import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { OidcLoginError, finishLogin, provisionUser } from '../../../../auth/oidc'
import { createSession } from '../../../../auth/sessions'
import { db, schema } from '../../../../db/client'
import { audit } from '../../../../utils/audit'
import { clientIp } from '../../../../utils/auth'
import { env } from '../../../../utils/env'

defineRouteMeta({ openAPI: { tags: ['auth'], summary: 'Retour du fournisseur SSO : validation, provisionnement, session' } })

export default defineEventHandler(async (event) => {
  const { key } = await getValidatedRouterParams(event, z.object({ key: z.string().regex(/^[a-z0-9-]{1,50}$/) }).parse)
  const [idp] = await db().select().from(schema.identityProviders).where(and(eq(schema.identityProviders.key, key), eq(schema.identityProviders.enabled, true)))
  if (!idp) throw createError({ statusCode: 404, statusMessage: 'Fournisseur inconnu' })
  // L'URL de retour est reconstruite sur l'URL publique déclarée (et non sur l'en-tête Host).
  const callbackUrl = new URL(`${env().APP_URL}${getRequestURL(event).pathname}${getRequestURL(event).search}`)
  let email = 'inconnu'
  try {
    const { identity, returnTo } = await finishLogin(idp, callbackUrl)
    email = identity.email
    const user = await provisionUser(idp, identity)
    await createSession(event, user.id, idp.id)
    await audit({ actorUserId: user.id, actorLabel: user.email, action: 'auth.login', outcome: 'success', ip: clientIp(event), details: { method: 'oidc', idp: idp.key, groups: identity.groups } })
    return sendRedirect(event, returnTo, 302)
  }
  catch (err) {
    const message = err instanceof OidcLoginError ? err.message : 'Connexion SSO impossible'
    if (!(err instanceof OidcLoginError)) console.error(`OIDC ${key} :`, err)
    await audit({ actorLabel: email, action: 'auth.login', outcome: err instanceof OidcLoginError && err.reason !== 'state' ? 'denied' : 'failure', ip: clientIp(event), details: { method: 'oidc', idp: idp.key, reason: err instanceof OidcLoginError ? err.reason : 'internal', message } })
    return sendRedirect(event, `/login?error=${encodeURIComponent(message)}`, 302)
  }
})
