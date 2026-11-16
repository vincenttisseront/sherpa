import { githubConnectorInput } from '../../../../shared/schemas/github-connector'
import { audit } from '../../../utils/audit'
import { clientIp, requirePermission } from '../../../utils/auth'
import { idParam, readValidated } from '../../../utils/validation'
import { updateGithubConnector } from '../../../services/github-connectors'

defineRouteMeta({ openAPI: { tags: ['admin'], summary: 'Modifie un connecteur GitHub (jeton remplacé s\'il est fourni)' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const user = await requirePermission(event, 'policy:manage')
  const input = await readValidated(event, githubConnectorInput.partial())
  const connector = await updateGithubConnector(id, input)
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'github_connector.update', targetType: 'github_connector', targetId: id, outcome: 'success', ip: clientIp(event), details: { ...input, token: input.token ? 'remplacé' : undefined } })
  return connector
})
