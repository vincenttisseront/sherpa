/**
 * Alias uniques des services d'une stack branchée sur un réseau partagé (réseau Traefik, réseau
 * externe). Sur un tel réseau, un nom court (« redis », « postgres ») peut être porté par un
 * conteneur d'une autre stack, et le DNS de Docker y envoyer le service. La plateforme :
 * - donne à chaque service l'alias « <stack>-<service> » sur ses réseaux propres ;
 * - réécrit, dans l'environnement des services branchés sur un réseau partagé, les noms d'hôte
 *   qui désignent un service de la stack (URL de connexion, variables *_HOST…) vers cet alias.
 * Les valeurs littérales sont réécrites dans le Compose final ; les variables secrètes (jamais
 * écrites dans le fichier) le sont au déploiement, à partir du même plan.
 */
import YAML from 'yaml'
import { SECRET_TOKEN_PREFIX } from './interpolate'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

export interface AliasPlan {
  /** Service → alias unique. */
  aliases: Record<string, string>
  /** Services branchés sur un réseau partagé (environnement réécrit). */
  consumers: string[]
  /** Variables secrètes citées par l'environnement de ces services → réécriture d'un hôte nu permise. */
  secretVars: Record<string, boolean>
}

export const aliasFor = (stack: string, service: string) => `${stack}-${service}`.toLowerCase().replace(/[^a-z0-9.-]/g, '-').slice(0, 63)

const HOST_KEY = /(HOST|HOSTNAME|SERVER|ADDR|ADDRESS)$/i
const REF_RE = new RegExp(`\\$\\{(\\w+)(?:[:?-][^}]*)?\\}|\\$(\\w+)|${SECRET_TOKEN_PREFIX}(\\w+)__`, 'g')

/**
 * Remplace les hôtes désignant un service : partie hôte des URL (scheme://[user[:mdp]@]hôte[:port]),
 * et, si `bare`, une valeur réduite à « hôte » ou « hôte:port ».
 */
export function rewriteHosts(value: string, aliases: Record<string, string>, bare: boolean): string {
  let out = value.replace(/([a-z][a-z0-9+.-]*:\/\/(?:[^/\s]*@)?)([A-Za-z0-9_.-]+)(?=[:/?#,\s]|$)/gi, (m, prefix: string, host: string) => {
    const to = aliases[host.toLowerCase()]
    return to ? `${prefix}${to}` : m
  })
  if (bare) {
    const m = out.match(/^([A-Za-z0-9_.-]+)(:\d+)?$/)
    const to = m && aliases[m[1]!.toLowerCase()]
    if (to) out = `${to}${m![2] ?? ''}`
  }
  return out
}

function serviceNetworkKeys(svc: Obj): string[] | null {
  if (svc.network_mode !== undefined) return null
  const n = svc.networks
  if (Array.isArray(n)) return n.map(String)
  if (isObj(n)) return Object.keys(n)
  return ['default']
}

function envEntries(svc: Obj): [string, string][] {
  const e = svc.environment
  if (Array.isArray(e)) {
    return e.map(String).map((x) => {
      const i = x.indexOf('=')
      return (i < 0 ? [x, ''] : [x.slice(0, i), x.slice(i + 1)]) as [string, string]
    })
  }
  if (isObj(e)) return Object.entries(e).map(([k, v]) => [k, v === null || v === undefined ? '' : String(v)])
  return []
}

/** Plan pour un Compose (arbre) : null si aucun service n'est branché sur un réseau partagé. */
export function aliasPlan(doc: Obj, stack: string, exclude: readonly string[] = []): AliasPlan | null {
  const services = (isObj(doc.services) ? doc.services : {}) as Record<string, Obj>
  const nets = (isObj(doc.networks) ? doc.networks : {}) as Record<string, unknown>
  const external = (key: string) => isObj(nets[key]) && (nets[key] as Obj).external === true
  const names = Object.keys(services).filter(s => !exclude.includes(s))
  const consumers = names.filter(s => serviceNetworkKeys(services[s]!)?.some(external))
  if (!consumers.length) return null
  const aliases = Object.fromEntries(names.filter(s => serviceNetworkKeys(services[s]!)?.some(k => !external(k))).map(s => [s.toLowerCase(), aliasFor(stack, s)]))
  const secretVars: Record<string, boolean> = {}
  for (const c of consumers) {
    for (const [key, value] of envEntries(services[c]!)) {
      for (const m of value.matchAll(REF_RE)) {
        const name = (m[1] ?? m[2] ?? m[3])!
        const before = value.slice(0, m.index)
        const bare = (value === m[0] && HOST_KEY.test(key)) || HOST_KEY.test(name) || /(:\/\/|@)$/.test(before)
        secretVars[name] = (secretVars[name] ?? false) || bare
      }
    }
  }
  return { aliases, consumers, secretVars }
}

/**
 * Applique le plan au Compose final (arbre modifié) : alias sur les réseaux propres de chaque
 * service, réécriture des valeurs littérales des services branchés sur un réseau partagé.
 * Retourne les messages de changement.
 */
export function applyAliasPlan(doc: Obj, plan: AliasPlan): { service?: string, message: string }[] {
  const changes: { service?: string, message: string }[] = []
  const services = doc.services as Record<string, Obj>
  const nets = (isObj(doc.networks) ? doc.networks : {}) as Record<string, unknown>
  const external = (key: string) => isObj(nets[key]) && (nets[key] as Obj).external === true
  for (const [name, svc] of Object.entries(services)) {
    const alias = plan.aliases[name.toLowerCase()]
    const keys = serviceNetworkKeys(svc)
    if (!alias || !keys) continue
    const current = isObj(svc.networks) ? svc.networks as Record<string, unknown> : {}
    svc.networks = Object.fromEntries(keys.map((k) => {
      const def = isObj(current[k]) ? { ...(current[k] as Obj) } : {}
      if (!external(k)) {
        const list = Array.isArray(def.aliases) ? def.aliases.map(String) : []
        if (!list.includes(alias)) def.aliases = [...list, alias]
      }
      return [k, def]
    }))
    changes.push({ service: name, message: `Alias unique « ${alias} » sur ${keys.filter(k => !external(k)).join(', ')} (évite les homonymes des réseaux partagés)` })
  }
  for (const c of plan.consumers) {
    const svc = services[c]!
    const rewritten: string[] = []
    const fix = (key: string, value: string) => {
      const next = rewriteHosts(value, plan.aliases, HOST_KEY.test(key))
      if (next !== value) rewritten.push(key)
      return next
    }
    if (Array.isArray(svc.environment)) {
      svc.environment = svc.environment.map(String).map((x) => {
        const i = x.indexOf('=')
        return i < 0 ? x : `${x.slice(0, i)}=${fix(x.slice(0, i), x.slice(i + 1))}`
      })
    }
    else if (isObj(svc.environment)) {
      svc.environment = Object.fromEntries(Object.entries(svc.environment).map(([k, v]) => [k, typeof v === 'string' ? fix(k, v) : v]))
    }
    if (rewritten.length) changes.push({ service: c, message: `Hôtes des services remplacés par leurs alias uniques dans ${rewritten.join(', ')} (service branché sur un réseau partagé)` })
  }
  const secrets = Object.keys(plan.secretVars)
  if (secrets.length) changes.push({ message: `Variables secrètes ${secrets.join(', ')} : hôtes des services remplacés par leurs alias uniques au déploiement` })
  return changes
}

/** Plan relu depuis le Compose final (texte) : réécriture des variables secrètes au déploiement. */
export function aliasPlanFromYaml(yamlText: string, stack: string, exclude: readonly string[] = []): AliasPlan | null {
  try {
    const doc = YAML.parse(yamlText) as unknown
    return isObj(doc) ? aliasPlan(doc, stack, exclude) : null
  }
  catch {
    return null
  }
}

/** Variables transmises à la stack, hôtes réécrits ; noms des variables modifiées (jamais les valeurs). */
export function rewriteStackEnv(env: { name: string, value: string }[], plan: AliasPlan | null): { env: { name: string, value: string }[], rewritten: string[] } {
  if (!plan) return { env, rewritten: [] }
  const rewritten: string[] = []
  const out = env.map((e) => {
    if (!(e.name in plan.secretVars)) return e
    const value = rewriteHosts(e.value, plan.aliases, plan.secretVars[e.name]!)
    if (value !== e.value) rewritten.push(e.name)
    return { name: e.name, value }
  })
  return { env: out, rewritten }
}
