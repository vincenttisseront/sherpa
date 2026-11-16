import { z } from 'zod'
import { requirePermission } from '../../../../utils/auth'
import { idParam, readValidated } from '../../../../utils/validation'
import { listReleaseArchives } from '../../../../services/github-releases'

defineRouteMeta({ openAPI: { tags: ['projects'], summary: 'Releases d\'un dépôt GitHub et leurs archives importables (fichiers .zip, .tar.gz, .tgz, .tar ; code source), sans rien enregistrer' } })

const input = z.object({
  url: z.string().trim().min(3).max(500),
  token: z.string().min(10).max(500).nullable().optional(),
})

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  await requirePermission(event, 'project:update', { projectId: id })
  return listReleaseArchives(id, await readValidated(event, input))
})
