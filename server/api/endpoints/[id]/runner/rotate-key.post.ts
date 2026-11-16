import { eq } from 'drizzle-orm'
import { db, schema } from '../../../../db/client'
import { audit } from '../../../../utils/audit'
import { clientIp, requirePermission } from '../../../../utils/auth'
import { idParam } from '../../../../utils/validation'
import { getRunnerRow, keyFingerprintOf, newHmacKey } from '../../../../services/runner-admin'
import { getEndpointOr404 } from '../../../../services/servers'

defineRouteMeta({ openAPI: { tags: ['runner'], summary: 'Génère une nouvelle clé HMAC (renvoyée une seule fois) ; l\'ancienne est détruite' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const ep = await getEndpointOr404(id)
  const user = await requirePermission(event, 'server:manage', { serverId: ep.serverId })
  const row = await getRunnerRow(id)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Aucun Runner configuré' })

  const k = newHmacKey()
  await db().transaction(async (tx) => {
    const [secret] = await tx.insert(schema.secrets).values({ purpose: 'runner_hmac', envelope: k.envelope, keyId: k.keyId }).returning({ id: schema.secrets.id })
    await tx.update(schema.targetRunners).set({ authSecretId: secret!.id, status: 'unconfigured', lastError: 'Nouvelle clé : à installer sur l\'hôte puis redémarrer le Runner' }).where(eq(schema.targetRunners.id, row.id))
    if (row.authSecretId) await tx.delete(schema.secrets).where(eq(schema.secrets.id, row.authSecretId))
  })
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'runner.rotate_key', targetType: 'server_endpoint', targetId: id, serverId: ep.serverId, outcome: 'success', ip: clientIp(event), details: { keyFingerprint: keyFingerprintOf(k.plain) } })
  return { hmacKey: k.plain, keyFingerprint: keyFingerprintOf(k.plain) }
})
