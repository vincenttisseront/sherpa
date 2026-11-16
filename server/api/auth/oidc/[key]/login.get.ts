import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { startLogin } from '../../../../auth/oidc'
import { enforceRateLimit } from '../../../../auth/rate-limit'
import { db, schema } from '../../../../db/client'
import { clientIp } from '../../../../utils/auth'

defineRouteMeta({ openAPI: { tags: ['auth'], summary: 'Démarre la connexion SSO (redirection vers le fournisseur)' } })

export default defineEventHandler(async (event) => {
  await enforceRateLimit(event, `oidc:${clientIp(event)}`, 30, 60)
  const { key } = await getValidatedRouterParams(event, z.object({ key: z.string().regex(/^[a-z0-9-]{1,50}$/) }).parse)
  const { returnTo } = getQuery(event)
  const [idp] = await db().select().from(schema.identityProviders).where(and(eq(schema.identityProviders.key, key), eq(schema.identityProviders.enabled, true)))
  if (!idp) throw createError({ statusCode: 404, statusMessage: 'Fournisseur inconnu' })
  try {
    return sendRedirect(event, await startLogin(idp, String(returnTo ?? '/')), 302)
  }
  catch (err) {
    console.error(`OIDC ${key} indisponible :`, (err as Error).message)
    return sendRedirect(event, `/login?error=${encodeURIComponent('Fournisseur d\'identité injoignable')}`, 302)
  }
})
