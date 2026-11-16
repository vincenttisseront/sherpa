/**
 * Reconstruction d'un Compose à partir des conteneurs d'un projet lancé hors
 * Portainer (docker compose en ligne de commande) : seul ce qui diffère des
 * valeurs par défaut de l'image est repris. Les valeurs d'environnement
 * deviennent des variables (secrètes) de la plateforme : le Compose ne
 * contient que des références ${VAR}.
 */
import { stringify } from 'yaml'
import type { AdoptionNote } from '../../../shared/schemas/adoption'
import type { ContainerConfig, ImageDefaults } from '../../adapters/portainer/types'
import { redactPatterns } from '../../utils/redact'

export interface ReconstructResult {
  composeText: string
  /** Nom de variable → valeur (interne au serveur, chiffrée à l'enregistrement). */
  variables: Record<string, string>
  notes: AdoptionNote[]
}

const VAR_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const COMPOSE_LABEL = /^com\.docker\.compose\./
const same = (a: readonly string[] | null | undefined, b: readonly string[] | null | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
const ns = (n: number | null) => (n ? `${Math.round(n / 1e9)}s` : undefined)
/** Compose interpole `$` : les valeurs littérales doivent le doubler. */
const esc = (v: string) => v.replace(/\$/g, '$$$$')
const varName = (s: string) => s.toUpperCase().replace(/[^A-Z0-9_]/g, '_').replace(/^(\d)/, '_$1')

export function reconstructCompose(stackName: string, containers: readonly ContainerConfig[], images: Readonly<Record<string, ImageDefaults | null>>): ReconstructResult {
  const notes: AdoptionNote[] = []
  const variables: Record<string, string> = {}
  const services: Record<string, Record<string, unknown>> = {}
  const topVolumes: Record<string, unknown> = {}
  const topNetworks: Record<string, unknown> = {}
  const prefix = `${stackName}_`

  // Une entrée par service (réplicas regroupés), conteneurs ponctuels ignorés.
  const byService = new Map<string, ContainerConfig[]>()
  for (const c of containers) {
    if (c.labels['com.docker.compose.oneoff']?.toLowerCase() === 'true') continue
    const svc = c.labels['com.docker.compose.service'] ?? c.name
    // Stack détachée de la plateforme : son Watchtower est recréé par la plateforme si elle la reprend.
    if (c.labels['platform.managed'] === 'true' && svc === 'platform-watchtower') continue
    byService.set(svc, [...(byService.get(svc) ?? []), c])
  }
  // Variables : même nom et même valeur partagés ; sinon préfixées par le service.
  const envOwners = new Map<string, string>()

  for (const [svc, list] of [...byService.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const c = list[0]!
    const img = images[c.image] ?? null
    const s: Record<string, unknown> = { image: c.image }
    if (list.length > 1) notes.push({ level: 'info', service: svc, message: `${list.length} conteneurs pour ce service : un seul est repris, ajuster le nombre de réplicas si besoin` })
    if (!img) notes.push({ level: 'warning', service: svc, message: `Image ${c.image} absente de l'hôte : valeurs par défaut inconnues, tout est repris explicitement` })

    // Commande et point d'entrée, s'ils diffèrent de l'image.
    for (const [key, value, dflt] of [['entrypoint', c.entrypoint, img?.entrypoint], ['command', c.cmd, img?.cmd]] as const) {
      if (!value || same(value, dflt)) continue
      const joined = value.join(' ')
      if (redactPatterns(joined) !== joined) {
        notes.push({ level: 'error', service: svc, message: `${key === 'command' ? 'Commande' : 'Point d\'entrée'} contenant un secret en clair : non repris, à redéfinir avec une variable` })
        continue
      }
      s[key] = value.map(esc)
    }
    if (c.workingDir && c.workingDir !== img?.workingDir) s.working_dir = c.workingDir
    if (c.user && c.user !== img?.user) s.user = c.user

    // Environnement : uniquement ce qui n'est pas hérité de l'image.
    const inherited = new Set(img?.env ?? [])
    const env: Record<string, string> = {}
    for (const e of c.env) {
      if (inherited.has(e)) continue
      const i = e.indexOf('=')
      const key = i < 0 ? e : e.slice(0, i)
      const value = i < 0 ? '' : e.slice(i + 1)
      let name = VAR_RE.test(key) ? key : varName(key)
      const owner = envOwners.get(name)
      if (owner !== undefined && variables[name] !== value) name = `${varName(svc)}_${name}`
      envOwners.set(name, svc)
      variables[name] = value
      env[key] = `\${${name}}`
    }
    if (Object.keys(env).length) s.environment = env

    // Ports publiés.
    const ports = c.portBindings.filter(p => p.hostPort).map((p) => {
      const [port, proto] = p.container.split('/')
      const ip = p.hostIp && p.hostIp !== '0.0.0.0' && p.hostIp !== '::' ? `${p.hostIp}:` : ''
      return `${ip}${p.hostPort}:${port}${proto && proto !== 'tcp' ? `/${proto}` : ''}`
    })
    if (ports.length) s.ports = [...new Set(ports)]

    // Montages : binds (chemins absolus de l'hôte), volumes nommés de la stack ou externes.
    const volumes: string[] = []
    const tmpfs: string[] = []
    for (const m of c.mounts) {
      const ro = m.rw ? '' : ':ro'
      if (m.type === 'bind' && m.source) volumes.push(`${m.source}:${m.destination}${ro}`)
      else if (m.type === 'volume' && m.name) {
        if (/^[0-9a-f]{64}$/.test(m.name)) {
          notes.push({ level: 'warning', service: svc, message: `Volume anonyme sur ${m.destination} : non repris, son contenu ne sera pas conservé au redéploiement` })
          continue
        }
        if (m.name.startsWith(prefix)) {
          const short = m.name.slice(prefix.length)
          topVolumes[short] = {}
          volumes.push(`${short}:${m.destination}${ro}`)
        }
        else {
          const key = m.name.replace(/[^A-Za-z0-9_.-]/g, '_')
          topVolumes[key] = { external: true, name: m.name }
          volumes.push(`${key}:${m.destination}${ro}`)
        }
      }
      else if (m.type === 'tmpfs') tmpfs.push(m.destination)
    }
    if (volumes.length) s.volumes = volumes
    if (tmpfs.length) s.tmpfs = tmpfs

    // Réseaux : ceux de la stack gardent leur nom court, les autres sont externes.
    const mode = c.networkMode ?? ''
    if (mode === 'host' || mode === 'none' || /^(container|service):/.test(mode)) {
      s.network_mode = mode
    }
    else {
      const nets: Record<string, unknown> = {}
      for (const n of c.networks) {
        if (n.name === `${prefix}default`) {
          nets.default = null
          continue
        }
        const key = n.name.startsWith(prefix) ? n.name.slice(prefix.length) : n.name.replace(/[^A-Za-z0-9_.-]/g, '_')
        if (n.name === 'bridge') {
          s.network_mode = 'bridge'
          continue
        }
        if (!n.name.startsWith(prefix)) topNetworks[key] = { external: true, name: n.name }
        else topNetworks[key] ??= {}
        const extra = n.aliases.filter(a => a !== svc && a !== c.name && !c.id.startsWith(a) && a !== c.id)
        nets[key] = extra.length ? { aliases: extra } : null
      }
      if (s.network_mode) {
        if (Object.keys(nets).length) notes.push({ level: 'warning', service: svc, message: 'Conteneur à la fois sur le réseau bridge et sur d\'autres réseaux : réseau bridge retiré' })
        delete s.network_mode
      }
      const keys = Object.keys(nets)
      if (keys.length && !(keys.length === 1 && keys[0] === 'default')) {
        s.networks = Object.values(nets).every(v => v === null) ? keys : nets
      }
    }

    // Labels : ni ceux de Compose, ni ceux hérités de l'image.
    // Labels posés par la plateforme (stack détachée) : réservés, reposés au déploiement.
    const fromPlatform = c.labels['platform.managed'] === 'true'
    const labels = Object.fromEntries(Object.entries(c.labels).filter(([k, v]) => !COMPOSE_LABEL.test(k) && img?.labels[k] !== v && !/^platform\./.test(k) && !(fromPlatform && /^com\.centurylinklabs\.watchtower\./.test(k))).map(([k, v]) => [k, esc(v)]))
    if (Object.keys(labels).length) s.labels = labels

    if (c.restartPolicy && c.restartPolicy !== 'no') s.restart = c.restartPolicy
    if (c.healthcheck && !same(c.healthcheck.test, img?.healthcheck)) {
      const hc: Record<string, unknown> = { test: c.healthcheck.test.map(esc) }
      if (ns(c.healthcheck.intervalNs)) hc.interval = ns(c.healthcheck.intervalNs)
      if (ns(c.healthcheck.timeoutNs)) hc.timeout = ns(c.healthcheck.timeoutNs)
      if (c.healthcheck.retries) hc.retries = c.healthcheck.retries
      if (ns(c.healthcheck.startPeriodNs)) hc.start_period = ns(c.healthcheck.startPeriodNs)
      s.healthcheck = hc
    }
    if (c.privileged) s.privileged = true
    if (c.capAdd.length) s.cap_add = c.capAdd
    if (c.capDrop.length) s.cap_drop = c.capDrop
    if (c.extraHosts.length) s.extra_hosts = c.extraHosts
    if (c.stopSignal && c.stopSignal !== 'SIGTERM') s.stop_signal = c.stopSignal
    if (c.tty) s.tty = true

    // Dépendances déclarées par Compose (label com.docker.compose.depends_on).
    const deps = (c.labels['com.docker.compose.depends_on'] ?? '').split(',').map(d => d.split(':')[0]!.trim()).filter(d => d && byService.has(d))
    if (deps.length) s.depends_on = deps
    services[svc] = s
  }

  const doc: Record<string, unknown> = { services }
  if (Object.keys(topNetworks).length) doc.networks = topNetworks
  if (Object.keys(topVolumes).length) doc.volumes = topVolumes
  const header = `# Reconstruit par la plateforme à partir des conteneurs de la stack « ${stackName} ».\n# Les valeurs d'environnement sont des variables chiffrées de la plateforme.\n`
  if (Object.keys(variables).length) notes.push({ level: 'info', service: null, message: `${Object.keys(variables).length} variable(s) d'environnement importée(s) comme variables secrètes (valeurs chiffrées, jamais affichées)` })
  return { composeText: header + stringify(doc, { lineWidth: 0 }), variables, notes }
}
