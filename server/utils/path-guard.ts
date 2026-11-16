/**
 * Validation des chemins sur le serveur cible (§6.5).
 *
 * Règle d'or : un chemin n'est jamais saisi librement pour une opération ;
 * il est *construit* à partir d'une racine configurée, d'un environnement et
 * d'un slug de projet validés, puis revérifié ici. Le Target Runner refait
 * la même vérification après résolution des liens symboliques (realpath),
 * que seul l'hôte peut effectuer.
 */
import { posix } from 'node:path'

/** Préfixes système interdits, en plus de `/` lui-même. */
export const SENSITIVE_PREFIXES = [
  '/etc',
  '/proc',
  '/sys',
  '/dev',
  '/boot',
  '/root',
  '/bin',
  '/sbin',
  '/lib',
  '/lib32',
  '/lib64',
  '/usr',
  '/run',
  '/var/run',
  '/var/lib/docker',
  '/var/lib/containerd',
  '/var/lib/portainer',
  '/var/log',
  '/snap',
] as const

/**
 * Dossiers génériques de premier niveau, partagés par nature (FHS, disques de données) :
 * refusés comme racine ou règle de volume, qui couvrirait tout ce qu'ils contiennent.
 * Un dossier dédié de premier niveau (ex. /tools) reste accepté.
 */
export const GENERIC_TOP_LEVEL = ['/srv', '/opt', '/home', '/mnt', '/media', '/var', '/tmp', '/data', '/nix'] as const

/** Raison de refus d'un chemin trop large pour servir de racine, sinon null. */
export function tooBroad(p: string): string | null {
  const depth = p.split('/').filter(Boolean).length
  if (depth === 0) return 'racine du système'
  if (depth === 1 && (GENERIC_TOP_LEVEL as readonly string[]).includes(p)) return `${p} est un dossier partagé : choisir un sous-dossier dédié (ex. ${p}/deployments) ou un dossier propre à la racine (ex. /tools)`
  return null
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const RELEASE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export class PathViolation extends Error {
  constructor(public readonly path: string, public readonly reason: string) {
    super(`Chemin refusé (${reason}) : ${path}`)
    this.name = 'PathViolation'
  }
}

function isWithin(child: string, parent: string): boolean {
  if (parent === '/') return true
  return child === parent || child.startsWith(`${parent}/`)
}

/**
 * Normalise un chemin absolu POSIX et rejette toute forme ambiguë.
 * Les segments `..` sont refusés *avant* normalisation : on ne veut pas
 * qu'un `a/../b` passe silencieusement.
 */
export function normalizeAbsolute(input: string): string {
  if (typeof input !== 'string' || input.length === 0) throw new PathViolation(String(input), 'vide')
  if (input.length > 1024) throw new PathViolation(input.slice(0, 64), 'trop long')
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(input)) throw new PathViolation(input, 'caractère de contrôle')
  if (input.includes('\\')) throw new PathViolation(input, 'antislash')
  if (!input.startsWith('/')) throw new PathViolation(input, 'chemin relatif')
  if (input.split('/').some(seg => seg === '..' || seg === '.')) throw new PathViolation(input, 'segment . ou ..')
  if (input.startsWith('/~') || input.includes('/~/')) throw new PathViolation(input, 'tilde')
  const normalized = posix.normalize(input).replace(/\/+$/, '') || '/'
  return normalized
}

export function assertNotSensitive(path: string, extraForbidden: readonly string[] = []): void {
  const p = normalizeAbsolute(path)
  if (p === '/') throw new PathViolation(p, 'racine du système')
  if (p === '/var/run/docker.sock' || p.endsWith('/docker.sock')) throw new PathViolation(p, 'socket Docker')
  for (const prefix of SENSITIVE_PREFIXES) {
    if (isWithin(p, prefix)) throw new PathViolation(p, `répertoire système ${prefix}`)
  }
  for (const f of extraForbidden) {
    if (isWithin(p, normalizeAbsolute(f))) throw new PathViolation(p, `chemin interdit par la configuration ${f}`)
  }
}

/** Valide une racine configurée par un administrateur (path_configs). */
export function validateRoot(root: string, extraForbidden: readonly string[] = []): string {
  const p = normalizeAbsolute(root)
  assertNotSensitive(p, extraForbidden)
  // Une racine trop large (ex. /srv) donnerait accès à tout ce qu'elle contient.
  const broad = tooBroad(p)
  if (broad) throw new PathViolation(p, broad)
  return p
}

export function assertSlug(value: string, label = 'identifiant'): string {
  if (!SLUG_RE.test(value)) throw new PathViolation(value, `${label} invalide`)
  return value
}

export interface PathConfigLike {
  workingRoot: string
  buildRoot: string
  tmpRoot: string
  runtimeRoot: string
  forbiddenPaths: readonly string[]
}

export interface ProjectLayout {
  projectDir: string
  releasesDir: string
  sharedDir: string
  tmpDir: string
  buildDir: string
  runtimeDir: string
  release: (releaseId: string) => {
    dir: string
    sourceDir: string
    buildContextDir: string
    generatedDir: string
    composeFile: string
    metadataFile: string
  }
}

/**
 * Construit l'arborescence d'un projet (§6.2) :
 * <workingRoot>/<project>/{releases/<id>/{source,build-context,generated},shared,tmp}
 * Les racines sont configurées par endpoint ET par environnement (§6.4,
 * ex. /srv/deployments/production) : l'environnement n'est donc pas ajouté ici.
 * Tous les chemins retournés sont garantis à l'intérieur des racines configurées.
 */
export function projectLayout(cfg: PathConfigLike, projectSlug: string, projectPath?: string | null): ProjectLayout {
  assertSlug(projectSlug, 'projet')
  const working = validateRoot(cfg.workingRoot, cfg.forbiddenPaths)
  const build = validateRoot(cfg.buildRoot, cfg.forbiddenPaths)
  const tmp = validateRoot(cfg.tmpRoot, cfg.forbiddenPaths)
  const runtime = validateRoot(cfg.runtimeRoot, cfg.forbiddenPaths)

  // Le répertoire de travail et les données applicatives restent séparés (§6.3).
  if (isWithin(runtime, working) || isWithin(working, runtime)) {
    throw new PathViolation(runtime, 'le répertoire runtime doit être distinct du répertoire de travail')
  }

  // Chemin choisi pour le projet : releases et données sous une même racine (data/ séparé de releases/).
  const custom = projectPath ? validateProjectPath(cfg, projectPath) : null
  const projectDir = custom ?? posix.join(working, projectSlug)
  const releasesDir = posix.join(projectDir, 'releases')

  return {
    projectDir,
    releasesDir,
    sharedDir: posix.join(projectDir, 'shared'),
    tmpDir: posix.join(tmp, projectSlug),
    buildDir: posix.join(build, projectSlug),
    runtimeDir: custom ? posix.join(custom, 'data') : posix.join(runtime, projectSlug),
    release: (releaseId: string) => {
      if (!RELEASE_ID_RE.test(releaseId)) throw new PathViolation(releaseId, 'identifiant de release invalide')
      const dir = posix.join(releasesDir, releaseId)
      return {
        dir,
        sourceDir: posix.join(dir, 'source'),
        buildContextDir: posix.join(dir, 'build-context'),
        generatedDir: posix.join(dir, 'generated'),
        composeFile: posix.join(dir, 'compose.yml'),
        metadataFile: posix.join(dir, 'metadata.json'),
      }
    },
  }
}

/**
 * Chemin racine choisi pour un projet : absolu, sans zone sensible ni chemin
 * interdit, strictement sous la racine de travail ou la racine runtime de
 * l'environnement (là où le Runner est autorisé à écrire), jamais une racine elle-même.
 */
export function validateProjectPath(cfg: PathConfigLike, projectPath: string): string {
  const p = normalizeAbsolute(projectPath)
  assertNotSensitive(p, cfg.forbiddenPaths)
  const roots = [cfg.workingRoot, cfg.runtimeRoot].map(r => normalizeAbsolute(r))
  if (!roots.some(r => isWithin(p, r) && p !== r)) {
    throw new PathViolation(p, `doit se trouver sous ${roots.join(' ou ')}`)
  }
  return p
}

/**
 * Vérifie qu'un chemin fourni (ex. par le Runner, ou un bind demandé) reste
 * dans le périmètre d'un projet donné et pas dans celui d'un voisin.
 */
export function assertInsideProject(path: string, layout: ProjectLayout): string {
  const p = normalizeAbsolute(path)
  const roots = [layout.projectDir, layout.tmpDir, layout.buildDir, layout.runtimeDir]
  if (!roots.some(r => isWithin(p, r))) throw new PathViolation(p, 'hors du périmètre du projet')
  return p
}

/**
 * Valide un chemin relatif interne à une archive ou un dépôt (entrée ZIP,
 * sous-répertoire GitHub, chemin du Compose/Dockerfile).
 */
export function validateRelativeEntry(entry: string): string {
  if (!entry || entry.length > 512) throw new PathViolation(entry, 'entrée vide ou trop longue')
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(entry)) throw new PathViolation(entry, 'caractère de contrôle')
  if (entry.includes('\\')) throw new PathViolation(entry, 'antislash')
  if (entry.startsWith('/') || /^[A-Za-z]:/.test(entry)) throw new PathViolation(entry, 'chemin absolu')
  const segments = entry.split('/').filter(s => s !== '' && s !== '.')
  if (segments.some(s => s === '..')) throw new PathViolation(entry, 'remontée ..')
  return segments.join('/')
}

export { isWithin }
