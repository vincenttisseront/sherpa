import { requestProgress } from '../../utils/progress'
import type { DiscoveryPreview } from '../../../shared/schemas/infra'
import { serverConnectionInput } from '../../../shared/schemas/servers'
import { portainer } from '../../adapters/portainer'
import { requirePermission } from '../../utils/auth'
import { discoverServer } from '../../services/discovery'
import { connectionFromInput, portainerErrorMessage } from '../../services/servers'
import { readValidated } from '../../utils/validation'

defineRouteMeta({ openAPI: { tags: ['servers'], summary: 'Découverte sans enregistrement (assistant) : endpoints, réseaux, volumes, inventaire' } })

export default defineEventHandler(async (event): Promise<DiscoveryPreview> => {
  await requirePermission(event, 'server:manage')
  const input = await readValidated(event, serverConnectionInput)
  try {
    return await discoverServer(portainer(), connectionFromInput(input), requestProgress(event))
  }
  catch (err) {
    throw createError({ statusCode: 422, statusMessage: portainerErrorMessage(err) })
  }
})
