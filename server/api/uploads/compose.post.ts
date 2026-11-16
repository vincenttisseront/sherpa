import { Readable } from 'node:stream'
import { z } from 'zod'
import { makeZip } from '../../lib/zip-writer'
import { audit } from '../../utils/audit'
import { clientIp, requirePermission } from '../../utils/auth'
import { readValidated } from '../../utils/validation'
import { UploadRejected, storeUpload } from '../../services/uploads'
import { requestProgress } from '../../utils/progress'

defineRouteMeta({ openAPI: { tags: ['uploads'], summary: 'Compose saisi dans l\'interface : enregistré comme une archive (compose.yml) pour le circuit de déploiement habituel' } })

const input = z.object({
  content: z.string().min(10, 'Compose vide').max(512 * 1024, 'Compose trop volumineux (512 Ko maximum)'),
  name: z.string().trim().min(1).max(100).default('compose-saisi'),
})

export default defineEventHandler(async (event) => {
  const user = await requirePermission(event, 'source:import')
  const { content, name } = await readValidated(event, input)
  try {
    const stored = await storeUpload(Readable.from(makeZip([{ name: 'compose.yml', data: content }])), `${name}.zip`, user.id, requestProgress(event))
    await audit({ actorUserId: user.id, actorLabel: user.email, action: 'upload.create', targetType: 'upload', targetId: stored.id, outcome: 'success', ip: clientIp(event), details: { name: stored.originalName, source: 'saisie', sizeBytes: stored.sizeBytes, sha256: stored.sha256 } })
    setResponseStatus(event, 201)
    return stored
  }
  catch (err) {
    if (err instanceof UploadRejected) throw createError({ statusCode: err.status, statusMessage: err.message })
    throw err
  }
})
