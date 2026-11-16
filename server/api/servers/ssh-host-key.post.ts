import { type SshHostKeyScan, sshHostKeyScanInput } from '../../../shared/schemas/servers'
import { scanHostKey } from '../../adapters/ssh/session'
import { requirePermission } from '../../utils/auth'
import { readValidated } from '../../utils/validation'
import { portainerErrorMessage } from '../../services/servers'

defineRouteMeta({ openAPI: { tags: ['servers'], summary: 'Lit la clé d\'hôte SSH présentée (empreinte à confirmer), sans authentification' } })

export default defineEventHandler(async (event): Promise<SshHostKeyScan> => {
  await requirePermission(event, 'server:manage')
  const { host, port } = await readValidated(event, sshHostKeyScanInput)
  try {
    return await scanHostKey(host, port)
  }
  catch (err) {
    throw createError({ statusCode: 422, statusMessage: portainerErrorMessage(err) })
  }
})
