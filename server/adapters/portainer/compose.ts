/**
 * Exécution de `docker compose` contre un hôte, comme le fait le serveur
 * Portainer : la CLI Docker parle à un socket Unix local privé.
 * - Agent : relais propre à l'opération, qui ajoute la signature de l'agent à
 *   chaque requête et transmet en HTTPS, flux et connexions détournées compris.
 * - SSH : relais de la session SSH vers le socket Docker de l'hôte.
 *
 * Les variables secrètes passent par l'environnement du processus uniquement
 * (interpolation Compose), jamais par un fichier ; l'environnement de la
 * console n'est pas transmis.
 */
import { spawn } from 'node:child_process'
import { isBenignSecret } from '../../lib/network-probe'
import { mkdtemp, rm } from 'node:fs/promises'
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { redactPatterns } from '../../utils/redact'
import { agentHeaders } from './agent-signature'
import { sshDockerSocket } from '../ssh/session'
import { type PortainerConnection, PortainerError } from './types'

const HOP_BY_HOP = new Set(['host', 'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade'])

interface Relay { socketPath: string, close(): Promise<void> }

/** Relais local signé vers un agent. */
export async function startAgentRelay(conn: PortainerConnection): Promise<Relay> {
  const dir = await mkdtemp(join(tmpdir(), 'pp-agent-'))
  const socketPath = join(dir, 'docker.sock')
  const target = new URL(conn.url)
  const secure = target.protocol === 'https:'
  const request = secure ? httpsRequest : httpRequest
  const tls = secure ? { rejectUnauthorized: conn.tlsVerify, ...(conn.caCertPem ? { ca: conn.caCertPem } : {}) } : {}

  const outbound = (req: IncomingMessage, extra: Record<string, string> = {}) => {
    const headers: Record<string, string | string[]> = {}
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !HOP_BY_HOP.has(k)) headers[k] = v
    return request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (secure ? 443 : 80),
      method: req.method,
      path: req.url,
      headers: { ...headers, ...agentHeaders(conn.token), host: target.host, ...extra },
      ...tls,
    })
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const out = outbound(req)
    out.on('response', (r) => {
      const headers = Object.fromEntries(Object.entries(r.headers).filter(([k]) => !HOP_BY_HOP.has(k)))
      res.writeHead(r.statusCode ?? 502, headers)
      r.pipe(res)
    })
    out.on('error', (err) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ message: `Agent injoignable : ${redactPatterns(err.message)}` }))
    })
    req.pipe(out)
  })
  // Connexions détournées par Docker (attach, exec) : tunnel brut une fois la réponse 101 reçue.
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const out = outbound(req, { connection: 'Upgrade', upgrade: String(req.headers.upgrade ?? 'tcp') })
    out.on('upgrade', (r, upstream, upHead) => {
      const lines = [`HTTP/1.1 ${r.statusCode} ${r.statusMessage}`, ...Object.entries(r.headers).map(([k, v]) => `${k}: ${String(v)}`)]
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (upHead.length) socket.write(upHead)
      if (head.length) upstream.write(head)
      upstream.pipe(socket).pipe(upstream)
      upstream.on('error', () => socket.destroy())
      socket.on('error', () => upstream.destroy())
    })
    out.on('response', (r) => {
      socket.write(`HTTP/1.1 ${r.statusCode} ${r.statusMessage}\r\n\r\n`)
      r.pipe(socket)
    })
    out.on('error', () => socket.destroy())
    out.end()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })
  return {
    socketPath,
    async close() {
      server.closeAllConnections()
      await new Promise<void>(r => server.close(() => r()))
      await rm(dir, { recursive: true, force: true })
    },
  }
}

export interface ComposeRun {
  /** Arguments après `docker compose` (projet, fichiers, commande). */
  args: string[]
  /** Contenu passé sur l'entrée standard (`-f -`). */
  stdin?: string
  /** Variables pour l'interpolation Compose (secrets compris). */
  env?: { name: string, value: string }[]
  timeoutMs: number
}

export function dockerCli(): string {
  return process.env.DOCKER_CLI_PATH || 'docker'
}

/** Socket Docker local de l'hôte : relais de la session SSH (partagé) ou relais signé de l'agent (propre à l'opération). */
async function dockerSocketFor(conn: PortainerConnection): Promise<Relay> {
  if (conn.transport === 'ssh' && conn.ssh) return { socketPath: await sshDockerSocket(conn.ssh), close: async () => {} }
  return startAgentRelay(conn)
}

/** Lance `docker compose` contre l'hôte ; erreur explicite (sans secret) en cas d'échec. */
export async function runCompose(conn: PortainerConnection, run: ComposeRun): Promise<string[]> {
  const relay = await dockerSocketFor(conn)
  const work = await mkdtemp(join(tmpdir(), 'pp-compose-'))
  try {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: work,
      DOCKER_CONFIG: work,
      DOCKER_HOST: `unix://${relay.socketPath}`,
      COMPOSE_PROGRESS: 'plain',
      COMPOSE_ANSI: 'never',
      // Hôte SSH : chaque appel à l'API Docker est un canal de la session ; parallélisme borné.
      ...(conn.transport === 'ssh' ? { COMPOSE_PARALLEL_LIMIT: '4' } : {}),
    }
    for (const v of run.env ?? []) env[v.name] = v.value
    const secrets = (run.env ?? []).map(v => v.value).filter(v => v.length >= 4 && !isBenignSecret(v, new Set()))
    const mask = (line: string) => secrets.reduce((l, s) => l.split(s).join('••••'), redactPatterns(line))
    const output: string[] = []
    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn(dockerCli(), ['compose', ...run.args], { cwd: work, env, stdio: ['pipe', 'pipe', 'pipe'] })
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        reject(new PortainerError('docker compose : délai dépassé', 'timeout'))
      }, run.timeoutMs)
      const collect = (b: Buffer) => {
        for (const l of b.toString('utf8').split('\n')) if (l.trim()) output.push(mask(l))
        if (output.length > 400) output.splice(0, output.length - 400)
      }
      child.stdout.on('data', collect)
      child.stderr.on('data', collect)
      child.on('error', (err) => {
        clearTimeout(timer)
        reject(new PortainerError(`docker compose indisponible (${(err as NodeJS.ErrnoException).code ?? err.message}) : installer la CLI Docker et le plugin compose`, 'unsupported'))
      })
      child.on('close', (c) => {
        clearTimeout(timer)
        resolve(c ?? 1)
      })
      child.stdin.end(run.stdin ?? '')
    })
    if (code !== 0) {
      const tail = output.slice(-12).join(' | ')
      throw new PortainerError(`docker compose a échoué (code ${code}) : ${tail}`.slice(0, 1500), 'http', 500)
    }
    return output
  }
  finally {
    await relay.close().catch(() => {})
    await rm(work, { recursive: true, force: true }).catch(() => {})
  }
}
