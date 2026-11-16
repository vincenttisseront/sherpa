import { audit } from '../../../utils/audit'
import { clientIp, requirePermission } from '../../../utils/auth'
import { idParam } from '../../../utils/validation'
import { removeGithubConnector } from '../../../services/github-connectors'

defineRouteMeta({ openAPI: { tags: ['admin'], summary: 'Supprime un connecteur GitHub et son jeton' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const user = await requirePermission(event, 'policy:manage')
  const r = await removeGithubConnector(id)
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'github_connector.delete', targetType: 'github_connector', targetId: id, outcome: 'success', ip: clientIp(event), details: r })
  setResponseStatus(event, 204)
  return null
})
