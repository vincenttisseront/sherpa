import { z } from 'zod'
import { SEARCH_TABLES, nlSearchInput } from '../../../../shared/schemas/ollama'
import { SEARCH_PERMISSION } from '../../../lib/ollama/nl-search'
import { audit } from '../../../utils/audit'
import { clientIp, requireAnyPermission } from '../../../utils/auth'
import { requestProgress } from '../../../utils/progress'
import { readValidated } from '../../../utils/validation'
import { naturalSearch } from '../../../services/ai-search'

defineRouteMeta({ openAPI: { tags: ['ollama'], summary: 'Recherche en langage naturel d\'un tableau (audit, déploiements) : la phrase devient des filtres validés par le schéma de la liste, jamais une requête' } })

const params = z.object({ table: z.enum(SEARCH_TABLES) })

export default defineEventHandler(async (event) => {
  const { table } = await getValidatedRouterParams(event, params.parse)
  const user = await requireAnyPermission(event, SEARCH_PERMISSION[table])
  const { text } = await readValidated(event, nlSearchInput)
  const base = { actorUserId: user.id, actorLabel: user.email, action: 'ollama.search', targetType: 'table', targetId: table, ip: clientIp(event) }
  try {
    const result = await naturalSearch(user, table, text, requestProgress(event))
    // Ni la phrase ni la réponse du modèle ne sont conservées : seulement des comptes.
    await audit({ ...base, outcome: 'success', details: { model: result.meta.model, durationMs: result.meta.durationMs, applied: result.applied.length, ignored: result.ignored.length } })
    return result
  }
  catch (err) {
    await audit({ ...base, outcome: 'failure', details: { error: (err as { statusMessage?: string }).statusMessage ?? 'Erreur' } })
    throw err
  }
})
