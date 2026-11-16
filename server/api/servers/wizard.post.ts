/**
 * Validation finale de l'assistant de connexion (§5.1, étape 13).
 *
 * La découverte est refaite ici : le client ne transmet que des décisions
 * (endpoints retenus, environnements, politiques réseau, chemins, ports,
 * Traefik), jamais l'inventaire lui-même. Tout est écrit dans une seule
 * transaction : pas de serveur à moitié configuré.
 */
import { eq } from 'drizzle-orm'
import type { FieldErrors, NetworkDecision } from '../../../shared/schemas/infra'
import { serverWizardInput } from '../../../shared/schemas/servers'
import { portainer } from '../../adapters/portainer'
import { scanHostKey } from '../../adapters/ssh/session'
import { db, schema } from '../../db/client'
import { audit } from '../../utils/audit'
import { clientIp, requirePermission } from '../../utils/auth'
import { encryptSecret } from '../../utils/crypto'
import { pgCode, readValidated, validationError } from '../../utils/validation'
import { discoverServer, syncInventory } from '../../services/discovery'
import { findCrossEnvironmentOverlaps, replacePortRules, setEndpointEnvironments, upsertPathConfig, upsertTraefikConfig, validatePathConfig, validatePortRule, validateTraefik } from '../../services/infra-config'
import { connectionFromInput, connectionLabel, environmentMaps, portainerErrorMessage, secretFromInput, serverColumnsFromInput } from '../../services/servers'
import { requestProgress } from '../../utils/progress'
import { prepareEndpointDirectories } from '../../services/runner-admin'

defineRouteMeta({ openAPI: { tags: ['servers'], summary: 'Crée un serveur et toute sa configuration (assistant, transaction unique)' } })

export default defineEventHandler(async (event) => {
  const user = await requirePermission(event, 'server:manage')
  for (const p of ['network:manage', 'path:manage', 'port:manage', 'domain:manage'] as const) await requirePermission(event, p)

  const input = await readValidated(event, serverWizardInput)
  const conn = connectionFromInput(input)

  const progress = requestProgress(event)
  let preview
  try {
    preview = await discoverServer(portainer(), conn, progress)
  }
  catch (err) {
    throw createError({ statusCode: 422, statusMessage: portainerErrorMessage(err) })
  }

  // Type de la clé d'hôte (affichage) : l'empreinte a déjà été vérifiée par la connexion.
  const hostKeyType = input.transport === 'ssh' ? (await scanHostKey(input.host, input.port).catch(() => null))?.keyType ?? null : null

  await progress.step('Validation des choix (endpoints, chemins, ports, Traefik)')
  // --- Validation croisée des décisions avec la découverte ---
  const errors: FieldErrors = {}
  const discoveredById = new Map(preview.endpoints.map(e => [e.id, e]))
  const pathValues = new Map<string, ReturnType<typeof validatePathConfig>>()

  input.endpoints.forEach((ep, i) => {
    const at = (f: string) => `endpoints.${i}.${f}`
    const d = discoveredById.get(ep.portainerEndpointId)
    if (!d) {
      errors[at('portainerEndpointId')] = `Endpoint ${ep.portainerEndpointId} absent de Portainer`
      return
    }
    for (const name of Object.keys(ep.networks)) {
      if (!d.networks.some(n => n.name === name)) errors[at(`networks.${name}`)] = `Réseau ${name} introuvable sur ${d.name}`
    }
    if (!ep.enabled) return

    if (!d.supported) errors[at('enabled')] = `${d.name} : seul Docker Standalone est déployable pour l'instant`
    if (d.error) errors[at('enabled')] = `${d.name} : ${d.error}`
    if (ep.environmentKeys.length === 0) errors[at('environmentKeys')] = `${d.name} : associer au moins un environnement`

    for (const env of ep.environmentKeys) {
      const j = ep.paths.findIndex(p => p.environmentKey === env)
      if (j < 0) {
        errors[at(`paths.${env}`)] = `${d.name} / ${env} : chemins de travail à configurer`
        continue
      }
      const { environmentKey: _, ...cfg } = ep.paths[j]!
      const r = validatePathConfig(cfg)
      pathValues.set(`${i}:${env}`, r)
      if (!r.ok) for (const [f, msg] of Object.entries(r.errors)) errors[at(`paths.${env}.${f}`)] = msg
    }
    const overlaps = findCrossEnvironmentOverlaps(Object.fromEntries(ep.paths.filter(p => ep.environmentKeys.includes(p.environmentKey)).map(p => [p.environmentKey, p])))
    for (const [env, fe] of Object.entries(overlaps)) for (const [f, msg] of Object.entries(fe)) errors[at(`paths.${env}.${f}`)] ??= msg
    ep.paths.forEach((p) => {
      if (!ep.environmentKeys.includes(p.environmentKey)) errors[at(`paths.${p.environmentKey}`)] = `${d.name} : environnement ${p.environmentKey} non associé`
    })
    ep.portRules.forEach((r, j) => {
      const msg = validatePortRule(r)
      if (msg) errors[at(`portRules.${j}`)] = msg
    })
    if (ep.traefik) {
      for (const [f, msg] of Object.entries(validateTraefik(ep.traefik, d.networks.map(n => n.name)))) errors[at(`traefik.${f}`)] = msg
      // Le réseau Traefik choisi doit être autorisé, sinon les projets ne pourraient pas s'y attacher.
      const decision = ep.networks[ep.traefik.networkName]
      if (decision && decision.policy !== 'allowed') errors[at('traefik.networkName')] = 'Le réseau Traefik doit être autorisé'
    }
  })
  if (Object.keys(errors).length) throw validationError(errors, 'Configuration incomplète ou invalide')

  // --- Écriture ---
  const { idByKey } = await environmentMaps()
  const decisions = new Map<number, Record<string, NetworkDecision>>(input.endpoints.map(e => [e.portainerEndpointId, e.networks]))

  await progress.step('Enregistrement du serveur et de sa configuration')
  const enabledIds: string[] = []
  const serverId = await db().transaction(async (tx) => {
    const { envelope, keyId } = encryptSecret(secretFromInput(input))
    const [secret] = await tx.insert(schema.secrets).values({ purpose: input.transport === 'ssh' ? 'ssh_credentials' : 'agent_secret', envelope, keyId }).returning({ id: schema.secrets.id })
    const [server] = await tx.insert(schema.portainerServers).values({
      name: input.name,
      description: input.description,
      ...serverColumnsFromInput(input),
      ...(hostKeyType ? { sshHostKeyType: hostKeyType } : {}),
      tokenSecretId: secret!.id,
      tags: input.tags,
      status: 'online',
      lastCheckedAt: new Date(),
    }).returning({ id: schema.portainerServers.id })

    const { endpointIds } = await syncInventory(tx, server!.id, preview, decisions, idByKey)
    enabledIds.length = 0

    for (const [i, ep] of input.endpoints.entries()) {
      const endpointId = endpointIds.get(ep.portainerEndpointId)!
      await tx.update(schema.serverEndpoints).set({ enabled: ep.enabled }).where(eq(schema.serverEndpoints.id, endpointId))
      if (!ep.enabled) continue
      enabledIds.push(endpointId)
      await setEndpointEnvironments(tx, endpointId, ep.environmentKeys.map(k => idByKey.get(k)!))
      for (const env of ep.environmentKeys) {
        const r = pathValues.get(`${i}:${env}`)
        if (r?.ok) await upsertPathConfig(tx, endpointId, idByKey.get(env)!, r.value, user.id)
      }
      await replacePortRules(tx, endpointId, ep.portRules, idByKey)
      if (ep.traefik) await upsertTraefikConfig(tx, endpointId, ep.traefik)
    }
    return server!.id
  }).catch((err) => {
    if (pgCode(err) === '23505') throw validationError({ name: 'Un serveur porte déjà ce nom' }, 'Un serveur porte déjà ce nom')
    throw err
  })

  await audit({
    actorUserId: user.id,
    actorLabel: user.email,
    action: 'server.create',
    targetType: 'portainer_server',
    targetId: serverId,
    serverId,
    outcome: 'success',
    ip: clientIp(event),
    details: {
      name: input.name,
      url: connectionLabel(input),
      transport: input.transport,
      version: preview.version,
      ...(input.transport === 'ssh' ? { auth: input.auth, hostKey: input.hostKey } : { tlsVerify: input.tlsVerify }),
      endpoints: input.endpoints.filter(e => e.enabled).map(e => ({ id: e.portainerEndpointId, environments: e.environmentKeys, traefik: !!e.traefik, portRules: e.portRules.length })),
    },
  })

  // Répertoires de travail créés en arrière-plan (hôte SSH : avec les droits du moteur Docker si besoin).
  for (const endpointId of enabledIds) void prepareEndpointDirectories(endpointId).catch(() => {})

  setResponseStatus(event, 201)
  return { id: serverId }
})
