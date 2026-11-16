import { githubConnectorInput } from '../../../../shared/schemas/github-connector'
import { audit } from '../../../utils/audit'
import { clientIp, requirePermission } from '../../../utils/auth'
import { readValidated } from '../../../utils/validation'
import { createGithubConnector, scanGithubConnector } from '../../../services/github-connectors'

defineRouteMeta({ openAPI: { tags: ['admin'], summary: 'Ajoute un connecteur GitHub (compte vérifié avec le jeton, chiffré) et fait un premier relevé' } })

export default defineEventHandler(async (event) => {
  const user = await requirePermission(event, 'policy:manage')
  const input = await readValidated(event, githubConnectorInput)
  const connector = await createGithubConnector(input, user.id)
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'github_connector.create', targetType: 'github_connector', targetId: connector.id, outcome: 'success', ip: clientIp(event), details: { name: connector.name, owner: connector.owner, apiUrl: connector.apiUrl, repositories: connector.repositories } })
  await scanGithubConnector(connector.id).catch(() => null)
  setResponseStatus(event, 201)
  return connector
})
