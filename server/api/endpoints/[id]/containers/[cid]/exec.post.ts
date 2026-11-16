import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { portainer } from '../../../../../adapters/portainer'
import { db, schema } from '../../../../../db/client'
import { enforceRateLimit } from '../../../../../auth/rate-limit'
import { assertQuota, registerExec } from '../../../../../services/exec'
import { liveEndpoints, projectOfStack } from '../../../../../services/live'
import { connectionFor } from '../../../../../services/servers'
import { audit } from '../../../../../utils/audit'
import { canOn, clientIp, requireUser } from '../../../../../utils/auth'
import { readValidated } from '../../../../../utils/validation'

defineRouteMeta({ openAPI: { tags: ['live'], summary: 'Ouvre un terminal dans un conteneur en marche (droit container:exec, session obligatoire) ; sortie par SSE, saisie par POST' } })

const params = z.object({ id: z.uuid(), cid: z.string().regex(/^[a-f0-9]{12,64}$/) })
const body = z.object({ cols: z.number().int().min(20).max(500).default(100), rows: z.number().int().min(5).max(200).default(30), shell: z.enum(['auto', 'sh', 'bash']).default('auto') })
const SHELLS = {
  auto: ['/bin/sh', '-c', 'if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi'],
  sh: ['/bin/sh'],
  bash: ['/bin/bash'],
} as const

export default defineEventHandler(async (event) => {
  const user = requireUser(event)
  // Un jeton d'API n'ouvre jamais de terminal : accès interactif réservé à une session de personne.
  if (!user.id || event.context.apiToken) throw createError({ statusCode: 403, statusMessage: 'Un terminal s\'ouvre depuis une session de connexion' })
  const { id, cid } = await getValidatedRouterParams(event, params.parse)
  const input = await readValidated(event, body)
  await enforceRateLimit(event, `exec:${user.id}`, 20, 60)
  const [row] = await liveEndpoints(user, id)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Endpoint introuvable' })
  const conn = await connectionFor(row.server)
  const p = portainer()
  const container = await p.inspectContainer(conn, row.ep.portainerEndpointId, cid)
  if (!container) throw createError({ statusCode: 404, statusMessage: 'Conteneur introuvable' })

  // Portée du droit : le serveur, et le projet et l'environnement quand le conteneur appartient à un projet géré.
  const project = await projectOfStack(row.ep.id, container.labels['com.docker.compose.project'] ?? null)
  const scope = { serverId: row.server.id, ...(project ? { projectId: project.id, environmentId: await environmentIdOf(project.targetId) } : {}) }
  if (!canOn(user, 'container:exec', scope)) {
    await audit({ actorUserId: user.id, actorLabel: user.email, action: 'container.exec_open', targetType: 'container', targetId: container.id, serverId: row.server.id, projectId: project?.id, outcome: 'denied', ip: clientIp(event), details: { container: container.name } })
    throw createError({ statusCode: 403, statusMessage: 'Permission insuffisante : ouvrir un terminal demande le droit « Ouvrir un terminal dans un conteneur »' })
  }
  if (!container.state.running) throw createError({ statusCode: 409, statusMessage: 'Le conteneur n\'est pas en marche : démarrez-le pour ouvrir un terminal' })
  try {
    assertQuota(user.id)
  }
  catch (err) {
    throw createError({ statusCode: (err as { statusCode?: number }).statusCode ?? 429, statusMessage: (err as Error).message })
  }
  const session = await p.openExec(conn, row.ep.portainerEndpointId, container.id, { cmd: [...SHELLS[input.shell]], cols: input.cols, rows: input.rows })
    .catch((err) => { throw createError({ statusCode: (err as { kind?: string }).kind === 'unsupported' ? 409 : 502, statusMessage: (err as { kind?: string }).kind === 'unsupported' ? (err as Error).message : `Terminal impossible : ${(err as Error).message}` }) })
  const sessionId = await registerExec(session, {
    userId: user.id, userEmail: user.email, ip: clientIp(event), serverId: row.server.id, serverName: row.server.name,
    containerId: container.id, containerName: container.name, shell: input.shell, projectId: project?.id ?? null,
  })
  return { sessionId, container: container.name, shell: input.shell }
})

async function environmentIdOf(targetId: string): Promise<string | null> {
  const [t] = await db().select({ e: schema.projectTargets.environmentId }).from(schema.projectTargets).where(and(eq(schema.projectTargets.id, targetId)))
  return t?.e ?? null
}
