import { asc } from 'drizzle-orm'
import type { EnvironmentDto } from '../../shared/schemas/environments'
import { db, schema } from '../db/client'
import { requireUser } from '../utils/auth'

defineRouteMeta({ openAPI: { tags: ['reference'], summary: 'Environnements (dev, staging, production)' } })

export default defineEventHandler(async (event): Promise<EnvironmentDto[]> => {
  requireUser(event)
  return db().select({ id: schema.environments.id, key: schema.environments.key, name: schema.environments.name, isProduction: schema.environments.isProduction })
    .from(schema.environments).orderBy(asc(schema.environments.sortOrder))
})
