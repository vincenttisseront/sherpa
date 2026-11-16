import { z } from 'zod'
import { audit } from '../../../../../utils/audit'
import { clientIp, requirePermission } from '../../../../../utils/auth'
import { zipServiceFiles } from '../../../../../services/service-files'
import { getTargetOr404, targetScope } from '../../../../../services/projects'

defineRouteMeta({ openAPI: { tags: ['targets'], summary: 'Télécharge un dossier (ou un fichier) d\'un service en zip, compressé à la volée' } })

const params = z.object({ id: z.uuid(), service: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/) })
// path répété : plusieurs éléments du même dossier dans un seul zip.
const query = z.object({ mount: z.string().min(1).max(1024), path: z.union([z.string().max(1024), z.array(z.string().max(1024)).max(500)]).default('') })

export default defineEventHandler(async (event) => {
  const { id, service } = await getValidatedRouterParams(event, params.parse)
  const q = await getValidatedQuery(event, query.parse)
  const t = await getTargetOr404(id)
  const user = await requirePermission(event, 'deployment:execute', targetScope(t))
  const z = await zipServiceFiles(t, service, q.mount, q.path)
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'target.file_download_zip', targetType: 'project_target', targetId: id, ...targetScope(t), outcome: 'success', ip: clientIp(event), details: { service, mount: q.mount, path: q.path } })
  setHeader(event, 'Content-Type', 'application/zip')
  setHeader(event, 'Content-Disposition', `attachment; filename="${z.name}"; filename*=UTF-8''${encodeURIComponent(z.name)}`)
  setHeader(event, 'Cache-Control', 'no-store')
  setHeader(event, 'X-Content-Type-Options', 'nosniff')
  return sendStream(event, z.stream)
})
