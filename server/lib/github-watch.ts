/**
 * Analyse d'un compte GitHub : versions de packages utilisées par les déploiements (image du
 * registre du compte) et artefacts Actions (dernier de chaque nom, par dépôt). Fonction pure.
 */
import type { ArtifactView, GithubAlert, PackageUsage, PackageView } from '../../shared/schemas/github-connector'
import type { GithubArtifact, GithubPackage, GithubPackageVersion } from './github'

export interface DeployedImage { targetId: string, projectId: string, label: string, service: string, image: string }

/** « ghcr.io/org/app/web:1.2@sha256:… » → compte, package, tag, empreinte (registre du compte seulement). */
export function parseRegistryImage(image: string, registryHost: string): { owner: string, name: string, tag: string | null, digest: string | null } | null {
  const host = registryHost.toLowerCase()
  const lower = image.trim()
  if (!lower.toLowerCase().startsWith(`${host}/`)) return null
  let rest = lower.slice(host.length + 1)
  let digest: string | null = null
  const at = rest.indexOf('@')
  if (at >= 0) {
    digest = rest.slice(at + 1)
    rest = rest.slice(0, at)
  }
  const colon = rest.lastIndexOf(':')
  const tag = colon > rest.lastIndexOf('/') ? rest.slice(colon + 1) : null
  const path = (tag !== null ? rest.slice(0, colon) : rest).split('/')
  if (path.length < 2) return null
  return { owner: path[0]!.toLowerCase(), name: path.slice(1).join('/').toLowerCase(), tag: tag ?? (digest ? null : 'latest'), digest }
}

export interface WatchInput {
  owner: string
  registryHost: string
  packages: { pkg: GithubPackage, versions: GithubPackageVersion[] }[]
  artifacts: { repository: string, list: GithubArtifact[] }[]
  deployed: DeployedImage[]
  expiringDays: number
  now?: number
}

export function analyzeGithub(input: WatchInput): { packages: PackageView[], artifacts: ArtifactView[], alerts: GithubAlert[] } {
  const now = input.now ?? Date.now()
  const owner = input.owner.toLowerCase()
  const alerts: GithubAlert[] = []
  const containers = new Map(input.packages.filter(p => p.pkg.type === 'container').map(p => [p.pkg.name.toLowerCase(), p] as const))
  const usage = new Map<string, PackageUsage[]>()
  const missing = new Map<string, { image: string, targets: DeployedImage[] }>()

  for (const d of input.deployed) {
    const ref = parseRegistryImage(d.image, input.registryHost)
    if (!ref || ref.owner !== owner) continue
    const p = containers.get(ref.name)
    if (!p) {
      const m = missing.get(`${ref.name}`) ?? { image: `${input.registryHost}/${owner}/${ref.name}`, targets: [] }
      m.targets.push(d)
      missing.set(ref.name, m)
      continue
    }
    const present = p.versions.some(v => (ref.digest && v.name === ref.digest) || (ref.tag !== null && v.tags.includes(ref.tag)))
    usage.set(ref.name, [...(usage.get(ref.name) ?? []), { targetId: d.targetId, projectId: d.projectId, label: d.label, service: d.service, image: d.image, present }])
  }

  for (const [name, m] of missing) {
    alerts.push({ key: `package.missing|${name}`, level: 'error', kind: 'package.missing', subject: m.image, message: `Package introuvable sur ${input.owner} (supprimé, renommé ou jeton sans accès) : un redéploiement ne pourra pas récupérer l'image`, url: null, targets: uniqTargets(m.targets) })
  }
  const packages: PackageView[] = input.packages.map(({ pkg, versions }) => {
    const used = usage.get(pkg.name.toLowerCase()) ?? []
    for (const [image, list] of groupBy(used.filter(u => !u.present), u => u.image)) {
      alerts.push({ key: `package.version-missing|${image}`, level: 'error', kind: 'package.version-missing', subject: image, message: 'Version déployée absente du package (supprimée par une politique de rétention ?) : un redéploiement ou une migration échouera', url: pkg.htmlUrl, targets: uniqTargets(list) })
    }
    const latest = [...versions].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
    return { name: pkg.name, type: pkg.type, repository: pkg.repository, visibility: pkg.visibility, url: pkg.htmlUrl, versions: pkg.versionCount ?? versions.length, latest: latest ? { name: latest.name, tags: latest.tags, createdAt: latest.createdAt } : null, usedBy: used }
  }).sort((a, b) => a.name.localeCompare(b.name))

  const artifacts: ArtifactView[] = []
  const limit = input.expiringDays * 864e5
  for (const { repository, list } of input.artifacts) {
    for (const [name, all] of groupBy(list, a => a.name)) {
      const last = [...all].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))[0]!
      artifacts.push({ repository, name, sizeBytes: last.sizeBytes, createdAt: last.createdAt, expiresAt: last.expiresAt, expired: last.expired, branch: last.branch, count: all.length })
      const url = `https://github.com/${repository}/actions${last.runId ? `/runs/${last.runId}` : ''}`
      const left = last.expiresAt ? new Date(last.expiresAt).getTime() - now : null
      if (last.expired || (left !== null && left <= 0)) {
        alerts.push({ key: `artifact.expired|${repository}|${name}`, level: 'warning', kind: 'artifact.expired', subject: `${repository} · ${name}`, message: `Dernier artefact expiré${last.expiresAt ? ` le ${last.expiresAt.slice(0, 10)}` : ''} : relancer le workflow pour le reproduire`, url, targets: [] })
      }
      else if (left !== null && left < limit) {
        alerts.push({ key: `artifact.expiring|${repository}|${name}`, level: 'warning', kind: 'artifact.expiring', subject: `${repository} · ${name}`, message: `Dernier artefact expire dans ${Math.max(1, Math.ceil(left / 864e5))} jour(s) (${last.expiresAt!.slice(0, 10)})`, url, targets: [] })
      }
    }
  }
  artifacts.sort((a, b) => a.repository.localeCompare(b.repository) || a.name.localeCompare(b.name))
  alerts.sort((a, b) => (a.level === b.level ? a.subject.localeCompare(b.subject) : a.level === 'error' ? -1 : 1))
  return { packages, artifacts, alerts }
}

function groupBy<T>(list: readonly T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>()
  for (const x of list) m.set(key(x), [...(m.get(key(x)) ?? []), x])
  return m
}

function uniqTargets(list: readonly { targetId: string, projectId: string, label: string }[]) {
  return [...new Map(list.map(t => [t.targetId, { targetId: t.targetId, projectId: t.projectId, label: t.label }])).values()]
}
