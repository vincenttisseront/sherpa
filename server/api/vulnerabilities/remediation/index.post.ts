import { remediationCreateInput } from '../../../../shared/schemas/remediation'
import { audit } from '../../../utils/audit'
import { clientIp } from '../../../utils/auth'
import { readValidated } from '../../../utils/validation'
import { requireSubjectAccess } from '../../../utils/remediation-access'
import { createRemediation } from '../../../services/remediation'

defineRouteMeta({ openAPI: { tags: ['vulnerabilities'], summary: 'Ouvre la demande de correction sur GitHub (issue, ou PR avec les modifications retenues) et la suit' } })

export default defineEventHandler(async (event) => {
  const input = await readValidated(event, remediationCreateInput)
  const user = await requireSubjectAccess(event, input.subject, true)
  try {
    const r = await createRemediation(input, user.id)
    await audit({ actorUserId: user.id, actorLabel: user.email, action: 'vulnerability.remediation', targetType: 'remediation_request', targetId: r.id, outcome: 'success', ip: clientIp(event), details: { kind: r.kind, repository: r.repository, number: r.number, subject: input.subject, oneTimeToken: !!input.token } })
    setResponseStatus(event, 201)
    return r
  }
  catch (err) {
    await audit({ actorUserId: user.id, actorLabel: user.email, action: 'vulnerability.remediation', targetType: 'vulnerability', targetId: input.subject.id, outcome: 'failure', ip: clientIp(event), details: { kind: input.kind, repository: input.repository ?? null, error: (err as Error).message } })
    throw err
  }
})
