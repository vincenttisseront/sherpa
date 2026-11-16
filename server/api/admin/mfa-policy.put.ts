import { getMfaPolicy, hasMfa, mfaRequiredFor, mfaStatus, setMfaPolicy } from '../../auth/mfa'
import { mfaPolicyInput } from '../../../shared/schemas/mfa'
import { audit } from '../../utils/audit'
import { clientIp, requirePermission } from '../../utils/auth'
import { readValidated } from '../../utils/validation'

defineRouteMeta({ openAPI: { tags: ['admin'], summary: 'Définit qui doit activer une double authentification ; les sessions des comptes concernés sont limitées à leur page tant qu\'ils n\'en ont pas' } })

export default defineEventHandler(async (event) => {
  const actor = await requirePermission(event, 'policy:manage')
  const { required } = await readValidated(event, mfaPolicyInput)
  // Garde-fou : l'auteur ne doit pas se verrouiller lui-même (son compte serait limité à sa page tant qu'il n'a pas de facteur).
  if (required !== 'off' && actor.id && await mfaRequiredFor({ id: actor.id, kind: actor.kind }, required) && !hasMfa(await mfaStatus(actor.id))) {
    throw createError({ statusCode: 409, statusMessage: 'Activer d\'abord votre propre double authentification (page Mon compte) avant de l\'imposer' })
  }
  const before = await getMfaPolicy()
  await setMfaPolicy(required, actor.id)
  await audit({ actorUserId: actor.id, actorLabel: actor.email, action: 'policy.mfa', outcome: 'success', ip: clientIp(event), details: { before, after: required } })
  return { required }
})
