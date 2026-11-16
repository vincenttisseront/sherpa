/**
 * Empreinte actuelle d'un tag dans son registre (requête HEAD sur le manifeste,
 * jeton anonyme si le registre le demande) : base de la vérification « image à
 * jour ». Sur Docker Hub, une requête HEAD n'est pas décomptée du quota de
 * téléchargements. Seuls des registres publics connus sont interrogés (aucune
 * requête vers un hôte arbitraire tiré d'un Compose) ; le résultat est mis en cache.
 */
import { Agent, fetch } from 'undici'

export interface ImageRef {
  /** Registre tel qu'écrit (docker.io par défaut). */
  registry: string
  repository: string
  tag: string | null
  digest: string | null
}

const PUBLIC_REGISTRIES: Record<string, string> = {
  'docker.io': 'registry-1.docker.io',
  'index.docker.io': 'registry-1.docker.io',
  'registry-1.docker.io': 'registry-1.docker.io',
  'ghcr.io': 'ghcr.io',
  'quay.io': 'quay.io',
  'gcr.io': 'gcr.io',
  'registry.k8s.io': 'registry.k8s.io',
  'mcr.microsoft.com': 'mcr.microsoft.com',
  'public.ecr.aws': 'public.ecr.aws',
  'registry.gitlab.com': 'registry.gitlab.com',
  'lscr.io': 'lscr.io',
  'mirror.gcr.io': 'mirror.gcr.io',
  // Registres d'éditeurs qui reprennent Docker Hub à l'identique (mêmes tags et empreintes) :
  // interrogés sur Docker Hub (leurs propres limites d'appels sont plus strictes).
  'docker.n8n.io': 'registry-1.docker.io',
}
// Registres publics supplémentaires (REGISTRY_EXTRA_PUBLIC : « hote » ou « hote=hote_api », séparés par des virgules).
for (const entry of (process.env.REGISTRY_EXTRA_PUBLIC ?? '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean)) {
  const [name, api] = entry.split('=')
  if (name && /^[a-z0-9.-]+(?::\d+)?$/.test(name) && (!api || /^[a-z0-9.-]+(?::\d+)?$/.test(api))) PUBLIC_REGISTRIES[name] = api || name
}
/** Serveurs de jetons acceptés (realm de WWW-Authenticate). */
const TOKEN_HOSTS = new Set(['auth.docker.io', 'ghcr.io', 'quay.io', 'gcr.io', 'registry.k8s.io', 'mcr.microsoft.com', 'public.ecr.aws', 'gitlab.com', 'registry.gitlab.com', 'lscr.io', 'mirror.gcr.io'])

const ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ')

export function parseImageRef(ref: string): ImageRef | null {
  let rest = ref.trim()
  if (!rest || /\s/.test(rest)) return null
  let digest: string | null = null
  const at = rest.indexOf('@')
  if (at >= 0) {
    digest = rest.slice(at + 1)
    rest = rest.slice(0, at)
    if (!/^sha256:[0-9a-f]{64}$/.test(digest)) return null
  }
  let tag: string | null = null
  const colon = rest.lastIndexOf(':')
  if (colon > rest.lastIndexOf('/')) {
    tag = rest.slice(colon + 1)
    rest = rest.slice(0, colon)
  }
  const parts = rest.split('/')
  const first = parts[0]!
  const hasRegistry = parts.length > 1 && (first.includes('.') || first.includes(':') || first === 'localhost')
  const registry = hasRegistry ? first.toLowerCase() : 'docker.io'
  let repository = (hasRegistry ? parts.slice(1) : parts).join('/')
  if (!repository || !/^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/.test(repository)) return null
  if (PUBLIC_REGISTRIES[registry] === 'registry-1.docker.io' && !repository.includes('/')) repository = `library/${repository}`
  return { registry, repository, tag: tag ?? (digest ? null : 'latest'), digest }
}

/** Le registre est-il interrogé par la plateforme ? */
export const isPublicRegistry = (registry: string) => registry in PUBLIC_REGISTRIES

export class RegistryError extends Error {}

const dispatcher = new Agent({ allowH2: false, connect: { rejectUnauthorized: true } })
const cache = new Map<string, { at: number, value: Promise<string> }>()
const TTL_MS = 30 * 60_000

async function head(url: string, token: string | null): Promise<Response> {
  return await fetch(url, {
    method: 'HEAD',
    dispatcher,
    redirect: 'follow',
    signal: AbortSignal.timeout(8000),
    headers: { 'accept': ACCEPT, 'user-agent': 'sherpa', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  }) as unknown as Response
}

/** Jeton anonyme d'après l'en-tête WWW-Authenticate: Bearer realm=…,service=…,scope=… */
async function anonymousToken(challenge: string): Promise<string> {
  const params = Object.fromEntries([...challenge.matchAll(/(\w+)="([^"]*)"/g)].map(m => [m[1]!, m[2]!]))
  if (!/^Bearer\s/i.test(challenge) || !params.realm) throw new RegistryError('Authentification du registre non prise en charge')
  const realm = new URL(params.realm)
  if (realm.protocol !== 'https:' || !TOKEN_HOSTS.has(realm.hostname)) throw new RegistryError(`Serveur de jetons non autorisé : ${realm.hostname}`)
  if (params.service) realm.searchParams.set('service', params.service)
  if (params.scope) realm.searchParams.set('scope', params.scope)
  const res = await fetch(realm, { dispatcher, signal: AbortSignal.timeout(8000), headers: { 'user-agent': 'sherpa' } })
  if (!res.ok) throw new RegistryError(`Jeton du registre refusé (${res.status})`)
  const body = await res.json() as { token?: string, access_token?: string }
  const token = body.token ?? body.access_token
  if (!token) throw new RegistryError('Jeton du registre absent')
  return token
}

/** Empreinte (sha256:…) que le registre associe aujourd'hui au tag. */
export function remoteDigest(ref: ImageRef): Promise<string> {
  const host = PUBLIC_REGISTRIES[ref.registry]
  if (!host) return Promise.reject(new RegistryError(`Registre ${ref.registry} non interrogé (registres publics uniquement)`))
  if (!ref.tag) return Promise.reject(new RegistryError('Image figée par empreinte'))
  const key = `${host}/${ref.repository}:${ref.tag}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value
  const value = (async () => {
    const url = `https://${host}/v2/${ref.repository}/manifests/${encodeURIComponent(ref.tag!)}`
    let res = await head(url, null).catch((err) => { throw new RegistryError(`Registre injoignable : ${(err as Error).message}`) })
    if (res.status === 401) {
      const token = await anonymousToken(res.headers.get('www-authenticate') ?? '')
      res = await head(url, token)
    }
    if (res.status === 404) throw new RegistryError('Tag introuvable dans le registre (supprimé ou image privée)')
    if (res.status === 401 || res.status === 403) throw new RegistryError('Image privée : accès au registre requis')
    if (res.status === 429) throw new RegistryError('Limite d\'appels du registre atteinte')
    if (!res.ok) throw new RegistryError(`Le registre a répondu ${res.status}`)
    const digest = res.headers.get('docker-content-digest')
    if (!digest || !/^sha256:[0-9a-f]{64}$/.test(digest)) throw new RegistryError('Empreinte absente de la réponse du registre')
    return digest
  })()
  if (cache.size > 500) cache.delete(cache.keys().next().value!)
  cache.set(key, { at: Date.now(), value })
  value.catch(() => cache.delete(key))
  return value
}

/** Versions publiées (tags) d'un dépôt d'un registre public, avec le même jeton anonyme. */
export async function listTags(ref: ImageRef, max = 2000): Promise<string[]> {
  const host = PUBLIC_REGISTRIES[ref.registry]
  if (!host) throw new RegistryError(`Registre ${ref.registry} non interrogé (registres publics uniquement)`)
  const get = (url: string, token: string | null): Promise<Awaited<ReturnType<typeof fetch>>> => fetch(url, {
    dispatcher,
    // Liste longue (centaines de versions) et premier accès lent derrière un proxy : délai élargi.
    signal: AbortSignal.timeout(20_000),
    headers: { 'accept': 'application/json', 'user-agent': 'sherpa', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  })
  const tags: string[] = []
  let token: string | null = null
  let url: string | null = `https://${host}/v2/${ref.repository}/tags/list?n=1000`
  while (url && tags.length < max) {
    let res: Awaited<ReturnType<typeof get>> = await get(url, token).catch((err) => { throw new RegistryError(`Registre injoignable : ${(err as Error).message}`) })
    if (res.status === 401 && !token) {
      token = await anonymousToken(res.headers.get('www-authenticate') ?? '')
      res = await get(url, token)
    }
    if (!res.ok) throw new RegistryError(`Le registre a répondu ${res.status} sur la liste des versions`)
    tags.push(...(((await res.json()) as { tags?: string[] | null }).tags ?? []))
    // Pagination : en-tête Link: </v2/…?last=…>; rel="next" (même hôte uniquement).
    const next: string | undefined = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1]
    url = next ? new URL(next, `https://${host}`).toString() : null
    if (url && new URL(url).hostname !== host) url = null
  }
  return tags
}

/** Tag de version stable le plus récent (x.y.z, préfixe v accepté), sinon null. */
export function latestStableTag(tags: readonly string[]): string | null {
  const parsed = tags.map(t => ({ t, m: /^v?(\d+)\.(\d+)\.(\d+)$/.exec(t) })).filter(x => x.m)
  parsed.sort((a, b) => {
    for (let i = 1; i <= 3; i++) {
      const d = Number(b.m![i]) - Number(a.m![i])
      if (d) return d
    }
    return 0
  })
  return parsed[0]?.t ?? null
}
