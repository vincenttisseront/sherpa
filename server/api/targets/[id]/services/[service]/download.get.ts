import { z } from 'zod'
import { MAX_PREVIEW_BYTES, imageTypeOf } from '../../../../../../shared/utils/image-types'
import { audit } from '../../../../../utils/audit'
import { clientIp, requirePermission } from '../../../../../utils/auth'
import { downloadServiceFile } from '../../../../../services/service-files'
import { getTargetOr404, targetScope } from '../../../../../services/projects'

defineRouteMeta({ openAPI: { tags: ['targets'], summary: 'Télécharge un fichier d\'un service (binaire ou volumineux), transmis en flux ; `inline=1` : aperçu d\'une image' } })

const params = z.object({ id: z.uuid(), service: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/) })
const query = z.object({ mount: z.string().min(1).max(1024), path: z.string().max(1024).default(''), inline: z.enum(['0', '1']).default('0') })

export default defineEventHandler(async (event) => {
  const { id, service } = await getValidatedRouterParams(event, params.parse)
  const { mount, path, inline } = await getValidatedQuery(event, query.parse)
  // Aperçu : images seulement, d'une taille raisonnable.
  const imageType = inline === '1' ? imageTypeOf(path) : null
  if (inline === '1' && !imageType) throw createError({ statusCode: 422, statusMessage: 'Aperçu réservé aux images' })
  const t = await getTargetOr404(id)
  const user = await requirePermission(event, 'deployment:execute', targetScope(t))
  const f = await downloadServiceFile(t, service, mount, path, imageType ? MAX_PREVIEW_BYTES : null)
  await audit({ actorUserId: user.id, actorLabel: user.email, action: imageType ? 'target.file_preview' : 'target.file_download', targetType: 'project_target', targetId: id, ...targetScope(t), outcome: 'success', ip: clientIp(event), details: { service, mount, path, size: f.size } })
  setHeader(event, 'Content-Type', imageType ?? 'application/octet-stream')
  setHeader(event, 'Content-Length', f.size)
  setHeader(event, 'Content-Disposition', `${imageType ? 'inline' : 'attachment'}; filename="${f.name}"; filename*=UTF-8''${encodeURIComponent(f.name)}`)
  // Contenu d'un service servi depuis l'origine de la console : jamais exécuté (SVG à script), même ouvert directement.
  if (imageType) setHeader(event, 'Content-Security-Policy', 'default-src \'none\'; img-src \'self\' data:; style-src \'unsafe-inline\'; sandbox')
  setHeader(event, 'Cache-Control', 'no-store')
  setHeader(event, 'X-Content-Type-Options', 'nosniff')
  return sendStream(event, f.stream)
})
