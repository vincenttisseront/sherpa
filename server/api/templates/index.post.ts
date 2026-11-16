import { templateInput } from '../../../shared/schemas/templates'
import { db, schema } from '../../db/client'
import { deriveVariables, validateTemplateCompose } from '../../services/templates'
import { audit } from '../../utils/audit'
import { clientIp, requirePermission } from '../../utils/auth'
import { pgCode, readValidated, validationError } from '../../utils/validation'

defineRouteMeta({ openAPI: { tags: ['templates'], summary: 'Enregistre un Compose comme modèle de la plateforme (variables déduites des références ${NOM})' } })

export default defineEventHandler(async (event) => {
  const user = await requirePermission(event, 'source:import')
  const input = await readValidated(event, templateInput)
  const problem = validateTemplateCompose(input.compose)
  if (problem) throw validationError({ compose: problem })
  const [row] = await db().insert(schema.composeTemplates).values({ ...input, variables: deriveVariables(input.compose), createdBy: user.id }).returning({ id: schema.composeTemplates.id })
    .catch((err) => {
      if (pgCode(err) === '23505') throw validationError({ name: 'Un modèle porte déjà ce nom' })
      throw err
    })
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'template.create', targetType: 'template', targetId: row!.id, outcome: 'success', ip: clientIp(event), details: { name: input.name } })
  setResponseStatus(event, 201)
  return { id: row!.id }
})
