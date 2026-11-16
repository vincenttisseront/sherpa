/**
 * Conversion d'un Compose existant vers le modèle de la plateforme :
 * - routes Traefik (labels) → expositions gérées (domaine, port, chemin, middlewares) ;
 * - réseau Traefik retiré des services exposés (la plateforme le raccorde elle-même) ;
 * - binds relatifs → chemins réels de l'hôte (les données restent où elles sont) ;
 * - `build` → image en cours d'exécution (les sources ne sont pas disponibles).
 * Les commentaires du fichier d'origine sont conservés.
 */
import { parseMount } from '../compose/entries'
import { type Document, type YAMLMap, type YAMLSeq, isMap, isScalar, isSeq, parseDocument } from 'yaml'
import type { AdoptionNote } from '../../../shared/schemas/adoption'
import type { Exposure } from '../../../shared/schemas/analysis'
import type { ProxyRoute } from '../../../shared/schemas/proxy'

export interface ConvertContext {
  stackName: string
  /** Réseau Traefik de la plateforme (configuration enregistrée ou proposée). */
  traefikNetwork: string | null
  certResolver: string | null
  /** Routes actuelles vers les conteneurs de la stack. */
  routes: readonly ProxyRoute[]
  /** Middlewares définis dans les labels des conteneurs de la stack (nom → type). */
  stackMiddlewares: ReadonlyMap<string, string>
  /** Routes d'AUTRES stacks qui utilisent un middleware défini par celle-ci. */
  foreignMiddlewareUsers: ReadonlyMap<string, string[]>
  /** Montages réels par service : destination → source sur l'hôte. */
  mounts: Readonly<Record<string, readonly { destination: string, source: string | null }[]>>
  /** Image exécutée par service (remplace une section build). */
  runningImages: Readonly<Record<string, string>>
}

export interface ConvertResult {
  composeText: string
  exposures: Exposure[]
  notes: AdoptionNote[]
  droppedRoutes: string[]
}

function scalar(n: unknown): string | null {
  return isScalar(n) ? String(n.value) : typeof n === 'string' ? n : null
}

const describe = (r: ProxyRoute) => `${r.hosts.join(', ') || r.rule || r.router}${r.pathPrefix ?? ''} → ${r.container?.service ?? r.container?.name ?? '?'}`

export function convertCompose(text: string, ctx: ConvertContext): ConvertResult {
  const notes: AdoptionNote[] = []
  const droppedRoutes: string[] = []
  const exposures: Exposure[] = []
  const doc: Document = parseDocument(text)
  if (doc.errors.length) throw new Error(`Compose illisible : ${doc.errors[0]!.message.split('\n')[0]}`)
  const services = doc.get('services')
  if (!isMap(services)) throw new Error('Compose sans section services')

  const svcNodes = new Map<string, YAMLMap>()
  for (const pair of services.items) {
    const name = scalar(pair.key)
    if (name && isMap(pair.value)) svcNodes.set(name, pair.value as YAMLMap)
  }

  for (const [name, svc] of svcNodes) {
    // --- Labels Traefik retirés (convertis plus bas à partir des routes réelles) ---
    const labels = svc.get('labels')
    let removed = 0
    if (isMap(labels)) {
      for (const p of [...labels.items]) {
        const k = scalar(p.key) ?? ''
        if (/^traefik\./i.test(k)) {
          labels.delete(p.key)
          removed++
        }
      }
      if (!labels.items.length) svc.delete('labels')
    }
    else if (isSeq(labels)) {
      labels.items = labels.items.filter((i) => {
        const keep = !/^traefik\./i.test(scalar(i) ?? '')
        if (!keep) removed++
        return keep
      })
      if (!labels.items.length) svc.delete('labels')
    }
    if (removed) notes.push({ level: 'info', service: name, message: `${removed} label(s) Traefik retiré(s) : le routage est repris par les expositions gérées` })

    // --- env_file : le fichier n'est pas disponible, ses variables sont à définir dans la plateforme ---
    const envFile = svc.get('env_file')
    if (envFile !== undefined) {
      const files = (isSeq(envFile) ? envFile.items.map(i => (isMap(i) ? scalar(i.get('path')) : scalar(i))) : [scalar(envFile)]).filter((f): f is string => !!f)
      notes.push({ level: 'error', service: name, message: `env_file ${files.join(', ')} : fichier non disponible, définir ces variables dans la plateforme` })
      svc.delete('env_file')
    }

    // --- build : sources indisponibles, on fige l'image en cours ---
    if (svc.has('build')) {
      const img = ctx.runningImages[name]
      if (img) {
        svc.delete('build')
        svc.set('image', img)
        notes.push({ level: 'warning', service: name, message: `Image construite sur place : figée sur ${img}. Associer les sources (ZIP ou GitHub) pour reconstruire` })
      }
      else notes.push({ level: 'error', service: name, message: 'Image construite sur place et aucun conteneur en cours : fournir les sources (ZIP ou GitHub)' })
    }

    // --- Binds relatifs → chemins réels de l'hôte ---
    const vols = svc.get('volumes')
    if (isSeq(vols)) {
      vols.items = vols.items.map((item) => {
        const real = (dest: string) => ctx.mounts[name]?.find(m => m.destination === dest)?.source ?? null
        if (isMap(item)) {
          const src = scalar(item.get('source'))
          const dst = scalar(item.get('target'))
          if (scalar(item.get('type')) === 'bind' && src && dst && /^[.~]/.test(src)) {
            const abs = real(dst)
            if (abs) {
              item.set('source', abs)
              notes.push({ level: 'info', service: name, message: `Bind relatif ${src} remplacé par le chemin réel ${abs}` })
            }
            else notes.push({ level: 'warning', service: name, message: `Bind relatif ${src} : chemin réel inconnu (conteneur absent), il serait recréé vide sous le répertoire du projet` })
          }
          return item
        }
        const s = scalar(item)
        const m = s ? /^([.~][^:]*):([^:]+)(:.*)?$/.exec(s) : null
        if (!m) return item
        const abs = real(m[2]!)
        if (!abs) {
          notes.push({ level: 'warning', service: name, message: `Bind relatif ${m[1]} : chemin réel inconnu (conteneur absent), il serait recréé vide sous le répertoire du projet` })
          return item
        }
        notes.push({ level: 'info', service: name, message: `Bind relatif ${m[1]} remplacé par le chemin réel ${abs}` })
        return doc.createNode(`${abs}:${m[2]}${m[3] ?? ''}`)
      })
    }
    if (svc.has('container_name')) notes.push({ level: 'info', service: name, message: `container_name retiré par la plateforme : les autres conteneurs doivent joindre ce service par son nom « ${name} »` })
  }

  // --- Routes → expositions ---
  const seen = new Set<string>()
  const exposedServices = new Set<string>()
  for (const r of ctx.routes) {
    const svcName = r.container?.service
    if (r.provider === 'file') {
      notes.push({ level: 'info', service: svcName ?? null, message: `${describe(r)} : route définie dans la configuration fichier de Traefik, inchangée` })
      continue
    }
    // nginx déclaré dans la plateforme : un site défini à la main (ou VIRTUAL_HOST) devient une exposition gérée.
    const nginxSite = r.provider === 'nginx' && r.convertible
    if (r.provider !== 'docker' && !nginxSite) {
      notes.push({ level: 'info', service: svcName ?? null, message: `${describe(r)} : servie par un autre proxy (${r.router}), inchangée` })
      continue
    }
    if (nginxSite && !r.rule?.startsWith('VIRTUAL_HOST=')) {
      const origin = /\(([^)]+)\)$/.exec(r.warnings.find(w => w.startsWith('Site défini hors plateforme')) ?? '')?.[1]
      notes.push({ level: 'warning', service: svcName ?? null, message: `${describe(r)} : reprise en exposition gérée (fichier de site écrit par la console) ; retirer ensuite le bloc server d'origine${origin ? ` de ${origin}` : ''} pour éviter un doublon` })
    }
    // Routeur de redirection HTTP → HTTPS : refait par la plateforme.
    if (r.redirectsToHttps && !r.tls) continue
    // Routeur créé d'office par Traefik (règle par défaut « Host(`{{ normalize .Name }}`) ») : aucun
    // nom d'hôte public, rien à reprendre ; signalé seulement si le service n'a pas d'autre route.
    if (r.rule?.includes('{{')) {
      const other = ctx.routes.some(o => o !== r && o.container?.service === svcName && o.convertible && !o.rule?.includes('{{'))
      if (!other) notes.push({ level: 'info', service: svcName ?? null, message: `Routeur automatique de Traefik pour ${svcName ?? r.container?.name ?? r.router} (règle par défaut, sans nom d'hôte public) ignoré — exposer le service depuis l'onglet « Exposition web » si besoin` })
      continue
    }
    if (!r.convertible || !svcName || !svcNodes.has(svcName) || r.targetPort === null) {
      droppedRoutes.push(describe(r))
      notes.push({ level: 'warning', service: svcName ?? null, message: `${describe(r)} : règle « ${r.rule ?? '?'} » non convertible, à recréer à la main après la reprise` })
      continue
    }
    const middlewares: string[] = []
    for (const m of r.middlewares) {
      const [base, prov = 'docker'] = m.split('@') as [string, string | undefined]
      const type = prov === 'docker' ? ctx.stackMiddlewares.get(base) : undefined
      if (type === 'redirectscheme') continue
      if (type) {
        notes.push({ level: 'warning', service: svcName, message: `Middleware « ${base} » (${type}) défini dans les labels de la stack : non repris. Le déclarer dans la configuration Traefik (fournisseur fichier) puis l'ajouter à l'exposition` })
        continue
      }
      middlewares.push(`${base}@${prov}`)
    }
    if (!r.tls) notes.push({ level: 'info', service: svcName, message: `${describe(r)} : servie aujourd'hui en HTTP, elle le sera en HTTPS` })
    if (r.tls && r.certResolver && ctx.certResolver && r.certResolver !== ctx.certResolver) {
      notes.push({ level: 'info', service: svcName, message: `${describe(r)} : certificat délivré par « ${ctx.certResolver} » au lieu de « ${r.certResolver} »` })
    }
    for (const host of r.hosts) {
      const key = `${svcName}|${host}|${r.pathPrefix ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)
      exposures.push({ service: svcName, host, port: r.targetPort, pathPrefix: r.pathPrefix, middlewares })
      exposedServices.add(svcName)
    }
  }
  for (const [mw, users] of ctx.foreignMiddlewareUsers) {
    notes.push({ level: 'warning', service: null, message: `Middleware « ${mw} » défini par cette stack et utilisé ailleurs (${users.join(', ')}) : il disparaîtra au premier déploiement géré` })
  }

  // --- Réseau Traefik : raccordé par la plateforme pour les services exposés ---
  const topNets = doc.get('networks')
  if (ctx.traefikNetwork && isMap(topNets) && exposedServices.size) {
    const keys = topNets.items.filter((p) => {
      const k = scalar(p.key)
      const v = p.value
      const name = isMap(v) ? scalar(v.get('name')) : null
      return name === ctx.traefikNetwork || (k === ctx.traefikNetwork && !name)
    }).map(p => scalar(p.key)!)
    if (keys.length) {
      for (const name of exposedServices) {
        const svc = svcNodes.get(name)!
        const nets = svc.get('networks')
        if (isSeq(nets)) nets.items = nets.items.filter(i => !keys.includes(scalar(i) ?? ''))
        else if (isMap(nets)) for (const k of keys) nets.delete(k)
        const left = svc.get('networks')
        if ((isSeq(left) || isMap(left)) && !(left as YAMLSeq | YAMLMap).items.length) svc.delete('networks')
      }
      for (const k of keys) {
        const used = [...svcNodes.values()].some((svc) => {
          const nets = svc.get('networks')
          return (isSeq(nets) && nets.items.some(i => scalar(i) === k)) || (isMap(nets) && nets.has(k))
        })
        if (!used) topNets.delete(k)
      }
      if (!topNets.items.length) doc.delete('networks')
    }
  }
  if (!exposures.length && !droppedRoutes.length && !ctx.routes.length) notes.push({ level: 'info', service: null, message: 'Aucune route vers cette stack' })
  return { composeText: doc.toString({ lineWidth: 0 }), exposures, notes, droppedRoutes }
}

/** Port publié à remplacer par une exposition web derrière le Traefik de l'endpoint. */
export interface PublishedToWeb { service: string, published: number, protocol: 'tcp' | 'udp' }

/** Port publié d'une entrée « ports » (syntaxe courte ou longue), null si non publié. */
function publishedOf(item: unknown): { published: number, protocol: string } | null {
  if (isMap(item)) {
    const raw = item.get('published')
    const p = Number(isScalar(raw) ? raw.value : raw)
    const proto = item.get('protocol')
    return Number.isInteger(p) && p > 0 ? { published: p, protocol: String((isScalar(proto) ? proto.value : proto) ?? 'tcp') } : null
  }
  const s = scalar(item)
  if (!s) return null
  const [spec, proto = 'tcp'] = s.split('/') as [string, string | undefined]
  const parts = spec.replace(/^\[[^\]]+\]:/, 'x:').split(':')
  if (parts.length < 2) return null
  const p = Number(parts[parts.length - 2])
  return Number.isInteger(p) && p > 0 ? { published: p, protocol: proto } : null
}

/**
 * Retire du Compose les ports publiés remplacés par une exposition web : le
 * service n'est plus joignable que par le reverse proxy (réseau Traefik).
 * Renvoie le Compose et les ports effectivement retirés.
 */
export function dropPublishedPorts(text: string, ports: readonly PublishedToWeb[]): { composeText: string, removed: PublishedToWeb[] } {
  if (!ports.length) return { composeText: text, removed: [] }
  const doc = parseDocument(text)
  const services = doc.get('services')
  const removed: PublishedToWeb[] = []
  if (!isMap(services)) return { composeText: text, removed }
  for (const pair of services.items) {
    const name = scalar(pair.key)
    if (!name || !isMap(pair.value)) continue
    const svc = pair.value as YAMLMap
    const list = svc.get('ports')
    if (!isSeq(list)) continue
    list.items = list.items.filter((item) => {
      const p = publishedOf(item)
      const hit = p && ports.find(x => x.service === name && x.published === p.published && x.protocol === p.protocol)
      if (hit) removed.push(hit)
      return !hit
    })
    if (!list.items.length) svc.delete('ports')
  }
  return { composeText: doc.toString({ lineWidth: 0 }), removed }
}

/** Retire des montages (service, point de montage dans le conteneur) d'un Compose, commentaires conservés. */
export function dropMounts(text: string, mounts: readonly { service: string, target: string }[]): { composeText: string, removed: { service: string, target: string }[] } {
  if (!mounts.length) return { composeText: text, removed: [] }
  const doc = parseDocument(text)
  const services = doc.get('services')
  const removed: { service: string, target: string }[] = []
  if (!isMap(services)) return { composeText: text, removed }
  for (const pair of services.items) {
    const name = scalar(pair.key)
    if (!name || !isMap(pair.value)) continue
    const svc = pair.value as YAMLMap
    const list = svc.get('volumes')
    if (!isSeq(list)) continue
    list.items = list.items.filter((item) => {
      const raw = (item as { toJSON?: () => unknown }).toJSON?.() ?? item
      let target: string | null = null
      try {
        target = parseMount(raw).target
      }
      catch {
        return true
      }
      const hit = mounts.find(m => m.service === name && m.target === target)
      if (hit) removed.push(hit)
      return !hit
    })
    if (!list.items.length) svc.delete('volumes')
  }
  return { composeText: doc.toString({ lineWidth: 0 }), removed }
}
