import { eq } from 'drizzle-orm'
import { sshCredentialsRotation } from '../../../../shared/schemas/servers'
import { portainer } from '../../../adapters/portainer'
import { db, schema } from '../../../db/client'
import { audit } from '../../../utils/audit'
import { clientIp, requirePermission } from '../../../utils/auth'
import { encryptSecret } from '../../../utils/crypto'
import { idParam, readValidated, validationError } from '../../../utils/validation'
import { connectionFor, encodeSshSecret, getServerOr404, portainerErrorMessage, sshSecretFromInput } from '../../../services/servers'

defineRouteMeta({ openAPI: { tags: ['servers'], summary: 'Remplace les identifiants SSH (mot de passe ou clé), testés avant enregistrement ; ancien secret détruit' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const user = await requirePermission(event, 'server:manage', { serverId: id })
  const input = await readValidated(event, sshCredentialsRotation)
  const server = await getServerOr404(id)
  if (server.transport !== 'ssh') throw createError({ statusCode: 409, statusMessage: 'Serveur joint par un agent : remplacer son AGENT_SECRET' })

  const secret = sshSecretFromInput(input)
  const current = await connectionFor(server)
  try {
    const v = await portainer().getVersion({ ...current, ssh: { ...current.ssh!, password: undefined, privateKey: undefined, passphrase: undefined, ...secret } })
    if (!v.supported) throw new Error(`${v.version} non supporté`)
  }
  catch (err) {
    await audit({ actorUserId: user.id, actorLabel: user.email, action: 'server.ssh_credentials_rotate', targetType: 'portainer_server', targetId: id, serverId: id, outcome: 'failure', ip: clientIp(event), details: { auth: input.auth, error: portainerErrorMessage(err) } })
    throw validationError({ [input.auth === 'key' ? 'privateKey' : 'password']: portainerErrorMessage(err) }, 'Les nouveaux identifiants ne fonctionnent pas')
  }

  await db().transaction(async (tx) => {
    const { envelope, keyId } = encryptSecret(encodeSshSecret(secret))
    const [row] = await tx.insert(schema.secrets).values({ purpose: 'ssh_credentials', envelope, keyId }).returning({ id: schema.secrets.id })
    await tx.update(schema.portainerServers).set({ tokenSecretId: row!.id, sshAuth: input.auth, status: 'online', lastError: null, lastCheckedAt: new Date() }).where(eq(schema.portainerServers.id, id))
    await tx.delete(schema.secrets).where(eq(schema.secrets.id, server.tokenSecretId))
  })
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'server.ssh_credentials_rotate', targetType: 'portainer_server', targetId: id, serverId: id, outcome: 'success', ip: clientIp(event), details: { auth: input.auth } })
  setResponseStatus(event, 204)
  return null
})
