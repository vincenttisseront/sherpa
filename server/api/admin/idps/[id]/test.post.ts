import { eq } from 'drizzle-orm'
import { forgetConfig, oidcConfig } from '../../../../auth/oidc'
import { db, schema } from '../../../../db/client'
import { requirePermission } from '../../../../utils/auth'
import { idParam } from '../../../../utils/validation'

defineRouteMeta({ openAPI: { tags: ['admin'], summary: 'Teste la découverte OIDC du fournisseur' } })

export default defineEventHandler(async (event) => {
  await requirePermission(event, 'user:manage')
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const [idp] = await db().select().from(schema.identityProviders).where(eq(schema.identityProviders.id, id))
  if (!idp) throw createError({ statusCode: 404, statusMessage: 'Fournisseur introuvable' })
  forgetConfig(id)
  try {
    const m = (await oidcConfig(idp)).serverMetadata()
    return { ok: true, issuer: m.issuer, authorizationEndpoint: m.authorization_endpoint, endSession: !!m.end_session_endpoint, pkce: (m.code_challenge_methods_supported ?? []).includes('S256'), scopesSupported: m.scopes_supported ?? [] }
  }
  catch (err) {
    return { ok: false, error: (err as Error).message }
  }
})
