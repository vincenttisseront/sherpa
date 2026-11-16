import { scanHostKey } from '../../../adapters/ssh/session'
import { requirePermission } from '../../../utils/auth'
import { idParam } from '../../../utils/validation'
import { getServerOr404, portainerErrorMessage } from '../../../services/servers'

defineRouteMeta({ openAPI: { tags: ['servers'], summary: 'Clé d\'hôte SSH présentée maintenant par le serveur, comparée à l\'empreinte confirmée' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  await requirePermission(event, 'server:manage', { serverId: id })
  const server = await getServerOr404(id)
  if (server.transport !== 'ssh' || !server.sshHost) throw createError({ statusCode: 409, statusMessage: 'Ce serveur n\'est pas joint en SSH' })
  try {
    const p = await scanHostKey(server.sshHost, server.sshPort ?? 22)
    return { ...p, confirmed: server.sshHostKey, matches: p.fingerprint === server.sshHostKey }
  }
  catch (err) {
    throw createError({ statusCode: 422, statusMessage: portainerErrorMessage(err) })
  }
})
