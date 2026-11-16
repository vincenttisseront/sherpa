import { issueSetupToken, setupRequired } from '../auth/setup'
import { env } from '../utils/env'

/**
 * Au démarrage, tant qu'aucun compte n'existe : un NOUVEAU jeton d'initialisation
 * est émis et affiché sur une ligne facile à retrouver (le précédent est invalidé).
 * Les logs d'un conteneur recréé étant perdus, réémettre à chaque démarrage évite
 * de rester sans jeton. Base ou Redis pas encore prêts : nouvelles tentatives.
 */
export default defineNitroPlugin(() => {
  void (async () => {
    for (let attempt = 1; attempt <= 30; attempt++) {
      try {
        if (!(await setupRequired())) return
        const token = await issueSetupToken(true)
        if (!token) return
        const url = `${env().APP_URL}/setup`
        console.warn([
          '',
          '=== Initialisation de la plateforme ===',
          `Aucun compte n'existe. Créer le premier administrateur sur ${url}`,
          `Jeton d'initialisation (usage unique, valable 24 h) : ${token}`,
          'Nouveau jeton sans redémarrer : docker compose exec app node dist/setup-token.mjs',
          '======================================',
          '',
        ].join('\n'))
        return
      }
      catch (err) {
        if (attempt === 30) console.error('Initialisation : jeton non émis (base ou Redis injoignable) :', (err as Error).message)
        else await new Promise(r => setTimeout(r, 2000))
      }
    }
  })()
})
