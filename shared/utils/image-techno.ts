/**
 * Techno d'une image (regroupement de la page Vulnérabilités) : dépôt sans registre Docker Hub,
 * tag ni empreinte (« n8nio/n8n », « postgres », « ghcr.io/org/app ») et version (tag, sinon
 * empreinte courte).
 */
import { compareVersions, parseTag } from './image-version'

export function imageTechno(image: string): { techno: string, version: string } {
  let rest = image.trim()
  // Conteneur lancé sur une image sans nom (empreinte seule).
  if (/^sha256:[0-9a-f]+$/i.test(rest)) return { techno: 'image sans nom', version: rest.slice(7, 19) }
  let digest: string | null = null
  const at = rest.indexOf('@')
  if (at >= 0) {
    digest = rest.slice(at + 1)
    rest = rest.slice(0, at)
  }
  let tag: string | null = null
  const colon = rest.lastIndexOf(':')
  if (colon > rest.lastIndexOf('/')) {
    tag = rest.slice(colon + 1)
    rest = rest.slice(0, colon)
  }
  const techno = rest.replace(/^(docker\.io|index\.docker\.io|registry-1\.docker\.io)\//, '').replace(/^library\//, '')
  return { techno, version: tag ?? (digest ? digest.replace(/^sha256:/, '').slice(0, 12) : 'latest') }
}

/** Versions d'une même techno, la plus récente d'abord (versions comparables, sinon ordre alphabétique inverse). */
export function compareImageVersions(a: string, b: string): number {
  const va = parseTag(a)
  const vb = parseTag(b)
  if (va && vb && va.shape === vb.shape) return compareVersions(vb, va)
  if (va && !vb) return -1
  if (!va && vb) return 1
  return b.localeCompare(a)
}
