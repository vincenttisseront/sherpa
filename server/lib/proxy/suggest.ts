/**
 * Configuration Traefik de la plateforme proposée à partir de l'existant :
 * réseau, points d'entrée, résolveur, domaines, middlewares communs. Rien
 * n'est enregistré : l'administrateur valide dans le formulaire.
 */
import type { ProxyCandidate, ProxyKind, ProxyRoute, ProxyTopology, TraefikSuggestion } from '../../../shared/schemas/proxy'
import { HOSTNAME_RE, isAllowedHost } from '../../../shared/utils/domains'

export interface NetworkInfo { name: string, policy: 'unreviewed' | 'allowed' | 'forbidden', missing: boolean }

function mostCommon<T>(items: readonly T[]): T | null {
  const counts = new Map<T, number>()
  for (const i of items) counts.set(i, (counts.get(i) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
}

/**
 * Motifs de domaines couvrant les hôtes : deux hôtes ou plus sous le même parent
 * donnent `*.parent` (un seul niveau), un hôte isolé reste exact.
 */
export function domainPatterns(hosts: readonly string[]): string[] {
  // Un joker n'est proposé que sous un parent à deux niveaux au moins (jamais « *.org »), sauf localhost.
  const wild = (h: string) => h.split('.').length >= 3 || h.endsWith('.localhost')
  const valid = [...new Set(hosts.map(h => h.toLowerCase()))].filter(h => HOSTNAME_RE.test(h) && wild(h))
  const exact = [...new Set(hosts.map(h => h.toLowerCase()))].filter(h => HOSTNAME_RE.test(h) && !wild(h))
  const byParent = new Map<string, string[]>()
  for (const h of valid) {
    const parent = h.slice(h.indexOf('.') + 1)
    byParent.set(parent, [...(byParent.get(parent) ?? []), h])
  }
  const out = new Set<string>(exact)
  for (const [parent, hs] of byParent) {
    if (hs.length >= 2) out.add(`*.${parent}`)
    else out.add(hs[0]!)
  }
  return [...out].sort()
}

export function suggestTraefikConfig(topo: ProxyTopology, networks: readonly NetworkInfo[], existingDomains: readonly string[] = []): TraefikSuggestion {
  const proxy = topo.proxies.find(p => p.kind === 'traefik' && p.traefik)
  if (!proxy?.traefik) return { available: false, config: null, notes: {}, warnings: ['Aucun Traefik détecté sur cet endpoint'] }
  const st = proxy.traefik
  const notes: Record<string, string> = {}
  const warnings: string[] = []
  const traefikRoutes = topo.routes.filter((r): r is ProxyRoute => (r.provider === 'docker' || r.provider === 'file') && r.kind === 'http')
  const tcpEps = st.entrypoints.filter(e => e.protocol === 'tcp')

  // Réseau : celui du fournisseur Docker, sinon le plus utilisé par les routes, sinon celui de Traefik.
  const routeNet = mostCommon(traefikRoutes.map(r => r.network).filter((n): n is string => !!n))
  const networkName = (st.providers.docker?.network && proxy.networks.includes(st.providers.docker.network) ? st.providers.docker.network : null) ?? routeNet ?? proxy.networks[0] ?? ''
  notes.networkName = st.providers.docker?.network === networkName
    ? 'Réseau déclaré pour le fournisseur Docker de Traefik'
    : routeNet === networkName ? 'Réseau utilisé par la majorité des routes existantes' : 'Réseau auquel Traefik est attaché'
  const net = networks.find(n => n.name === networkName)
  if (!networkName) warnings.push('Traefik n\'est attaché à aucun réseau utilisable')
  else if (!net || net.missing) warnings.push(`Réseau « ${networkName} » inconnu de la plateforme : relancer la découverte`)
  else if (net.policy !== 'allowed') warnings.push(`Réseau « ${networkName} » à autoriser dans « Réseaux et volumes » avant d'enregistrer`)

  const https = tcpEps.find(e => e.port === 443) ?? tcpEps.find(e => e.tls) ?? null
  const http = tcpEps.find(e => e.port === 80) ?? tcpEps.find(e => !!e.redirectTo) ?? null
  const entrypointHttps = https?.name ?? 'websecure'
  const entrypointHttp = http?.name ?? 'web'
  notes.entrypointHttps = https ? `${https.name} (${https.address ?? '?'})${https.hostPorts.length ? ` publié sur ${https.hostPorts.join(', ')}` : ''}` : 'Aucun point d\'entrée HTTPS trouvé : valeur par défaut'
  notes.entrypointHttp = http ? `${http.name} (${http.address ?? '?'})${http.redirectTo ? `, redirige déjà vers ${http.redirectTo}` : ''}` : 'Aucun point d\'entrée HTTP trouvé : valeur par défaut'
  if (!https) warnings.push('Aucun point d\'entrée sur le port 443 : les expositions HTTPS ne fonctionneront pas')

  const resolvers = traefikRoutes.map(r => r.certResolver).filter((n): n is string => !!n)
  const certResolver = https?.certResolver ?? mostCommon(resolvers) ?? (st.certResolvers.length === 1 ? st.certResolvers[0]!.name : null)
  const res = st.certResolvers.find(r => r.name === certResolver)
  notes.certResolver = certResolver
    ? `${certResolver}${res?.challenge ? ` (challenge ${res.challenge}${res.dnsProvider ? ` ${res.dnsProvider}` : ''})` : ''}${resolvers.length ? `, utilisé par ${resolvers.filter(r => r === certResolver).length} route(s)` : ''}`
    : proxy.certificates.files ? 'Certificats fournis par fichier : pas de résolveur ACME' : 'Aucun résolveur ACME configuré'
  if (res?.staging) warnings.push(`Le résolveur « ${res.name} » délivre des certificats de test`)

  const hosts = traefikRoutes.filter(r => !(r.redirectsToHttps && !r.tls)).flatMap(r => r.hosts)
  // Les domaines déjà autorisés sont conservés ; seuls les hôtes qu'ils ne couvrent pas sont ajoutés.
  const uncovered = hosts.filter(h => !isAllowedHost(h, existingDomains))
  const added = domainPatterns(uncovered)
  const allowedDomains = [...new Set([...existingDomains, ...added])].sort()
  notes.allowedDomains = !hosts.length
    ? (existingDomains.length ? 'Aucun domaine routé : domaines autorisés actuels conservés' : 'Aucun domaine routé : à compléter')
    : added.length
      ? `${existingDomains.length ? 'Domaines actuels conservés, ajoutés' : 'Déduits'} de ${new Set(uncovered).size} domaine(s) déjà routé(s) : ${added.join(', ')} ; « *.x » couvre un seul niveau`
      : `Les ${new Set(hosts).size} domaine(s) routé(s) sont déjà couverts par les domaines autorisés`

  // Middlewares présents sur toutes les routes HTTPS (hors redirections) de plusieurs stacks, et
  // durables : définis par fichier ou sur le conteneur Traefik, pas dans les labels d'une application.
  const secured = traefikRoutes.filter(r => r.tls)
  const redirectTypes = new Set(topo.middlewares.filter(m => m.type === 'redirectscheme' || m.type === 'redirectregex').map(m => m.name.split('@')[0]))
  const appDefined = new Set(topo.middlewares.filter(m => m.name.endsWith('@docker') && m.provider !== proxy.container.name).map(m => m.name.split('@')[0]))
  const qualify = (m: string, provider: string) => (m.includes('@') ? m : `${m}@${provider}`)
  const stacksCount = new Set(secured.map(r => r.container?.stack ?? r.router)).size
  let common = secured.length >= 2 && stacksCount >= 2 ? secured[0]!.middlewares.map(m => qualify(m, secured[0]!.provider)) : []
  for (const r of secured.slice(1)) common = common.filter(m => r.middlewares.map(x => qualify(x, r.provider)).includes(m))
  const defaultMiddlewares = common.filter((m) => {
    const [base, prov] = m.split('@') as [string, string]
    return !redirectTypes.has(base) && !(prov === 'docker' && appDefined.has(base))
  })
  notes.defaultMiddlewares = defaultMiddlewares.length
    ? 'Appliqués à toutes les routes HTTPS existantes'
    : common.length ? 'Middlewares communs définis par une application : non repris (ils disparaîtraient avec elle)' : 'Aucun middleware commun à toutes les routes'

  const redirectAtEntrypoint = !!http?.redirectTo
  const redirectToHttps = true
  notes.redirectToHttps = redirectAtEntrypoint ? `Déjà assurée par le point d'entrée ${http!.name}` : traefikRoutes.some(r => r.redirectsToHttps) ? 'Les routes existantes redirigent HTTP vers HTTPS' : 'Recommandé'

  const publicBind = https?.hostPorts.some(h => h.startsWith('0.0.0.0:') || h.startsWith(':::')) ?? false
  const exposure = publicBind ? 'external' : 'internal'
  notes.exposure = https?.hostPorts.length
    ? (publicBind ? `Port HTTPS publié sur toutes les interfaces (${https.hostPorts.join(', ')})` : `Port HTTPS publié uniquement sur ${https.hostPorts.join(', ')}`)
    : 'Port HTTPS non publié sur l\'hôte'

  return {
    available: true,
    config: { networkName, certResolver, entrypointHttp, entrypointHttps, allowedDomains, defaultMiddlewares, routerNamePattern: '{project}-{env}-{service}', exposure, redirectToHttps },
    notes,
    warnings,
  }
}

export interface CandidateInput {
  id: string
  name: string
  image: string
  running: boolean
  networks: string[]
  ports: { ip: string | null, privatePort: number, publicPort: number | null }[]
  /** Techno reconnue par la configuration lue dans le conteneur (image non reconnue). */
  probedKind: ProxyKind | null
}

const PROVIDER_OF: Partial<Record<ProxyKind, NonNullable<ProxyCandidate['provider']>>> = { 'traefik': 'traefik', 'nginx-proxy': 'nginx-proxy', 'nginx': 'nginx', 'swag': 'nginx' }
const RANK = { 'traefik': 0, 'nginx-proxy': 1, 'nginx': 2 } as const
const DEFAULT_NETS = new Set(['bridge', 'host', 'none'])
const ACME_COMPANION_RE = /(?:nginxproxy\/acme-companion|jrcs\/letsencrypt-nginx-proxy-companion)/i

const published = (c: CandidateInput) => c.ports.filter(p => p.publicPort)
const webPorts = (c: CandidateInput) => published(c).filter(p => p.privatePort === 80 || p.privatePort === 443 || p.publicPort === 80 || p.publicPort === 443)

/**
 * Conteneurs susceptibles d'être le reverse proxy : proxy reconnu (image ou configuration), ou
 * conteneur publiant 80/443 (reverse proxy ou site web : proposé quand même). Le plus probable d'abord.
 */
export function proxyCandidates(topo: ProxyTopology, containers: readonly CandidateInput[]): (ProxyCandidate & { input: CandidateInput })[] {
  const out = containers.flatMap((c) => {
    const detected = topo.proxies.find(p => p.container.id === c.id || p.container.name === c.name)
    const kind = detected?.kind ?? c.probedKind
    const web = webPorts(c)
    if (!kind && !web.length) return []
    // Techno inconnue publiant 80/443 : nginx classique proposé (le plus courant), à vérifier.
    const provider = kind ? PROVIDER_OF[kind] ?? null : 'nginx'
    const ports = published(c).map(p => `${p.ip && p.ip !== '0.0.0.0' && p.ip !== '::' ? `${p.ip}:` : ''}${p.publicPort}→${p.privatePort}`)
    const reason = !kind
      ? 'Publie 80/443 sans techno reconnue : reverse proxy ou site web (nginx classique proposé, à vérifier)'
      : provider
        ? `${kind}${detected ? ' reconnu par son image' : ' reconnu par sa configuration'}${web.length ? `, publie ${web.map(p => p.publicPort).join('/')}` : ''}`
        : `${kind} : non piloté par la console (Traefik, nginx-proxy ou nginx seulement)`
    return [{ container: c.name, image: c.image, running: c.running, kind, provider, ports, reason, selected: false, input: c }]
  })
  const score = (x: (typeof out)[number]) => [x.provider ? 0 : 1, x.kind ? 0 : 1, x.running ? 0 : 1, webPorts(x.input).some(p => p.privatePort === 443) ? 0 : 1, x.provider ? RANK[x.provider] : 9]
  return out.sort((a, b) => {
    const sa = score(a)
    const sb = score(b)
    for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sa[i]! - sb[i]!
    return a.container.localeCompare(b.container)
  })
}

/**
 * Configuration proposée d'après le reverse proxy qui tourne : Traefik (analyse détaillée),
 * nginx-proxy ou nginx (conteneur, réseau, domaines déjà servis). `pick` : conteneur choisi.
 */
export function suggestProxyConfig(topo: ProxyTopology, networks: readonly NetworkInfo[], existingDomains: readonly string[], containers: readonly CandidateInput[], pick?: string): TraefikSuggestion {
  const all = proxyCandidates(topo, containers)
  const chosen = pick ? all.find(c => c.container === pick) : all.find(c => c.provider)
  const candidates: ProxyCandidate[] = all.map(({ input: _input, ...c }) => ({ ...c, selected: c.container === chosen?.container }))
  if (!chosen?.provider) {
    const warnings = !all.length
      ? ['Aucun reverse proxy détecté : aucun conteneur ne publie 80 ou 443']
      : chosen ? [`${chosen.container} : ${chosen.reason}`] : ['Aucun reverse proxy pilotable détecté (Traefik, nginx-proxy ou nginx) : choisir un candidat ou configurer manuellement']
    return { available: false, config: null, notes: {}, warnings, candidates }
  }
  if (chosen.provider === 'traefik') return { ...suggestTraefikConfig(topo, networks, existingDomains), candidates }

  const c = chosen.input
  const notes: Record<string, string> = {}
  const warnings: string[] = []
  const nets = c.networks.filter(n => !DEFAULT_NETS.has(n))
  const allowed = nets.find(n => networks.find(x => x.name === n)?.policy === 'allowed')
  const networkName = allowed ?? nets[0] ?? ''
  notes.networkName = allowed ? `Réseau autorisé auquel ${c.name} est attaché` : networkName ? `Réseau de ${c.name}` : 'Aucun réseau dédié'
  if (!networkName) warnings.push(`${c.name} n'est branché que sur le réseau par défaut : créer un réseau dédié, l'y brancher, puis relancer la détection`)
  else if (!allowed) warnings.push(`Réseau « ${networkName} » à autoriser dans « Réseaux et volumes » avant d'enregistrer`)

  const hosts = topo.routes.filter(r => r.proxyId === c.id && r.kind === 'http').flatMap(r => r.hosts)
  const added = domainPatterns(hosts.filter(h => !isAllowedHost(h, existingDomains)))
  const allowedDomains = [...new Set([...existingDomains, ...added])].sort()
  notes.allowedDomains = hosts.length ? `Déduits des ${new Set(hosts).size} domaine(s) déjà servis par ${c.name}` : 'Aucun domaine lu dans sa configuration : à compléter'

  const https = webPorts(c).filter(p => p.privatePort === 443)
  const redirectToHttps = https.length > 0
  notes.redirectToHttps = redirectToHttps ? 'Le port 443 est publié' : 'Port 443 non publié : HTTP seul'
  const exposure = https.some(p => !p.ip || p.ip === '0.0.0.0' || p.ip === '::') ? 'external' : 'internal'
  notes.exposure = https.length ? `Port HTTPS publié ${exposure === 'external' ? 'sur toutes les interfaces' : `sur ${https.map(p => p.ip).join(', ')}`}` : 'Port HTTPS non publié sur l\'hôte'

  const nginxConfDir = chosen.kind === 'swag' ? '/config/nginx/site-confs' : '/etc/nginx/conf.d'
  const letsencrypt = chosen.provider === 'nginx-proxy' && containers.some(x => ACME_COMPANION_RE.test(x.image))
  notes.provider = chosen.reason
  notes.nginxContainer = c.name
  if (chosen.provider === 'nginx') notes.nginxConfDir = chosen.kind === 'swag' ? 'Dossier des sites de SWAG' : 'Dossier inclus par la configuration nginx standard'
  if (chosen.provider === 'nginx-proxy') notes.letsencrypt = letsencrypt ? 'acme-companion détecté' : 'acme-companion absent'
  if (!c.running) warnings.push(`${c.name} est arrêté`)
  if (!chosen.kind) warnings.push(`Techno de ${c.name} non reconnue : nginx classique proposé, à vérifier`)

  return {
    available: true,
    config: {
      networkName, certResolver: null, entrypointHttp: 'web', entrypointHttps: 'websecure', allowedDomains, defaultMiddlewares: [],
      routerNamePattern: '{project}-{env}-{service}', exposure, redirectToHttps,
      provider: chosen.provider, nginxContainer: c.name, nginxConfDir, letsencrypt,
    },
    notes,
    warnings,
    candidates,
  }
}
