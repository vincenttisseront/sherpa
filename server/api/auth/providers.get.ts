import { asc, eq } from 'drizzle-orm'
import { db, schema } from '../../db/client'

defineRouteMeta({ openAPI: { tags: ['auth'], summary: 'Fournisseurs SSO actifs (page de connexion)' } })

export default defineEventHandler(async () => {
  return db().select({ key: schema.identityProviders.key, name: schema.identityProviders.name, kind: schema.identityProviders.kind })
    .from(schema.identityProviders).where(eq(schema.identityProviders.enabled, true)).orderBy(asc(schema.identityProviders.name))
})
