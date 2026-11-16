import { requirePermission } from '../../../utils/auth'
import { listGithubConnectors } from '../../../services/github-connectors'

defineRouteMeta({ openAPI: { tags: ['admin'], summary: 'Connecteurs GitHub (packages, artefacts Actions) et nombre d\'alertes' } })

export default defineEventHandler(async (event) => {
  await requirePermission(event, 'policy:manage')
  return listGithubConnectors()
})
