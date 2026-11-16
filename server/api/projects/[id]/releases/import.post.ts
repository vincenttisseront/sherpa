import { z } from 'zod'
import { audit } from '../../../../utils/audit'
import { clientIp, requirePermission } from '../../../../utils/auth'
import { requestProgress } from '../../../../utils/progress'
import { idParam, readValidated } from '../../../../utils/validation'
import { importReleaseArchive } from '../../../../services/github-releases'
import { UploadRejected } from '../../../../services/uploads'

defineRouteMeta({ openAPI: { tags: ['projects'], summary: 'Importe une archive de release GitHub (fichier attaché ou code source du tag) comme une archive déposée : tar converti en ZIP, inspection complète' } })

const input = z.object({
  apiUrl: z.url(),
  repository: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/, 'Dépôt invalide'),
  tag: z.string().trim().min(1).max(250),
  archiveKey: z.string().regex(/^(asset:\d{1,15}|source:(tar\.gz|zip))$/, 'Archive invalide'),
  token: z.string().min(10).max(500).nullable().optional(),
})

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  await requirePermission(event, 'project:update', { projectId: id })
  const user = await requirePermission(event, 'source:import')
  const body = await readValidated(event, input)
  const details = { source: 'github-release', repository: body.repository, tag: body.tag, archive: body.archiveKey }
  try {
    const stored = await importReleaseArchive(id, body, user.id, requestProgress(event))
    await audit({ actorUserId: user.id, actorLabel: user.email, action: 'upload.create', targetType: 'upload', targetId: stored.id, projectId: id, outcome: 'success', ip: clientIp(event), details: { ...details, name: stored.originalName, sizeBytes: stored.sizeBytes, sha256: stored.sha256, files: stored.report.files, ...(stored.report.source ? { convertedFrom: stored.report.source.format, originalSha256: stored.report.source.sha256 } : {}) } })
    setResponseStatus(event, 201)
    return stored
  }
  catch (err) {
    if (err instanceof UploadRejected) {
      await audit({ actorUserId: user.id, actorLabel: user.email, action: 'upload.create', targetType: 'upload', projectId: id, outcome: 'failure', ip: clientIp(event), details: { ...details, error: err.message } })
      throw createError({ statusCode: err.status, statusMessage: err.message })
    }
    throw err
  }
})
