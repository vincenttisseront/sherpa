/**
 * Analyse d'un Compose (§9) : validation de sécurité, contrôle des réseaux,
 * volumes et ports contre les politiques de l'endpoint, génération du
 * Compose final et du diff présentés avant tout déploiement.
 *
 * Fonction pure : aucune E/S. Le même code est exécuté à l'analyse (avant
 * confirmation) et par le worker juste avant le build (les politiques ont pu
 * changer entre-temps).
 */
import { posix } from 'node:path'
import { createTwoFilesPatch } from 'diff'
import YAML from 'yaml'
import type { PortRuleLike } from '../../utils/port-guard'
import { evaluatePort } from '../../utils/port-guard'
import type { VolumeRuleLike } from '../../utils/bind-guard'
import { evaluateBind } from '../../utils/bind-guard'
import { PathViolation, normalizeAbsolute, validateRelativeEntry } from '../../utils/path-guard'
import type { EntryError, MountEntry, PortEntry } from './entries'
import { parseMount, parsePort, readOnlyMount, rebuildMount } from './entries'
import { envFileRefs, envFileVarNames } from './env-files'
import { applyHealthOverrides, shortGraceDependencies } from './healthchecks'
import { type ImageOverride, applyImageOverrides } from './image-upgrade'
import { aliasFor, aliasPlan, applyAliasPlan } from './unique-aliases'
import { nginxSiteFile } from '../proxy/nginx-sites'
import { type Variable, containsSecretToken, findVariables, interpolateTree, restoreSecretRefs, unescapeDollars } from './interpolate'
import type { AnalysisResult, BuildPlan, Change, ComposeIssue, Exposure, ExposureReport, MountReport, PortApproval, PortReport, TraefikPolicy } from '../../../shared/schemas/analysis'
import { HOSTNAME_RE, MIDDLEWARE_RE, PATH_PREFIX_RE, isAllowedHost, normalizeHost } from '../../../shared/utils/domains'
import type { WatchtowerConfig } from '../../../shared/schemas/watchtower'
import type { HealthcheckOverride } from '../../../shared/schemas/projects'
import { trimChars } from '../../../shared/utils/trim'

/** Vrai si la référence d'image porte un tag : un « : » après le dernier « / », suivi d'au moins un caractère (sans regex : /:[^/]+$/ est quadratique). */
function hasTag(image: string): boolean {
  const colon = image.indexOf(':', image.lastIndexOf('/') + 1)
  return colon !== -1 && colon < image.length - 1
}

export type { AnalysisResult, BuildPlan, Change, ComposeIssue, Exposure, ExposureReport, MountReport, PortApproval, PortReport, TraefikPolicy }

export interface NetworkPolicy {
  name: string
  policy: 'unreviewed' | 'allowed' | 'forbidden'
  allowedEnvironmentIds: string[]
  missing: boolean
}

export interface AnalyzeContext {
  projectSlug: string
  projectId: string
  environmentKey: string
  environmentId: string
  releaseSlug: string
  /** Répertoire du fichier Compose, relatif à la racine des sources ('' si racine). */
  composeDir: string
  /** Fichiers présents dans les sources (chemins relatifs à la racine). */
  files: ReadonlySet<string>
  variables: Record<string, Variable>
  portRules: readonly PortRuleLike[]
  portApprovals: readonly PortApproval[]
  volumeRules: readonly VolumeRuleLike[]
  /** <runtimeRoot>/<projet> : destination des binds relatifs. */
  runtimeDir: string | null
  workingRoots: readonly string[]
  networks: readonly NetworkPolicy[]
  dockerVolumes: readonly string[]
  /** Configuration Traefik de l'endpoint (null : pas de Traefik). */
  traefik?: TraefikPolicy | null
  exposures?: readonly Exposure[]
  /** Hôtes déjà routés par d'autres cibles du même endpoint. */
  takenHosts?: readonly { host: string, pathPrefix: string | null, owner: string }[]
  /** Configuration Watchtower de la cible (§12) ; null ou désactivée : aucun Watchtower. */
  watchtower?: WatchtowerConfig | null
  watchtowerImage?: string
  /** Profil Watchtower du serveur auquel la cible est rattachée (scope porté par ses services). */
  watchtowerProfile?: { scope: string, name: string } | null
  /** Origine de la configuration : un dépôt Git est réputé faire foi. */
  sourceKind?: 'zip' | 'github'
  /** Volumes nommés (locaux) stockés en dossiers sous le répertoire de données du projet. */
  volumesAsFolders?: boolean
  /** Clés des fichiers env_file présents dans les sources (chemin depuis la racine → clés), sans les valeurs. */
  envFileKeys?: Record<string, string[]>
  /** Dossier des sources de la release sur l'hôte : destination des binds relatifs en lecture seule vers des fichiers des sources. */
  sourceDir?: string | null
  /**
   * Nom de stack imposé (stack reprise de l'existant) : le conserver garde les
   * volumes et réseaux nommés `<stack>_x` existants. Par défaut `<projet>-<env>`.
   */
  stackName?: string | null
  /** Réglages de healthcheck propres à la cible (service → valeurs). */
  healthchecks?: Record<string, HealthcheckOverride>
  /** Images mises à niveau par la plateforme (appliquées si le Compose déclare l'image d'origine). */
  imageOverrides?: Record<string, ImageOverride>
  /** PGDATA des services PostgreSQL migrés vers une nouvelle version majeure. */
  pgData?: Record<string, { path: string, major: number }>
  /** Sous-réseaux attribués aux réseaux de la stack (réseau → CIDR), depuis la plage de l'endpoint. */
  networkSubnets?: Record<string, string>
  /** Services non gérés par la console (retirés du Compose, conteneur détaché de la stack). */
  excludedServices?: readonly string[]
  /** Services suspendus (retirés de la stack jusqu'à leur reprise ; conteneur supprimé au déploiement). */
  suspendedServices?: readonly string[]
  /** Ports publiés retirés du Compose déployé (accès par le reverse proxy uniquement). */
  unpublishedPorts?: readonly { service: string, published: number, protocol: 'tcp' | 'udp' }[]
}

/** Fichiers du fuseau horaire de l'hôte, montables en lecture seule sans règle. */
const TIMEZONE_PATHS = ['/etc/localtime', '/etc/timezone', '/usr/share/zoneinfo']

export const WATCHTOWER_SERVICE = 'platform-watchtower'
/** Variable (secrète) portant l'URL de notification vers la plateforme. */
export const WATCHTOWER_HOOK_VAR = 'PLATFORM_WATCHTOWER_HOOK'
const WT = 'com.centurylinklabs.watchtower'

/**
 * Rapport de passage Watchtower rendu en JSON (template Go) et envoyé à la plateforme.
 * La plateforme ne s'y fie que pour les signalements et échecs : les mises à jour
 * effectives sont constatées sur les conteneurs eux-mêmes.
 */
const reportList = (name: string, extra = '') =>
  `"${name.toLowerCase()}":[{{range $i, $c := .Report.${name}}}{{if $i}},{{end}}{"name":{{printf "%q" $c.Name}},"image":{{printf "%q" $c.ImageName}},"from":{{printf "%q" $c.CurrentImageID.ShortID}},"to":{{printf "%q" $c.LatestImageID.ShortID}}${extra}}{{end}}]`
export const WATCHTOWER_REPORT_TEMPLATE = `{{- if .Report -}}{${reportList('Updated')},${reportList('Failed', ',"error":{{printf "%q" $c.Error}}')},${reportList('Stale')}}{{- end -}}`

/** Politique Watchtower effective d'un service. */
export function watchtowerPolicyOf(cfg: WatchtowerConfig, service: string, labels: Record<string, string | null>): 'off' | 'monitor' | 'update' {
  if (cfg.mode === 'labels') {
    if (labels[`${WT}.enable`] !== 'true') return 'off'
    return labels[`${WT}.monitor-only`] === 'true' ? 'monitor' : 'update'
  }
  const p = cfg.services[service] ?? 'off'
  // Mode « détection seule » : jamais de mise à jour, même pour un service sélectionné.
  return cfg.mode === 'manual' && p === 'update' ? 'monitor' : p
}

const TRAEFIK_NETWORK_KEY = 'platform-traefik'

export function routerNameFor(pattern: string, project: string, env: string, service: string): string {
  return trimChars(pattern.replace('{project}', project).replace('{env}', env).replace('{service}', service).toLowerCase().replace(/[^a-z0-9-]+/g, '-'), '-').slice(0, 100)
}

const MAX_SERVICES = 30
const MAX_COMPOSE_BYTES = 512 * 1024
const DANGEROUS_CAPS = new Set(['ALL', 'SYS_ADMIN', 'NET_ADMIN', 'SYS_PTRACE', 'SYS_MODULE', 'DAC_READ_SEARCH', 'SYS_RAWIO', 'SYS_BOOT', 'SYS_TIME', 'MAC_ADMIN', 'MAC_OVERRIDE', 'BPF', 'PERFMON'])
const SERVICE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/
const RESERVED_LABEL = /^platform\./
const TRAEFIK_LABEL = /^traefik\./
const KNOWN_TOP_LEVEL = new Set(['services', 'networks', 'volumes', 'version', 'name', 'secrets', 'configs'])

/**
 * Volumes nommés locaux → dossiers du projet : `nom:/cible` devient `./nom:/cible`
 * (résolu ensuite sous le répertoire de données), et la déclaration est retirée.
 * Les volumes externes ou avec driver/options restent des volumes Docker.
 */
function volumesToFolders(services: Record<string, Obj>, topVolumes: Record<string, Obj | null>): Change[] {
  const convertible = new Set(Object.entries(topVolumes)
    .filter(([, def]) => !isObj(def) || (def.external !== true && (def.driver === undefined || def.driver === 'local') && def.driver_opts === undefined && def.name === undefined))
    .map(([k]) => k))
  const changes: Change[] = []
  const done = new Set<string>()
  for (const [name, svc] of Object.entries(services)) {
    if (!isObj(svc) || !Array.isArray(svc.volumes)) continue
    svc.volumes = svc.volumes.map((v: unknown) => {
      if (typeof v === 'string') {
        const [src, ...rest] = v.split(':')
        if (!src || !convertible.has(src) || !rest.length) return v
        done.add(src)
        changes.push({ service: name, kind: 'volume', message: `Volume « ${src} » stocké dans le dossier du projet (data/${src})` })
        return [`./${src}`, ...rest].join(':')
      }
      if (isObj(v) && (v.type === undefined || v.type === 'volume') && typeof v.source === 'string' && convertible.has(v.source)) {
        done.add(v.source)
        changes.push({ service: name, kind: 'volume', message: `Volume « ${v.source} » stocké dans le dossier du projet (data/${v.source})` })
        const { volume: _v, ...rest } = v
        return { ...rest, type: 'bind', source: `./${v.source}`, bind: { create_host_path: true } }
      }
      return v
    })
  }
  for (const k of done) Reflect.deleteProperty(topVolumes, k)
  return changes
}

export function stackNameFor(projectSlug: string, environmentKey: string): string {
  return `${projectSlug}-${environmentKey}`.toLowerCase().slice(0, 63)
}

export function imageTagFor(projectSlug: string, service: string, releaseSlug: string): string {
  const svc = service.toLowerCase().replace(/[^a-z0-9_.-]/g, '-')
  return `platform/${projectSlug}-${svc}:${releaseSlug}`
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

/** Liste ou dictionnaire → dictionnaire (environment, labels, build.args). */
function toMap(v: unknown): Record<string, string | null> {
  if (Array.isArray(v)) {
    return Object.fromEntries(v.map((e) => {
      const s = String(e)
      const i = s.indexOf('=')
      return i < 0 ? [s, null] : [s.slice(0, i), s.slice(i + 1)]
    }))
  }
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x === null || x === undefined ? null : String(x)]))
  return {}
}

function serviceNetworks(svc: Obj): string[] {
  const n = svc.networks
  if (Array.isArray(n)) return n.map(String)
  if (isObj(n)) return Object.keys(n)
  return ['default']
}

export function analyzeCompose(rawText: string, ctx: AnalyzeContext): AnalysisResult {
  const issues: ComposeIssue[] = []
  const err = (code: string, message: string, service?: string) => issues.push({ severity: 'error', code, message, service })
  const warn = (code: string, message: string, service?: string) => issues.push({ severity: 'warning', code, message, service })
  const info = (code: string, message: string, service?: string) => issues.push({ severity: 'info', code, message, service })
  const stackName = ctx.stackName || stackNameFor(ctx.projectSlug, ctx.environmentKey)
  const empty: AnalysisResult = { ok: false, stackName, issues, services: [], builds: [], images: {}, ports: [], mounts: [], networks: [], variables: [], changes: [], sourceYaml: rawText, finalYaml: null, diff: null, secretVariables: [], exposures: [], watchtower: [] }

  if (Buffer.byteLength(rawText) > MAX_COMPOSE_BYTES) {
    err('compose.too_large', `Fichier Compose supérieur à ${MAX_COMPOSE_BYTES / 1024} Ko`)
    return empty
  }

  // --- Analyse YAML sûre ---
  let source: unknown
  try {
    const doc = YAML.parseDocument(rawText, { merge: true, uniqueKeys: true, prettyErrors: true, schema: 'core' })
    if (doc.errors.length) throw doc.errors[0]
    source = doc.toJS({ maxAliasCount: 100 })
  }
  catch (e) {
    err('compose.yaml', `YAML invalide : ${(e as Error).message.split('\n')[0]}`)
    return empty
  }
  if (!isObj(source) || !isObj(source.services)) {
    err('compose.no_services', 'Le fichier Compose doit contenir une section « services »')
    return empty
  }
  const sourceYaml = YAML.stringify(source, { lineWidth: 0 })

  // --- env_file → variables de la plateforme (avant l'interpolation) ---
  const envChanges: Change[] = []
  const fromEnvFiles = new Map<string, string>()
  const envFileOrder: { path: string, keys: string[] }[] = []
  const envRefs: { service: string, svc: Obj, files: { path: string, required: boolean }[] }[] = []
  for (const [name, svc] of Object.entries(source.services as Record<string, unknown>)) {
    if (!isObj(svc) || svc.env_file === undefined) continue
    const files = envFileRefs(svc.env_file).map(f => ({ ...f, path: (() => {
      try {
        return validateRelativeEntry(posix.join(ctx.composeDir, f.path))
      }
      catch {
        return ''
      }
    })() }))
    envRefs.push({ service: name, svc, files })
    for (const f of files) if (f.path && ctx.envFileKeys?.[f.path]) envFileOrder.push({ path: f.path, keys: ctx.envFileKeys[f.path]! })
  }
  const envNames = envFileVarNames(envFileOrder)
  for (const { service, svc, files } of envRefs) {
    const added: string[] = []
    let blocked = false
    const env = toMap(svc.environment)
    for (const f of files) {
      const map = f.path ? envNames.get(f.path) : undefined
      if (!map) {
        if (!f.required) continue
        err('service.env_file', `env_file ${f.path || '(chemin invalide)'} absent des sources : définir ces variables dans la plateforme`, service)
        blocked = true
        continue
      }
      for (const [key, varName] of map) {
        fromEnvFiles.set(varName, f.path)
        // « environment » l'emporte sur env_file, comme dans Docker Compose.
        if (key in env) continue
        env[key] = `\${${varName}}`
        added.push(key)
      }
    }
    if (blocked) continue
    delete svc.env_file
    svc.environment = env
    envChanges.push({ service, kind: 'variable', message: `env_file ${files.map(f => f.path).join(', ')} → ${added.length} variable(s) de la plateforme` })
  }

  // --- Variables injectées dans l'environnement des services (sans modifier le Compose source) ---
  const sourceServices = source.services as Record<string, unknown>
  for (const [name, v] of Object.entries(ctx.variables)) {
    if (!v.inject?.length) continue
    const targets = v.inject.includes('*') ? Object.keys(sourceServices) : v.inject
    for (const service of targets) {
      const svc = sourceServices[service]
      if (!isObj(svc)) {
        warn('variable.inject_unknown', `Variable ${name} à injecter dans ${service} : service absent du Compose`)
        continue
      }
      const env = toMap(svc.environment)
      if (name in env) {
        info('variable.inject_kept', `Variable ${name} : déjà définie dans l'environnement de ${service} par le Compose (valeur du Compose conservée)`, service)
        continue
      }
      env[name] = `\${${name}}`
      svc.environment = env
      envChanges.push({ service, kind: 'variable', message: `Variable ${name} injectée dans l'environnement` })
    }
  }

  // --- Variables ---
  const uses = findVariables(envChanges.length ? YAML.stringify(source, { lineWidth: 0 }) : rawText)
  const missingSet = new Set<string>()
  const doc = interpolateTree(source as Obj, ctx.variables, missingSet)
  // Variables issues des env_file regroupées : une seule action (import) les fournit toutes.
  const missingFromFiles = new Map<string, string[]>()
  for (const name of missingSet) {
    const file = fromEnvFiles.get(name)
    if (file) missingFromFiles.set(file, [...(missingFromFiles.get(file) ?? []), name])
    else err('variable.missing', `Variable ${name} non définie (aucune valeur par défaut)`)
  }
  for (const [file, names] of missingFromFiles) {
    err('env_file.import', `${names.length} variable(s) de ${file} à importer dans la plateforme (${names.slice(0, 6).join(', ')}${names.length > 6 ? '…' : ''})`)
  }
  const variables = uses.map(u => ({ ...u, provided: ctx.variables[u.name] !== undefined, secret: ctx.variables[u.name]?.secret ?? false }))
  for (const name of Object.keys(ctx.variables)) {
    if (!uses.some(u => u.name === name)) info('variable.unused', `Variable ${name} définie mais non utilisée par le Compose`)
  }

  // --- Niveau racine ---
  for (const key of Object.keys(doc)) {
    if (key.startsWith('x-')) continue
    if (key === 'include') err('compose.include', '« include » n\'est pas autorisé : un seul fichier Compose par projet')
    else if (!KNOWN_TOP_LEVEL.has(key)) err('compose.unknown_key', `Clé de premier niveau inconnue : ${key}`)
  }
  for (const k of ['secrets', 'configs'] as const) {
    if (isObj(doc[k]) && Object.values(doc[k] as Obj).some(v => isObj(v) && 'file' in v)) {
      err(`compose.${k}_file`, `${k} à partir de fichiers non supportés : utiliser les variables (secrètes) de la plateforme`)
    }
  }

  // Services sous profil Compose : non démarrés par défaut (ni par Portainer) → ni construits, ni déployés, ni attendus.
  const allServices = doc.services as Record<string, Obj>
  const profiled = Object.entries(allServices).filter(([, v]) => isObj(v) && Array.isArray(v.profiles) && v.profiles.length > 0).map(([k]) => k)
  for (const name of profiled) info('service.profile', `Service sous profil (${(allServices[name]!.profiles as string[]).join(', ')}) : non déployé`, name)
  // Services exclus de la gestion (ex. Traefik d'une stack reprise) : retirés du Compose géré ;
  // leur conteneur tourne hors de la stack, et les autres services ne l'attendent plus au démarrage.
  // Services suspendus (ex. un service en échec qui bloquerait chaque mise à jour) : gardés dans la
  // source, retirés de la stack (conteneur supprimé au déploiement), ni démarrés ni contrôlés.
  const known = (list: readonly string[] | undefined, code: string, label: string) => {
    for (const name of list ?? []) if (!(name in allServices)) info(`${code}_stale`, `Service ${name} marqué « ${label} » mais absent du Compose : réglage sans effet`, name)
    return (list ?? []).filter(n => n in allServices)
  }
  const unmanaged = known(ctx.excludedServices, 'service.excluded', 'non géré')
  const suspended = known(ctx.suspendedServices, 'service.suspended', 'suspendu').filter(n => !unmanaged.includes(n))
  for (const name of unmanaged) info('service.excluded', 'Service non géré par la console : retiré de la stack, son conteneur continue de tourner hors de la stack', name)
  for (const name of suspended) info('service.suspended', 'Service suspendu : retiré de la stack (conteneur supprimé, données conservées), ni démarré ni contrôlé jusqu\'à sa reprise', name)
  const excluded = [...unmanaged, ...suspended]
  const services = Object.fromEntries(Object.entries(allServices).filter(([k]) => !profiled.includes(k) && !excluded.includes(k))) as Record<string, Obj>
  for (const [name, svc] of Object.entries(services)) {
    if (!isObj(svc)) continue
    if (typeof svc.network_mode === 'string' && excluded.some(x => svc.network_mode === `service:${x}`)) err('service.excluded_network', `Partage l'espace réseau de ${String(svc.network_mode).slice(8)}, non géré ou suspendu : le réintégrer ou retirer network_mode`, name)
    if (Array.isArray(svc.depends_on)) svc.depends_on = svc.depends_on.filter(d => !excluded.includes(String(d)))
    else if (isObj(svc.depends_on)) svc.depends_on = Object.fromEntries(Object.entries(svc.depends_on).filter(([d]) => !excluded.includes(d)))
    if (Array.isArray(svc.depends_on) && !svc.depends_on.length) delete svc.depends_on
    if (isObj(svc.depends_on) && !Object.keys(svc.depends_on).length) delete svc.depends_on
    if (Array.isArray(svc.links)) svc.links = svc.links.filter(l => !excluded.includes(String(l).split(':')[0]!))
  }
  doc.services = services
  const serviceNames = Object.keys(services)
  if (serviceNames.length === 0) err('compose.no_services', 'Aucun service défini')
  if (serviceNames.length > MAX_SERVICES) err('compose.too_many_services', `Plus de ${MAX_SERVICES} services`)

  const topNetworks = (isObj(doc.networks) ? doc.networks : {}) as Record<string, Obj | null>
  const topVolumes = (isObj(doc.volumes) ? doc.volumes : {}) as Record<string, Obj | null>
  const folderChanges = ctx.volumesAsFolders ? volumesToFolders(services, topVolumes) : []

  const builds: BuildPlan[] = []
  const images: Record<string, string> = {}
  const ports: PortReport[] = []
  const mounts: MountReport[] = []
  const health = applyHealthOverrides(services, ctx.healthchecks)
  issues.push(...health.issues)
  issues.push(...applyImageOverrides(services as Record<string, Record<string, unknown>>, ctx.imageOverrides))
  for (const [service, pg] of Object.entries(ctx.pgData ?? {})) {
    const svc = services[service]
    if (!svc) continue
    // Données migrées dans un sous-dossier du volume : le cluster de la nouvelle version.
    svc.environment = { ...toMap(svc.environment), PGDATA: pg.path }
    issues.push({ severity: 'info', code: 'pg.migrated', service, message: `Données migrées vers PostgreSQL ${pg.major} : PGDATA=${pg.path}` })
  }
  for (const g of shortGraceDependencies(services)) {
    info('healthcheck.short_grace', `${g.dependents.join(', ')} attend${g.dependents.length > 1 ? 'ent' : ''} que ce service soit sain : il est déclaré en échec après ${g.graceSec} s sans réponse, et le déploiement s'arrête. Un premier démarrage long (migrations) peut dépasser ce délai : allonger son start_period dans Réglages de la cible › Healthchecks.`, g.service)
  }
  const changes: Change[] = [...envChanges, ...folderChanges, ...health.changes]
  const usedNetworks = new Set<string>()
  const allowedRules = ctx.portRules

  for (const name of serviceNames) {
    const svc = services[name]
    if (!isObj(svc)) {
      err('service.invalid', 'Définition de service invalide', name)
      continue
    }
    if (!SERVICE_NAME_RE.test(name)) err('service.name', `Nom de service invalide : ${name}`, name)

    // --- Options dangereuses ---
    if (svc.privileged === true) err('service.privileged', 'Mode privilégié interdit', name)
    for (const k of ['pid', 'ipc', 'uts', 'userns_mode', 'cgroup'] as const) {
      if (svc[k] === 'host') err(`service.${k}_host`, `${k}: host interdit (partage de l'espace de l'hôte)`, name)
    }
    if (typeof svc.network_mode === 'string') {
      if (svc.network_mode === 'host') err('service.network_host', 'network_mode: host interdit', name)
      else if (/^(container|service):/.test(svc.network_mode)) warn('service.network_shared', `network_mode ${svc.network_mode} : pile réseau partagée`, name)
      else if (svc.network_mode !== 'bridge' && svc.network_mode !== 'none') err('service.network_mode', `network_mode non supporté : ${svc.network_mode}`, name)
    }
    for (const cap of (Array.isArray(svc.cap_add) ? svc.cap_add : []).map(c => String(c).toUpperCase().replace(/^CAP_/, ''))) {
      if (DANGEROUS_CAPS.has(cap)) err('service.cap_add', `Capacité ${cap} interdite`, name)
      else warn('service.cap_add', `Capacité supplémentaire ${cap}`, name)
    }
    if (svc.devices !== undefined || svc.device_cgroup_rules !== undefined) err('service.devices', 'Accès aux périphériques de l\'hôte interdit', name)
    if (Array.isArray(svc.security_opt) && svc.security_opt.some(o => /unconfined|label[:=]disable/i.test(String(o)))) err('service.security_opt', 'Désactivation du confinement (seccomp/apparmor/selinux) interdite', name)
    if (svc.volumes_from !== undefined) err('service.volumes_from', 'volumes_from interdit', name)
    if (svc.extends !== undefined) err('service.extends', 'extends non supporté', name)
    if (svc.sysctls !== undefined) warn('service.sysctls', 'Paramètres noyau (sysctls) modifiés', name)
    if (svc.extra_hosts !== undefined) info('service.extra_hosts', 'Résolutions DNS personnalisées (extra_hosts)', name)

    // --- Secrets : uniquement dans environment ---
    if (containsSecretToken(JSON.stringify({ ...svc, environment: undefined }))) err('variable.secret_misuse', 'Une variable secrète ne peut être utilisée que dans « environment »', name)

    // --- Labels ---
    const labels = toMap(svc.labels)
    for (const l of Object.keys(labels)) {
      if (RESERVED_LABEL.test(l)) err('labels.reserved', `Label réservé à la plateforme : ${l}`, name)
      if (TRAEFIK_LABEL.test(l) && (ctx.traefik?.provider ?? 'traefik') === 'traefik') err('labels.traefik', `Label Traefik manuel (${l}) : l'exposition est gérée par la configuration Traefik de la plateforme`, name)
    }

    // --- Image / build ---
    if (svc.build !== undefined) {
      const b = typeof svc.build === 'string' ? { context: svc.build } : isObj(svc.build) ? svc.build : null
      if (!b) {
        err('build.invalid', 'Section build invalide', name)
      }
      else {
        for (const k of ['dockerfile_inline', 'ssh', 'secrets', 'additional_contexts', 'extra_hosts', 'privileged', 'entitlements']) {
          if (b[k] !== undefined) err('build.option', `Option de build non autorisée : ${k}`, name)
        }
        if (b.network !== undefined && b.network !== 'default') err('build.network', 'Réseau de build personnalisé interdit', name)
        try {
          const ctxRaw = String(b.context ?? '.')
          if (/^[a-z]+:\/\//i.test(ctxRaw) || ctxRaw.startsWith('git@')) throw new PathViolation(ctxRaw, 'contexte distant interdit')
          if (ctxRaw.startsWith('/')) throw new PathViolation(ctxRaw, 'contexte absolu interdit')
          const context = validateRelativeEntry([ctx.composeDir, ctxRaw].filter(Boolean).join('/'))
          const dockerfile = validateRelativeEntry(String(b.dockerfile ?? 'Dockerfile'))
          const full = context ? `${context}/${dockerfile}` : dockerfile
          if (!ctx.files.has(full)) err('build.dockerfile_missing', `Dockerfile introuvable dans les sources : ${full}`, name)
          const image = imageTagFor(ctx.projectSlug, name, ctx.releaseSlug)
          builds.push({ service: name, context, dockerfile, args: Object.fromEntries(Object.entries(toMap(b.args)).map(([k, v]) => [k, v ?? ''])), target: typeof b.target === 'string' ? b.target : null, image })
          images[name] = image
          if (svc.image) info('build.image_ignored', `Image « ${String(svc.image)} » remplacée par l'image construite`, name)
        }
        catch (e) {
          err('build.context', `Contexte de build refusé : ${e instanceof PathViolation ? e.reason : (e as Error).message}`, name)
        }
      }
    }
    else if (typeof svc.image !== 'string' || !svc.image) {
      err('service.no_image', 'Ni « image » ni « build » : impossible de démarrer ce service', name)
    }
    else {
      images[name] = svc.image
      if (!svc.image.includes('@') && (!hasTag(svc.image) || svc.image.endsWith(':latest'))) {
        warn('image.latest', `Image ${svc.image} sans version figée (latest) : déploiement non reproductible`, name)
      }
    }

    // --- Ports ---
    // Ports retirés par la cible (reverse proxy uniquement) : absents du Compose déployé, gardés au rapport.
    const isUnpublished = (pub: number, protocol: string) => (ctx.unpublishedPorts ?? []).some(u => u.service === name && u.published === pub && u.protocol === protocol)
    const kept: unknown[] = []
    for (const raw of Array.isArray(svc.ports) ? svc.ports : []) {
      let p: PortEntry
      try {
        p = parsePort(typeof raw === 'string' ? unescapeDollars(raw) : raw)
      }
      catch (e) {
        err('ports.invalid', (e as EntryError).message, name)
        kept.push(raw)
        continue
      }
      const entry = typeof raw === 'string' ? raw : JSON.stringify(raw)
      if (p.published !== null && (p.publishedEnd === null || p.publishedEnd === p.published) && isUnpublished(p.published, p.protocol)) {
        ports.push({ service: name, entry, published: p.published, hostIp: p.hostIp, protocol: p.protocol, policy: 'internal', accepted: true, reason: 'Non publié : accès par le reverse proxy uniquement', needsApproval: false, containerPort: p.target, unpublished: true })
        changes.push({ service: name, kind: 'port', message: `Port ${p.published}/${p.protocol} non publié sur l'hôte (accès par le reverse proxy uniquement)` })
        if (!(ctx.exposures ?? []).some(e => e.service === name)) warn('ports.unpublished_unexposed', `Port ${p.published}/${p.protocol} non publié et aucune exposition web : service joignable seulement depuis les autres conteneurs`, name)
        continue
      }
      kept.push(raw)
      if (p.published === null) {
        err('ports.random', `Port ${p.target}/${p.protocol} publié sur un port aléatoire de l'hôte : préciser le port publié, ou utiliser « expose »`, name)
        ports.push({ service: name, entry, published: null, hostIp: p.hostIp, protocol: p.protocol, policy: 'forbidden', accepted: false, reason: 'Port publié non précisé', needsApproval: false, containerPort: p.target })
        continue
      }
      for (let pub = p.published; pub <= (p.publishedEnd ?? p.published); pub++) {
        const approval = ctx.portApprovals.find(a => a.service === name && a.published === pub && a.protocol === p.protocol)
        const d = evaluatePort({ hostPort: pub, containerPort: p.target, protocol: p.protocol, hostIp: p.hostIp ?? undefined, justification: approval?.justification, confirmed: approval?.confirmed }, allowedRules)
        ports.push({ service: name, entry, published: pub, hostIp: p.hostIp, protocol: p.protocol, policy: d.policy, accepted: d.accepted, reason: d.reason, needsApproval: d.policy === 'approval' && !d.accepted, containerPort: p.target + (pub - p.published) })
        if (!d.accepted) {
          if (d.policy === 'approval') err('ports.approval', `Port ${pub}/${p.protocol} : ${d.reason}`, name)
          else err('ports.forbidden', d.reason, name)
        }
        if (!p.hostIp || p.hostIp === '0.0.0.0' || p.hostIp === '::') warn('ports.all_interfaces', `Port ${pub}/${p.protocol} publié sur toutes les interfaces de l'hôte`, name)
      }
    }
    if (Array.isArray(svc.ports)) {
      if (kept.length) svc.ports = kept
      else delete svc.ports
    }

    // --- Volumes ---
    const rewritten: unknown[] = []
    for (const raw of Array.isArray(svc.volumes) ? svc.volumes : []) {
      let m: MountEntry
      try {
        m = parseMount(raw)
      }
      catch (e) {
        err('volumes.invalid', (e as EntryError).message, name)
        rewritten.push(raw)
        continue
      }
      const report: MountReport = { service: name, type: m.type, source: m.source, effectiveSource: m.source, target: m.target, readOnly: m.readOnly, accepted: true, reason: '' }
      if (!m.target.startsWith('/')) {
        report.accepted = false
        report.reason = 'Chemin dans le conteneur non absolu'
      }
      else if (m.type === 'other') {
        report.accepted = false
        report.reason = 'Type de montage non supporté'
      }
      else if (m.type === 'tmpfs') {
        report.reason = 'Système de fichiers temporaire'
      }
      else if (m.type === 'volume') {
        if (m.source === null) report.reason = 'Volume anonyme (données perdues au recréé)'
        else if (!(m.source in topVolumes)) {
          report.accepted = false
          report.reason = `Volume nommé « ${m.source} » non déclaré dans la section volumes`
        }
        else {
          const def = topVolumes[m.source]
          const external = isObj(def) && def.external === true
          const realName = isObj(def) && typeof def.name === 'string' ? def.name : m.source
          if (external && !ctx.dockerVolumes.includes(realName)) {
            report.accepted = false
            report.reason = `Volume externe « ${realName} » inexistant sur l'endpoint`
          }
          else if (isObj(def) && (def.driver !== undefined && def.driver !== 'local')) {
            report.accepted = false
            report.reason = `Driver de volume non autorisé : ${String(def.driver)}`
          }
          else if (isObj(def) && isObj(def.driver_opts) && ('device' in def.driver_opts || 'o' in def.driver_opts)) {
            report.accepted = false
            report.reason = 'Volume local avec device/options de montage : équivalent à un bind non contrôlé'
          }
          else {
            report.reason = external ? 'Volume externe existant' : `Volume nommé (préfixé par la stack : ${stackName}_${m.source})`
          }
        }
      }
      else if (m.type === 'bind') {
        const src = unescapeDollars(m.source ?? '')
        let effective: string
        try {
          if (src.startsWith('~')) throw new PathViolation(src, 'chemin relatif au répertoire personnel interdit')
          if (src.startsWith('/')) {
            effective = normalizeAbsolute(src)
          }
          else {
            if (!ctx.runtimeDir) throw new PathViolation(src, 'chemins non configurés pour cet environnement')
            const rel = validateRelativeEntry(src)
            // Fichiers fournis par les sources (ex. ./configuration du dépôt), montés en lecture seule depuis la release.
            const inSources = rel ? validateRelativeEntry(posix.join(ctx.composeDir, rel)) : ''
            const fromSources = !!ctx.sourceDir && m.readOnly && !!inSources && [...ctx.files].some(f => f === inSources || f.startsWith(`${inSources}/`))
            effective = fromSources ? `${ctx.sourceDir}/${inSources}` : rel ? `${ctx.runtimeDir}/${rel}` : ctx.runtimeDir
          }
          // Fuseau horaire de l'hôte (/etc/localtime…) : montage courant et sans risque, toujours en lecture seule.
          if (src.startsWith('/') && TIMEZONE_PATHS.some(t => effective === t || effective.startsWith(`${t}/`))) {
            report.accepted = true
            report.reason = 'Fuseau horaire de l\'hôte (lecture seule)'
            report.effectiveSource = effective
            if (!m.readOnly) {
              rewritten.push(readOnlyMount(m))
              changes.push({ service: name, kind: 'volume', message: `Bind « ${src} » monté en lecture seule (fuseau horaire de l'hôte)` })
              mounts.push(report)
              continue
            }
            rewritten.push(m.raw)
            mounts.push(report)
            continue
          }
          const fromRelease = !src.startsWith('/') && !!ctx.sourceDir && effective.startsWith(`${ctx.sourceDir}/`)
          const d = fromRelease
            ? { allowed: true, reason: 'Fichiers des sources de la release (lecture seule)' }
            : evaluateBind({ hostPath: effective, mode: m.readOnly ? 'ro' : 'rw', environmentId: ctx.environmentId, projectId: ctx.projectId, projectRuntimeDir: ctx.runtimeDir, workingRoots: ctx.workingRoots }, ctx.volumeRules)
          report.accepted = d.allowed
          report.reason = d.allowed && !src.startsWith('/') && !fromRelease ? 'Chemin relatif → répertoire runtime du projet (persistant entre releases)' : d.reason
          report.effectiveSource = effective
          if (d.allowed && effective !== src) {
            rewritten.push(rebuildMount(m, effective))
            changes.push({ service: name, kind: 'volume', message: `Bind « ${src} » → ${effective}` })
            mounts.push(report)
            continue
          }
        }
        catch (e) {
          report.accepted = false
          report.reason = e instanceof PathViolation ? `${e.reason} (${e.path})` : 'Chemin invalide'
        }
      }
      if (!report.accepted) err('volumes.refused', `${m.source ?? '(anonyme)'} → ${m.target} : ${report.reason}`, name)
      mounts.push(report)
      rewritten.push(raw)
    }
    if (Array.isArray(svc.volumes)) svc.volumes = rewritten

    // --- Réseaux ---
    if (svc.network_mode === undefined) for (const n of serviceNetworks(svc)) {
      if (n !== 'default' && !(n in topNetworks)) err('networks.undeclared', `Réseau « ${n} » non déclaré dans la section networks`, name)
      usedNetworks.add(n)
    }

    if (svc.healthcheck === undefined) info('healthcheck.missing', 'Pas de healthcheck : seul l\'état « démarré » sera contrôlé', name)
  }

  // --- Réseaux déclarés ---
  const networks: AnalysisResult['networks'] = []
  for (const [key, defRaw] of Object.entries(topNetworks)) {
    const def = isObj(defRaw) ? defRaw : {}
    if (def.external === true) {
      const realName = typeof def.name === 'string' ? def.name : key
      const pol = ctx.networks.find(n => n.name === realName && !n.missing)
      let status: 'allowed' | 'refused' = 'refused'
      let reason: string
      if (!pol) reason = 'Réseau externe inexistant sur l\'endpoint'
      else if (pol.policy !== 'allowed') reason = pol.policy === 'forbidden' ? 'Réseau interdit par la politique de l\'endpoint' : 'Réseau non encore examiné par un administrateur'
      else if (pol.allowedEnvironmentIds.length && !pol.allowedEnvironmentIds.includes(ctx.environmentId)) reason = `Réseau non autorisé pour l'environnement ${ctx.environmentKey}`
      else {
        status = 'allowed'
        reason = 'Réseau autorisé'
      }
      if (status === 'refused') err('networks.refused', `${realName} : ${reason}`)
      networks.push({ name: realName, external: true, status, reason })
    }
    else {
      const driver = typeof def.driver === 'string' ? def.driver : 'bridge'
      if (driver !== 'bridge') {
        err('networks.driver', `Réseau ${key} : driver « ${driver} » non autorisé (bridge uniquement)`)
        networks.push({ name: key, external: false, status: 'refused', reason: `Driver ${driver} non autorisé` })
      }
      else {
        if (def.ipam !== undefined || def.driver_opts !== undefined) warn('networks.custom', `Réseau ${key} : configuration IPAM/driver_opts personnalisée`)
        networks.push({ name: `${stackName}_${key}`, external: false, status: 'created', reason: 'Réseau privé de la stack, créé par Docker' })
      }
    }
    if (!usedNetworks.has(key)) info('networks.unused', `Réseau ${key} déclaré mais non utilisé`)
  }
  if (usedNetworks.has('default') && !('default' in topNetworks)) {
    networks.push({ name: `${stackName}_default`, external: false, status: 'created', reason: 'Réseau par défaut de la stack' })
  }

  // --- Exposition Traefik (§11) ---
  const exposures: ExposureReport[] = []
  const tr = ctx.traefik ?? null
  const provider = tr?.provider ?? 'traefik'
  const P = provider === 'traefik' ? 'Traefik' : provider
  const seenRoutes = new Set<string>()
  const routerCount = new Map<string, number>()
  for (const e of ctx.exposures ?? []) {
    const host = normalizeHost(e.host)
    const base = routerNameFor(tr?.routerNamePattern ?? '{project}-{env}-{service}', ctx.projectSlug, ctx.environmentKey, e.service)
    const n = (routerCount.get(base) ?? 0) + 1
    routerCount.set(base, n)
    const router = n === 1 ? base : `${base}-${n}`
    const report: ExposureReport = { ...e, host, router, url: `https://${host}${e.pathPrefix ?? ''}`, accepted: false, reason: '' }
    const svc = services[e.service]
    const routeKey = `${host}|${e.pathPrefix ?? ''}`
    const taken = (ctx.takenHosts ?? []).find(t => normalizeHost(t.host) === host && (t.pathPrefix ?? '') === (e.pathPrefix ?? ''))
    if (!tr) report.reason = 'Aucun reverse proxy (Traefik, nginx) n\'est configuré pour cet endpoint'
    else if (!svc) report.reason = `Service « ${e.service} » absent du Compose`
    else if (typeof svc.network_mode === 'string') report.reason = `Service avec network_mode : non raccordable au réseau ${P}`
    else if (!HOSTNAME_RE.test(host)) report.reason = `Nom d'hôte invalide : ${host}`
    else if (!isAllowedHost(host, tr.allowedDomains)) report.reason = `Domaine non autorisé sur cet endpoint (autorisés : ${tr.allowedDomains.join(', ') || 'aucun'})`
    else if (taken) report.reason = `Déjà utilisé par ${taken.owner}`
    else if (seenRoutes.has(routeKey)) report.reason = 'Même hôte et même chemin déclarés deux fois'
    else if (!Number.isInteger(e.port) || e.port < 1 || e.port > 65535) report.reason = `Port interne invalide : ${e.port}`
    else if (e.pathPrefix !== null && !PATH_PREFIX_RE.test(e.pathPrefix)) report.reason = `Préfixe de chemin invalide : ${e.pathPrefix}`
    else if (provider === 'traefik' && e.middlewares.some(m => !MIDDLEWARE_RE.test(m))) report.reason = 'Nom de middleware invalide'
    else if (!ctx.networks.some(n => n.name === tr.networkName && n.policy === 'allowed' && !n.missing)) report.reason = `Réseau ${P} « ${tr.networkName} » absent ou non autorisé`
    // nginx-proxy : un conteneur = un port (VIRTUAL_PORT) et au plus un chemin (VIRTUAL_PATH).
    else if (provider === 'nginx-proxy' && (ctx.exposures ?? []).some(o => o.service === e.service && o.port !== e.port)) report.reason = `nginx-proxy : un seul port exposé par service (${e.service} en déclare plusieurs)`
    else if (provider === 'nginx-proxy' && e.pathPrefix !== null && (ctx.exposures ?? []).filter(o => o.service === e.service).length > 1) report.reason = 'nginx-proxy : un préfixe de chemin n\'est possible que pour une exposition unique du service'
    else {
      report.accepted = true
      report.reason = tr.exposure === 'external' ? `Exposé via ${P} (accès externe)` : `Exposé via ${P} (réseau interne)`
      if (provider !== 'traefik' && e.middlewares.length) warn('proxy.middlewares_ignored', `${host} : middlewares Traefik ignorés par ${P} (${e.middlewares.join(', ')})`, e.service)
    }
    seenRoutes.add(routeKey)
    if (!report.accepted) err('traefik.exposure', `${host} → ${e.service} : ${report.reason}`, e.service)
    else if (tr?.exposure === 'external') warn('traefik.external', `${report.url} sera accessible depuis l'extérieur`, e.service)
    exposures.push(report)
  }

  // --- Watchtower (§12) ---
  const wt = ctx.watchtower?.enabled ? ctx.watchtower : null
  const watchtower: AnalysisResult['watchtower'] = []
  if (serviceNames.includes(WATCHTOWER_SERVICE)) err('watchtower.reserved', `Nom de service réservé à la plateforme : ${WATCHTOWER_SERVICE}`)
  if (!wt && serviceNames.some(n => Object.keys(toMap(services[n]!.labels)).some(l => l.startsWith(`${WT}.`)))) {
    info('watchtower.labels_ignored', 'Labels Watchtower présents, mais Watchtower est désactivé pour cette cible : ils sont ignorés')
  }
  if (wt) {
    for (const name of serviceNames) {
      const policy = watchtowerPolicyOf(wt, name, toMap(services[name]!.labels))
      if (policy === 'off') {
        watchtower.push({ service: name, policy, accepted: true, reason: 'Exclu' })
        continue
      }
      const image = images[name] ?? ''
      let reason = policy === 'monitor' ? 'Nouvelle image signalée, sans mise à jour' : 'Mis à jour par Watchtower'
      let accepted = true
      if (builds.some(b => b.service === name)) {
        accepted = false
        reason = 'Image construite par la plateforme (absente de tout registre) : redéployer depuis la source'
      }
      else if (image.includes('@sha256:')) {
        accepted = false
        reason = 'Image figée par son empreinte : aucune mise à jour possible'
      }
      else if (policy === 'update' && (!hasTag(image) || image.endsWith(':latest'))) {
        warn('watchtower.floating', `${name} : image flottante (${image}) mise à jour automatiquement — version imprévisible`, name)
      }
      if (!accepted) err('watchtower.service', `${name} : ${reason}`, name)
      watchtower.push({ service: name, policy, accepted, reason })
    }
    for (const s of Object.keys(wt.services)) {
      if (wt.mode !== 'labels' && !serviceNames.includes(s) && wt.services[s] !== 'off') info('watchtower.unknown_service', `Service ${s} sélectionné pour Watchtower mais absent du Compose`)
    }
    const updating = watchtower.filter(w => w.policy === 'update' && w.accepted)
    if (!watchtower.some(w => w.policy !== 'off')) warn('watchtower.empty', 'Watchtower activé sans aucun service sélectionné')
    if (ctx.sourceKind === 'github' && updating.length && !wt.acknowledgeGitDrift) {
      err('watchtower.git_drift', `Source Git et mises à jour automatiques (${updating.map(u => u.service).join(', ')}) : l'exécution pourra différer du dépôt. Le confirmer explicitement dans la configuration Watchtower.`)
    }
    else if (ctx.sourceKind === 'github' && updating.length) {
      warn('watchtower.git_drift', `Écart Git ↔ exécution accepté : ${updating.map(u => u.service).join(', ')} peuvent être mis à jour hors du dépôt`)
    }
    if (!ctx.watchtowerProfile) err('watchtower.profile', 'Aucun profil Watchtower pour ce serveur : en choisir un dans la configuration Watchtower de la cible')
    warn('watchtower.socket', `Watchtower du profil « ${ctx.watchtowerProfile?.name ?? '?'} » (conteneur partagé du serveur, accès au socket Docker) : il n'agit que sur les services sélectionnés (scope et labels)`)
  }

  const ok = !issues.some(i => i.severity === 'error')
  const secretVariables = variables.filter(v => v.secret).map(v => v.name)
  const result: AnalysisResult = { ok, stackName, issues, services: serviceNames, builds, images, ports, mounts, networks, variables, changes, sourceYaml, finalYaml: null, diff: null, secretVariables, exposures, watchtower }
  if (!ok) return result

  // --- Génération du Compose final ---
  const final: Obj = {}
  for (const [k, v] of Object.entries(doc)) {
    if (k === 'version' || k === 'name') {
      changes.push({ kind: 'removed', message: `Clé « ${k} » retirée (nom de projet fixé par la plateforme : ${stackName})` })
      continue
    }
    final[k] = v
  }
  const platformLabels = (svc: string) => ({
    'platform.managed': 'true',
    'platform.project': ctx.projectSlug,
    'platform.environment': ctx.environmentKey,
    'platform.release': ctx.releaseSlug,
    'platform.service': svc,
  })
  for (const name of profiled) changes.push({ service: name, kind: 'removed', message: 'Service sous profil retiré (non démarré par défaut)' })
  for (const name of serviceNames) {
    const svc = (final.services as Record<string, Obj>)[name]!
    const build = builds.find(b => b.service === name)
    if (build) {
      delete svc.build
      svc.image = build.image
      svc.pull_policy = 'never'
      changes.push({ service: name, kind: 'build', message: `Build remplacé par l'image construite sur le serveur cible : ${build.image}` })
    }
    if (svc.container_name !== undefined) {
      changes.push({ service: name, kind: 'container_name', message: `container_name « ${String(svc.container_name)} » retiré (évite les conflits entre environnements)` })
      delete svc.container_name
    }
    if (svc.restart === undefined && !isObj(svc.deploy)) {
      svc.restart = 'unless-stopped'
      changes.push({ service: name, kind: 'restart', message: 'Politique de redémarrage ajoutée : unless-stopped' })
    }
    svc.labels = { ...Object.fromEntries(Object.entries(toMap(svc.labels)).map(([k, v]) => [k, v ?? ''])), ...platformLabels(name) }
    changes.push({ service: name, kind: 'label', message: 'Labels de traçabilité platform.* ajoutés' })
  }
  // Sous-réseaux de la plage de l'endpoint (au lieu des /16 de Docker), sauf IPAM déjà écrit dans le Compose.
  for (const [key, subnet] of Object.entries(ctx.networkSubnets ?? {})) {
    const nets = (isObj(final.networks) ? final.networks : {}) as Record<string, Obj | null>
    const def = isObj(nets[key]) ? nets[key] as Obj : {}
    if (def.external === true) continue
    if (def.ipam !== undefined) {
      info('networks.subnet_kept', `Réseau ${key} : IPAM du Compose conservé (plage de l'endpoint non appliquée)`)
      continue
    }
    final.networks = { ...nets, [key]: { ...def, ipam: { config: [{ subnet }] } } }
    const n = networks.find(x => x.name === `${stackName}_${key}`)
    if (n) n.reason = `${n.reason} · sous-réseau ${subnet}`
    changes.push({ kind: 'network', message: `Réseau ${key} : sous-réseau ${subnet} (plage de l'endpoint)` })
  }
  if (tr && exposures.length) {
    final.networks = { ...(isObj(final.networks) ? final.networks as Obj : {}), [TRAEFIK_NETWORK_KEY]: { external: true, name: tr.networkName } }
    for (const e of exposures) {
      const svc = (final.services as Record<string, Obj>)[e.service]!
      // Raccordement au réseau Traefik sans perdre les réseaux existants (dont « default »).
      if (Array.isArray(svc.networks)) {
        if (!svc.networks.includes(TRAEFIK_NETWORK_KEY)) svc.networks = [...svc.networks, TRAEFIK_NETWORK_KEY]
      }
      else if (isObj(svc.networks)) {
        svc.networks = { ...svc.networks, [TRAEFIK_NETWORK_KEY]: {} }
      }
      else {
        svc.networks = ['default', TRAEFIK_NETWORK_KEY]
      }
      if (provider !== 'traefik') {
        // nginx : le service est joint par son alias unique sur le réseau du proxy (jamais un homonyme).
        const nets = Array.isArray(svc.networks) ? Object.fromEntries((svc.networks as string[]).map(n => [n, {}])) : { ...(svc.networks as Obj) }
        const def = isObj(nets[TRAEFIK_NETWORK_KEY]) ? nets[TRAEFIK_NETWORK_KEY] as Obj : {}
        const aliases = Array.isArray(def.aliases) ? def.aliases.map(String) : []
        const alias = aliasFor(stackName, e.service)
        nets[TRAEFIK_NETWORK_KEY] = { ...def, aliases: aliases.includes(alias) ? aliases : [...aliases, alias] }
        svc.networks = nets
      }
      if (provider === 'nginx-proxy') {
        // Variables lues par nginx-proxy (et acme-companion) ; un service exposé sous plusieurs noms : liste.
        const env = toMap(svc.environment)
        const hosts = exposures.filter(x => x.service === e.service).map(x => x.host)
        svc.environment = {
          ...env,
          VIRTUAL_HOST: [...new Set(hosts)].join(','),
          VIRTUAL_PORT: String(e.port),
          ...(e.pathPrefix ? { VIRTUAL_PATH: e.pathPrefix } : {}),
          ...(tr.letsencrypt ? { LETSENCRYPT_HOST: [...new Set(hosts)].join(',') } : {}),
          ...(tr.redirectToHttps ? {} : { HTTPS_METHOD: 'noredirect' }),
        }
        changes.push({ service: e.service, kind: 'variable', message: `Exposition nginx-proxy : ${e.url} → port ${e.port} (VIRTUAL_HOST${tr.letsencrypt ? ', LETSENCRYPT_HOST' : ''})` })
        continue
      }
      if (provider === 'nginx') {
        changes.push({ service: e.service, kind: 'network', message: `Exposition nginx : ${e.url} → ${aliasFor(stackName, e.service)}:${e.port} (fichier ${nginxSiteFile(stackName)} écrit dans ${'conf.d'} au déploiement)` })
        continue
      }
      const R = e.router
      const rule = `Host(\`${e.host}\`)${e.pathPrefix ? ` && PathPrefix(\`${e.pathPrefix}\`)` : ''}`
      const middlewares = [...new Set([...tr.defaultMiddlewares, ...e.middlewares])]
      const labels: Record<string, string> = {
        'traefik.enable': 'true',
        'traefik.docker.network': tr.networkName,
        [`traefik.http.routers.${R}.rule`]: rule,
        [`traefik.http.routers.${R}.entrypoints`]: tr.entrypointHttps,
        [`traefik.http.routers.${R}.tls`]: 'true',
        [`traefik.http.routers.${R}.service`]: R,
        [`traefik.http.services.${R}.loadbalancer.server.port`]: String(e.port),
        ...(tr.certResolver ? { [`traefik.http.routers.${R}.tls.certresolver`]: tr.certResolver } : {}),
        ...(middlewares.length ? { [`traefik.http.routers.${R}.middlewares`]: middlewares.join(',') } : {}),
        [`traefik.http.routers.${R}-http.rule`]: rule,
        [`traefik.http.routers.${R}-http.entrypoints`]: tr.entrypointHttp,
        ...(tr.redirectToHttps
          ? {
              [`traefik.http.routers.${R}-http.middlewares`]: `${R}-https-redirect`,
              [`traefik.http.routers.${R}-http.service`]: 'noop@internal',
              [`traefik.http.middlewares.${R}-https-redirect.redirectscheme.scheme`]: 'https',
              [`traefik.http.middlewares.${R}-https-redirect.redirectscheme.permanent`]: 'true',
            }
          : { [`traefik.http.routers.${R}-http.service`]: R }),
      }
      svc.labels = { ...(svc.labels as Record<string, string>), ...labels }
      changes.push({ service: e.service, kind: 'label', message: `Exposition Traefik : ${e.url} → port ${e.port}${tr.redirectToHttps ? ' (HTTP redirigé vers HTTPS)' : ''}` })
    }
    changes.push({ kind: 'network', message: `Réseau externe ${tr.networkName} ajouté (clé ${TRAEFIK_NETWORK_KEY}) pour le routage ${P}` })
  }
  // Alias uniques « <stack>-<service> » dès qu'un service est branché sur un réseau partagé.
  const plan = aliasPlan(final, stackName, [WATCHTOWER_SERVICE])
  if (plan) {
    for (const c of applyAliasPlan(final, plan)) changes.push({ ...(c.service ? { service: c.service } : {}), kind: 'network', message: c.message })
  }
  if (wt) {
    const finalServices = final.services as Record<string, Obj>
    for (const w of watchtower) {
      const svc = finalServices[w.service]!
      // Les labels Watchtower du Compose sont remplacés par la décision de la plateforme.
      const labels = Object.fromEntries(Object.entries(svc.labels as Record<string, string>).filter(([k]) => !k.startsWith(`${WT}.`)))
      labels[`${WT}.scope`] = ctx.watchtowerProfile?.scope ?? stackName
      labels[`${WT}.enable`] = w.policy === 'off' ? 'false' : 'true'
      if (w.policy === 'monitor') labels[`${WT}.monitor-only`] = 'true'
      svc.labels = labels
    }
    const selected = watchtower.filter(w => w.policy !== 'off')
    changes.push({ kind: 'label', message: `Rattaché au Watchtower du profil « ${ctx.watchtowerProfile?.name ?? '?'} » (${wt.mode === 'manual' ? 'détection seule' : 'mises à jour au rythme du profil'}) pour ${selected.map(w => `${w.service} (${w.policy === 'monitor' ? 'signalé' : 'mis à jour'})`).join(', ') || 'aucun service'}` })
  }
  for (const v of variables) {
    if (v.provided && !v.secret) changes.push({ kind: 'variable', message: `Variable ${v.name} substituée` })
    if (v.secret) changes.push({ kind: 'variable', message: `Variable secrète ${v.name} transmise à Portainer, jamais écrite dans le fichier` })
  }

  const finalYaml = restoreSecretRefs(YAML.stringify(final, { lineWidth: 0 }))
  result.finalYaml = `# Généré par la plateforme — ${stackName} — release ${ctx.releaseSlug}\n${finalYaml}`
  result.diff = createTwoFilesPatch('compose.source.yml', 'compose.final.yml', sourceYaml, finalYaml, '', '', { context: 3 })
  return result
}
