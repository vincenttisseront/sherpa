import { userCreateInput } from '../../../../shared/schemas/admin'
import { createInvitation } from '../../../auth/invitations'
import { db, schema } from '../../../db/client'
import { sendInvitationMail } from '../../../services/invitation-mail'
import { emitNotification } from '../../../services/notifications'
import { audit } from '../../../utils/audit'
import { clientIp, requirePermission } from '../../../utils/auth'
import { pgCode, readValidated, validationError } from '../../../utils/validation'

defineRouteMeta({ openAPI: { tags: ['admin'], summary: 'Crée un compte local ou externe et renvoie UNE fois son lien d\'invitation' } })

export default defineEventHandler(async (event) => {
  const actor = await requirePermission(event, 'user:manage')
  const input = await readValidated(event, userCreateInput)
  if (input.expiresAt && new Date(input.expiresAt).getTime() <= Date.now()) throw validationError({ expiresAt: 'Date dans le passé' })
  const user = await db().transaction(async (tx) => {
    const [u] = await tx.insert(schema.users).values({ email: input.email, displayName: input.displayName, kind: input.kind, status: 'invited', expiresAt: input.expiresAt ? new Date(input.expiresAt) : null }).returning()
    if (input.groupIds.length) await tx.insert(schema.userGroups).values(input.groupIds.map(groupId => ({ userId: u!.id, groupId })))
    return u!
  }).catch((err) => {
    if (pgCode(err) === '23505') throw validationError({ email: 'Un compte existe déjà avec cet email' })
    throw err
  })
  const inv = await createInvitation(user.id, 'invite', actor.id)
  await audit({ actorUserId: actor.id, actorLabel: actor.email, action: 'user.create', targetType: 'user', targetId: user.id, outcome: 'success', ip: clientIp(event), details: { email: user.email, kind: user.kind, expiresAt: input.expiresAt, groups: input.groupIds } })
  const mail = await sendInvitationMail(user, inv.url, inv.expiresAt, 'invite')
  await emitNotification({
    event: 'user.invited', severity: 'info', title: `Invitation : ${user.displayName}`,
    summary: `${actor.email} a invité ${user.email} (compte ${user.kind === 'local' ? 'local' : 'externe'}).${mail.emailed ? ' Le lien lui a été envoyé par email.' : ''}`,
    facts: [{ label: 'Compte', value: user.email }, { label: 'Par', value: actor.email }, ...(input.expiresAt ? [{ label: 'Expire le', value: new Date(input.expiresAt).toLocaleDateString('fr-FR') }] : [])],
    path: '/admin/users',
  })
  setResponseStatus(event, 201)
  // Le lien est aussi remis à l'administrateur (SMTP absent ou en échec, ou transmission par un autre canal).
  return { id: user.id, invitationUrl: inv.url, invitationExpiresAt: inv.expiresAt.toISOString(), ...mail }
})
