import { eq } from 'drizzle-orm'
import { serverPatch } from '../../../shared/schemas/servers'
import { portainer } from '../../adapters/portainer'
import { db, schema } from '../../db/client'
import { audit } from '../../utils/audit'
import { clientIp, requirePermission } from '../../utils/auth'
import { idParam, pgCode, readValidated, validationError } from '../../utils/validation'
import { connectionFor, getServerOr404, loadServerDetail, portainerErrorMessage } from '../../services/servers'

defineRouteMeta({ openAPI: { tags: ['servers'], summary: 'Modifie un serveur ; un changement de connexion (URL, TLS, hôte SSH) est re-testé avant enregistrement' } })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  const user = await requirePermission(event, 'server:manage', { serverId: id })
  const patch = await readValidated(event, serverPatch)
  const server = await getServerOr404(id)

  const ssh = server.transport === 'ssh'
  // Champs propres à l'autre transport : ignorés.
  const ignored = new Set(ssh ? ['url', 'tlsVerify', 'caCertPem'] : ['sshHost', 'sshPort', 'sshUser', 'sshHostKey', 'dockerSocket'])
  const set: Record<string, unknown> = Object.fromEntries(Object.entries(patch).filter(([k]) => !ignored.has(k)))
  const differs = (k: keyof typeof server) => set[k] !== undefined && set[k] !== server[k]
  const connectionChanged = ssh
    ? (['sshHost', 'sshPort', 'sshUser', 'sshHostKey', 'dockerSocket'] as const).some(differs)
    : (['url', 'tlsVerify', 'caCertPem'] as const).some(differs)
  if (ssh && (differs('sshHost') || differs('sshPort')) && !differs('sshHostKey')) {
    throw validationError({ sshHostKey: 'Nouvel hôte ou port : confirmer l\'empreinte de sa clé d\'hôte' }, 'Empreinte de clé d\'hôte à confirmer')
  }
  if (connectionChanged) {
    const current = await connectionFor(server)
    const conn = ssh
      ? { ...current, url: `ssh://${String(set.sshUser ?? server.sshUser)}@${String(set.sshHost ?? server.sshHost)}:${String(set.sshPort ?? server.sshPort ?? 22)}`, ssh: { ...current.ssh!, host: String(set.sshHost ?? server.sshHost), port: Number(set.sshPort ?? server.sshPort ?? 22), username: String(set.sshUser ?? server.sshUser), hostKey: String(set.sshHostKey ?? server.sshHostKey), dockerSocket: String(set.dockerSocket ?? server.dockerSocket) } }
      : { ...current, url: patch.url ?? server.url, tlsVerify: patch.tlsVerify ?? server.tlsVerify, caCertPem: patch.caCertPem !== undefined ? patch.caCertPem : server.caCertPem }
    try {
      const v = await portainer().getVersion(conn)
      if (!v.supported) throw new Error(`${v.version} non supporté`)
    }
    catch (err) {
      throw validationError({ [ssh ? 'sshHost' : 'url']: portainerErrorMessage(err) }, 'La nouvelle connexion a échoué')
    }
    if (ssh) set.url = conn.url
  }

  await db().update(schema.portainerServers).set(set).where(eq(schema.portainerServers.id, id)).catch((err) => {
    if (pgCode(err) === '23505') throw validationError({ name: 'Un serveur porte déjà ce nom' })
    throw err
  })

  const changed = Object.fromEntries(Object.entries(set).filter(([k, v]) => v !== (server as Record<string, unknown>)[k]))
  await audit({
    actorUserId: user.id, actorLabel: user.email, action: 'server.update', targetType: 'portainer_server', targetId: id, serverId: id,
    outcome: 'success', ip: clientIp(event), details: { changed: Object.keys(changed), ...(connectionChanged ? (ssh ? { url: set.url, hostKey: set.sshHostKey ?? server.sshHostKey } : { url: patch.url ?? server.url, tlsVerify: patch.tlsVerify ?? server.tlsVerify }) : {}) },
  })
  return loadServerDetail(id)
})
