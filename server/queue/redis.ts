import { Redis } from 'ioredis'
import { env } from '../utils/env'

let connection: Redis | undefined

/** Connexion partagée. maxRetriesPerRequest: null est requis par BullMQ. */
export function redis(): Redis {
  if (!connection) {
    connection = new Redis(env().REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false })
  }
  return connection
}

export async function closeRedis(): Promise<void> {
  await connection?.quit()
  connection = undefined
}
