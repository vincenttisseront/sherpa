/**
 * Données de référence idempotentes : environnements et rôles intégrés.
 * Appliquées par `migrate` à chaque démarrage (les permissions des rôles intégrés
 * suivent ainsi les nouvelles versions) et, par sécurité, par l'initialisation.
 */
import { sql } from 'drizzle-orm'
import { BUILTIN_ROLES } from '../../shared/utils/permissions'
import { db, schema } from './client'

const ENVIRONMENTS = [
  { key: 'dev', name: 'Développement', sortOrder: 1, isProduction: false },
  { key: 'staging', name: 'Staging', sortOrder: 2, isProduction: false },
  { key: 'production', name: 'Production', sortOrder: 3, isProduction: true },
] as const

export async function ensureReferenceData(): Promise<void> {
  await db().insert(schema.environments).values([...ENVIRONMENTS]).onConflictDoNothing({ target: schema.environments.key })
  for (const [key, role] of Object.entries(BUILTIN_ROLES)) {
    await db().insert(schema.roles)
      .values({ key, name: role.name, builtin: true, permissions: [...role.permissions] })
      .onConflictDoUpdate({ target: schema.roles.key, set: { permissions: sql`excluded.permissions`, name: sql`excluded.name`, builtin: true } })
  }
}
