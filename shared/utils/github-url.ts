/**
 * Lecture d'une URL de dépôt GitHub saisie telle quelle : page du dépôt,
 * branche (`/tree/<ref>/<dossier>`), fichier (`/blob/<ref>/<chemin>`), URL de
 * clonage HTTPS ou SSH, page de release (`/releases/tag/<tag>`, `/releases/latest`,
 * `/releases/download/<tag>/<fichier>`), ou simplement `organisation/depot`. GitHub Enterprise :
 * l'API est `https://<hôte>/api/v3`.
 */
export interface ParsedRepoUrl {
  apiUrl: string
  repository: string
  /** Référence lue dans l'URL (premier segment après tree/blob). */
  ref: string | null
  /** Dossier (tree) ou fichier (blob) désigné dans le dépôt. */
  path: string | null
  pathKind: 'dir' | 'file' | null
  /** URL de release : tag (null : dernière release, ou liste des releases) et fichier attaché éventuel. */
  release: { tag: string | null, asset: string | null } | null
}

const OWNER = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})'
const REPO = '[A-Za-z0-9._-]{1,100}'

export function apiUrlForHost(host: string): string {
  const h = host.toLowerCase()
  return h === 'github.com' || h === 'www.github.com' ? 'https://api.github.com' : `https://${h}/api/v3`
}

export function parseRepoUrl(input: string): ParsedRepoUrl | null {
  const raw = input.trim()
  const short = new RegExp(`^(${OWNER})/(${REPO}?)$`).exec(raw)
  if (short && !raw.includes(':')) return { apiUrl: 'https://api.github.com', repository: `${short[1]}/${short[2]!.replace(/\.git$/, '')}`, ref: null, path: null, pathKind: null, release: null }
  const ssh = new RegExp(`^(?:ssh://)?git@([A-Za-z0-9.-]+)[:/](${OWNER})/(${REPO})$`).exec(raw)
  if (ssh) return { apiUrl: apiUrlForHost(ssh[1]!), repository: `${ssh[2]}/${ssh[3]!.replace(/\.git$/, '')}`, ref: null, path: null, pathKind: null, release: null }
  let url: URL
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
  }
  catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const seg = url.pathname.split('/').filter(Boolean).map(s => decodeURIComponent(s))
  if (seg.length < 2 || !new RegExp(`^${OWNER}$`).test(seg[0]!) || !new RegExp(`^${REPO}$`).test(seg[1]!)) return null
  const repository = `${seg[0]}/${seg[1]!.replace(/\.git$/, '')}`
  let ref: string | null = null
  let path: string | null = null
  let pathKind: ParsedRepoUrl['pathKind'] = null
  let release: ParsedRepoUrl['release'] = null
  if ((seg[2] === 'tree' || seg[2] === 'blob') && seg[3]) {
    ref = seg[3]
    const rest = seg.slice(4).join('/')
    if (rest) {
      path = rest
      pathKind = seg[2] === 'blob' ? 'file' : 'dir'
    }
  }
  else if (seg[2] === 'releases') {
    if (seg[3] === 'tag' && seg[4]) release = { tag: seg.slice(4).join('/'), asset: null }
    else if (seg[3] === 'download' && seg[4] && seg[5]) release = { tag: seg[4], asset: seg.slice(5).join('/') }
    else release = { tag: null, asset: null }
    ref = release.tag
  }
  return { apiUrl: apiUrlForHost(url.host), repository, ref, path, pathKind, release }
}
