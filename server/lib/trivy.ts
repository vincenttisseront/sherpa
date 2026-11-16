/**
 * Trivy : script de l'analyse d'une image (conteneur ponctuel avec le socket Docker de l'hôte et
 * le cache de la base de vulnérabilités) et lecture de son rapport JSON. Fonctions pures.
 */
import { type Finding, SEVERITIES, type Severity, type SeverityCounts, type TrivySettings } from '../../shared/schemas/trivy'

export const TRIVY_OUTPUT = '/tmp/trivy.json'
export const TRIVY_EXTRA_CA = '/tmp/extra-ca.pem'
export const TRIVY_CACHE_VOLUME = 'platform-trivy-cache'
export const MAX_FINDINGS = 1000
/** Code source monté en lecture seule dans le conteneur Trivy (analyse « fs »). */
export const TRIVY_SOURCE_DIR = '/src'

/** Référence d'image passée à la ligne de commande : caractères d'une référence Docker seulement. */
const IMAGE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,300}$/

/**
 * Script de l'analyse : une image (socket Docker de l'hôte), ou le code source monté sur
 * TRIVY_SOURCE_DIR (dépendances déclarées : package-lock.json, requirements.txt, go.sum, pom.xml…).
 */
export function trivyScript(image: string | { source: true }, s: Pick<TrivySettings, 'severities' | 'ignoreUnfixed' | 'dbRepository' | 'timeoutMin'>): string {
  const fs = typeof image !== 'string'
  if (!fs && !IMAGE_REF_RE.test(image)) throw new Error(`Référence d'image refusée : ${image}`)
  if (s.dbRepository && !/^[A-Za-z0-9][A-Za-z0-9._:/-]+$/.test(s.dbRepository)) throw new Error('Dépôt de la base de vulnérabilités invalide')
  const args = [
    fs ? 'fs' : 'image', '--quiet', '--format', 'json', '--output', TRIVY_OUTPUT, '--scanners', 'vuln',
    '--severity', s.severities.join(','), '--timeout', `${s.timeoutMin}m`,
    ...(s.ignoreUnfixed ? ['--ignore-unfixed'] : []),
    ...(s.dbRepository ? ['--db-repository', s.dbRepository] : []),
  ]
  return [
    // AC supplémentaires de la console (inspection TLS, AC interne) ajoutées à celles de l'image.
    `if [ -f ${TRIVY_EXTRA_CA} ]; then cat /etc/ssl/certs/ca-certificates.crt ${TRIVY_EXTRA_CA} > /tmp/ca.pem && export SSL_CERT_FILE=/tmp/ca.pem; fi`,
    `exec trivy ${args.join(' ')} '${fs ? TRIVY_SOURCE_DIR : image}'`,
  ].join('\n')
}

interface RawVuln { VulnerabilityID: string, PkgName: string, InstalledVersion: string, FixedVersion?: string, Severity: string, Title?: string, PrimaryURL?: string }
interface RawReport { ArtifactName?: string, Metadata?: { OS?: { Family?: string, Name?: string }, ImageID?: string, ImageConfig?: { config?: { Labels?: Record<string, string> | null } } }, Results?: { Target: string, Class?: string, Type?: string, Vulnerabilities?: RawVuln[] | null }[] | null }

const RANK = Object.fromEntries(SEVERITIES.map((s, i) => [s, i])) as Record<Severity, number>
export const emptyCounts = (): SeverityCounts => ({ CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 })

export function parseTrivyReport(text: string): { os: string | null, imageId: string | null, counts: SeverityCounts, fixable: number, findings: Finding[], targets: string[], sourceUrl: string | null, imageVersion: string | null } {
  const r = JSON.parse(text) as RawReport
  const counts = emptyCounts()
  const seen = new Set<string>()
  const findings: Finding[] = []
  let fixable = 0
  for (const res of r.Results ?? []) {
    for (const v of res.Vulnerabilities ?? []) {
      const severity = (SEVERITIES as readonly string[]).includes(v.Severity) ? v.Severity as Severity : 'UNKNOWN'
      // Une même vulnérabilité d'un même paquet n'est comptée qu'une fois.
      const key = `${v.VulnerabilityID}|${v.PkgName}|${v.InstalledVersion}`
      if (seen.has(key)) continue
      seen.add(key)
      counts[severity]++
      if (v.FixedVersion) fixable++
      const cls = res.Class === 'os-pkgs' || res.Class === 'lang-pkgs' ? res.Class : undefined
      findings.push({ id: v.VulnerabilityID, pkg: v.PkgName, installed: v.InstalledVersion, fixed: v.FixedVersion || null, severity, title: v.Title?.slice(0, 300) ?? null, url: v.PrimaryURL ?? null, target: res.Target, ...(cls ? { class: cls } : {}), ...(res.Type ? { type: res.Type.slice(0, 40) } : {}) })
    }
  }
  findings.sort((a, b) => RANK[a.severity] - RANK[b.severity] || Number(!a.fixed) - Number(!b.fixed) || a.id.localeCompare(b.id))
  const os = r.Metadata?.OS?.Family ? `${r.Metadata.OS.Family} ${r.Metadata.OS.Name ?? ''}`.trim() : null
  // Cibles du rapport : système et fichiers de dépendances trouvés (avec ou sans vulnérabilité).
  const targets = [...new Set((r.Results ?? []).map(x => x.Target))]
  // Dépôt d'origine déclaré par l'image (convention OCI), pour adresser les demandes de correction.
  const source = r.Metadata?.ImageConfig?.config?.Labels?.['org.opencontainers.image.source']
  const sourceUrl = source && /^https?:\/\/\S{1,300}$/.test(source) ? source : null
  const version = r.Metadata?.ImageConfig?.config?.Labels?.['org.opencontainers.image.version']?.trim().slice(0, 80) || null
  return { os, imageId: r.Metadata?.ImageID ?? null, counts, fixable, findings: findings.slice(0, MAX_FINDINGS), targets, sourceUrl, imageVersion: version }
}

/** Vulnérabilités qui bloquent le déploiement d'une image construite (réglage « au build »). */
export function blockingFindings(findings: readonly Finding[], settings: Pick<TrivySettings, 'buildBlock' | 'buildBlockFixableOnly'>): Finding[] {
  if (settings.buildBlock === 'off') return []
  const levels: Severity[] = settings.buildBlock === 'CRITICAL' ? ['CRITICAL'] : ['CRITICAL', 'HIGH']
  return findings.filter(f => levels.includes(f.severity) && (!settings.buildBlockFixableOnly || !!f.fixed))
}

/** Vulnérabilités apparues depuis l'analyse précédente, à partir d'une sévérité. */
export function newFindings(previous: readonly Finding[] | null, current: readonly Finding[], min: 'CRITICAL' | 'HIGH'): Finding[] {
  const before = new Set((previous ?? []).map(f => `${f.id}|${f.pkg}`))
  return current.filter(f => RANK[f.severity] <= RANK[min] && !before.has(`${f.id}|${f.pkg}`))
}
