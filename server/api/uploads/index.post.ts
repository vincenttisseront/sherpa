import { z } from 'zod'
import { audit } from '../../utils/audit'
import { clientIp, requirePermission } from '../../utils/auth'
import { UploadRejected, storeUpload } from '../../services/uploads'
import { requestProgress } from '../../utils/progress'

defineRouteMeta({ openAPI: { tags: ['uploads'], summary: 'Dépose une archive ZIP, tar.gz ou tar (corps brut) ; tar converti en ZIP, inspection complète avant acceptation' } })

export default defineEventHandler(async (event) => {
  const user = await requirePermission(event, 'source:import')
  const { name } = await getValidatedQuery(event, z.object({ name: z.string().min(1).max(255).default('archive.zip') }).parse)
  const type = getHeader(event, 'content-type') ?? ''
  // Le format réel est lu dans le contenu ; le type annoncé n'écarte que les envois manifestement erronés.
  if (!/^application\/(zip|x-zip-compressed|gzip|x-gzip|x-tar|x-gtar|x-compressed-tar|octet-stream)\b/.test(type)) {
    throw createError({ statusCode: 415, statusMessage: 'Corps attendu : archive ZIP, tar.gz ou tar' })
  }
  try {
    const stored = await storeUpload(event.node.req, name, user.id, requestProgress(event))
    await audit({ actorUserId: user.id, actorLabel: user.email, action: 'upload.create', targetType: 'upload', targetId: stored.id, outcome: 'success', ip: clientIp(event), details: { name: stored.originalName, sizeBytes: stored.sizeBytes, sha256: stored.sha256, files: stored.report.files } })
    setResponseStatus(event, 201)
    return stored
  }
  catch (err) {
    if (err instanceof UploadRejected) {
      await audit({ actorUserId: user.id, actorLabel: user.email, action: 'upload.create', targetType: 'upload', outcome: 'failure', ip: clientIp(event), details: { name, error: err.message } })
      throw createError({ statusCode: err.status, statusMessage: err.message })
    }
    throw err
  }
})
