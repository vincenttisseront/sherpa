/**
 * Nettoyage périodique des répertoires temporaires des serveurs cibles :
 * fichiers de plus de 24 h, uniquement sur les endpoints sans déploiement en
 * cours (un transfert ou une extraction ne doit jamais être interrompu).
 */
import { and, eq, inArray } from 'drizzle-orm'
import { ACTIVE_STATUSES } from '../../shared/utils/deployment-status'
import { runnerFor } from '../adapters/runner'
import { db, schema } from '../db/client'
import { audit } from '../utils/audit'
import { formatBytes } from '../../shared/utils/format'
import { isWithin } from '../utils/path-guard'

export async function cleanupTargetTmp(maxAgeSec = 24 * 3600): Promise<Record<string, string>> {
  const results: Record<string, string> = {}
  const configs = await db().select({ c: schema.pathConfigs, ep: schema.serverEndpoints })
    .from(schema.pathConfigs)
    .innerJoin(schema.serverEndpoints, eq(schema.serverEndpoints.id, schema.pathConfigs.endpointId))
    .where(eq(schema.serverEndpoints.enabled, true))

  for (const { c, ep } of configs) {
    const key = `${ep.name}:${c.tmpRoot}`
    // Garde-fou (configurations antérieures à la validation) : une racine temporaire qui recouvre
    // des releases ou des données n'est jamais purgée.
    const shared = configs.filter(o => o.ep.id === ep.id).flatMap(o => [o.c.workingRoot, o.c.runtimeRoot])
      .filter(r => isWithin(r, c.tmpRoot) || isWithin(c.tmpRoot, r))
    if (shared.length) {
      results[key] = `ignoré : la racine temporaire recouvre ${[...new Set(shared)].join(', ')} (à corriger dans l'onglet Chemins)`
      continue
    }
    const busy = await db().$count(
      schema.deployments,
      and(
        inArray(schema.deployments.status, [...ACTIVE_STATUSES]),
        inArray(schema.deployments.targetId, db().select({ id: schema.projectTargets.id }).from(schema.projectTargets).where(eq(schema.projectTargets.endpointId, ep.id))),
      ),
    )
    if (busy) {
      results[key] = 'reporté (déploiement en cours)'
      continue
    }
    try {
      const runner = await runnerFor(ep.id)
      const r = await runner.cleanup({ requestId: crypto.randomUUID(), actor: 'maintenance' }, { path: c.tmpRoot, olderThanSec: maxAgeSec })
      results[key] = `${formatBytes(r.removedBytes)} supprimés`
      if (r.removedBytes) {
        await audit({ actorLabel: 'system', action: 'files.cleanup_tmp', targetType: 'server_endpoint', targetId: ep.id, serverId: ep.serverId, environmentId: c.environmentId, outcome: 'success', details: { path: c.tmpRoot, removedBytes: r.removedBytes } })
      }
    }
    catch (err) {
      results[key] = `échec : ${err instanceof Error ? err.message : err}`
    }
  }
  return results
}
