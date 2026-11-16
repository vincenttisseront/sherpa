/**
 * Rotation de la clé maîtresse : rechiffre les secrets avec la clé courante.
 *   node dist/rekey.mjs --dry-run   (aperçu)
 *   node dist/rekey.mjs             (rotation)
 * Prérequis : MASTER_KEY_ID / MASTER_KEY_FILE = nouvelle clé ; MASTER_KEYS_PREVIOUS_FILE = anciennes clés.
 * N'affiche jamais de secret.
 */
import { closeDb } from '../server/db/client'
import { closeRedis } from '../server/queue/redis'
import { rekeyAll } from '../server/services/rekey'

const dryRun = process.argv.includes('--dry-run')
try {
  const r = await rekeyAll({ dryRun })
  console.info(`Clé courante : ${r.currentKeyId}`)
  console.info(`Secrets : ${r.total} (répartition par clé : ${Object.entries(r.byKey).map(([k, n]) => `${k}=${n}`).join(', ') || 'aucun'})`)
  console.info(dryRun ? `À rechiffrer : ${r.toRotate} (aperçu, rien n'est modifié)` : `Rechiffrés : ${r.rotated} / ${r.toRotate}`)
  if (r.unreadable.length) {
    console.error(`${r.unreadable.length} secret(s) chiffré(s) avec une clé absente du trousseau (${[...new Set(r.unreadable.map(u => u.keyId))].join(', ')}) : ajouter cette clé à MASTER_KEYS_PREVIOUS_FILE puis relancer.`)
    process.exitCode = 2
  }
  else if (!dryRun) {
    console.info('Rotation terminée : l\'ancienne clé peut être retirée de MASTER_KEYS_PREVIOUS_FILE après redémarrage de l\'application et du worker.')
  }
}
finally {
  await closeRedis().catch(() => {})
  await closeDb()
}
