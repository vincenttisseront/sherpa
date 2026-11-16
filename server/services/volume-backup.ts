/**
 * Données des services d'une cible : volumes (nommés ou chemins de l'hôte) montés en écriture
 * dans leurs conteneurs en service. Base de la sauvegarde à froid prise avant une mise à niveau.
 */
import { eq } from 'drizzle-orm'
import { createError } from 'h3'
import { portainer } from '../adapters/portainer'
import { db, schema } from '../db/client'
import { stackOfTarget } from './diagnostic'
import type { TargetRow } from './projects'
import { connectionFor } from './servers'

export interface ServiceMounts { service: string, mounts: { source: string, destination: string }[] }

export async function dataMounts(t: TargetRow, services: readonly string[]): Promise<ServiceMounts[]> {
  if (!services.length) return []
  const [s] = await db().select().from(schema.portainerServers).where(eq(schema.portainerServers.id, t.server.id))
  if (!s) throw createError({ statusCode: 404, statusMessage: 'Serveur introuvable' })
  const conn = await connectionFor(s)
  const p = portainer()
  const stack = stackOfTarget(t)
  const containers = (await p.listContainers(conn, t.endpoint.portainerEndpointId)).filter(c => c.labels['com.docker.compose.project'] === stack)
  const out: ServiceMounts[] = []
  for (const service of services) {
    const c = containers.find(x => x.labels['com.docker.compose.service'] === service)
    if (!c) continue
    const cfg = await p.inspectConfig(conn, t.endpoint.portainerEndpointId, c.id)
    // Montages en écriture seulement (données) ; sockets et fichiers de configuration en lecture seule exclus.
    const mounts = (cfg?.mounts ?? [])
      .filter(m => m.rw && (m.type === 'volume' || m.type === 'bind') && !m.destination.endsWith('.sock'))
      .map(m => ({ source: (m.type === 'volume' ? m.name : m.source) ?? '', destination: m.destination }))
      .filter(m => m.source)
    if (mounts.length) out.push({ service, mounts })
  }
  return out
}
