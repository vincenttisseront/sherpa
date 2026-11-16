import { audit } from '../../../utils/audit'
import { clientIp, requirePermission } from '../../../utils/auth'
import { idParam } from '../../../utils/validation'
import { getServerOr404 } from '../../../services/servers'
import { serverTechSupportReport } from '../../../services/tech-support'

defineRouteMeta({ openAPI: { tags: ['servers'], summary: 'Rapport « tech support » du serveur en texte brut (accès, moteur Docker, disque, Runner, chemins, Traefik, plan d\'adressage, Watchtower, projets, conteneurs, audit ; aucun secret)' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const server = await getServerOr404(id)
  const user = await requirePermission(event, 'server:read', { serverId: id })
  const text = await serverTechSupportReport(id, user)
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'server.tech_support', targetType: 'portainer_server', targetId: id, serverId: id, outcome: 'success', ip: clientIp(event), details: {} })
  const slug = server.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'serveur'
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  setHeader(event, 'Content-Type', 'text/plain; charset=utf-8')
  setHeader(event, 'Content-Disposition', `attachment; filename="tech-support-serveur-${slug}-${stamp}.txt"`)
  setHeader(event, 'Cache-Control', 'no-store')
  return text
})
