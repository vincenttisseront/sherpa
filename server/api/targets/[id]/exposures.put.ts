import { eq } from 'drizzle-orm'
import { exposuresInput } from '../../../../shared/schemas/projects'
import { HOSTNAME_RE, PATH_PREFIX_RE, MIDDLEWARE_RE, isAllowedHost, normalizeHost } from '../../../../shared/utils/domains'
import { db, schema } from '../../../db/client'
import { audit } from '../../../utils/audit'
import { clientIp, requirePermission } from '../../../utils/auth'
import { idParam, readValidated, validationError } from '../../../utils/validation'
import { buildAnalyzeContext, getTargetOr404, targetScope } from '../../../services/projects'

defineRouteMeta({ openAPI: { tags: ['targets'], summary: 'Enregistre les expositions web (domaine, port, chemin) des services de la cible, servies par le reverse proxy de l\'endpoint' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const t = await getTargetOr404(id)
  const user = await requirePermission(event, 'project:update', targetScope(t))
  const input = await readValidated(event, exposuresInput)
  const ctx = await buildAnalyzeContext(t, { composePath: 'compose.yml', files: new Set(), releaseSlug: 'r-0000-000000', portApprovals: [] })
  const errors: Record<string, string> = {}
  const seen = new Set<string>()
  input.forEach((e, i) => {
    const host = normalizeHost(e.host)
    const key = `${host}|${e.pathPrefix ?? ''}`
    if (!ctx.traefik) errors[`${i}.host`] = 'Aucun reverse proxy (Traefik, nginx) n\'est configuré pour cet endpoint'
    else if (!HOSTNAME_RE.test(host)) errors[`${i}.host`] = 'Nom d\'hôte invalide'
    else if (!isAllowedHost(host, ctx.traefik.allowedDomains)) errors[`${i}.host`] = `Domaine non autorisé (autorisés : ${ctx.traefik.allowedDomains.join(', ') || 'aucun'})`
    else if (ctx.takenHosts?.some(x => normalizeHost(x.host) === host && (x.pathPrefix ?? '') === (e.pathPrefix ?? ''))) errors[`${i}.host`] = `Déjà utilisé par ${ctx.takenHosts.find(x => normalizeHost(x.host) === host)!.owner}`
    else if (seen.has(key)) errors[`${i}.host`] = 'Déclaré deux fois'
    if (e.pathPrefix && !PATH_PREFIX_RE.test(e.pathPrefix)) errors[`${i}.pathPrefix`] = 'Chemin invalide (ex. /api)'
    if (e.middlewares.some(m => !MIDDLEWARE_RE.test(m))) errors[`${i}.middlewares`] = 'Nom de middleware invalide'
    seen.add(key)
  })
  if (Object.keys(errors).length) throw validationError(errors, 'Expositions invalides')
  const value = input.map(e => ({ ...e, host: normalizeHost(e.host) }))
  await db().update(schema.projectTargets).set({ exposures: value }).where(eq(schema.projectTargets.id, id))
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'target.exposures', targetType: 'project_target', targetId: id, ...targetScope(t), outcome: 'success', ip: clientIp(event), details: { exposures: value } })
  return value
})
