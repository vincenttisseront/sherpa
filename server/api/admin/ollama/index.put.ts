import { ollamaSettingsInput } from '../../../../shared/schemas/ollama'
import { audit } from '../../../utils/audit'
import { clientIp, requirePermission } from '../../../utils/auth'
import { readValidated } from '../../../utils/validation'
import { saveOllamaSettings } from '../../../services/ollama'

defineRouteMeta({ openAPI: { tags: ['admin'], summary: 'Enregistre les réglages Ollama (adresse, modèle, délai, contexte, jeton chiffré)' } })

export default defineEventHandler(async (event) => {
  const user = await requirePermission(event, 'policy:manage')
  const input = await readValidated(event, ollamaSettingsInput)
  const { settings, credentialChanged } = await saveOllamaSettings(input, user.id)
  await audit({
    actorUserId: user.id,
    actorLabel: user.email,
    action: 'ollama.settings',
    targetType: 'platform',
    outcome: 'success',
    ip: clientIp(event),
    details: { enabled: settings.enabled, baseUrl: settings.baseUrl, model: settings.model, timeoutSec: settings.timeoutSec, contextTokens: settings.contextTokens, credentialChanged },
  })
  return settings
})
