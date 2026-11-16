/**
 * Sélection du Runner d'un endpoint.
 * - RUNNER_ADAPTER=mock : Runner simulé en mémoire (un par endpoint, pour garder son état) ;
 * - hôte joint en SSH : actions du Runner exécutées par SSH (aucun Runner à installer) ;
 * - sinon : Runner réel configuré pour l'endpoint (table target_runners).
 */
import { readFileSync } from 'node:fs'
import { eq } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import { decryptSecret } from '../../utils/crypto'
import { env } from '../../utils/env'
import { createHttpRunner } from './http'
import { createMockRunner } from './mock'
import { createSshRunner } from './ssh'
import type { TargetRunner } from './types'

export class RunnerNotConfigured extends Error {
  constructor() {
    super('Aucun Target Runner configuré pour cet endpoint')
    this.name = 'RunnerNotConfigured'
  }
}

const mocks = new Map<string, TargetRunner>()
let clientIdentity: { cert: string, key: string } | null | undefined

function platformIdentity() {
  if (clientIdentity === undefined) {
    const e = env()
    clientIdentity = e.RUNNER_CLIENT_CERT_FILE && e.RUNNER_CLIENT_KEY_FILE
      ? { cert: readFileSync(e.RUNNER_CLIENT_CERT_FILE, 'utf8'), key: readFileSync(e.RUNNER_CLIENT_KEY_FILE, 'utf8') }
      : null
  }
  return clientIdentity
}

export interface RunnerRecord {
  url: string
  authSecretId: string | null
  caCertPem: string | null
  serverName: string | null
}

export async function runnerFromRecord(record: RunnerRecord): Promise<TargetRunner> {
  if (!record.authSecretId) throw new RunnerNotConfigured()
  const [secret] = await db().select({ envelope: schema.secrets.envelope }).from(schema.secrets).where(eq(schema.secrets.id, record.authSecretId))
  if (!secret) throw new RunnerNotConfigured()
  const id = platformIdentity()
  if (!id && new URL(record.url).protocol === 'https:') {
    throw new Error('Certificat client de la plateforme absent (RUNNER_CLIENT_CERT_FILE / RUNNER_CLIENT_KEY_FILE)')
  }
  return createHttpRunner({
    url: record.url,
    hmacKey: Buffer.from(decryptSecret(secret.envelope), 'base64'),
    caCertPem: record.caCertPem,
    serverName: record.serverName,
    clientCertPem: id?.cert,
    clientKeyPem: id?.key,
    timeoutMs: env().RUNNER_TIMEOUT_MS,
  })
}

export async function runnerFor(endpointId: string): Promise<TargetRunner> {
  if (env().RUNNER_ADAPTER === 'mock') {
    let m = mocks.get(endpointId)
    if (!m) mocks.set(endpointId, (m = createMockRunner()))
    return m
  }
  const ssh = await sshRunnerFor(endpointId)
  if (ssh) return ssh
  const [record] = await db().select().from(schema.targetRunners).where(eq(schema.targetRunners.endpointId, endpointId))
  if (!record) throw new RunnerNotConfigured()
  return runnerFromRecord(record)
}

/** Racines autorisées d'un endpoint : celles de ses configurations de chemins (tous environnements). */
export async function endpointRoots(endpointId: string): Promise<string[]> {
  const rows = await db().select().from(schema.pathConfigs).where(eq(schema.pathConfigs.endpointId, endpointId))
  return [...new Set(rows.flatMap(r => [r.workingRoot, r.buildRoot, r.tmpRoot, r.runtimeRoot]))].sort()
}

/** Runner par SSH si le serveur de l'endpoint est joint en SSH, sinon null. */
export async function sshRunnerFor(endpointId: string): Promise<TargetRunner | null> {
  const [row] = await db().select({ server: schema.portainerServers }).from(schema.serverEndpoints)
    .innerJoin(schema.portainerServers, eq(schema.portainerServers.id, schema.serverEndpoints.serverId))
    .where(eq(schema.serverEndpoints.id, endpointId))
  if (row?.server.transport !== 'ssh') return null
  // Import différé : servers.ts dépend lui-même des adaptateurs.
  const { connectionFor } = await import('../../services/servers')
  const conn = await connectionFor(row.server)
  return createSshRunner(conn.ssh!, await endpointRoots(endpointId))
}

export * from './types'
