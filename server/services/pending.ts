/**
 * Actions en attente sur une cible : jamais closes sur déclaration. La plateforme
 * vérifie elle-même la condition (variable renseignée après la création de
 * l'action, déploiement réussi ensuite) et lève l'action quand elle est remplie.
 * Chaque action porte un lien direct vers le champ à renseigner.
 */
import { and, desc, eq, gt, ilike, inArray, isNull, sql } from 'drizzle-orm'
import type { PendingAction, PendingCheck, PendingStatus } from '../../shared/schemas/projects'
import { db, schema } from '../db/client'
import { audit } from '../utils/audit'
import { targetVariables } from './projects'

const fmt = (iso: string) => new Date(iso).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'short', timeStyle: 'short' })

interface TargetLite {
  id: string
  projectId: string
  envSecretId: string | null
  pendingAction: PendingAction | null
  variablesMeta: Record<string, { updatedAt: string }>
}

/** Formulaire où se fait la saisie. Harbor : le générateur, sur l'installateur importé s'il est encore disponible. */
async function linkFor(t: TargetLite, check: PendingCheck): Promise<string> {
  const base = `/projects/${t.projectId}`
  if (check.kind === 'deployed') return `${base}?deploy=1`
  if (check.via === 'harbor-generator') {
    const ae = schema.auditEvents
    const [installer] = await db().select({ id: schema.uploads.id }).from(schema.uploads)
      .innerJoin(ae, and(sql`${ae.targetId} = ${schema.uploads.id}::text`, eq(ae.action, 'upload.create')))
      .where(and(eq(ae.projectId, t.projectId), isNull(schema.uploads.consumedAt), ilike(schema.uploads.originalName, 'harbor-online-installer-%')))
      .orderBy(desc(schema.uploads.createdAt)).limit(1)
    return installer ? `${base}?deploy=1&upload=${installer.id}&focus=adminPassword` : `${base}?deploy=1&archive=release`
  }
  return `${base}?tab=variables&focus=${encodeURIComponent(check.name)}`
}

/**
 * Décision pure : la condition est-elle remplie ? `deployedAfter(t)` dit si un déploiement
 * réussi a eu lieu après l'instant t ; `changedAt` est la date de dernière modification de la variable.
 */
export async function decidePending(action: PendingAction, v: { changedAt: string | null, hasValue: boolean }, deployedAfter: (since: string) => Promise<boolean>): Promise<{ done: boolean, missing: string | null }> {
  const check: PendingCheck = action.check ?? { kind: 'deployed' }
  if (check.kind === 'deployed') {
    return (await deployedAfter(action.at)) ? { done: true, missing: null } : { done: false, missing: `Aucun déploiement réussi depuis le ${fmt(action.at)}` }
  }
  if (!v.hasValue || !v.changedAt || v.changedAt <= action.at) return { done: false, missing: `${check.name} n'a pas reçu de nouvelle valeur depuis le ${fmt(action.at)}` }
  if (check.kind === 'variable-deployed' && !(await deployedAfter(v.changedAt))) return { done: false, missing: `${check.name} renseignée le ${fmt(v.changedAt)} : déploiement réussi à faire ensuite` }
  return { done: true, missing: null }
}

/** Condition vérifiée sur les données de la plateforme (variables, déploiements), jamais sur une déclaration. */
export async function evaluatePending(t: TargetLite): Promise<PendingStatus | null> {
  const action = t.pendingAction
  if (!action) return null
  const check: PendingCheck = action.check ?? { kind: 'deployed' }
  const link = await linkFor(t, check)
  const deployedAfter = async (since: string) => {
    const [d] = await db().select({ id: schema.deployments.id }).from(schema.deployments)
      .where(and(eq(schema.deployments.targetId, t.id), eq(schema.deployments.status, 'HEALTHY'), gt(schema.deployments.createdAt, new Date(since)), inArray(schema.deployments.action, ['deploy', 'redeploy', 'rollback'])))
      .limit(1)
    return !!d
  }
  const name = check.kind === 'deployed' ? null : check.name
  const v = name ? { changedAt: t.variablesMeta[name]?.updatedAt ?? null, hasValue: !!(await targetVariables(t))[name]?.value } : { changedAt: null, hasValue: false }
  return { ...(await decidePending(action, v, deployedAfter)), link }
}

/** Vérifie et lève l'action si elle est faite (journalisé). Renvoie l'état avant levée. */
export async function resolvePending(targetId: string, actor = 'system'): Promise<PendingStatus | null> {
  const [t] = await db().select().from(schema.projectTargets).where(eq(schema.projectTargets.id, targetId))
  if (!t?.pendingAction) return null
  const status = await evaluatePending(t)
  if (status?.done) {
    await db().update(schema.projectTargets).set({ pendingAction: null }).where(eq(schema.projectTargets.id, targetId))
    await audit({ actorUserId: null, actorLabel: actor, action: 'target.pending.resolved', targetType: 'project_target', targetId, projectId: t.projectId, outcome: 'success', details: { title: t.pendingAction.title, check: t.pendingAction.check ?? { kind: 'deployed' } } })
  }
  return status
}
