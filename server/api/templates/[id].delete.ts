import { eq } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import { audit } from '../../utils/audit'
import { canOn, clientIp, requireUser } from '../../utils/auth'
import { idParam } from '../../utils/validation'

defineRouteMeta({ openAPI: { tags: ['templates'], summary: 'Supprime un modèle de la plateforme (son auteur ou un administrateur des politiques ; les modèles fournis sont intouchables)' } })

export default defineEventHandler(async (event) => {
  const user = requireUser(event)
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const [t] = await db().select().from(schema.composeTemplates).where(eq(schema.composeTemplates.id, id))
  if (!t) throw createError({ statusCode: 404, statusMessage: 'Modèle introuvable' })
  if (t.createdBy !== user.id && !canOn(user, 'policy:manage', {})) throw createError({ statusCode: 403, statusMessage: 'Seul l\'auteur du modèle ou un administrateur peut le supprimer' })
  await db().delete(schema.composeTemplates).where(eq(schema.composeTemplates.id, id))
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'template.delete', targetType: 'template', targetId: id, outcome: 'success', ip: clientIp(event), details: { name: t.name } })
  return { ok: true }
})
