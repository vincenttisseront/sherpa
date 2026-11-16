import { eq } from 'drizzle-orm'
import { runnerConfigInput } from '../../../../shared/schemas/infra'
import { db, schema } from '../../../db/client'
import { audit } from '../../../utils/audit'
import { clientIp, requirePermission } from '../../../utils/auth'
import { env } from '../../../utils/env'
import { idParam, readValidated, validationError } from '../../../utils/validation'
import { getRunnerRow, keyFingerprintOf, newHmacKey, toRunnerDto } from '../../../services/runner-admin'
import { getEndpointOr404 } from '../../../services/servers'

defineRouteMeta({ openAPI: { tags: ['runner'], summary: 'Enregistre le Runner ; à la création, renvoie UNE fois la clé HMAC à installer sur l\'hôte' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const ep = await getEndpointOr404(id)
  const user = await requirePermission(event, 'server:manage', { serverId: ep.serverId })
  const input = await readValidated(event, runnerConfigInput)
  if (input.url.startsWith('http:') && env().NODE_ENV === 'production') throw validationError({ url: 'HTTPS (mTLS) obligatoire en production' })

  const existing = await getRunnerRow(id)
  let hmacKey: string | null = null
  await db().transaction(async (tx) => {
    if (existing) {
      await tx.update(schema.targetRunners).set({ ...input, status: 'unconfigured', lastError: null }).where(eq(schema.targetRunners.id, existing.id))
      return
    }
    const k = newHmacKey()
    hmacKey = k.plain
    const [secret] = await tx.insert(schema.secrets).values({ purpose: 'runner_hmac', envelope: k.envelope, keyId: k.keyId }).returning({ id: schema.secrets.id })
    await tx.insert(schema.targetRunners).values({ ...input, endpointId: id, authSecretId: secret!.id, allowedActions: [] })
  })

  await audit({
    actorUserId: user.id, actorLabel: user.email, action: existing ? 'runner.update' : 'runner.create', targetType: 'server_endpoint', targetId: id, serverId: ep.serverId,
    outcome: 'success', ip: clientIp(event), details: { url: input.url, serverName: input.serverName, customCa: !!input.caCertPem, ...(hmacKey ? { keyFingerprint: keyFingerprintOf(hmacKey) } : {}) },
  })
  return { runner: await toRunnerDto(id), hmacKey }
})
