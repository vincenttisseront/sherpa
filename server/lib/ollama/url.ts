/**
 * Adresse du serveur Ollama : fonctions pures (aucune E/S), partagées par l'enregistrement des
 * réglages et par l'adaptateur HTTP (qui revérifie avant chaque appel).
 *
 * Ollama tourne le plus souvent sur le réseau interne (localhost, conteneur voisin, serveur GPU du
 * LAN) : les adresses privées sont donc admises. Sont refusés les identifiants dans l'adresse, les
 * paramètres, et les adresses de métadonnées cloud / lien local (cible classique d'une SSRF).
 */
import { trimTrailingSlashes } from '../../../shared/utils/trim'

const BLOCKED_HOSTS = new Set(['metadata.google.internal', 'metadata', 'instance-data'])

const isLinkLocal = (host: string): boolean =>
  /^169\.254\.\d{1,3}\.\d{1,3}$/.test(host)
  || host.startsWith('fe80:')
  || host.startsWith('::ffff:a9fe:')
  || host === 'fd00:ec2::254'

/** null si l'adresse est utilisable, sinon la raison du refus (en français, pour l'interface). */
export function checkOllamaUrl(raw: string): string | null {
  let u: URL
  try {
    u = new URL(raw)
  }
  catch {
    return 'Adresse invalide'
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'Seules les adresses http et https sont admises'
  if (u.username || u.password) return 'Pas d\'identifiants dans l\'adresse : utiliser le champ « Jeton »'
  if (u.search || u.hash) return 'L\'adresse ne doit contenir ni paramètres ni ancre'
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (BLOCKED_HOSTS.has(host) || isLinkLocal(host)) return 'Adresse réservée (métadonnées du cloud ou lien local) : refusée'
  return null
}

/** Adresse canonique sans « / » final (un préfixe de chemin est conservé : proxy inverse devant Ollama). */
export function normalizeOllamaUrl(raw: string): string {
  const u = new URL(raw)
  return trimTrailingSlashes(`${u.origin}${u.pathname}`)
}
