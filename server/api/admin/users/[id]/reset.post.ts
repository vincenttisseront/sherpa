import { eq } from 'drizzle-orm'
import { createInvitation } from '../../../../auth/invitations'
import { db, schema } from '../../../../db/client'
import { sendInvitationMail } from '../../../../services/invitation-mail'
import { audit } from '../../../../utils/audit'
import { clientIp, requirePermission } from '../../../../utils/auth'
import { idParam } from '../../../../utils/validation'

defineRouteMeta({ openAPI: { tags: ['admin'], summary: 'Lien de réinitialisation (ou nouvelle invitation) renvoyé une seule fois' } })

export default defineEventHandler(async (event) => {
  const actor = await requirePermission(event, 'user:manage')
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const [u] = await db().select().from(schema.users).where(eq(schema.users.id, id))
  if (!u) throw createError({ statusCode: 404, statusMessage: 'Utilisateur introuvable' })
  if (u.kind === 'sso') throw createError({ statusCode: 409, statusMessage: 'Compte SSO : mot de passe géré par le fournisseur d\'identité' })
  const purpose = u.status === 'invited' ? 'invite' : 'reset'
  const inv = await createInvitation(u.id, purpose, actor.id)
  await audit({ actorUserId: actor.id, actorLabel: actor.email, action: purpose === 'reset' ? 'user.password_reset_link' : 'user.reinvite', targetType: 'user', targetId: id, outcome: 'success', ip: clientIp(event), details: { email: u.email } })
  const mail = await sendInvitationMail(u, inv.url, inv.expiresAt, purpose)
  return { url: inv.url, expiresAt: inv.expiresAt.toISOString(), purpose, ...mail }
})
