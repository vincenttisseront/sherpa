import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { env } from '../utils/env'
import * as schema from './schema'

let client: ReturnType<typeof postgres> | undefined
let instance: ReturnType<typeof drizzle<typeof schema>> | undefined

export function db() {
  if (!instance) {
    client = postgres(env().DATABASE_URL, { max: 10, idle_timeout: 30, connect_timeout: 10 })
    instance = drizzle(client, { schema })
  }
  return instance
}

export type Db = ReturnType<typeof db>

export async function closeDb(): Promise<void> {
  await client?.end({ timeout: 5 })
  client = undefined
  instance = undefined
}

export { schema }
