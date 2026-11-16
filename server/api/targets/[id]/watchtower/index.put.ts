import { eq } from 'drizzle-orm'
import { watchtowerConfig } from '../../../../../shared/schemas/watchtower'
import { db, schema } from '../../../../db/client'
import { analyzeCompose } from '../../../../lib/compose/analyze'
import { audit } from '../../../../utils/audit'
import { clientIp, requirePermission } from '../../../../utils/auth'
import { idParam, readValidated } from '../../../../utils/validation'
import { buildAnalyzeContext, getTargetOr404, targetScope } from '../../../../services/projects'
import { getTargetWatchtower } from '../../../../services/watchtower'

defineRouteMeta({ openAPI: { tags: ['watchtower'], summary: 'Enregistre la configuration Watchtower (appliquée au prochain déploiement ou redéploiement)' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const t = await getTargetOr404(id)
  const user = await requirePermission(event, 'project:update', targetScope(t))
  const config = await readValidated(event, watchtowerConfig)
  if (config.profileId) {
    const [p] = await db().select({ endpointId: schema.watchtowerProfiles.endpointId }).from(schema.watchtowerProfiles).where(eq(schema.watchtowerProfiles.id, config.profileId))
    if (p?.endpointId !== t.endpoint.id) throw createError({ statusCode: 422, statusMessage: 'Profil Watchtower inconnu sur le serveur de la cible', data: { errors: { profileId: 'Profil inconnu sur ce serveur' } } })
  }

  // Contrôle immédiat contre la release active : mêmes règles qu'au déploiement.
  const [release] = t.target.currentReleaseId ? await db().select().from(schema.releases).where(eq(schema.releases.id, t.target.currentReleaseId)) : []
  if (release?.composeSource && config.enabled) {
    const ctx = await buildAnalyzeContext({ ...t, target: { ...t.target, watchtower: config } }, {
      composePath: release.composePath ?? 'compose.yml', files: new Set(), releaseSlug: release.slug ?? 'r-0000-000000', portApprovals: [],
      sourceKind: release.sourceKind === 'github' ? 'github' : 'zip',
    })
    const issues = analyzeCompose(release.composeSource, ctx).issues.filter(i => i.code.startsWith('watchtower.'))
    if (issues.some(i => i.severity === 'error')) throw createError({ statusCode: 422, statusMessage: 'Configuration Watchtower refusée pour la release active', data: { issues } })
  }

  await db().update(schema.projectTargets).set({ watchtower: config }).where(eq(schema.projectTargets.id, id))
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'watchtower.configure', targetType: 'project_target', targetId: id, ...targetScope(t), outcome: 'success', ip: clientIp(event), details: { ...config } })
  return getTargetWatchtower(await getTargetOr404(id))
})
