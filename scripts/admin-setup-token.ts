/**
 * Régénère le jeton d'initialisation (si aucun compte n'existe encore) ; le précédent est invalidé :
 *   docker compose exec app node dist/setup-token.mjs        (production)
 *   npm run admin:setup-token [-- --out fichier]             (développement)
 * Le jeton est écrit dans le fichier indiqué (droits 600) ou affiché.
 */
import { writeFileSync } from 'node:fs'
import { issueSetupToken } from '../server/auth/setup'
import { closeDb } from '../server/db/client'
import { closeRedis } from '../server/queue/redis'

const outIdx = process.argv.indexOf('--out')
const token = await issueSetupToken(true)
if (!token) console.error('Des comptes existent déjà : initialisation inutile.')
else if (outIdx > 0) {
  writeFileSync(process.argv[outIdx + 1]!, token, { mode: 0o600 })
  console.info(`Jeton d'initialisation écrit dans ${process.argv[outIdx + 1]} (valable 24 h).`)
}
else console.info(`Jeton d'initialisation (usage unique, valable 24 h) : ${token}`)
await closeRedis()
await closeDb()
