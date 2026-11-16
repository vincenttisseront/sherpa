/**
 * Installateur Harbor : son Compose n'est pas livré, il est produit par l'étape
 * « prepare » (image goharbor/prepare) à partir de harbor.yml. La plateforme
 * remplit harbor.yml (HTTP derrière le Traefik géré, TLS terminé par Traefik,
 * données et journaux dans le dossier de données du projet), exécute prepare
 * sur l'hôte, puis adapte le Compose produit : chemins relatifs rendus absolus
 * (fichiers de configuration écrits par prepare sur l'hôte), ports du proxy
 * retirés (exposition par Traefik). Fonctions pures, sans accès à l'hôte.
 */
import { posix } from 'node:path'
import YAML from 'yaml'
import { HOSTNAME_RE } from '../../../shared/utils/domains'
import { byCode } from '../../../shared/utils/compare'

export interface HarborInstaller {
  /** Dossier racine de l'archive (« harbor »), ou null. */
  root: string | null
  /** Version des images, lue dans le script prepare (ex. v2.15.4). */
  version: string
  prepareImage: string
  templatePath: string
  preparePath: string
}

const VERSION_RE = /goharbor\/prepare:(v\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?)\b/

/** Fichiers caractéristiques d'un installateur Harbor (prepare et harbor.yml.tmpl à la racine). */
export function harborInstallerPaths(entries: readonly string[], root: string | null): { preparePath: string, templatePath: string } | null {
  const at = (f: string) => (root ? `${root}/${f}` : f)
  return entries.includes(at('prepare')) && entries.includes(at('harbor.yml.tmpl')) ? { preparePath: at('prepare'), templatePath: at('harbor.yml.tmpl') } : null
}

export function detectHarborInstaller(entries: readonly string[], root: string | null, prepareScript: string): HarborInstaller | null {
  const paths = harborInstallerPaths(entries, root)
  const version = VERSION_RE.exec(prepareScript)?.[1]
  if (!paths || !version) return null
  return { root, version, prepareImage: `goharbor/prepare:${version}`, ...paths }
}

export interface HarborSettings {
  hostname: string
  /** URL publique (HTTPS terminé par Traefik). */
  externalUrl: string
  adminPassword: string
  dbPassword: string
  /** Chemins sur l'hôte. */
  dataVolume: string
  logLocation: string
}

/** Règle Harbor : 8 à 128 caractères, avec majuscule, minuscule et chiffre. */
export function harborPasswordProblem(p: string): string | null {
  if (p.length < 8 || p.length > 128) return '8 à 128 caractères'
  if (!/[A-Z]/.test(p) || !/[a-z]/.test(p) || !/\d/.test(p)) return 'Au moins une majuscule, une minuscule et un chiffre'
  return null
}

/** harbor.yml à partir du modèle de l'installateur (commentaires conservés). */
export function renderHarborConfig(template: string, s: HarborSettings): string {
  if (!HOSTNAME_RE.test(s.hostname)) throw new Error(`Nom d'hôte invalide : ${s.hostname}`)
  const doc = YAML.parseDocument(template)
  if (doc.errors.length) throw new Error(`harbor.yml.tmpl illisible : ${doc.errors[0]!.message}`)
  doc.set('hostname', s.hostname)
  // HTTP uniquement : le TLS est terminé par le Traefik de la plateforme.
  doc.delete('https')
  doc.setIn(['http', 'port'], 80)
  doc.set('external_url', s.externalUrl)
  doc.set('harbor_admin_password', s.adminPassword)
  doc.setIn(['database', 'password'], s.dbPassword)
  doc.set('data_volume', s.dataVolume)
  doc.setIn(['log', 'local', 'location'], s.logLocation)
  return doc.toString({ lineWidth: 0 })
}

/**
 * nginx.conf du proxy de Harbor : les blocs upstream (core, portal…) sont résolus
 * une seule fois au démarrage de nginx. Un service recréé seul (variable modifiée,
 * image mise à jour par Watchtower) change d'adresse et nginx relaie alors vers une
 * adresse périmée (connexion refusée, 401 d'un autre service). Résolution continue
 * par le DNS de Docker : zone partagée et paramètre resolve (nginx ≥ 1.27.3).
 */
export function patchHarborNginx(conf: string): { conf: string, changed: boolean } {
  if (conf.includes('# platform: resolve')) return { conf, changed: false }
  let out = conf.replace(/^(\s*)http\s*\{/m, (m, indent: string) => `${m}\n${indent}  # platform: resolve — adresses des services relues en continu (DNS de Docker)\n${indent}  resolver 127.0.0.11 valid=10s ipv6=off;`)
  out = out.replace(/upstream\s+([\w-]+)\s*\{([^}]*)\}/g, (_m, name: string, body: string) => {
    const servers = body.replace(/(server\s+[^;\s]+)([^;]*);/g, (s, head: string, rest: string) => (/\bresolve\b/.test(rest) ? s : `${head}${rest} resolve;`))
    const zone = /\bzone\b/.test(servers) ? '' : `\n    zone ${name} 64k;`
    return `upstream ${name} {${zone}${servers}}`
  })
  return { conf: out, changed: out !== conf }
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

export interface AdaptedCompose {
  yaml: string
  /** env_file référencés (chemins relatifs à la racine du Compose). */
  envFiles: string[]
  changes: string[]
}

/**
 * Compose produit par prepare → Compose déployable par la plateforme :
 * montages relatifs (./common/config/…) rendus absolus vers le dossier où prepare
 * a écrit la configuration sur l'hôte ; ports publiés du proxy retirés.
 */
export function adaptHarborCompose(text: string, composeDir: string): AdaptedCompose {
  const doc = YAML.parse(text) as Obj
  if (!isObj(doc) || !isObj(doc.services)) throw new Error('Compose produit par prepare illisible')
  const changes: string[] = []
  const envFiles = new Set<string>()
  const absolute = (src: string) => (src.startsWith('./') || src.startsWith('../') ? posix.join(composeDir, src) : src)

  for (const [name, svc] of Object.entries(doc.services as Record<string, Obj>)) {
    if (!isObj(svc)) continue
    if (Array.isArray(svc.volumes)) {
      svc.volumes = svc.volumes.map((v) => {
        if (typeof v === 'string') {
          const [src, ...rest] = v.split(':')
          const abs = absolute(src!)
          return abs === src ? v : [abs, ...rest].join(':')
        }
        if (isObj(v) && v.type === 'bind' && typeof v.source === 'string') return { ...v, source: absolute(v.source) }
        return v
      })
    }
    const refs = Array.isArray(svc.env_file) ? svc.env_file : svc.env_file ? [svc.env_file] : []
    for (const r of refs) if (typeof r === 'string') envFiles.add(posix.normalize(r))
    // Le proxy de Harbor est exposé par Traefik (port 8080 du conteneur) : aucun port publié sur l'hôte.
    if (name === 'proxy' && svc.ports) {
      delete svc.ports
      changes.push('proxy : ports publiés retirés (exposition par Traefik sur le port 8080)')
    }
  }
  changes.unshift(`Montages ./common/config/… rendus absolus vers ${composeDir}`)
  return { yaml: YAML.stringify(doc, { lineWidth: 0 }), envFiles: [...envFiles].sort(byCode), changes }
}
