/**
 * Client HTTP du Target Runner : mTLS (certificat client de la plateforme,
 * AC du Runner) + requêtes signées HMAC. Chaque entrée est validée par le
 * schéma de l'action AVANT envoi : la liste blanche s'applique des deux côtés.
 */
import { Readable } from 'node:stream'
import { Agent, request } from 'undici'
import { EMPTY_SHA256, HEADERS, sha256Hex, sign } from '../../lib/runner-signature'
import type { BuildResult, DirInfo, DiskInfo, ExtractResult, RemoveImagesResult, RunnerAction, RunnerCallContext, RunnerHealth, RunnerInput, TargetRunner } from './types'
import { validateRunnerInput } from './types'

export interface HttpRunnerOptions {
  url: string
  hmacKey: Buffer
  /** AC ayant signé le certificat serveur du Runner. */
  caCertPem?: string | null
  clientCertPem?: string | null
  clientKeyPem?: string | null
  /** Nom attendu dans le certificat du Runner, si différent de l'hôte de l'URL. */
  serverName?: string | null
  timeoutMs?: number
}

export class RunnerHttpError extends Error {
  constructor(message: string, public readonly status: number | null, public readonly kind: 'network' | 'auth' | 'denied' | 'invalid' | 'conflict' | 'server') {
    super(message)
    this.name = 'RunnerHttpError'
  }
}

export function kindFor(status: number): RunnerHttpError['kind'] {
  if (status === 401) return 'auth'
  if (status === 403) return 'denied'
  if (status === 409) return 'conflict'
  if (status === 400 || status === 404 || status === 413 || status === 422) return 'invalid'
  return 'server'
}

export function createHttpRunner(opts: HttpRunnerOptions): TargetRunner {
  const base = new URL(opts.url)
  const timeout = opts.timeoutMs ?? 120_000
  const dispatcher = new Agent({
    connect: {
      ...(opts.caCertPem ? { ca: opts.caCertPem } : {}),
      ...(opts.clientCertPem && opts.clientKeyPem ? { cert: opts.clientCertPem, key: opts.clientKeyPem } : {}),
      ...(opts.serverName ? { servername: opts.serverName } : {}),
      rejectUnauthorized: true,
    },
    headersTimeout: timeout,
    bodyTimeout: timeout,
  })

  async function call<T>(ctx: RunnerCallContext | null, method: 'GET' | 'POST' | 'PUT', path: string, body?: { json?: unknown, stream?: AsyncIterable<Uint8Array>, sha256?: string, size?: number }): Promise<T> {
    const raw = body?.json !== undefined ? Buffer.from(JSON.stringify(body.json)) : undefined
    const bodySha = raw ? sha256Hex(raw) : body?.sha256 ?? EMPTY_SHA256
    const headers: Record<string, string> = {
      ...sign(opts.hmacKey, method, path, bodySha),
      [HEADERS.requestId]: ctx?.requestId ?? crypto.randomUUID(),
      [HEADERS.actor]: ctx?.actor ?? 'platform',
      ...(raw ? { 'content-type': 'application/json' } : {}),
      ...(body?.stream ? { 'content-type': 'application/octet-stream', 'content-length': String(body.size) } : {}),
    }
    let res
    try {
      res = await request(new URL(path, base), { method, headers, body: raw ?? (body?.stream ? Readable.from(body.stream) : undefined), dispatcher })
    }
    catch (err) {
      const e = err as { code?: string, message?: string }
      throw new RunnerHttpError(`Runner injoignable : ${e.code ?? e.message ?? 'erreur réseau'}`, null, 'network')
    }
    const text = await res.body.text()
    let data: { error?: string } & Record<string, unknown>
    try {
      data = text ? JSON.parse(text) : {}
    }
    catch {
      data = { error: text.slice(0, 300) }
    }
    if (res.statusCode >= 400) throw new RunnerHttpError(data.error ?? `Erreur ${res.statusCode}`, res.statusCode, kindFor(res.statusCode))
    return data as T
  }

  const action = <A extends Exclude<RunnerAction, 'uploadFile'>, T>(name: A) =>
    (ctx: RunnerCallContext, input: RunnerInput<A>) => call<T>(ctx, 'POST', `/v1/actions/${name}`, { json: validateRunnerInput(name, input) })

  return {
    health: () => call<RunnerHealth>(null, 'GET', '/v1/health'),
    checkDir: action<'checkDir', DirInfo>('checkDir'),
    ensureDir: async (ctx, input) => {
      await action<'ensureDir', unknown>('ensureDir')(ctx, input)
    },
    pathExists: action<'pathExists', { exists: boolean }>('pathExists'),
    async uploadFile(ctx, input, data) {
      const i = validateRunnerInput('uploadFile', input)
      const q = new URLSearchParams({ path: i.path, size: String(i.sizeBytes), sha256: i.sha256 })
      await call(ctx, 'PUT', `/v1/files?${q}`, { stream: data, sha256: i.sha256, size: i.sizeBytes })
    },
    extractArchive: action<'extractArchive', ExtractResult>('extractArchive'),
    hashTree: action<'hashTree', { sha256: string, files: number }>('hashTree'),
    prepareBuildContext: action<'prepareBuildContext', { sizeBytes: number }>('prepareBuildContext'),
    /** Build : réponse NDJSON lue au fil de l'eau (logs transmis immédiatement). */
    async build(ctx, input, onLog) {
      const body = Buffer.from(JSON.stringify(validateRunnerInput('build', input)))
      const path = '/v1/actions/build'
      let res
      try {
        res = await request(new URL(path, base), {
          method: 'POST',
          dispatcher,
          body,
          headers: { ...sign(opts.hmacKey, 'POST', path, sha256Hex(body)), [HEADERS.requestId]: ctx.requestId, [HEADERS.actor]: ctx.actor, 'content-type': 'application/json' },
          // Un build peut être long : le délai est porté par le Runner (timeoutSec).
          headersTimeout: timeout,
          bodyTimeout: (input.timeoutSec + 60) * 1000,
        })
      }
      catch (err) {
        const e = err as { code?: string, message?: string }
        throw new RunnerHttpError(`Runner injoignable : ${e.code ?? e.message ?? 'erreur réseau'}`, null, 'network')
      }
      if (res.statusCode >= 400) {
        const text = await res.body.text()
        let message = `Erreur ${res.statusCode}`
        try {
          message = (JSON.parse(text) as { error?: string }).error ?? message
        }
        catch { /* corps non JSON */ }
        throw new RunnerHttpError(message, res.statusCode, kindFor(res.statusCode))
      }
      let buffer = ''
      let result: BuildResult | null = null
      let failure: string | null = null
      for await (const chunk of res.body) {
        buffer += chunk.toString('utf8')
        let nl
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const raw = buffer.slice(0, nl)
          buffer = buffer.slice(nl + 1)
          if (!raw.trim()) continue
          const msg = JSON.parse(raw) as { type: 'log', stream: 'stdout' | 'stderr', line: string } | ({ type: 'result' } & BuildResult) | { type: 'error', message: string }
          if (msg.type === 'log') onLog({ ts: new Date().toISOString(), stream: msg.stream, line: msg.line })
          else if (msg.type === 'result') result = { imageId: msg.imageId, imageTag: msg.imageTag, durationMs: msg.durationMs, contextBytes: msg.contextBytes }
          else failure = msg.message
        }
      }
      if (failure) throw new RunnerHttpError(failure, 422, 'invalid')
      if (!result) throw new RunnerHttpError('Flux de build interrompu sans résultat', null, 'network')
      return result
    },
    removeImages: action<'removeImages', RemoveImagesResult>('removeImages'),
    diskUsage: action<'diskUsage', DiskInfo>('diskUsage'),
    writeFile: action<'writeFile', { sha256: string }>('writeFile'),
    cleanup: action<'cleanup', { removedBytes: number }>('cleanup'),
  }
}
