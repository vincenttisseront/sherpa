/**
 * Administration du Target Runner d'un endpoint : enregistrement, clé HMAC,
 * diagnostic complet (authentification, racines, répertoires, espace disque,
 * dépôt + extraction d'une archive témoin).
 */
import { type Progress, noProgress } from '../utils/progress'
import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { RunnerCallContext, TargetRunner } from '../adapters/runner'
import { endpointRoots, runnerFor } from '../adapters/runner'
import { db, schema } from '../db/client'
import { sha256Hex } from '../lib/runner-signature'
import { makeZip } from '../lib/zip-writer'
import { decryptSecret, encryptSecret } from '../utils/crypto'
import { env } from '../utils/env'
import { isWithin } from '../utils/path-guard'
import { environmentMaps } from './servers'
import { emitNotification } from './notifications'
import { audit } from '../utils/audit'
import { formatBytes } from '../../shared/utils/format'
import type { DiagnosticResult, DiagnosticStep, RunnerDto, StepStatus } from '../../shared/schemas/runner'

export type { DiagnosticResult, DiagnosticStep, RunnerDto, StepStatus }

export async function getRunnerRow(endpointId: string) {
  const [row] = await db().select().from(schema.targetRunners).where(eq(schema.targetRunners.endpointId, endpointId))
  return row
}

export async function toRunnerDto(endpointId: string): Promise<RunnerDto> {
  const r = await getRunnerRow(endpointId)
  const [host] = await db().select({ transport: schema.portainerServers.transport }).from(schema.serverEndpoints)
    .innerJoin(schema.portainerServers, eq(schema.portainerServers.id, schema.serverEndpoints.serverId)).where(eq(schema.serverEndpoints.id, endpointId))
  const viaSsh = host?.transport === 'ssh'
  let keyFingerprint: string | null = null
  if (r?.authSecretId) {
    const [s] = await db().select({ envelope: schema.secrets.envelope }).from(schema.secrets).where(eq(schema.secrets.id, r.authSecretId))
    if (s) keyFingerprint = keyFingerprintOf(decryptSecret(s.envelope))
  }
  const e = env()
  return {
    configured: !!r,
    url: r?.url ?? null,
    caCertPem: r?.caCertPem ?? null,
    serverName: r?.serverName ?? null,
    maxConcurrentBuilds: r?.maxConcurrentBuilds ?? 2,
    status: r?.status ?? 'unconfigured',
    version: r?.version ?? null,
    hostname: r?.hostname ?? null,
    hostRoots: r?.hostRoots ?? [],
    lastCheckedAt: r?.lastCheckedAt?.toISOString() ?? null,
    lastError: r?.lastError ?? null,
    keyFingerprint,
    platformIdentity: !!(e.RUNNER_CLIENT_CERT_FILE && e.RUNNER_CLIENT_KEY_FILE),
    adapter: e.RUNNER_ADAPTER,
    viaSsh,
    sshRoots: viaSsh ? await endpointRoots(endpointId) : [],
  }
}

/**
 * Empreinte courte de la clé, vérifiable sur l'hôte sans exposer la clé :
 *   tr -d '\n' < hmac.key | sha256sum | cut -c1-16
 */
export function keyFingerprintOf(plainBase64: string): string {
  return sha256Hex(plainBase64.trim()).slice(0, 16)
}

/** Génère une clé HMAC, la chiffre et la renvoie en clair UNE seule fois (à installer sur l'hôte). */
export function newHmacKey(): { plain: string, envelope: string, keyId: string } {
  const plain = randomBytes(32).toString('base64')
  return { plain, ...encryptSecret(plain) }
}

const fmtBytes = formatBytes

/**
 * Diagnostic de bout en bout. Les répertoires configurés absents sont créés
 * si la configuration l'autorise (création automatique, §6.4).
 */
export async function diagnoseRunner(endpointId: string, actor: string, progress: Progress = noProgress): Promise<DiagnosticResult> {
  const steps: DiagnosticStep[] = []
  const ctx: RunnerCallContext = { requestId: crypto.randomUUID(), actor }
  const STEPS = ['health', 'roots', 'dirs', 'disk', 'io']
  const step = async (key: string, label: string, fn: () => Promise<{ status?: StepStatus, detail: string }>) => {
    await progress.step(label, STEPS.indexOf(key) + 1, STEPS.length)
    const t = Date.now()
    try {
      const r = await fn()
      steps.push({ key, label, status: r.status ?? 'ok', detail: r.detail, durationMs: Date.now() - t })
    }
    catch (err) {
      steps.push({ key, label, status: 'error', detail: err instanceof Error ? err.message : String(err), durationMs: Date.now() - t })
    }
    return steps.at(-1)!.status !== 'error'
  }
  const skip = (key: string, label: string, why: string) => steps.push({ key, label, status: 'skipped', detail: why, durationMs: 0 })

  let runner: TargetRunner | undefined
  let roots: string[] = []
  const healthy = await step('health', 'Connexion, mTLS et signature', async () => {
    runner = await runnerFor(endpointId)
    const h = await runner.health()
    roots = h.roots
    await db().update(schema.targetRunners).set({ version: h.version, hostname: h.hostname, hostRoots: h.roots }).where(eq(schema.targetRunners.endpointId, endpointId))
    if (h.version === 'ssh') return { detail: `Par SSH sur ${h.hostname} (SFTP${h.actions.includes('build') ? ' et build Docker' : ', build indisponible : socket Docker inaccessible'}) · racines : ${h.roots.join(', ') || 'aucune'}` }
    return { detail: `Runner ${h.version} sur ${h.hostname} · racines : ${h.roots.join(', ')}` }
  })

  const { keyById } = await environmentMaps()
  const configs = await db().select().from(schema.pathConfigs).where(eq(schema.pathConfigs.endpointId, endpointId))
  const ROOTS = ['workingRoot', 'buildRoot', 'tmpRoot', 'runtimeRoot'] as const

  if (!healthy || !runner) {
    for (const [k, l] of [['roots', 'Racines configurées'], ['dirs', 'Répertoires'], ['disk', 'Espace disque'], ['io', 'Dépôt et extraction']]) skip(k!, l!, 'Runner injoignable')
  }
  else if (!configs.length) {
    for (const [k, l] of [['roots', 'Racines configurées'], ['dirs', 'Répertoires'], ['disk', 'Espace disque'], ['io', 'Dépôt et extraction']]) skip(k!, l!, 'Aucun chemin configuré sur cet endpoint')
  }
  else {
    const r = runner
    const rootsOk = await step('roots', 'Racines configurées couvertes par l\'hôte', async () => {
      const outside = configs.flatMap(c => ROOTS.map(f => c[f]).filter(p => !roots.some(root => isWithin(p, root))).map(p => `${keyById.get(c.environmentId)} : ${p}`))
      if (outside.length) throw new Error(`Hors des racines déclarées sur l'hôte (RUNNER_ROOTS) : ${outside.join(' ; ')}`)
      return { detail: `${configs.length * ROOTS.length} répertoires couverts` }
    })

    const dirsOk = rootsOk && await step('dirs', 'Répertoires', async () => {
      const created: string[] = []
      const missing: string[] = []
      for (const c of configs) {
        for (const f of ROOTS) {
          const info = await r.checkDir(ctx, { path: c[f] })
          if (info.exists && !info.isDirectory) throw new Error(`${c[f]} existe mais n'est pas un répertoire`)
          if (info.exists && info.writable) continue
          if (!c.autoCreate) {
            if (info.exists) throw new Error(`${c[f]} n'est pas accessible en écriture par le Runner`)
            missing.push(c[f])
            continue
          }
          // Absent, ou fermé au compte (hôte SSH : repris avec les droits du moteur Docker).
          await r.ensureDir(ctx, { path: c[f], mode: c.dirMode, ...(c.ownerUid !== null ? { uid: c.ownerUid } : {}), ...(c.groupGid !== null ? { gid: c.groupGid } : {}) })
          if (!(await r.checkDir(ctx, { path: c[f] })).writable) throw new Error(`${c[f]} n'est pas accessible en écriture par le Runner`)
          created.push(c[f])
        }
      }
      if (missing.length) throw new Error(`Répertoires absents (création automatique désactivée) : ${missing.join(', ')}`)
      return { detail: created.length ? `Créés ou rendus accessibles : ${created.join(', ')}` : 'Tous présents et accessibles en écriture' }
    })

    if (!dirsOk) {
      skip('disk', 'Espace disque', 'Répertoires non disponibles')
      skip('io', 'Dépôt et extraction', 'Répertoires non disponibles')
    }
    else {
      await step('disk', 'Espace disque', async () => {
        const lines: string[] = []
        let worst: StepStatus = 'ok'
        for (const c of configs) {
          const d = await r.diskUsage(ctx, { path: c.workingRoot })
          const min = c.minFreeDiskMb * 1024 * 1024
          if (d.freeBytes < min) worst = 'error'
          else if (d.freeBytes < min * 1.5 && worst !== 'error') worst = 'warning'
          lines.push(`${keyById.get(c.environmentId)} : ${fmtBytes(d.freeBytes)} libres (minimum ${fmtBytes(min)})`)
        }
        return { status: worst, detail: lines.join(' · ') }
      })

      await step('io', 'Dépôt, extraction, empreinte et nettoyage', async () => {
        const tmp = configs[0]!.tmpRoot
        const tag = `.diagnostic-${randomBytes(4).toString('hex')}`
        const zip = makeZip([{ name: 'diagnostic/compose.yml', data: 'services: {}\n' }, { name: 'diagnostic/Dockerfile', data: 'FROM scratch\n' }])
        const archive = `${tmp}/${tag}.zip`
        const dest = `${tmp}/${tag}`
        await r.uploadFile(ctx, { path: archive, sizeBytes: zip.length, sha256: sha256Hex(zip) }, (async function* () { yield zip })())
        try {
          const x = await r.extractArchive(ctx, { archivePath: archive, destination: dest, format: 'zip', maxFiles: 10, maxTotalBytes: 1024 * 1024, timeoutSec: 30, allowSymlinks: false })
          const h = await r.hashTree(ctx, { path: dest })
          return { detail: `Archive témoin de ${zip.length} o déposée et extraite dans ${tmp} (${x.files} fichiers, Compose et Dockerfile détectés : ${x.composeFiles.length && x.dockerfiles.length ? 'oui' : 'non'}, empreinte ${h.sha256.slice(0, 12)}…)` }
        }
        finally {
          await r.cleanup(ctx, { path: dest }).catch(() => {})
          await r.cleanup(ctx, { path: archive }).catch(() => {})
        }
      })
    }
  }

  const ok = steps.every(s => s.status !== 'error')
  const firstError = steps.find(s => s.status === 'error')
  await db().update(schema.targetRunners).set({
    status: !healthy ? 'offline' : ok ? 'online' : 'error',
    lastCheckedAt: new Date(),
    lastError: firstError ? `${firstError.label} : ${firstError.detail}` : null,
  }).where(eq(schema.targetRunners.endpointId, endpointId))
  return { ok, steps }
}

export interface PreparedDirectories { created: string[], failed: { path: string, error: string }[] }

/**
 * Répertoires configurés d'un endpoint créés (ou rendus accessibles) sans action manuelle :
 * à la connexion du serveur et à l'enregistrement des chemins. Sur un hôte SSH, ce que le compte
 * ne peut pas créer l'est avec les droits du moteur Docker. Ne lève jamais : échecs rapportés.
 */
export async function prepareEndpointDirectories(endpointId: string, environmentId?: string): Promise<PreparedDirectories> {
  const out: PreparedDirectories = { created: [], failed: [] }
  const configs = (await db().select().from(schema.pathConfigs).where(eq(schema.pathConfigs.endpointId, endpointId)))
    .filter(c => c.autoCreate && (!environmentId || c.environmentId === environmentId))
  if (!configs.length) return out
  let runner: TargetRunner
  try {
    runner = await runnerFor(endpointId)
  }
  catch {
    return out // Pas de Runner (ni SSH) sur cet endpoint : préparé au premier déploiement.
  }
  const ctx: RunnerCallContext = { requestId: `prepare-${randomBytes(4).toString('hex')}`, actor: 'platform' }
  for (const c of configs) {
    for (const f of ['workingRoot', 'buildRoot', 'tmpRoot', 'runtimeRoot'] as const) {
      try {
        const info = await runner.checkDir(ctx, { path: c[f] })
        if (info.exists && info.writable) continue
        if (info.exists && !info.isDirectory) throw new Error('existe mais n\'est pas un répertoire')
        await runner.ensureDir(ctx, { path: c[f], mode: c.dirMode, ...(c.ownerUid !== null ? { uid: c.ownerUid } : {}), ...(c.groupGid !== null ? { gid: c.groupGid } : {}) })
        out.created.push(c[f])
      }
      catch (err) {
        out.failed.push({ path: c[f], error: (err as Error).message.slice(0, 300) })
      }
    }
  }
  return out
}

/**
 * Contrôle périodique léger d'un Runner (sans écriture) : joignabilité mTLS et
 * espace disque des racines de travail. Une dégradation est auditée et notifiée.
 */
export async function checkRunnerHealth(endpointId: string): Promise<'online' | 'offline' | 'error'> {
  const [row] = await db().select({ r: schema.targetRunners, ep: schema.serverEndpoints.name, server: schema.portainerServers.name, serverId: schema.portainerServers.id })
    .from(schema.targetRunners)
    .innerJoin(schema.serverEndpoints, eq(schema.serverEndpoints.id, schema.targetRunners.endpointId))
    .innerJoin(schema.portainerServers, eq(schema.portainerServers.id, schema.serverEndpoints.serverId))
    .where(eq(schema.targetRunners.endpointId, endpointId))
  if (!row) return 'offline'
  let status: 'online' | 'offline' | 'error' = 'online'
  let error: string | null = null
  try {
    const runner = await runnerFor(endpointId)
    const h = await runner.health()
    await db().update(schema.targetRunners).set({ version: h.version, hostname: h.hostname, hostRoots: h.roots }).where(eq(schema.targetRunners.endpointId, endpointId))
    const ctx: RunnerCallContext = { requestId: crypto.randomUUID(), actor: 'system' }
    for (const c of await db().select().from(schema.pathConfigs).where(eq(schema.pathConfigs.endpointId, endpointId))) {
      const d = await runner.diskUsage(ctx, { path: c.workingRoot }).catch(() => null)
      if (d && d.freeBytes < c.minFreeDiskMb * 1024 * 1024) {
        status = 'error'
        error = `Espace disque insuffisant sous ${c.workingRoot} : ${fmtBytes(d.freeBytes)} libres (minimum ${fmtBytes(c.minFreeDiskMb * 1024 * 1024)})`
      }
    }
  }
  catch (err) {
    status = 'offline'
    error = `Connexion, mTLS et signature : ${err instanceof Error ? err.message : String(err)}`
  }
  await db().update(schema.targetRunners).set({ status, lastCheckedAt: new Date(), lastError: error }).where(eq(schema.targetRunners.endpointId, endpointId))
  if (status !== 'online' && row.r.status === 'online') {
    await audit({ actorLabel: 'system', action: 'runner.unavailable', targetType: 'target_runner', targetId: row.r.id, serverId: row.serverId, outcome: 'failure', details: { endpoint: row.ep, error } })
    await emitNotification({
      event: 'server.unavailable', severity: 'error',
      title: `Runner ${status === 'offline' ? 'injoignable' : 'en erreur'} : ${row.server} / ${row.ep}`,
      summary: `${error ?? 'Runner indisponible'}\nDépôts de fichiers et builds impossibles sur cet endpoint.`,
      facts: [{ label: 'Serveur', value: row.server }, { label: 'Endpoint', value: row.ep }, { label: 'Runner', value: row.r.url }],
      path: `/servers/${row.serverId}`, serverId: row.serverId,
    })
  }
  else if (status === 'online' && row.r.status !== 'online' && row.r.lastCheckedAt) {
    await audit({ actorLabel: 'system', action: 'runner.recovered', targetType: 'target_runner', targetId: row.r.id, serverId: row.serverId, outcome: 'success', details: { endpoint: row.ep } })
  }
  return status
}

/** Tous les Runners des endpoints activés. */
export async function checkAllRunners(): Promise<Record<string, string>> {
  const rows = await db().select({ endpointId: schema.targetRunners.endpointId }).from(schema.targetRunners)
    .innerJoin(schema.serverEndpoints, eq(schema.serverEndpoints.id, schema.targetRunners.endpointId))
    .where(eq(schema.serverEndpoints.enabled, true))
  const out: Record<string, string> = {}
  for (const r of rows) out[r.endpointId] = await checkRunnerHealth(r.endpointId)
  return out
}
