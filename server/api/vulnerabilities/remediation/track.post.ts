import { remediationTrackInput } from '../../../../shared/schemas/remediation'
import { audit } from '../../../utils/audit'
import { clientIp } from '../../../utils/auth'
import { readValidated } from '../../../utils/validation'
import { requireSubjectAccess } from '../../../utils/remediation-access'
import { trackRemediation } from '../../../services/remediation'

defineRouteMeta({ openAPI: { tags: ['vulnerabilities'], summary: 'Suit une issue ou une PR ouverte sur GitHub (lien) pour une image ou un code source analysé' } })

export default defineEventHandler(async (event) => {
  const input = await readValidated(event, remediationTrackInput)
  const user = await requireSubjectAccess(event, input.subject, true)
  const r = await trackRemediation(input.subject, input.url, user.id)
  await audit({ actorUserId: user.id, actorLabel: user.email, action: 'vulnerability.remediation.track', targetType: 'remediation_request', targetId: r.id, outcome: 'success', ip: clientIp(event), details: { repository: r.repository, number: r.number } })
  setResponseStatus(event, 201)
  return r
})
