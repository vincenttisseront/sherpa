/**
 * En-têtes de sécurité HTTP (§19). La CSP n'autorise que les scripts du site et,
 * par empreinte, les scripts en ligne effectivement rendus dans la page
 * (configuration Nuxt, importmap) : aucun 'unsafe-inline' pour les scripts.
 */
import { createHash } from 'node:crypto'

const INLINE_SCRIPT_RE = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi

/** Empreintes CSP des scripts en ligne exécutables (les blocs JSON ne sont pas des scripts). */
export function inlineScriptHashes(html: string): string[] {
  const hashes = new Set<string>()
  for (const m of html.matchAll(INLINE_SCRIPT_RE)) {
    const attrs = m[1] ?? ''
    const type = /\btype=["']?([^"'\s>]+)/i.exec(attrs)?.[1]?.toLowerCase()
    if (type && type !== 'module' && type !== 'text/javascript' && type !== 'importmap') continue
    hashes.add(`'sha256-${createHash('sha256').update(m[2] ?? '', 'utf8').digest('base64')}'`)
  }
  return [...hashes]
}

export function contentSecurityPolicy(scriptHashes: string[]): string {
  return [
    'default-src \'self\'',
    `script-src 'self' ${scriptHashes.join(' ')}`.trim(),
    // Les liaisons :style de Vue produisent des attributs style.
    'style-src \'self\' \'unsafe-inline\'',
    'img-src \'self\' data:',
    'font-src \'self\'',
    'connect-src \'self\'',
    'object-src \'none\'',
    'base-uri \'self\'',
    'form-action \'self\'',
    'frame-ancestors \'none\'',
  ].join('; ')
}

export const BASE_SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  // Les liens d'invitation portent un jeton dans le chemin : jamais transmis à un autre site.
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
}
