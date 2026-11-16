import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db, schema } from '../../../db/client'
import { audit } from '../../../utils/audit'
import { clientIp, requirePermission } from '../../../utils/auth'
import { idParam, readValidated } from '../../../utils/validation'
import { getTargetOr404, targetScope } from '../../../services/projects'

defineRouteMeta({ openAPI: { tags: ['targets'], summary: 'Retire un port publié du Compose déployé (accès par le reverse proxy uniquement) ou le publie de nouveau ; appliqué au prochain déploiement' } })

const input = z.object({
  service: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/),
  published: z.number().int().min(1).max(65535),
  protocol: z.enum(['tcp', 'udp']).default('tcp'),
  unpublished: z.boolean(),
})

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const t = await getTargetOr404(id)
  const user = await requirePermission(event, 'deployment:execute', targetScope(t))
  const { service, published, protocol, unpublished } = await readValidated(event, input)
  const o = t.target.composeOverrides ?? {}
  const same = (u: { service: string, published: number, protocol: string }) => u.service === service && u.published === published && u.protocol === protocol
  const next = [...(o.unpublishedPorts ?? []).filter(u => !same(u)), ...(unpublished ? [{ service, published, protocol, at: new Date().toISOString(), by: user.email }] : [])]
  await db().update(schema.projectTargets).set({ composeOverrides: { ...o, unpublishedPorts: next } }).where(eq(schema.projectTargets.id, id))
  await audit({ actorUserId: user.id, actorLabel: user.email, action: unpublished ? 'target.port_unpublished' : 'target.port_published', targetType: 'target', targetId: id, ...targetScope(t), outcome: 'success', ip: clientIp(event), details: { service, published, protocol } })
  return { unpublishedPorts: next.map(({ service, published, protocol }) => ({ service, published, protocol })) }
})
