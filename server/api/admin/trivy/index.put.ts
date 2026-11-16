import { trivySettingsInput } from '../../../../shared/schemas/trivy'
import { audit } from '../../../utils/audit'
import { clientIp, requirePermission } from '../../../utils/auth'
import { readValidated } from '../../../utils/validation'
import { saveTrivySettings } from '../../../services/trivy'

defineRouteMeta({ openAPI: { tags: ['admin'], summary: 'Enregistre les réglages Trivy (rythme cron, sévérités, périmètre, image, miroir de la base) et replanifie' } })

export default defineEventHandler(async (event) => {
  const user = await requirePermission(event, 'policy:manage')
  const input = await readValidated(event, trivySettingsInput)
  try {
    Intl.DateTimeFormat('fr-FR', { timeZone: input.timezone })
  }
  catch {
    throw createError({ statusCode: 422, statusMessage: 'Fuseau horaire inconnu', data: { errors: { timezone: 'Fuseau IANA (ex. Europe/Paris)' } } })
  }
  const saved = await saveTrivySettings(input, user.id).catch((err: Error) => {
    throw createError({ statusCode: 422, statusMessage: `Planification refusée : ${err.message}`, data: { errors: { cron: err.message } } })
  })
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'trivy.settings', targetType: 'platform', outcome: 'success', ip: clientIp(event), details: saved })
  return saved
})
