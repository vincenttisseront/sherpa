import { audit } from '../utils/audit'
import { clientIp, requirePermission } from '../utils/auth'
import { globalTechSupportReport } from '../services/tech-support'

defineRouteMeta({ openAPI: { tags: ['system'], summary: 'Rapport « tech support » de la plateforme en texte brut (console, santé, base, files, configuration, réglages, serveurs, projets, échecs récents ; ni secret ni donnée personnelle)' } })

export default defineEventHandler(async (event) => {
  const user = await requirePermission(event, 'audit:read')
  const text = await globalTechSupportReport(user)
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'platform.tech_support', targetType: 'platform', outcome: 'success', ip: clientIp(event), details: {} })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  setHeader(event, 'Content-Type', 'text/plain; charset=utf-8')
  setHeader(event, 'Content-Disposition', `attachment; filename="tech-support-plateforme-${stamp}.txt"`)
  setHeader(event, 'Cache-Control', 'no-store')
  return text
})
