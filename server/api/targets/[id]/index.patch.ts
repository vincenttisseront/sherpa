import { eq } from 'drizzle-orm'
import { targetPatch } from '../../../../shared/schemas/projects'
import { db, schema } from '../../../db/client'
import { audit } from '../../../utils/audit'
import { clientIp, requirePermission } from '../../../utils/auth'
import { idParam, readValidated, validationError } from '../../../utils/validation'
import { getTargetOr404, targetScope } from '../../../services/projects'
import { validatePlacement } from '../../../services/placement'

defineRouteMeta({ openAPI: { tags: ['targets'], summary: 'Réglages de la cible (placement sur l\'hôte, réseau du reverse proxy, rollback automatique, délai des healthchecks)' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const t = await getTargetOr404(id)
  const user = await requirePermission(event, 'project:update', targetScope(t))
  const patch = await readValidated(event, targetPatch)
  // Les données déjà écrites ne sont pas déplacées : chemin et stockage fixés après le premier déploiement.
  const moved = (patch.projectPath !== undefined && patch.projectPath !== t.target.projectPath)
    || (patch.volumesAsFolders !== undefined && patch.volumesAsFolders !== t.target.volumesAsFolders)
  if (moved && t.target.currentReleaseId) throw validationError({ projectPath: 'Chemin et stockage des volumes modifiables uniquement avant le premier déploiement' })
  if (patch.projectPath !== undefined || patch.proxyNetwork !== undefined) {
    const errors = await validatePlacement({
      endpointId: t.endpoint.id, environmentId: t.env.id, projectSlug: t.project.slug, targetId: id,
      projectPath: patch.projectPath !== undefined ? patch.projectPath : t.target.projectPath,
      proxyNetwork: patch.proxyNetwork !== undefined ? patch.proxyNetwork : t.target.proxyNetwork,
    })
    if (Object.keys(errors).length) throw validationError(errors)
  }
  const { pendingAction, ...rest } = patch
  // Les images mises à niveau ne s'écrivent que par la mise à niveau (contrôles des versions) : conservées telles quelles.
  if (rest.composeOverrides) rest.composeOverrides = { ...rest.composeOverrides, images: t.target.composeOverrides?.images ?? {} }
  await db().update(schema.projectTargets).set({
    ...rest,
    // Création ou suppression explicite ; une action n'est jamais « faite » par déclaration (voir /pending/verify).
    ...(pendingAction !== undefined ? { pendingAction: pendingAction ? { ...pendingAction, at: new Date().toISOString(), by: user.email } : null } : {}),
  }).where(eq(schema.projectTargets.id, id))
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'target.update', targetType: 'project_target', targetId: id, ...targetScope(t), outcome: 'success', ip: clientIp(event), details: patch })
  return { ok: true }
})
