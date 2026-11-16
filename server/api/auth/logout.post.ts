import { eq } from 'drizzle-orm'
import { endSessionUrl } from '../../auth/oidc'
import { clearSessionCookie, revokeSession } from '../../auth/sessions'
import { db, schema } from '../../db/client'
import { audit } from '../../utils/audit'
import { clientIp } from '../../utils/auth'

defineRouteMeta({ openAPI: { tags: ['auth'], summary: 'Déconnexion (révocation de la session, et URL de déconnexion du fournisseur SSO)' } })

export default defineEventHandler(async (event) => {
  const s = event.context.session
  const u = event.context.user
  let redirect: string | null = null
  if (s) {
    await revokeSession(s.id)
    if (s.idpId) {
      const [idp] = await db().select().from(schema.identityProviders).where(eq(schema.identityProviders.id, s.idpId))
      if (idp) redirect = await endSessionUrl(idp)
    }
    await audit({ actorUserId: u?.id ?? null, actorLabel: u?.email ?? 'inconnu', action: 'auth.logout', outcome: 'success', ip: clientIp(event) })
  }
  clearSessionCookie(event)
  return { ok: true, redirect }
})
