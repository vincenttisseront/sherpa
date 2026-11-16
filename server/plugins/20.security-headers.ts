/** En-têtes de sécurité sur toutes les réponses ; CSP à empreintes sur les pages rendues. */
import { BASE_SECURITY_HEADERS, contentSecurityPolicy, inlineScriptHashes } from '../utils/security-headers'
import { env } from '../utils/env'

export default defineNitroPlugin((nitroApp) => {
  // En développement (Vite, rechargement à chaud), la CSP stricte bloquerait le client.
  if (import.meta.dev) return

  nitroApp.hooks.hook('request', (event) => {
    for (const [k, v] of Object.entries(BASE_SECURITY_HEADERS)) setResponseHeader(event, k, v)
    if (env().COOKIE_SECURE) setResponseHeader(event, 'Strict-Transport-Security', 'max-age=31536000')
    // Réponses de l'API : jamais mises en cache (données et droits propres à la session).
    if (event.path.startsWith('/api/')) setResponseHeader(event, 'Cache-Control', 'no-store')
  })

  nitroApp.hooks.hook('render:response', (response) => {
    if (typeof response.body !== 'string') return
    response.headers ??= {}
    response.headers['content-security-policy'] = contentSecurityPolicy(inlineScriptHashes(response.body))
  })
})
