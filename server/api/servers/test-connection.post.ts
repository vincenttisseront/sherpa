import type { ConnectionTestResult } from '../../../shared/schemas/servers'
import { serverConnectionInput } from '../../../shared/schemas/servers'
import { PortainerError, portainer } from '../../adapters/portainer'
import { audit } from '../../utils/audit'
import { clientIp, requirePermission } from '../../utils/auth'
import { readValidated } from '../../utils/validation'
import { connectionFromInput, connectionLabel } from '../../services/servers'

defineRouteMeta({
  openAPI: { tags: ['servers'], summary: 'Teste la connexion à un hôte (agent ou SSH) sans l\'enregistrer (étape du wizard)' },
})

export default defineEventHandler(async (event): Promise<ConnectionTestResult> => {
  const user = await requirePermission(event, 'server:manage')
  const input = await readValidated(event, serverConnectionInput)
  const started = Date.now()
  const conn = connectionFromInput(input)

  let result: ConnectionTestResult
  try {
    const version = await portainer().getVersion(conn)
    const endpoints = version.supported ? await portainer().listEndpoints(conn) : []
    result = {
      ok: version.supported,
      version: version.version,
      supported: version.supported,
      endpoints: endpoints.map(e => ({ id: e.id, name: e.name, type: e.kind })),
      ...(version.supported ? {} : { error: input.transport === 'ssh' ? `${version.version} : Docker 20 ou plus récent requis` : `Agent Portainer ${version.version} non supporté (2.x requis)` }),
      durationMs: Date.now() - started,
    }
  }
  catch (err) {
    const message = err instanceof PortainerError ? err.message : 'Erreur inattendue'
    result = { ok: false, version: null, supported: false, endpoints: [], error: message, durationMs: Date.now() - started }
  }

  // Aucun secret (AGENT_SECRET, mot de passe, clé) ne figure dans l'audit.
  await audit({
    actorUserId: user.id,
    actorLabel: user.email,
    action: 'server.test_connection',
    outcome: result.ok ? 'success' : 'failure',
    ip: clientIp(event),
    details: { url: connectionLabel(input), transport: input.transport, version: result.version, error: result.error },
  })
  return result
})
