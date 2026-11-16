import { env } from '../utils/env'

/** Échoue au démarrage si la configuration est invalide plutôt qu'à la première requête. */
export default defineNitroPlugin(() => {
  const e = env()
  if (e.DEV_AUTH_BYPASS) console.warn('⚠ DEV_AUTH_BYPASS actif : authentification désactivée (développement uniquement)')
})
