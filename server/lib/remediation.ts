/**
 * Demandes de correction des vulnérabilités (issue ou PR GitHub) : regroupement par paquet avec
 * la version corrigée minimale, modifications de fichiers proposées (versions épinglées des
 * requirements Python, mise à jour des paquets système dans le Dockerfile), texte prêt à publier
 * (français ou anglais). Fonctions pures.
 */
import { type Finding, SEVERITIES, type Severity, type SeverityCounts } from '../../shared/schemas/trivy'

export type Lang = 'fr' | 'en'

export interface RemediationGroup {
  pkg: string
  installed: string
  /** Version qui corrige toutes les vulnérabilités du groupe (la plus petite possible) ; null sans correctif. */
  fixed: string | null
  severity: Severity
  vulns: { id: string, url: string | null, severity: Severity }[]
  kind: 'os' | 'lang'
  /** Fichiers ou cibles concernés (système, requirements.txt, package-lock.json…). */
  files: string[]
}

const RANK = Object.fromEntries(SEVERITIES.map((s, i) => [s, i])) as Record<Severity, number>
const OS_TARGET_RE = /\((?:alpine|debian|ubuntu|redhat|rhel|centos|rocky|alma|amazon|oracle|photon|wolfi|chainguard|suse|opensuse[\w.-]*|sles|cbl-mariner|azurelinux|fedora|bottlerocket|echo)\b[^)]*\)\s*$/i

export const findingKind = (f: Pick<Finding, 'class' | 'target'>): 'os' | 'lang' => (f.class ? (f.class === 'os-pkgs' ? 'os' : 'lang') : OS_TARGET_RE.test(f.target) ? 'os' : 'lang')

/** Comparaison de versions tolérante (1.10 > 1.9, 2.0.0-1+deb12u2 > 2.0.0-1+deb12u1). */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^[v=<>~^\s]+/, '').split(/[^0-9A-Za-z]+/).filter(Boolean)
  const pa = parts(a)
  const pb = parts(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i]
    const y = pb[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny) {
      const d = Number(x) - Number(y)
      if (d) return d > 0 ? 1 : -1
    }
    else if (x !== y) return nx ? 1 : ny ? -1 : x < y ? -1 : 1
  }
  return 0
}

/** Version corrigée d'une vulnérabilité : la plus petite au-dessus de la version installée (« 2.20.0, 2.31.0 »). */
export function minimalFix(fixed: string | null, installed: string): string | null {
  const list = (fixed ?? '').split(/\s*,\s*|\s*\|\|\s*/).map(v => v.replace(/^[>=~^\s]+/, '').trim()).filter(Boolean)
  if (!list.length) return null
  const above = list.filter(v => compareVersions(v, installed) > 0).sort(compareVersions)
  return above[0] ?? list.sort(compareVersions).at(-1)!
}

export interface Selection { minSeverity: Severity, fixableOnly: boolean }

export function groupFindings(findings: readonly Finding[], sel: Selection): RemediationGroup[] {
  const groups = new Map<string, RemediationGroup>()
  for (const f of findings) {
    if (RANK[f.severity] > RANK[sel.minSeverity]) continue
    if (sel.fixableOnly && !f.fixed) continue
    const kind = findingKind(f)
    const key = `${kind}|${f.pkg}|${f.installed}`
    const g = groups.get(key) ?? { pkg: f.pkg, installed: f.installed, fixed: null, severity: f.severity, vulns: [], kind, files: [] }
    if (!g.vulns.some(v => v.id === f.id)) g.vulns.push({ id: f.id, url: f.url, severity: f.severity })
    if (RANK[f.severity] < RANK[g.severity]) g.severity = f.severity
    if (!g.files.includes(f.target)) g.files.push(f.target)
    const fix = minimalFix(f.fixed, f.installed)
    // Toutes les vulnérabilités du groupe : la plus haute des versions corrigées minimales.
    if (fix && (!g.fixed || compareVersions(fix, g.fixed) > 0)) g.fixed = fix
    groups.set(key, g)
  }
  for (const g of groups.values()) g.vulns.sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.id.localeCompare(b.id))
  return [...groups.values()].sort((a, b) => RANK[a.severity] - RANK[b.severity] || b.vulns.length - a.vulns.length || a.pkg.localeCompare(b.pkg))
}

// ---------------------------------------------------------------------------
// Modifications de fichiers proposées
// ---------------------------------------------------------------------------

const pyName = (n: string) => n.toLowerCase().replace(/[-_.]+/g, '-')
export const isRequirementsFile = (path: string) => /(^|\/)requirements[\w.-]*\.(txt|in)$/i.test(path)

/** Versions épinglées (« paquet==x ») d'un fichier requirements montées aux versions corrigées. */
export function patchRequirements(text: string, bumps: ReadonlyMap<string, string>): { text: string, changed: { pkg: string, from: string, to: string }[] } {
  const want = new Map([...bumps].map(([k, v]) => [pyName(k), v]))
  const changed: { pkg: string, from: string, to: string }[] = []
  const lines = text.split('\n').map((line) => {
    const m = /^(\s*)([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?(\s*)==(\s*)([^\s;#,]+)(.*)$/.exec(line)
    if (!m) return line
    const to = want.get(pyName(m[2]!))
    if (!to || compareVersions(to, m[6]!) <= 0) return line
    changed.push({ pkg: m[2]!, from: m[6]!, to })
    return `${m[1]}${m[2]}${m[3] ?? ''}${m[4]}==${m[5]}${to}${m[7]}`
  })
  return { text: lines.join('\n'), changed }
}

export type OsFamily = 'apt' | 'apk' | null
export function osFamily(os: string | null): OsFamily {
  const o = (os ?? '').toLowerCase()
  return /^(debian|ubuntu)\b/.test(o) ? 'apt' : /^alpine\b/.test(o) ? 'apk' : null
}

export const OS_UPGRADE: Record<'apt' | 'apk', string> = {
  apt: 'RUN apt-get update && apt-get upgrade -y --no-install-recommends && rm -rf /var/lib/apt/lists/*',
  apk: 'RUN apk upgrade --no-cache',
}

/**
 * Mise à jour des paquets système juste après le dernier FROM (étape finale) du Dockerfile.
 * null : pas de FROM, ou mise à jour déjà présente dans l'étape finale.
 */
export function patchDockerfileOsUpgrade(text: string, family: 'apt' | 'apk'): { text: string, from: string } | null {
  const lines = text.split('\n')
  let last = -1
  for (const [i, l] of lines.entries()) if (/^\s*FROM\s+/i.test(l)) last = i
  if (last < 0) return null
  const stage = lines.slice(last).join('\n')
  if (/apt-get\s+(-\S+\s+)*(upgrade|dist-upgrade)|apk\s+(-\S+\s+)*upgrade/i.test(stage)) return null
  const from = lines[last]!.trim().replace(/^FROM\s+/i, '').replace(/\s+AS\s+\S+$/i, '')
  const comment = '# Correctifs de sécurité des paquets système (demande de correction de la console de déploiement)'
  lines.splice(last + 1, 0, comment, OS_UPGRADE[family])
  return { text: lines.join('\n'), from }
}

/** Branche de la PR : « securite/correctifs-AAAAMMJJ-HHMM ». */
export function remediationBranch(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `securite/correctifs-${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}`
}

// ---------------------------------------------------------------------------
// Dépôt GitHub d'une image, adresses
// ---------------------------------------------------------------------------

/** Interface web d'une API GitHub (api.github.com → github.com ; GHES …/api/v3 → hôte). */
export function webUrlOf(apiUrl: string): string {
  const u = apiUrl.replace(/\/+$/, '')
  if (/^https:\/\/api\.github\.com$/i.test(u)) return 'https://github.com'
  return u.replace(/\/api\/v3$/i, '')
}

/** « https://github.com/org/depot(.git)(/tree/…) » → « org/depot » pour l'interface web de cette API. */
export function repositoryFromUrl(url: string, apiUrl: string): string | null {
  const web = webUrlOf(apiUrl).toLowerCase()
  const clean = url.trim().replace(/^git\+/, '').replace(/^git@([^:]+):/, 'https://$1/')
  if (!clean.toLowerCase().startsWith(`${web}/`)) return null
  const m = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?(?:[/?#].*)?$/.exec(clean.slice(web.length + 1))
  return m ? `${m[1]}/${m[2]}` : null
}

/** Lien d'une issue ou d'une PR → dépôt et numéro. */
export function parseIssueUrl(url: string, apiUrl: string): { repository: string, number: number, kind: 'issue' | 'pr' } | null {
  const web = webUrlOf(apiUrl).toLowerCase()
  const clean = url.trim()
  if (!clean.toLowerCase().startsWith(`${web}/`)) return null
  const m = /^([A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100})\/(issues|pull)\/(\d{1,9})(?:[/?#].*)?$/.exec(clean.slice(web.length + 1))
  return m ? { repository: m[1]!, number: Number(m[3]), kind: m[2] === 'pull' ? 'pr' : 'issue' } : null
}

export { imageRefKey } from '../../shared/schemas/remediation'

// ---------------------------------------------------------------------------
// Texte de la demande
// ---------------------------------------------------------------------------

export interface RequestText {
  lang: Lang
  mode: 'issue' | 'pr'
  subject: { kind: 'image' | 'source', name: string, os: string | null, scannedAt: string, scanner: string }
  counts: SeverityCounts
  fixable: number
  selection: Selection
  groups: RemediationGroup[]
  /** Image de base de l'étape finale (Dockerfile), si connue. */
  baseImage: string | null
  osFamily: OsFamily
  /** Modifications portées par la PR. */
  changes: { path: string, summary: string }[]
  /** Contexte interne (serveur, projets), seulement si demandé. */
  context: string[]
}

const L = {
  fr: {
    sev: { CRITICAL: 'Critique', HIGH: 'Haute', MEDIUM: 'Moyenne', LOW: 'Basse', UNKNOWN: 'Inconnue' } as Record<Severity, string>,
    sevPlural: { CRITICAL: 'critique(s)', HIGH: 'haute(s)', MEDIUM: 'moyenne(s)', LOW: 'basse(s)', UNKNOWN: 'inconnue(s)' } as Record<Severity, string>,
    titleImage: (n: number, what: string, name: string) => `Sécurité : corriger ${n} vulnérabilité(s) ${what} de l'image ${name}`,
    titleSource: (n: number, what: string, name: string) => `Sécurité : corriger ${n} vulnérabilité(s) ${what} des dépendances (${name})`,
    whatOf: (s: Selection) => `${s.minSeverity === 'CRITICAL' ? 'critique(s)' : s.minSeverity === 'HIGH' ? 'critique(s) et haute(s)' : s.minSeverity === 'MEDIUM' ? 'critique(s) à moyenne(s)' : ''}`.trim(),
    headImage: (name: string) => `## Vulnérabilités à corriger dans l'image \`${name}\``,
    headSource: (name: string) => `## Vulnérabilités à corriger dans les dépendances de \`${name}\``,
    scan: (date: string, scanner: string, counts: string, fixable: number) => `Analyse [Trivy](https://trivy.dev) du ${date} (${scanner}) : ${counts} — dont **${fixable}** avec un correctif publié.`,
    scope: (s: Selection, pkgs: number, vulns: number) => `Cette demande porte sur les vulnérabilités ${s.minSeverity === 'LOW' ? 'de toutes sévérités' : `**${L.fr.whatOf(s)}**`}${s.fixableOnly ? ' qui ont un correctif publié' : ''} : ${pkgs} paquet(s), ${vulns} vulnérabilité(s).`,
    none: 'Aucune vulnérabilité relevée.',
    osHead: (os: string | null) => `### Paquets du système${os ? ` (${os})` : ''}`,
    langHead: '### Dépendances de l\'application',
    cols: ['Paquet', 'Installé', 'Corrigé dans', 'Sévérité', 'Vulnérabilités'],
    colFile: 'Fichier',
    noFix: 'pas encore',
    more: (n: number) => `… et ${n} autre(s) paquet(s), à voir dans la console.`,
    fixHead: '### Correction proposée',
    fixOs: (base: string | null) => `- **Paquets du système** : reconstruire l'image sur la dernière version de son image de base${base ? ` (\`FROM ${base}\`)` : ''}. Si les correctifs n'y sont pas encore repris, mettre à jour les paquets à la construction :`,
    fixOsNoCmd: (base: string | null) => `- **Paquets du système** : reconstruire l'image sur la dernière version de son image de base${base ? ` (\`FROM ${base}\`)` : ''}, ou passer à une image de base qui intègre les correctifs.`,
    fixLang: '- **Dépendances** : monter les versions suivantes (puis régénérer les fichiers de verrouillage) :',
    fixPending: (n: number) => `- ${n} vulnérabilité(s) n'ont pas encore de correctif publié : à surveiller.`,
    prHead: '### Modifications de cette PR',
    prNote: 'Le Dockerfile met à jour les paquets système juste après `FROM` (utilisateur root) : à vérifier si l\'image de base démarre sous un autre utilisateur.',
    ctxHead: '### Contexte',
    footer: '_Demande préparée par la console de déploiement à partir d\'une analyse Trivy. Les vulnérabilités seront revérifiées à la prochaine analyse : la demande y sera marquée résolue._',
  },
  en: {
    sev: { CRITICAL: 'Critical', HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low', UNKNOWN: 'Unknown' } as Record<Severity, string>,
    sevPlural: { CRITICAL: 'critical', HIGH: 'high', MEDIUM: 'medium', LOW: 'low', UNKNOWN: 'unknown' } as Record<Severity, string>,
    titleImage: (n: number, what: string, name: string) => `Security: fix ${n} ${what} vulnerabilit${n > 1 ? 'ies' : 'y'} in image ${name}`,
    titleSource: (n: number, what: string, name: string) => `Security: fix ${n} ${what} vulnerabilit${n > 1 ? 'ies' : 'y'} in dependencies (${name})`,
    whatOf: (s: Selection) => (s.minSeverity === 'CRITICAL' ? 'critical' : s.minSeverity === 'HIGH' ? 'critical/high' : s.minSeverity === 'MEDIUM' ? 'critical to medium' : ''),
    headImage: (name: string) => `## Vulnerabilities to fix in image \`${name}\``,
    headSource: (name: string) => `## Vulnerabilities to fix in the dependencies of \`${name}\``,
    scan: (date: string, scanner: string, counts: string, fixable: number) => `[Trivy](https://trivy.dev) scan of ${date} (${scanner}): ${counts} — **${fixable}** with a published fix.`,
    scope: (s: Selection, pkgs: number, vulns: number) => `This request covers ${s.minSeverity === 'LOW' ? 'all' : `**${L.en.whatOf(s)}**`} vulnerabilities${s.fixableOnly ? ' with a published fix' : ''}: ${pkgs} package(s), ${vulns} vulnerabilit${vulns > 1 ? 'ies' : 'y'}.`,
    none: 'No vulnerability found.',
    osHead: (os: string | null) => `### OS packages${os ? ` (${os})` : ''}`,
    langHead: '### Application dependencies',
    cols: ['Package', 'Installed', 'Fixed in', 'Severity', 'Vulnerabilities'],
    colFile: 'File',
    noFix: 'not yet',
    more: (n: number) => `… and ${n} more package(s).`,
    fixHead: '### Suggested fix',
    fixOs: (base: string | null) => `- **OS packages**: rebuild the image on the latest version of its base image${base ? ` (\`FROM ${base}\`)` : ''}. If the fixes are not in the base image yet, upgrade the packages at build time:`,
    fixOsNoCmd: (base: string | null) => `- **OS packages**: rebuild the image on the latest version of its base image${base ? ` (\`FROM ${base}\`)` : ''}, or move to a base image that ships the fixes.`,
    fixLang: '- **Dependencies**: bump the following versions (then regenerate the lock files):',
    fixPending: (n: number) => `- ${n} vulnerabilit${n > 1 ? 'ies have' : 'y has'} no published fix yet: to be monitored.`,
    prHead: '### Changes in this PR',
    prNote: 'The Dockerfile upgrades OS packages right after `FROM` (as root): to be checked if the base image runs as another user.',
    ctxHead: '### Context',
    footer: '_Request prepared by the deployment console from a Trivy scan. The vulnerabilities will be checked again at the next scan, which will mark this request as resolved._',
  },
}

const MAX_ROWS = 60
const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
const vulnLinks = (g: RemediationGroup) => {
  const shown = g.vulns.slice(0, 4).map(v => (v.url ? `[${v.id}](${v.url})` : v.id))
  return `${shown.join(', ')}${g.vulns.length > 4 ? ` +${g.vulns.length - 4}` : ''}`
}

export function requestTitle(t: Pick<RequestText, 'lang' | 'subject' | 'groups' | 'selection'>): string {
  const l = L[t.lang]
  const n = t.groups.reduce((a, g) => a + g.vulns.length, 0)
  const what = l.whatOf(t.selection)
  return (t.subject.kind === 'image' ? l.titleImage(n, what, t.subject.name) : l.titleSource(n, what, t.subject.name)).replace(/\s{2,}/g, ' ').slice(0, 250)
}

export function requestBody(t: RequestText): string {
  const l = L[t.lang]
  const date = new Date(t.subject.scannedAt).toLocaleDateString(t.lang === 'fr' ? 'fr-FR' : 'en-GB', { day: '2-digit', month: 'long', year: 'numeric' })
  const counts = SEVERITIES.filter(s => t.counts[s]).map(s => `${['CRITICAL', 'HIGH'].includes(s) ? '**' : ''}${t.counts[s]} ${l.sevPlural[s]}${['CRITICAL', 'HIGH'].includes(s) ? '**' : ''}`).join(', ') || l.none
  const vulns = t.groups.reduce((a, g) => a + g.vulns.length, 0)
  const out: string[] = [
    t.subject.kind === 'image' ? l.headImage(t.subject.name) : l.headSource(t.subject.name),
    '',
    l.scan(date, t.subject.scanner, counts, t.fixable),
    l.scope(t.selection, t.groups.length, vulns),
  ]
  const os = t.groups.filter(g => g.kind === 'os')
  const lang = t.groups.filter(g => g.kind === 'lang')
  if (os.length) {
    out.push('', l.osHead(t.subject.os), '', `| ${l.cols.join(' | ')} |`, `|${l.cols.map(() => '---').join('|')}|`)
    for (const g of os.slice(0, MAX_ROWS)) out.push(`| ${esc(g.pkg)} | ${esc(g.installed)} | ${g.fixed ? esc(g.fixed) : `_${l.noFix}_`} | ${l.sev[g.severity]} | ${vulnLinks(g)} |`)
    if (os.length > MAX_ROWS) out.push('', l.more(os.length - MAX_ROWS))
  }
  if (lang.length) {
    out.push('', l.langHead, '', `| ${l.colFile} | ${l.cols.join(' | ')} |`, `|---|${l.cols.map(() => '---').join('|')}|`)
    for (const g of lang.slice(0, MAX_ROWS)) out.push(`| ${esc(g.files.join(', '))} | ${esc(g.pkg)} | ${esc(g.installed)} | ${g.fixed ? esc(g.fixed) : `_${l.noFix}_`} | ${l.sev[g.severity]} | ${vulnLinks(g)} |`)
    if (lang.length > MAX_ROWS) out.push('', l.more(lang.length - MAX_ROWS))
  }
  if (t.groups.length) {
    out.push('', l.fixHead)
    if (os.some(g => g.fixed)) {
      if (t.osFamily) out.push(l.fixOs(t.baseImage), '', '  ```dockerfile', `  ${OS_UPGRADE[t.osFamily]}`, '  ```')
      else out.push(l.fixOsNoCmd(t.baseImage))
    }
    const bumps = lang.filter(g => g.fixed)
    if (bumps.length) {
      out.push(l.fixLang, '')
      for (const g of bumps.slice(0, MAX_ROWS)) out.push(`  - \`${g.pkg}\` ${g.installed} → **${g.fixed}** (${g.files.join(', ')})`)
    }
    const pending = t.groups.filter(g => !g.fixed).reduce((a, g) => a + g.vulns.length, 0)
    if (pending) out.push(l.fixPending(pending))
  }
  if (t.mode === 'pr' && t.changes.length) {
    out.push('', l.prHead, '')
    for (const c of t.changes) out.push(`- \`${c.path}\` : ${c.summary}`)
    if (t.changes.some(c => /dockerfile/i.test(c.path))) out.push('', `> ${l.prNote}`)
  }
  if (t.context.length) out.push('', l.ctxHead, '', ...t.context.map(c => `- ${c}`))
  out.push('', '---', l.footer)
  return out.join('\n').slice(0, 60_000)
}

/** Lien « nouvelle issue » pré-rempli (texte tronqué au besoin : la limite d'une URL est vite atteinte). */
export function newIssueUrl(apiUrl: string, repository: string, title: string, body: string, maxBody = 6000): string {
  const short = body.length > maxBody ? `${body.slice(0, maxBody)}\n\n…` : body
  return `${webUrlOf(apiUrl)}/${repository}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(short)}`
}
