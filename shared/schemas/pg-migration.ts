/** Migration de PostgreSQL vers une nouvelle version majeure (plan et demande). */
import { z } from 'zod'

export interface PgMigrationPlan {
  service: string
  /** Image en service (release active, mise à niveau comprise). */
  image: string
  currentMajor: number | null
  /** Versions majeures publiées, de même forme de tag (la plus récente de chaque majeure). */
  candidates: { major: number, tag: string, image: string }[]
  /** Montage des données relevé sur le conteneur en service. */
  mount: { type: string, source: string, destination: string } | null
  pgdata: string | null
  user: string | null
  /** Répertoire de l'hôte qui recevra la sauvegarde (dossier shared/ du projet). */
  backupDir: string | null
  /** Empêchements : la migration n'est possible que si la liste est vide. */
  blockers: string[]
  /** Points d'attention (affichés, non bloquants). */
  notes: string[]
}

export const pgMigrationInput = z.object({
  service: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/),
  tag: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/, 'Tag invalide'),
  /** Nom du service ressaisi : confirmation explicite (stack arrêtée pendant l'opération). */
  confirm: z.string(),
})
export type PgMigrationInput = z.infer<typeof pgMigrationInput>
