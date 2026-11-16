import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db, schema } from '../../../db/client'
import { audit } from '../../../utils/audit'
import { clientIp, requirePermission } from '../../../utils/auth'
import { idParam, readValidated } from '../../../utils/validation'
import { getTargetOr404, targetScope } from '../../../services/projects'

defineRouteMeta({ openAPI: { tags: ['targets'], summary: 'Marque un service comme non géré par la console (retiré de la stack, conteneur conservé hors de la stack) ou le réintègre' } })

const input = z.object({ service: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/), excluded: z.boolean() })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const t = await getTargetOr404(id)
  const user = await requirePermission(event, 'deployment:execute', targetScope(t))
  const { service, excluded } = await readValidated(event, input)
  const o = t.target.composeOverrides ?? {}
  const next = Object.fromEntries(Object.entries(o.excludedServices ?? {}).filter(([k]) => k !== service))
  if (excluded) next[service] = { at: new Date().toISOString(), by: user.email }
  await db().update(schema.projectTargets).set({ composeOverrides: { ...o, excludedServices: next } }).where(eq(schema.projectTargets.id, id))
  await audit({ actorUserId: user.id, actorLabel: user.email, action: excluded ? 'target.service_excluded' : 'target.service_included', targetType: 'target', targetId: id, ...targetScope(t), outcome: 'success', ip: clientIp(event), details: { service } })
  return { excluded: Object.keys(next) }
})
