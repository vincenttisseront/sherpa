/**
 * Serveur du Target Runner.
 *
 * Routes (toutes signées, toutes auditées) :
 *   GET  /v1/health
 *   POST /v1/actions/<action>     corps JSON validé par le schéma de l'action
 *   PUT  /v1/files?path=&size=&sha256=   dépôt de fichier en flux
 *
 * Toute autre route renvoie 404. Il n'existe aucune route d'exécution de commande.
 */
import { randomUUID } from 'node:crypto'
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { TLSSocket } from 'node:tls'
import { ZodError } from 'zod'
import { type RunnerAction, runnerActions } from '../server/adapters/runner/types'
import { HEADERS, NonceCache, sha256Hex, verify } from '../server/lib/runner-signature'
import { ZipRejected } from '../server/lib/zip'
import { PathViolation, validateRelativeEntry } from '../server/utils/path-guard'
import { RunnerError, createActions } from './actions'
import type { RunnerConfig } from './config'
import { FsGuard } from './fs-guard'
import { DockerError, createDockerClient } from './docker'

export const RUNNER_VERSION = '0.3.0'
const MAX_JSON_BYTES = 2 * 1024 * 1024
/** Actions sans Docker, toujours exposées. Le build et la suppression d'images exigent le socket Docker. */
const FS_ACTIONS: readonly RunnerAction[] = ['checkDir', 'ensureDir', 'pathExists', 'uploadFile', 'extractArchive', 'hashTree', 'prepareBuildContext', 'writeFile', 'diskUsage', 'cleanup']
const DOCKER_ACTIONS: readonly RunnerAction[] = ['build', 'removeImages']

/** Sémaphore simple : les builds au-delà de la limite attendent leur tour. */
function semaphore(max: number) {
  let active = 0
  const queue: (() => void)[] = []
  return {
    async acquire() {
      if (active < max) {
        active++
        return
      }
      await new Promise<void>(resolve => queue.push(resolve))
      active++
    },
    release() {
      active--
      queue.shift()?.()
    },
    get waiting() { return queue.length },
  }
}

type AuditFn = (entry: Record<string, unknown>) => void
const stdoutAudit: AuditFn = entry => process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`)

function send(res: ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(json), 'cache-control': 'no-store' })
  res.end(json)
}

async function readJson(req: IncomingMessage): Promise<{ raw: Buffer, value: unknown }> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > MAX_JSON_BYTES) throw new RunnerError('Corps de requête trop volumineux', 413)
    chunks.push(c as Buffer)
  }
  const raw = Buffer.concat(chunks)
  try {
    return { raw, value: raw.length ? JSON.parse(raw.toString('utf8')) : {} }
  }
  catch {
    throw new RunnerError('JSON invalide', 400)
  }
}

export function createRunnerServer(config: RunnerConfig, audit: AuditFn = stdoutAudit): Server {
  const guard = new FsGuard(config.roots)
  const actions = createActions(guard, { maxUploadBytes: config.maxUploadBytes })
  const docker = config.dockerSocket ? createDockerClient(config.dockerSocket) : null
  const builds = semaphore(config.maxBuilds)
  const nonces = new NonceCache()
  let running = 0
  const enabledActions = async (): Promise<RunnerAction[]> => [...FS_ACTIONS, ...(docker && await docker.ping() ? DOCKER_ACTIONS : [])]

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const started = Date.now()
    const requestId = String(req.headers[HEADERS.requestId] ?? randomUUID()).slice(0, 64)
    const actor = String(req.headers[HEADERS.actor] ?? 'inconnu').slice(0, 200)
    const url = new URL(req.url ?? '/', 'https://runner')
    const pathWithQuery = `${url.pathname}${url.search}`
    let action = 'unknown'
    let outcome: 'success' | 'failure' | 'denied' = 'failure'
    let detail: Record<string, unknown> = {}

    try {
      // 1. mTLS (si TLS actif, le handshake a déjà rejeté un client sans certificat valide).
      if (config.tls && !(req.socket as TLSSocket).authorized) throw new RunnerError('Certificat client refusé', 401)

      // 2. Signature et anti-rejeu.
      const v = verify(config.hmacKey, { method: req.method ?? 'GET', pathWithQuery, headers: req.headers }, nonces)
      if (!v.ok) {
        outcome = 'denied'
        throw new RunnerError(`Authentification refusée : ${v.reason}`, 401)
      }

      if (running >= config.maxConcurrent) throw new RunnerError('Runner occupé, réessayer plus tard', 503)
      running++
      try {
        if (req.method === 'GET' && url.pathname === '/v1/health') {
          action = 'health'
          await readJson(req)
          send(res, 200, { version: RUNNER_VERSION, actions: await enabledActions(), roots: config.roots, hostname: config.hostname })
        }
        else if (req.method === 'PUT' && url.pathname === '/v1/files') {
          action = 'uploadFile'
          const input = runnerActions.uploadFile.parse({
            path: url.searchParams.get('path'),
            sizeBytes: Number(url.searchParams.get('size')),
            sha256: url.searchParams.get('sha256'),
          })
          if (req.headers[HEADERS.contentSha256] !== input.sha256) throw new RunnerError('Empreinte signée différente de l\'empreinte annoncée', 400)
          detail = { path: input.path, sizeBytes: input.sizeBytes }
          await actions.uploadFile(input, req)
          send(res, 201, { ok: true })
        }
        else if (req.method === 'POST' && url.pathname === '/v1/actions/build') {
          action = 'build'
          if (!docker || !(await docker.ping())) throw new RunnerError('Build indisponible : moteur Docker injoignable sur cet hôte', 503)
          const { raw, value } = await readJson(req)
          if (sha256Hex(raw) !== req.headers[HEADERS.contentSha256]) throw new RunnerError('Corps altéré (empreinte différente de la signature)', 401)
          const input = runnerActions.build.parse(value)
          const contextDir = await guard.resolve(input.contextDir)
          const dockerfile = validateRelativeEntry(input.dockerfile)
          detail = { contextDir, dockerfile, imageTag: input.imageTag }
          // Réponse en flux NDJSON : logs au fil de l'eau, puis résultat ou erreur.
          res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' })
          const line = (o: unknown) => res.write(`${JSON.stringify(o)}\n`)
          if (builds.waiting || running > config.maxBuilds) line({ type: 'log', stream: 'stdout', line: 'En attente d\'un emplacement de build libre…' })
          await builds.acquire()
          try {
            const r = await docker.build({
              contextDir,
              dockerfile,
              tag: input.imageTag,
              buildArgs: input.buildArgs,
              labels: { ...input.labels, 'platform.managed': 'true' },
              target: input.target,
              memoryMb: Math.min(input.memoryMb ?? config.buildMaxMemoryMb, config.buildMaxMemoryMb),
              cpuQuota: input.cpuQuota,
              timeoutMs: input.timeoutSec * 1000,
              maxLogBytes: input.maxLogBytes,
              pull: input.pull,
              noCache: input.noCache,
              buildkit: config.buildkit,
              onLog: (l, stream) => line({ type: 'log', stream, line: l }),
            })
            line({ type: 'result', imageId: r.imageId, imageTag: input.imageTag, durationMs: r.durationMs, contextBytes: r.contextBytes })
            outcome = 'success'
            detail.imageId = r.imageId
          }
          catch (err) {
            const message = err instanceof DockerError || err instanceof PathViolation ? err.message : 'Erreur interne pendant le build'
            if (!(err instanceof DockerError || err instanceof PathViolation)) console.error(err)
            line({ type: 'error', message })
            detail.error = message
          }
          finally {
            builds.release()
            res.end()
          }
          return
        }
        else if (req.method === 'POST' && url.pathname === '/v1/actions/removeImages') {
          action = 'removeImages'
          if (!docker || !(await docker.ping())) throw new RunnerError('Moteur Docker injoignable sur cet hôte', 503)
          const { raw, value } = await readJson(req)
          if (sha256Hex(raw) !== req.headers[HEADERS.contentSha256]) throw new RunnerError('Corps altéré (empreinte différente de la signature)', 401)
          const input = runnerActions.removeImages.parse(value)
          detail = { tags: input.tags }
          send(res, 200, await docker.removeImages(input.tags))
        }
        else if (req.method === 'POST' && url.pathname.startsWith('/v1/actions/')) {
          action = url.pathname.slice('/v1/actions/'.length)
          if (!(FS_ACTIONS as readonly string[]).includes(action) || action === 'uploadFile') throw new RunnerError(`Action inconnue : ${action}`, 404)
          const { raw, value } = await readJson(req)
          if (sha256Hex(raw) !== req.headers[HEADERS.contentSha256]) throw new RunnerError('Corps altéré (empreinte différente de la signature)', 401)
          const input = runnerActions[action as RunnerAction].parse(value)
          detail = { ...(input as Record<string, unknown>) }
          delete detail.content
          const fn = actions[action as Exclude<RunnerAction, 'uploadFile' | 'build' | 'removeImages'>] as (i: unknown) => Promise<unknown>
          send(res, 200, (await fn(input)) ?? { ok: true })
        }
        else {
          throw new RunnerError('Route inconnue', 404)
        }
        outcome = 'success'
      }
      finally {
        running--
      }
    }
    catch (err) {
      let status = 500
      let message = 'Erreur interne du Runner'
      if (err instanceof RunnerError) [status, message] = [err.status, err.message]
      else if (err instanceof PathViolation) [status, message, outcome] = [403, err.message, 'denied']
      else if (err instanceof ZipRejected) [status, message] = [422, err.message]
      else if (err instanceof ZodError) [status, message] = [400, `Paramètres invalides : ${err.issues.map(i => `${i.path.join('.')} ${i.message}`).join(' ; ')}`]
      else if ((err as NodeJS.ErrnoException).code === 'ENOSPC') [status, message] = [507, 'Espace disque insuffisant']
      else if ((err as NodeJS.ErrnoException).code === 'EACCES') [status, message] = [403, `Permission refusée par le système de fichiers${(err as NodeJS.ErrnoException).path ? ` sur ${(err as NodeJS.ErrnoException).path} (compte du Runner : droits à donner sur ce répertoire)` : ''}`]
      if (status === 500) console.error(err)
      // Vider le corps restant pour permettre au client de lire la réponse.
      req.resume()
      if (!res.headersSent) send(res, status, { error: message })
      detail.error = message
    }
    finally {
      audit({ requestId, actor, action, outcome, durationMs: Date.now() - started, ...detail })
    }
  }

  const listener = (req: IncomingMessage, res: ServerResponse) => void handler(req, res)
  const server = config.tls
    ? createHttpsServer({ cert: config.tls.cert, key: config.tls.key, ca: config.tls.ca, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.2' }, listener)
    : createHttpServer(listener)
  server.requestTimeout = 15 * 60_000
  server.headersTimeout = 30_000
  return server
}
