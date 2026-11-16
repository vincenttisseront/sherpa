/**
 * Accès d'une cible au tableau de bord (§17) : fonctions pures, sans base ni réseau,
 * séparées de `dashboard.ts` pour rester testables sans charger les services.
 */
import type { DashboardDto } from '../../shared/schemas/dashboard'
import { stackNameFor } from '../lib/compose/analyze'

/** URL servie par un reverse proxy de l'hôte vers une stack (lue sur la carte des proxies). */
export interface DetectedUrl { stack: string, host: string, url: string, service: string | null }

/** Accès d'une cible : expositions gérées d'abord, puis URL détectées sur les proxies (sans doublon). */
export function linksOf(t: { exposures: { host: string, pathPrefix: string | null, service: string }[], stackName: string | null, slug: string, envKey: string }, httpsPort: number, detected: DetectedUrl[]): DashboardDto['deployed'][number]['links'] {
  const links: DashboardDto['deployed'][number]['links'] = []
  const seen = new Set<string>()
  for (const e of t.exposures) {
    const h = `${e.host}${e.pathPrefix ?? ''}`
    if (seen.has(h)) continue
    seen.add(h)
    links.push({ host: h, url: `https://${e.host}${httpsPort === 443 ? '' : `:${httpsPort}`}${e.pathPrefix ?? '/'}`, service: e.service, detected: false })
  }
  const stack = t.stackName ?? stackNameFor(t.slug, t.envKey)
  for (const d of detected.filter(x => x.stack === stack)) {
    if (seen.has(d.host) || d.host === '*') continue
    seen.add(d.host)
    links.push({ host: d.host, url: d.url, service: d.service, detected: true })
  }
  return links
}
