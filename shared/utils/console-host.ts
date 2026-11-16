/**
 * Hôte de la console vu depuis ses conteneurs : « localhost » y désigne le conteneur,
 * pas la machine. Les conteneurs app et worker déclarent ce nom (extra_hosts host-gateway).
 */
export const CONSOLE_HOST = 'host.docker.internal'

const LOOPBACK = /^(localhost|localhost\.localdomain|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|\[::1\]|0\.0\.0\.0)$/i

/** Adresse de boucle locale : injoignable comme hôte cible depuis la console. */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.test(host.trim())
}

/** Hôte d'une URL saisie (vide si illisible). */
export function urlHost(url: string): string {
  try {
    return new URL(url.trim()).hostname
  }
  catch {
    return ''
  }
}

/** Même URL avec l'hôte de la console à la place d'une adresse de boucle locale. */
export function withConsoleHost(url: string): string {
  try {
    const u = new URL(url.trim())
    u.hostname = CONSOLE_HOST
    return u.toString().replace(/\/$/, '')
  }
  catch {
    return url
  }
}

export const LOOPBACK_MESSAGE = `localhost désigne le conteneur de la console, pas la machine qui l'héberge : utiliser ${CONSOLE_HOST}`
