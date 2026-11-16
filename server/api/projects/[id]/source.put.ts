import { sourceInput } from '../../../../shared/schemas/projects'
import { audit } from '../../../utils/audit'
import { clientIp, requirePermission } from '../../../utils/auth'
import { idParam, readValidated, validationError } from '../../../utils/validation'
import { validateRelativeEntry } from '../../../utils/path-guard'
import { getProjectSource, saveProjectSource, toSourceDto } from '../../../services/sources'

defineRouteMeta({ openAPI: { tags: ['projects'], summary: 'Configure la source du projet ; le token GitHub est chiffré et jamais renvoyé' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const user = await requirePermission(event, 'project:update', { projectId: id })
  const input = await readValidated(event, sourceInput)
  try {
    if (input.subdirectory) validateRelativeEntry(input.subdirectory)
    validateRelativeEntry(input.composePath)
  }
  catch {
    throw validationError({ subdirectory: 'Chemin relatif sans « .. » attendu' })
  }
  await saveProjectSource(id, input)
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'project.source', targetType: 'project', targetId: id, projectId: id, outcome: 'success', ip: clientIp(event), details: { ...input, token: input.token === undefined ? 'inchangé' : input.token === null ? 'supprimé' : 'remplacé' } })
  return toSourceDto(await getProjectSource(id))
})
