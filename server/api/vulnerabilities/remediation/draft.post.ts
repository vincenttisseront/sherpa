import { remediationDraftInput } from '../../../../shared/schemas/remediation'
import { readValidated } from '../../../utils/validation'
import { requireSubjectAccess } from '../../../utils/remediation-access'
import { remediationDraft } from '../../../services/remediation'

defineRouteMeta({ openAPI: { tags: ['vulnerabilities'], summary: 'Demande de correction : dépôt GitHub de l\'image ou du code, texte prêt (issue ou PR) et modifications proposées' } })

export default defineEventHandler(async (event) => {
  const input = await readValidated(event, remediationDraftInput)
  await requireSubjectAccess(event, input.subject, false)
  return remediationDraft(input)
})
