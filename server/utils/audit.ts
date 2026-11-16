/**
 * Journal d'audit (§19) : toute action sensible, réussie, échouée ou refusée.
 * Les détails sont systématiquement masqués avant insertion.
 */
import { db, schema } from '../db/client'
import { redactObject } from './redact'

export interface AuditEntry {
  actorUserId?: string | null
  actorLabel: string
  action: string
  targetType?: string
  targetId?: string
  serverId?: string | null
  environmentId?: string | null
  projectId?: string | null
  outcome: 'success' | 'failure' | 'denied'
  ip?: string | null
  details?: Record<string, unknown>
}

export async function audit(entry: AuditEntry): Promise<void> {
  await db().insert(schema.auditEvents).values({
    ...entry,
    details: redactObject(entry.details ?? {}),
  })
  // Tout changement de droits tracé est aussi notifié (§18).
  if (entry.action.startsWith('permissions.') && entry.outcome === 'success') {
    const { emitNotification } = await import('../services/notifications')
    await emitNotification({
      event: 'permissions.changed',
      severity: 'warning',
      title: `Droits modifiés : ${PERMISSION_ACTION[entry.action] ?? entry.action}`,
      summary: `${entry.actorLabel} a modifié les droits d'accès à la plateforme.`,
      facts: [{ label: 'Action', value: PERMISSION_ACTION[entry.action] ?? entry.action }, { label: 'Par', value: entry.actorLabel }, ...(entry.targetType ? [{ label: 'Objet', value: `${entry.targetType} ${entry.targetId ?? ''}`.trim() }] : [])],
      path: entry.action === 'permissions.idp_mappings' ? '/admin/sso' : entry.action === 'permissions.groups' ? '/admin/users' : '/admin/roles',
    })
  }
}

const PERMISSION_ACTION: Record<string, string> = {
  'permissions.grant': 'rôle attribué',
  'permissions.revoke': 'rôle retiré',
  'permissions.groups': 'groupes d\'un utilisateur',
  'permissions.idp_mappings': 'correspondance de groupes SSO',
  'permissions.role_create': 'rôle créé',
  'permissions.role_update': 'rôle modifié',
  'permissions.role_delete': 'rôle supprimé',
}
