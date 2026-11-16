import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { closeDb, db } from './client'
import { ensureReferenceData } from './reference-data'

const folder = process.env.MIGRATIONS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), 'migrations')

await migrate(db(), { migrationsFolder: folder })
console.info(`Migrations appliquées depuis ${folder}`)
// Environnements et rôles intégrés : indispensables au premier administrateur, mis à jour à chaque version.
await ensureReferenceData()
console.info('Données de référence à jour (environnements, rôles intégrés)')
await closeDb()
