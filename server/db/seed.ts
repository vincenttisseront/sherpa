/** Données de référence (développement) : voir reference-data.ts, également appliqué par migrate. */
import { closeDb } from './client'
import { ensureReferenceData } from './reference-data'

await ensureReferenceData()
console.info('Seed terminé : environnements et rôles intégrés')
await closeDb()
