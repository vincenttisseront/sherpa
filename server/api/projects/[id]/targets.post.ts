import { eq } from 'drizzle-orm'
import { targetCreateInput } from '../../../../shared/schemas/projects'
import { db, schema } from '../../../db/client'
import { audit } from '../../../utils/audit'
import { clientIp, requirePermission } from '../../../utils/auth'
import { idParam, pgCode, readValidated, validationError } from '../../../utils/validation'
import { checkTarget, insertTarget, resolveTarget } from '../../../services/targets'

defineRouteMeta({ openAPI: { tags: ['projects'], summary: 'Ajoute une cible (endpoint × environnement, placement sur l\'hôte, réseau du reverse proxy) au projet' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const input = await readValidated(event, targetCreateInput)
  const { ep, environmentId } = await resolveTarget(input)
  const user = await requirePermission(event, 'project:update', { projectId: id, environmentId, serverId: ep.serverId })
  const [project] = await db().select().from(schema.projects).where(eq(schema.projects.id, id))
  if (!project) throw createError({ statusCode: 404, statusMessage: 'Projet introuvable' })
  await checkTarget(input, { ep, environmentId, projectSlug: project.slug, projectId: id })
  const targetId = await db().transaction(tx => insertTarget(tx, id, project.slug, input, environmentId, user.id)).catch((err) => {
    if (pgCode(err) === '23505') throw validationError({ environmentKey: 'Cible déjà existante' })
    throw err
  })
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'target.create', targetType: 'project_target', targetId, projectId: id, environmentId, serverId: ep.serverId, outcome: 'success', ip: clientIp(event), details: { endpoint: ep.name, environment: input.environmentKey, projectPath: input.projectPath, volumesAsFolders: input.volumesAsFolders, proxyNetwork: input.proxyNetwork } })
  setResponseStatus(event, 201)
  return { id: targetId }
})
