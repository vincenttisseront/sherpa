/**
 * Base PostgreSQL de test (platform_test), distincte de la base de dev :
 * créée si besoin, migrée, puis vidée avant chaque suite. Les tests qui en
 * dépendent sont sautés si PostgreSQL/Redis ne sont pas joignables.
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import postgres from 'postgres'

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? 'postgres://platform:platform@localhost:5432/platform'
export const TEST_DB_URL = ADMIN_URL.replace(/\/[^/]+$/, '/platform_test')

export async function databaseAvailable(): Promise<boolean> {
  const sql = postgres(ADMIN_URL, { max: 1, connect_timeout: 2, onnotice: () => {} })
  try {
    await sql`select 1`
    return true
  }
  catch {
    return false
  }
  finally {
    await sql.end({ timeout: 1 })
  }
}

/**
 * Prépare la base de test et oriente l'application vers elle (à appeler avant tout import utilisant db()).
 * Une base par fichier de test (suffixe) : les fichiers s'exécutent en parallèle.
 */
export async function setupTestDatabase(suffix = ''): Promise<void> {
  if (suffix && !/^[a-z_]+$/.test(suffix)) throw new Error('Suffixe de base invalide')
  const name = suffix ? `platform_test_${suffix}` : 'platform_test'
  const url = TEST_DB_URL.replace(/platform_test$/, name)
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} })
  const [exists] = await admin`select 1 from pg_database where datname = ${name}`
  if (!exists) await admin.unsafe(`create database ${name}`)
  await admin.end()

  process.env.DATABASE_URL = url
  process.env.MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64')
  const { resetEnvCache } = await import('../../server/utils/env')
  resetEnvCache()
  const { db, closeDb } = await import('../../server/db/client')
  await closeDb()
  // Données d'une exécution précédente vidées AVANT de migrer : une migration peut refuser des données obsolètes.
  const pre = postgres(url, { max: 1, onnotice: () => {} })
  const existing = await pre<{ tablename: string }[]>`select tablename from pg_tables where schemaname = 'public' and tablename <> '__drizzle_migrations'`
  if (existing.length) await pre.unsafe(`truncate ${existing.map(t => `"${t.tablename}"`).join(', ')} restart identity cascade`)
  await pre.end()
  const { migrate } = await import('drizzle-orm/postgres-js/migrator')
  await migrate(db(), { migrationsFolder: join(dirname(fileURLToPath(import.meta.url)), '../../server/db/migrations') })

  // Données vidées, référentiel (environnements, rôles intégrés) remis en place.
  const sql = postgres(url, { max: 1, onnotice: () => {} })
  const tables = await sql<{ tablename: string }[]>`select tablename from pg_tables where schemaname = 'public' and tablename <> '__drizzle_migrations'`
  if (tables.length) await sql.unsafe(`truncate ${tables.map(t => `"${t.tablename}"`).join(', ')} restart identity cascade`)
  await sql.end()
  const { schema } = await import('../../server/db/client')
  const { BUILTIN_ROLES } = await import('../../shared/utils/permissions')
  await db().insert(schema.environments).values([
    { key: 'dev', name: 'Développement', sortOrder: 1 },
    { key: 'staging', name: 'Staging', sortOrder: 2 },
    { key: 'production', name: 'Production', sortOrder: 3, isProduction: true },
  ])
  for (const [key, r] of Object.entries(BUILTIN_ROLES)) await db().insert(schema.roles).values({ key, name: r.name, builtin: true, permissions: [...r.permissions] })
}
