import { z } from 'zod'
import { environmentKey } from '../../../shared/schemas/common'
import type { FieldErrors, PathConfigInput } from '../../../shared/schemas/infra'
import { pathConfigInput } from '../../../shared/schemas/infra'
import { requirePermission } from '../../utils/auth'
import { readValidated } from '../../utils/validation'
import { findCrossEnvironmentOverlaps, validatePathConfig } from '../../services/infra-config'

defineRouteMeta({ openAPI: { tags: ['servers'], summary: 'Valide les chemins de tous les environnements d\'un endpoint (règles §6.5 et absence de recouvrement)' } })

const body = z.object({ configs: z.partialRecord(environmentKey, pathConfigInput) })

export default defineEventHandler(async (event): Promise<{ ok: boolean, errors: Record<string, FieldErrors>, values: Record<string, PathConfigInput> }> => {
  await requirePermission(event, 'path:manage')
  const { configs } = await readValidated(event, body)
  const errors: Record<string, FieldErrors> = {}
  const values: Record<string, PathConfigInput> = {}
  for (const [env, cfg] of Object.entries(configs)) {
    const r = validatePathConfig(cfg!)
    if (r.ok) values[env] = r.value
    else errors[env] = r.errors
  }
  for (const [env, fe] of Object.entries(findCrossEnvironmentOverlaps(values))) errors[env] = { ...fe, ...errors[env] }
  return { ok: Object.keys(errors).length === 0, errors, values }
})
