import { projectRemovalInput } from '../../../../shared/schemas/project-removal'
import { audit } from '../../../utils/audit'
import { clientIp, requirePermission } from '../../../utils/auth'
import { idParam, readValidated, validationError } from '../../../utils/validation'
import { deleteProjectDefinitively, detachProject, removalPlan } from '../../../services/project-removal'

defineRouteMeta({ openAPI: { tags: ['projects'], summary: 'Supprime définitivement le projet (stacks comprises) ou le détache de la plateforme en laissant tout tourner' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const input = await readValidated(event, projectRemovalInput)
  const plan = await removalPlan(id)
  // Les deux voies retirent le projet de la plateforme : modification du projet et suppression de ses déploiements.
  await requirePermission(event, 'project:update', { projectId: id })
  const user = await requirePermission(event, 'deployment:delete', { projectId: id })
  if (input.confirm !== plan.slug) throw validationError({ confirm: `Saisir l'identifiant du projet (${plan.slug}) pour confirmer` })
  const base = { actorUserId: user.id, actorLabel: user.email, targetType: 'project', targetId: id, projectId: id, ip: clientIp(event) }
  if (input.mode === 'detach') {
    const r = await detachProject(id, { stopWatchtower: input.stopWatchtower })
    await audit({ ...base, action: 'project.detach', outcome: 'success', details: { slug: plan.slug, targets: r.targets, watchtowerStopped: r.watchtowerStopped } })
    return { mode: 'detach', removed: true, ...r }
  }
  const r = await deleteProjectDefinitively(id, user.id, crypto.randomUUID())
  await audit({ ...base, action: r.removed ? 'project.delete' : 'project.delete_requested', outcome: 'success', details: { slug: plan.slug, stacks: plan.targets.filter(t => t.stack).map(t => t.stack), deployments: r.deploymentIds } })
  return { mode: 'delete', ...r }
})
