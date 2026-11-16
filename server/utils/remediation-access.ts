/**
 * Droits sur une demande de correction : voir le sujet (endpoint visible), et pour créer ou suivre
 * une demande, pouvoir déployer l'un des projets qui utilisent l'image ou le code, ou administrer
 * les règles de la plateforme.
 */
import type { H3Event } from 'h3'
import type { RemediationSubject } from '../../shared/schemas/remediation'
import { liveEndpoints } from '../services/live'
import { getTargetOr404, targetScope } from '../services/projects'
import { subjectTargets } from '../services/remediation'
import { type AuthUser, canOn, requireAnyPermission } from './auth'

export async function requireSubjectAccess(event: H3Event, subject: RemediationSubject, write: boolean): Promise<AuthUser> {
  const user = await requireAnyPermission(event, 'server:read')
  const { targets, endpointId } = await subjectTargets(subject)
  if (!endpointId || !(await liveEndpoints(user, endpointId)).length) throw createError({ statusCode: 404, statusMessage: 'Analyse introuvable' })
  if (!write || canOn(user, 'policy:manage', {})) return user
  for (const t of targets) {
    const row = await getTargetOr404(t.targetId).catch(() => null)
    if (row && canOn(user, 'deployment:execute', targetScope(row))) return user
  }
  throw createError({ statusCode: 403, statusMessage: 'Demande de correction réservée aux personnes qui déploient l\'un des projets concernés (ou administrent les règles)' })
}
