import { z } from 'zod'
import { requirePermission } from '../../../../utils/auth'
import { idParam, readValidated } from '../../../../utils/validation'
import { inspectRepository } from '../../../../services/github-inspect'

defineRouteMeta({ openAPI: { tags: ['projects'], summary: 'Inspecte un dépôt GitHub à partir de son URL (accès, référence, fichiers Compose) sans rien enregistrer' } })

const input = z.object({
  url: z.string().trim().min(3).max(500),
  token: z.string().min(10).max(500).nullable().optional(),
  refType: z.enum(['branch', 'tag', 'commit']).nullable().optional(),
  ref: z.string().trim().max(250).nullable().optional(),
})

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  await requirePermission(event, 'project:update', { projectId: id })
  return inspectRepository(id, await readValidated(event, input))
})
