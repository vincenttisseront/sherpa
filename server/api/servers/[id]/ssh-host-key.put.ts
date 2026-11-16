import { eq } from 'drizzle-orm'
import { sshHostKeyConfirm } from '../../../../shared/schemas/servers'
import { scanHostKey } from '../../../adapters/ssh/session'
import { db, schema } from '../../../db/client'
import { audit } from '../../../utils/audit'
import { clientIp, requirePermission } from '../../../utils/auth'
import { idParam, readValidated, validationError } from '../../../utils/validation'
import { getServerOr404, portainerErrorMessage } from '../../../services/servers'

defineRouteMeta({ openAPI: { tags: ['servers'], summary: 'Confirme une nouvelle empreinte de clé d\'hôte SSH (hôte réinstallé, clé régénérée) : elle doit être celle présentée maintenant' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const user = await requirePermission(event, 'server:manage', { serverId: id })
  const { hostKey } = await readValidated(event, sshHostKeyConfirm)
  const server = await getServerOr404(id)
  if (server.transport !== 'ssh' || !server.sshHost) throw createError({ statusCode: 409, statusMessage: 'Ce serveur n\'est pas joint en SSH' })

  // L'empreinte confirmée doit être celle que l'hôte présente maintenant (pas de saisie à l'aveugle).
  let presented
  try {
    presented = await scanHostKey(server.sshHost, server.sshPort ?? 22)
  }
  catch (err) {
    throw validationError({ hostKey: portainerErrorMessage(err) }, 'Clé d\'hôte illisible')
  }
  if (presented.fingerprint !== hostKey) throw validationError({ hostKey: `L'hôte présente ${presented.fingerprint}, pas l'empreinte confirmée` }, 'Empreinte différente de celle présentée')

  await db().update(schema.portainerServers).set({ sshHostKey: hostKey, sshHostKeyType: presented.keyType }).where(eq(schema.portainerServers.id, id))
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'server.ssh_host_key_confirm', targetType: 'portainer_server', targetId: id, serverId: id, outcome: 'success', ip: clientIp(event), details: { from: server.sshHostKey, to: hostKey, keyType: presented.keyType } })
  return { hostKey, keyType: presented.keyType }
})
