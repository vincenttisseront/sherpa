/**
 * Versions d'images : un tag est comparé seulement aux tags de même forme
 * (mêmes séparateurs et mêmes mots, chiffres variables). « v4.7-5.1.1 » se compare
 * à « v4.8-5.2.0 », jamais à « v4.8-5.2.0-ldap » ; « 18-alpine » à « 19-alpine ».
 */

export interface TagVersion {
  tag: string
  /** Forme du tag, chiffres remplacés par # (« v#.#-#.#.# »). */
  shape: string
  nums: number[]
  prerelease: boolean
}

const PRERELEASE = /(?:^|[^a-z])(rc|alpha|beta|dev|nightly|snapshot|preview|pre|canary|edge|test|unstable)(?:[^a-z]|\d|$)/i
/** Tags sans version : pas de mise à niveau de version possible (seulement l'empreinte du même tag). */
const FLOATING = /^(latest|stable|main|master|lts|current|edge|nightly|develop|dev)$/i

export function parseTag(tag: string): TagVersion | null {
  if (!/\d/.test(tag) || FLOATING.test(tag)) return null
  // Un tag qui n'est qu'une empreinte ou un identifiant (sha, date compacte de 8+ chiffres) n'est pas une version.
  if (/^[0-9a-f]{12,}$/i.test(tag) || /^sha256-/.test(tag)) return null
  const nums = (tag.match(/\d+/g) ?? []).map(Number)
  if (nums.some(n => n > 99_999_999)) return null
  return { tag, shape: tag.replace(/\d+/g, '#'), nums, prerelease: PRERELEASE.test(tag) }
}

export function compareVersions(a: TagVersion, b: TagVersion): number {
  for (let i = 0; i < Math.max(a.nums.length, b.nums.length); i++) {
    const d = (a.nums[i] ?? 0) - (b.nums[i] ?? 0)
    if (d) return d
  }
  return 0
}

export type UpgradeLevel = 'major' | 'minor' | 'patch'

/** Niveau du changement : premier nombre (majeure), deuxième (mineure), au-delà (correctif). */
export function upgradeLevel(from: TagVersion, to: TagVersion): UpgradeLevel {
  const i = from.nums.findIndex((n, k) => n !== to.nums[k])
  return i <= 0 ? 'major' : i === 1 ? 'minor' : 'patch'
}

export interface VersionCandidates {
  current: TagVersion
  /** Plus récente dans la même version majeure (mineure ou correctif). */
  compatible: { tag: string, level: UpgradeLevel } | null
  /** Plus récente toutes versions confondues, si c'est une nouvelle majeure. */
  major: { tag: string, level: 'major' } | null
}

/** Versions plus récentes de même forme ; les préversions seulement si la version actuelle en est une. */
export function newerVersions(currentTag: string, tags: readonly string[]): VersionCandidates | null {
  const current = parseTag(currentTag)
  if (!current) return null
  const newer = tags
    .map(parseTag)
    .filter((v): v is TagVersion => !!v && v.shape === current.shape && (current.prerelease || !v.prerelease) && compareVersions(v, current) > 0)
    .sort((a, b) => compareVersions(b, a))
  const compatible = newer.find(v => upgradeLevel(current, v) !== 'major') ?? null
  const top = newer[0] ?? null
  return {
    current,
    compatible: compatible ? { tag: compatible.tag, level: upgradeLevel(current, compatible) } : null,
    major: top && upgradeLevel(current, top) === 'major' ? { tag: top.tag, level: 'major' } : null,
  }
}

/**
 * Dernière version publiée d'un dépôt, pour figer une image absente du registre ou sur un tag
 * flottant : version « pure » (1.27.3, v2.4), hors préversions, la plus précise à égalité
 * (1.27.3 plutôt que 1.27). null si le dépôt ne publie pas de telles versions.
 */
export function latestVersion(tags: readonly string[]): string | null {
  return versionCandidates(tags)[0] ?? null
}

/** Versions « pures » publiées, de la plus récente à la plus ancienne (la plus précise d'abord à égalité). */
export function versionCandidates(tags: readonly string[]): string[] {
  // Dates (20230811) et numéros de build : pas des versions à proposer.
  const pure = tags.map(parseTag).filter((v): v is TagVersion => !!v && !v.prerelease && /^v?#(\.#)*$/.test(v.shape) && v.nums[0]! < 1000)
  pure.sort((a, b) => compareVersions(b, a) || b.nums.length - a.nums.length)
  return pure.map(v => v.tag)
}

/** Services à données (bases, files) : une nouvelle majeure peut exiger une migration des données. */
export const STATEFUL_IMAGE = /(^|\/)(postgres|postgis|mysql|mariadb|mongo|mongodb|redis|valkey|keydb|elasticsearch|opensearch|rabbitmq|kafka|zookeeper|cassandra|clickhouse|influxdb|timescaledb|couchdb|neo4j|etcd|minio|harbor-db|memcached)(:|@|$)/i

/**
 * Bases dont une nouvelle majeure ne relit pas les données existantes : PostgreSQL (format du
 * répertoire de données, pg_upgrade ou sauvegarde/restauration) et MongoDB (montée de version
 * pas à pas). Changer l'image suffit à casser le service : jamais proposé comme mise à niveau.
 */
export const MAJOR_NEEDS_MIGRATION = /(^|\/)(postgres|postgis|timescaledb|mongo|mongodb)(:|@|$)/i
