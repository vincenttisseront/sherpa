/**
 * Configuration du Target Runner, lue sur l'hôte cible uniquement.
 * Les racines autorisées sont déclarées ICI, localement : la plateforme ne
 * peut pas les élargir, même compromise.
 */
import { readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { z } from 'zod'
import { validateRoot } from '../server/utils/path-guard'

const schema = z.object({
  RUNNER_PORT: z.coerce.number().int().min(1).max(65535).default(8443),
  RUNNER_HOST: z.string().default('0.0.0.0'),
  /** Racines autorisées, séparées par des virgules (ex. /srv/deployments,/srv/builds,/srv/tmp,/srv/apps-data). */
  RUNNER_ROOTS: z.string().min(1),
  RUNNER_HMAC_KEY_FILE: z.string().min(1),
  RUNNER_TLS_CERT_FILE: z.string().optional(),
  RUNNER_TLS_KEY_FILE: z.string().optional(),
  /** AC qui a signé le certificat client de la plateforme (mTLS). */
  RUNNER_CLIENT_CA_FILE: z.string().optional(),
  RUNNER_MAX_UPLOAD_MB: z.coerce.number().int().positive().default(2048),
  RUNNER_MAX_CONCURRENT: z.coerce.number().int().positive().default(4),
  /** Socket du moteur Docker local (build). Absent : le build est désactivé. */
  RUNNER_DOCKER_SOCKET: z.string().default('/var/run/docker.sock'),
  RUNNER_MAX_BUILDS: z.coerce.number().int().positive().max(16).default(2),
  RUNNER_BUILD_MAX_MEMORY_MB: z.coerce.number().int().positive().default(4096),
  /** Builds avec BuildKit (étapes en parallèle, cache plus efficace) ; sans limite mémoire par build. Repli sur le builder classique s'il est indisponible. */
  RUNNER_BUILDKIT: z.stringbool().default(false),
  /** Développement uniquement : HTTP sans TLS. Refusé si NODE_ENV=production. */
  RUNNER_INSECURE_HTTP: z.stringbool().default(false),
  NODE_ENV: z.string().default('production'),
})

export interface RunnerConfig {
  port: number
  host: string
  roots: string[]
  hmacKey: Buffer
  tls: { cert: string, key: string, ca: string } | null
  maxUploadBytes: number
  maxConcurrent: number
  hostname: string
  dockerSocket: string | null
  maxBuilds: number
  buildkit: boolean
  buildMaxMemoryMb: number
}

export function loadRunnerConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const e = schema.parse(env)
  const roots = e.RUNNER_ROOTS.split(',').map(r => r.trim()).filter(Boolean).map(r => validateRoot(r))

  const hmacKey = Buffer.from(readFileSync(e.RUNNER_HMAC_KEY_FILE, 'utf8').trim(), 'base64')
  if (hmacKey.length < 32) throw new Error('Clé HMAC trop courte (32 octets minimum, encodée en base64)')

  let tls: RunnerConfig['tls'] = null
  if (e.RUNNER_INSECURE_HTTP) {
    if (e.NODE_ENV === 'production') throw new Error('RUNNER_INSECURE_HTTP est interdit en production')
  }
  else {
    if (!e.RUNNER_TLS_CERT_FILE || !e.RUNNER_TLS_KEY_FILE || !e.RUNNER_CLIENT_CA_FILE) {
      throw new Error('mTLS requis : RUNNER_TLS_CERT_FILE, RUNNER_TLS_KEY_FILE et RUNNER_CLIENT_CA_FILE')
    }
    tls = {
      cert: readFileSync(e.RUNNER_TLS_CERT_FILE, 'utf8'),
      key: readFileSync(e.RUNNER_TLS_KEY_FILE, 'utf8'),
      ca: readFileSync(e.RUNNER_CLIENT_CA_FILE, 'utf8'),
    }
  }

  return {
    port: e.RUNNER_PORT,
    host: e.RUNNER_HOST,
    roots,
    hmacKey,
    tls,
    maxUploadBytes: e.RUNNER_MAX_UPLOAD_MB * 1024 * 1024,
    maxConcurrent: e.RUNNER_MAX_CONCURRENT,
    hostname: hostname(),
    dockerSocket: e.RUNNER_DOCKER_SOCKET || null,
    maxBuilds: e.RUNNER_MAX_BUILDS,
    buildkit: e.RUNNER_BUILDKIT,
    buildMaxMemoryMb: e.RUNNER_BUILD_MAX_MEMORY_MB,
  }
}
