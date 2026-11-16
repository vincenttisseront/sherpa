/**
 * Flux SSE de la vue en direct : un instantané par endpoint à la connexion,
 * puis un nouvel instantané dès que le contenu change (lecture toutes les 3 s).
 * Durée bornée (30 min) : le navigateur se reconnecte seul.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { requireAnyPermission } from '../../utils/auth'
import { liveEndpoints, scanEndpoint } from '../../services/live'

defineRouteMeta({ openAPI: { tags: ['live'], summary: 'Flux SSE des conteneurs des endpoints gérés (changements en direct)' } })

const INTERVAL_MS = 3_000
const MAX_MS = 30 * 60_000

export default defineEventHandler(async (event) => {
  const user = await requireAnyPermission(event, 'server:read')
  const { endpointId } = await getValidatedQuery(event, z.object({ endpointId: z.uuid().optional() }).parse)
  const rows = await liveEndpoints(user, endpointId)
  if (endpointId && !rows.length) throw createError({ statusCode: 404, statusMessage: 'Endpoint introuvable' })

  const stream = createEventStream(event)
  const last = new Map<string, string>()
  let closed = false
  const started = Date.now()

  const tick = async () => {
    for (const row of rows) {
      const snap = await scanEndpoint(row)
      // Empreinte sans l'horodatage : on n'envoie que les vrais changements.
      const digest = createHash('sha256').update(JSON.stringify({ ...snap, scannedAt: 0, durationMs: 0 })).digest('hex')
      if (last.get(row.ep.id) === digest) {
        await stream.push({ event: 'alive', data: JSON.stringify({ endpointId: row.ep.id, scannedAt: snap.scannedAt }) })
        continue
      }
      last.set(row.ep.id, digest)
      await stream.push({ event: 'snapshot', data: JSON.stringify(snap) })
    }
  }

  const loop = async () => {
    while (!closed && Date.now() - started < MAX_MS) {
      await tick().catch(() => {})
      await new Promise(r => setTimeout(r, INTERVAL_MS))
    }
    if (!closed) await stream.close()
  }
  stream.onClosed(async () => {
    closed = true
    await stream.close()
  })
  void loop()
  return stream.send()
})
