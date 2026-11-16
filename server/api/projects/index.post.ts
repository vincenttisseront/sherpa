import { projectWithTargetInput } from '../../../shared/schemas/projects'
import { db, schema } from '../../db/client'
import { audit } from '../../utils/audit'
import { clientIp, requireAnyPermission, requirePermission } from '../../utils/auth'
import { pgCode, readValidated, validationError } from '../../utils/validation'
import { checkTarget, insertTarget, resolveTarget } from '../../services/targets'

defineRouteMeta({ openAPI: { tags: ['projects'], summary: 'Crée un projet, avec sa première cible le cas échéant (transaction unique)' } })

export default defineEventHandler(async (event) => {
  const user = await requireAnyPermission(event, 'project:create')
  const { target, ...input } = await readValidated(event, projectWithTargetInput)
  // Cible contrôlée AVANT toute écriture : rien n'est créé si elle est refusée.
  const resolved = target ? await resolveTarget(target) : null
  if (target && resolved) {
    await requirePermission(event, 'project:update', { environmentId: resolved.environmentId, serverId: resolved.ep.serverId })
    await checkTarget(target, { ...resolved, projectSlug: input.slug })
  }
  const { projectId, targetId } = await db().transaction(async (tx) => {
    const [p] = await tx.insert(schema.projects).values({ ...input, ownerUserId: user.id }).returning({ id: schema.projects.id })
    const targetId = target && resolved ? await insertTarget(tx, p!.id, input.slug, target, resolved.environmentId, user.id) : null
    return { projectId: p!.id, targetId }
  }).catch((err) => {
    if (pgCode(err) === '23505') throw validationError({ slug: 'Identifiant déjà utilisé' })
    throw err
  })
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'project.create', targetType: 'project', targetId: projectId, projectId, outcome: 'success', ip: clientIp(event), details: input })
  if (target && resolved && targetId) {
    await audit({ actorUserId: user.id, actorLabel: user.email, action: 'target.create', targetType: 'project_target', targetId, projectId, environmentId: resolved.environmentId, serverId: resolved.ep.serverId, outcome: 'success', ip: clientIp(event), details: { endpoint: resolved.ep.name, environment: target.environmentKey, projectPath: target.projectPath, volumesAsFolders: target.volumesAsFolders, proxyNetwork: target.proxyNetwork } })
  }
  setResponseStatus(event, 201)
  return { id: projectId, targetId }
})
