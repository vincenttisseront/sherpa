import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { checkPasswordPolicy, hashPassword } from '../../auth/password'
import { enforceRateLimit } from '../../auth/rate-limit'
import { createSession } from '../../auth/sessions'
import { consumeSetupToken, setupRequired } from '../../auth/setup'
import { db, schema } from '../../db/client'
import { ensureReferenceData } from '../../db/reference-data'
import { audit } from '../../utils/audit'
import { clientIp } from '../../utils/auth'
import { readValidated, validationError } from '../../utils/validation'

defineRouteMeta({ openAPI: { tags: ['auth'], summary: 'Crée le premier administrateur (jeton d\'initialisation à usage unique)' } })

const body = z.object({ token: z.string().min(10).max(100), email: z.email().trim().toLowerCase(), displayName: z.string().trim().min(2).max(100), password: z.string().max(256) })

export default defineEventHandler(async (event) => {
  await enforceRateLimit(event, `setup:${clientIp(event)}`, 10, 15 * 60)
  if (!(await setupRequired())) throw createError({ statusCode: 409, statusMessage: 'La plateforme est déjà initialisée' })
  const input = await readValidated(event, body)
  const policy = checkPasswordPolicy(input.password, input.email)
  if (policy) throw validationError({ password: policy })
  if (!(await consumeSetupToken(input.token))) {
    await audit({ actorLabel: input.email, action: 'auth.setup', outcome: 'denied', ip: clientIp(event), details: { reason: 'bad_token' } })
    throw validationError({ token: 'Jeton d\'initialisation invalide ou déjà utilisé' })
  }
  // Filet de sécurité si migrate n'a pas encore posé les rôles intégrés.
  await ensureReferenceData()
  const user = await db().transaction(async (tx) => {
    const [u] = await tx.insert(schema.users).values({ email: input.email, displayName: input.displayName, kind: 'local', status: 'active', passwordHash: await hashPassword(input.password), passwordChangedAt: new Date() }).returning()
    const [admin] = await tx.select().from(schema.roles).where(eq(schema.roles.key, 'admin'))
    if (!admin) throw new Error('Rôle administrateur intégré introuvable')
    await tx.insert(schema.roleBindings).values({ roleId: admin.id, subjectType: 'user', subjectId: u!.id })
    return u!
  })
  await createSession(event, user.id)
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'auth.setup', outcome: 'success', ip: clientIp(event), details: { email: user.email } })
  setResponseStatus(event, 201)
  return { ok: true }
})
