/**
 * Notes de version d'une mise à niveau d'image : sélection des releases GitHub entre la version
 * actuelle (exclue) et la version cible (incluse), nettoyage du Markdown, blocs de contexte pour
 * Ollama. Fonctions pures, testées.
 */
import type { GithubReleaseNotes } from './github'
import type { ContextPart } from './ollama/context'
import { compareVersions } from './remediation'

/** Version d'un tag de release ou d'image : « v1.4.2 », « release-1.4.2 », « 1.4.2-alpine » → « 1.4.2 ». */
export function versionOfTag(tag: string): string | null {
  const m = /^\d+(?:\.\d+){0,3}/.exec(tag.replace(/^[^\d]*/, ''))
  return m ? m[0] : null
}

/** Tag de préversion (« 1.5.0-rc1 », « 2.0.0-beta.2 »), même si GitHub ne marque pas la release comme telle. */
const isPreTag = (tag: string): boolean => /[-.](?:rc|alpha|beta|pre|preview|dev|snapshot|nightly)\d*/i.test(tag)

export const MAX_RELEASES = 15
export const MAX_NOTES_CHARS = 3500

/**
 * Releases dans l'intervalle ]from, to], de la plus ancienne à la plus récente ; préversions exclues
 * sauf si la cible en est une. Un tag court couvre ses correctifs : « 1.4 » exclut 1.4.x (déjà dans
 * l'image en service, qui suit 1.4) et « 1.5 » inclut 1.5.x (ce que la cible récupérera).
 */
export function releasesBetween(releases: readonly GithubReleaseNotes[], from: string, to: string): GithubReleaseNotes[] {
  const lo = versionOfTag(from)
  const hi = versionOfTag(to)
  if (!lo || !hi) return []
  // La cible est une préversion si son tag l'indique ou si GitHub marque la release de ce tag exacte comme telle.
  const sameTag = (a: string, b: string) => a.replace(/^v/i, '').toLowerCase() === b.replace(/^v/i, '').toLowerCase()
  const targetIsPre = isPreTag(to) || releases.some(r => r.prerelease && sameTag(r.tag, to))
  return releases
    .filter((r) => {
      const v = versionOfTag(r.tag)
      if (!v || (!targetIsPre && (r.prerelease || isPreTag(r.tag)))) return false
      const aboveFrom = compareVersions(v, lo) > 0 && !v.startsWith(`${lo}.`)
      const upToTarget = compareVersions(v, hi) <= 0 || v.startsWith(`${hi}.`)
      return aboveFrom && upToTarget
    })
    .sort((a, b) => compareVersions(versionOfTag(a.tag)!, versionOfTag(b.tag)!))
    .slice(-MAX_RELEASES)
}

/** Markdown allégé : commentaires HTML, images, badges et lignes vides répétées retirés ; borné. */
export function cleanNotes(body: string, max = MAX_NOTES_CHARS): string[] {
  const text = body
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    // Badges (image dans un lien) avant les images seules, sinon il resterait un lien vide.
    .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  const clipped = text.length > max ? `${text.slice(0, max)}\n[… notes tronquées …]` : text
  return clipped ? clipped.split('\n') : []
}

export interface ReleaseNotesContext {
  image: string
  service: string
  from: string
  to: string
  repository: string
  stateful: boolean
  releases: readonly GithubReleaseNotes[]
}

export function releaseNotesParts(c: ReleaseNotesContext): ContextPart[] {
  const head = [
    `Image : ${c.image} (service ${c.service}) · mise à niveau de ${c.from} vers ${c.to}`,
    `Dépôt des notes : ${c.repository} · ${c.releases.length} release(s) entre les deux versions${c.stateful ? ' · service à données : une migration est possible' : ''}`,
  ]
  const notes = c.releases.map((r, i) => ({
    title: `Release ${r.tag}${r.prerelease ? ' (préversion)' : ''}${r.publishedAt ? ` du ${r.publishedAt.slice(0, 10)}` : ''}`,
    lines: cleanNotes(r.body),
    // Les plus récentes d'abord en cas de manque de place : ce sont elles qui précèdent la mise à niveau.
    weight: 1 + i / Math.max(1, c.releases.length),
  }))
  return [{ title: 'Mise à niveau', lines: head, weight: 1 }, ...notes]
}
