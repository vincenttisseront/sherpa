import { z } from 'zod'
import { audit } from '../../../../../utils/audit'
import { clientIp, requirePermission } from '../../../../../utils/auth'
import { uploadServiceFile } from '../../../../../services/service-files'
import { getTargetOr404, targetScope } from '../../../../../services/projects'

defineRouteMeta({ openAPI: { tags: ['targets'], summary: 'Envoie un fichier (corps brut) dans un dossier d\'un service ; remplacement sur demande, ancienne version copiée à côté' } })

const params = z.object({ id: z.uuid(), service: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/) })
const query = z.object({
  mount: z.string().min(1).max(1024),
  path: z.string().max(1024).default(''),
  name: z.string().min(1).max(255),
  overwrite: z.enum(['0', '1']).default('0'),
})

export default defineEventHandler(async (event) => {
  const { id, service } = await getValidatedRouterParams(event, params.parse)
  const q = await getValidatedQuery(event, query.parse)
  const t = await getTargetOr404(id)
  const user = await requirePermission(event, 'deployment:execute', targetScope(t))
  const size = Number(getHeader(event, 'content-length') ?? Number.NaN)
  const base = { actorUserId: user.id, actorLabel: user.email, action: 'target.file_upload', targetType: 'project_target', targetId: id, ...targetScope(t), ip: clientIp(event) }
  try {
    const r = await uploadServiceFile(t, service, { mount: q.mount, dir: q.path, name: q.name, overwrite: q.overwrite === '1', size, body: event.node.req })
    await audit({ ...base, outcome: 'success', details: { service, mount: q.mount, path: r.path, size, backup: r.backup } })
    setResponseStatus(event, 201)
    return r
  }
  catch (err) {
    // Corps non lu (refus avant l'envoi) : abandonné, la connexion n'attend pas tout le fichier.
    event.node.req.resume()
    await audit({ ...base, outcome: 'failure', details: { service, mount: q.mount, path: q.path, name: q.name, size, error: (err as { statusMessage?: string, message?: string }).statusMessage ?? (err as Error).message } })
    throw err
  }
})
