/**
 * Mise à niveau des images d'une cible, indépendante de la source (archive, GitHub,
 * Compose saisi) : la nouvelle image est une surcharge propre à la cible, appliquée
 * à l'analyse SI le Compose déclare toujours l'image d'origine (une nouvelle source qui
 * change elle-même la version l'emporte). Le Compose source mis à niveau est aussi
 * produit, pour être reporté dans le dépôt ou l'archive.
 */
import { isMap, parseDocument } from 'yaml'
import type { ComposeIssue } from '../../../shared/schemas/analysis'

export interface ImageOverride { image: string, from: string, at: string, by: string | null }

/** Référence d'image normalisée (docker.io/library/x → x) pour comparer deux écritures. */
export function normalizeImage(ref: string): string {
  return ref.trim().replace(/^docker\.io\//, '').replace(/^index\.docker\.io\//, '').replace(/^library\//, '')
}
export const sameImage = (a: string, b: string) => normalizeImage(a) === normalizeImage(b)

export interface ImageOrigin {
  service: string
  /** Valeur écrite dans le Compose (avant interpolation), null pour un service construit sans image. */
  raw: string | null
  build: boolean
  /** Variable qui porte l'image ou sa version (`${VERSION-v4.7}`), et sa valeur par défaut. */
  variable: { name: string, fallback: string | null } | null
  /** Image héritée d'une ancre YAML (`<<: *base`). */
  inherited: boolean
}

const VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?])([^}]*))?\}/

/** D'où vient l'image de chaque service (ancres et clés de fusion résolues). */
export function imageOrigins(composeText: string): Record<string, ImageOrigin> {
  const doc = parseDocument(composeText, { merge: true })
  const js = doc.toJS({ maxAliasCount: 1000 }) as { services?: Record<string, { image?: unknown, build?: unknown } | null> }
  const out: Record<string, ImageOrigin> = {}
  for (const [service, svc] of Object.entries(js.services ?? {})) {
    const raw = typeof svc?.image === 'string' ? svc.image : null
    const m = raw ? VAR_RE.exec(raw) : null
    const own = doc.getIn(['services', service])
    out[service] = {
      service,
      raw,
      build: svc?.build !== undefined && svc?.build !== null,
      variable: m ? { name: m[1]!, fallback: m[2] && m[2].includes('-') ? m[3] ?? '' : null } : null,
      inherited: !!raw && !(isMap(own) && own.has('image')),
    }
  }
  return out
}

/**
 * Applique les surcharges d'image aux services (après interpolation). Une surcharge
 * dont l'image d'origine ne correspond plus au Compose est ignorée et signalée.
 */
export function applyImageOverrides(services: Record<string, Record<string, unknown>>, overrides: Readonly<Record<string, ImageOverride>> | undefined): ComposeIssue[] {
  const issues: ComposeIssue[] = []
  for (const [service, ov] of Object.entries(overrides ?? {})) {
    const svc = services[service]
    if (!svc || typeof svc.image !== 'string') continue
    if (sameImage(svc.image, ov.from)) {
      issues.push({ severity: 'info', code: 'image.upgrade', service, message: `Image mise à niveau : ${normalizeImage(ov.from)} → ${normalizeImage(ov.image)}` })
      svc.image = ov.image
    }
    else if (!sameImage(svc.image, ov.image)) {
      issues.push({ severity: 'warning', code: 'image.upgrade_stale', service, message: `Mise à niveau vers ${normalizeImage(ov.image)} ignorée : le Compose déclare désormais ${normalizeImage(svc.image)}` })
    }
  }
  return issues
}

export interface ComposePatch { composeText: string, changed: string[], manual: { service: string, reason: string }[] }

/**
 * Compose source avec les nouvelles images, pour le reporter à la source : valeur
 * littérale remplacée (une seule fois si elle est portée par une ancre), ou valeur par
 * défaut de la variable (`${VERSION-v4.7}`). Une image entièrement portée par une
 * variable sans défaut est signalée (à changer dans les variables du projet).
 */
export function patchComposeImages(composeText: string, changes: readonly { service: string, from: string, to: string }[]): ComposePatch {
  const origins = imageOrigins(composeText)
  let text = composeText
  const changed: string[] = []
  const manual: ComposePatch['manual'] = []
  const done = new Set<string>()
  for (const c of changes) {
    const o = origins[c.service]
    if (!o?.raw) {
      manual.push({ service: c.service, reason: 'image construite (build) : version de base dans le Dockerfile' })
      continue
    }
    if (done.has(o.raw)) {
      changed.push(c.service)
      continue
    }
    let next: string | null = null
    if (!o.variable && sameImage(o.raw, c.from)) next = keepRegistryPrefix(o.raw, c.to)
    else if (o.variable && o.variable.fallback !== null) {
      // Image interpolée avec la valeur par défaut : on remplace la partie qui diffère dans le défaut.
      const withDefault = o.raw.replace(VAR_RE, o.variable.fallback)
      if (sameImage(withDefault, c.from)) {
        const [fromTag, toTag] = [tagOf(c.from), tagOf(c.to)]
        if (fromTag && toTag && o.variable.fallback.includes(fromTag)) next = o.raw.replace(VAR_RE, m => m.replace(o.variable!.fallback!, o.variable!.fallback!.replace(fromTag, toTag)))
      }
    }
    if (!next) {
      manual.push({ service: c.service, reason: o.variable ? `image donnée par la variable ${o.variable.name} : la changer dans les variables du projet` : 'image du Compose différente de celle en service' })
      continue
    }
    const before = text
    text = replaceImageValue(text, o.raw, next)
    if (text !== before) {
      done.add(o.raw)
      changed.push(c.service)
    }
    else manual.push({ service: c.service, reason: 'valeur introuvable dans le texte du Compose' })
  }
  // Le résultat doit rester un Compose lisible.
  if (changed.length && parseDocument(text).errors.length) return { composeText, changed: [], manual: changes.map(c => ({ service: c.service, reason: 'réécriture impossible sans casser le YAML' })) }
  return { composeText: text, changed, manual }
}

const tagOf = (ref: string) => /:([^/@:]+)(?:@|$)/.exec(ref)?.[1] ?? null

/** Garde l'écriture du registre du Compose (docker.io/… ou non). */
function keepRegistryPrefix(raw: string, to: string): string {
  const n = normalizeImage(to)
  if (raw.startsWith('docker.io/library/')) return `docker.io/library/${n}`
  if (raw.startsWith('docker.io/')) return `docker.io/${n}`
  return raw.startsWith('library/') ? `library/${n}` : n
}

/** Remplace la valeur `image:` (guillemets ou non) partout où elle apparaît telle quelle. */
function replaceImageValue(text: string, raw: string, next: string): string {
  const esc = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text.replace(new RegExp(`(\\bimage:\\s*)(["']?)${esc}\\2(\\s*(?:#.*)?)$`, 'gm'), (_m, p1: string, q: string, tail: string) => `${p1}${q}${next}${q}${tail}`)
}
