import { asc, eq } from 'drizzle-orm'
import { redirectUri } from '../../../auth/oidc'
import { db, schema } from '../../../db/client'
import { requirePermission } from '../../../utils/auth'

defineRouteMeta({ openAPI: { tags: ['admin'], summary: 'Fournisseurs d\'identité OIDC (sans secret), URL de retour et mappings de groupes' } })

export default defineEventHandler(async (event) => {
  await requirePermission(event, 'user:manage')
  const idps = await db().select().from(schema.identityProviders).orderBy(asc(schema.identityProviders.name))
  const mappings = await db().select({ m: schema.idpGroupMappings, group: schema.groups.name }).from(schema.idpGroupMappings).innerJoin(schema.groups, eq(schema.groups.id, schema.idpGroupMappings.groupId))
  return idps.map(i => ({
    id: i.id, key: i.key, kind: i.kind, name: i.name, issuerUrl: i.issuerUrl, clientId: i.clientId, hasSecret: !!i.clientSecretId,
    scopes: i.scopes, groupsClaim: i.groupsClaim, requireMappedGroup: i.requireMappedGroup, allowedEmailDomains: i.allowedEmailDomains, enabled: i.enabled,
    redirectUri: redirectUri(i),
    mappings: mappings.filter(m => m.m.idpId === i.id).map(m => ({ externalGroup: m.m.externalGroup, groupId: m.m.groupId, group: m.group })),
  }))
})
