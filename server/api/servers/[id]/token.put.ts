import { eq } from 'drizzle-orm'
import { tokenRotation } from '../../../../shared/schemas/servers'
import { portainer } from '../../../adapters/portainer'
import { db, schema } from '../../../db/client'
import { audit } from '../../../utils/audit'
import { clientIp, requirePermission } from '../../../utils/auth'
import { encryptSecret } from '../../../utils/crypto'
import { idParam, readValidated, validationError } from '../../../utils/validation'
import { getServerOr404, portainerErrorMessage } from '../../../services/servers'

defineRouteMeta({ openAPI: { tags: ['servers'], summary: 'Remplace le token (testé avant enregistrement, ancien secret détruit)' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const user = await requirePermission(event, 'server:manage', { serverId: id })
  const { token } = await readValidated(event, tokenRotation)
  const server = await getServerOr404(id)
  if (server.transport === 'ssh') throw createError({ statusCode: 409, statusMessage: 'Serveur joint en SSH : remplacer ses identifiants SSH' })

  try {
    const v = await portainer().getVersion({ url: server.url, token, tlsVerify: server.tlsVerify, caCertPem: server.caCertPem })
    if (!v.supported) throw new Error(`Agent Portainer ${v.version} non supporté`)
  }
  catch (err) {
    await audit({ actorUserId: user.id, actorLabel: user.email, action: 'server.token_rotate', targetType: 'portainer_server', targetId: id, serverId: id, outcome: 'failure', ip: clientIp(event), details: { error: portainerErrorMessage(err) } })
    throw validationError({ token: portainerErrorMessage(err) }, 'Le nouveau token ne fonctionne pas')
  }

  await db().transaction(async (tx) => {
    const { envelope, keyId } = encryptSecret(token)
    const [secret] = await tx.insert(schema.secrets).values({ purpose: 'portainer_token', envelope, keyId }).returning({ id: schema.secrets.id })
    await tx.update(schema.portainerServers).set({ tokenSecretId: secret!.id, status: 'online', lastError: null, lastCheckedAt: new Date() }).where(eq(schema.portainerServers.id, id))
    await tx.delete(schema.secrets).where(eq(schema.secrets.id, server.tokenSecretId))
  })

  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'server.token_rotate', targetType: 'portainer_server', targetId: id, serverId: id, outcome: 'success', ip: clientIp(event) })
  setResponseStatus(event, 204)
  return null
})
