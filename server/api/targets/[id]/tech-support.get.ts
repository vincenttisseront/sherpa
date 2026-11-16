import { audit } from '../../../utils/audit'
import { canOn, clientIp, requirePermission } from '../../../utils/auth'
import { idParam } from '../../../utils/validation'
import { getTargetOr404, targetScope } from '../../../services/projects'
import { techSupportReport } from '../../../services/tech-support'

defineRouteMeta({ openAPI: { tags: ['targets'], summary: 'Rapport « tech support » de la cible en texte brut (état, diagnostic, conteneurs, réseaux, configuration, déploiements, journaux ; secrets masqués)' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const t = await getTargetOr404(id)
  const user = await requirePermission(event, 'project:read', targetScope(t))
  const logs = canOn(user, 'logs:read', targetScope(t))
  const text = await techSupportReport(t, { logs, by: user.email })
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'target.tech_support', targetType: 'project_target', targetId: id, ...targetScope(t), outcome: 'success', ip: clientIp(event), details: { logs } })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  setHeader(event, 'Content-Type', 'text/plain; charset=utf-8')
  setHeader(event, 'Content-Disposition', `attachment; filename="tech-support-${t.project.slug}-${t.env.key}-${stamp}.txt"`)
  setHeader(event, 'Cache-Control', 'no-store')
  return text
})
