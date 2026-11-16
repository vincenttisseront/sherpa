/** Migration d'une stack gérée vers un autre serveur (plan, demande, emplacement d'origine). */
import { z } from 'zod'

/**
 * Élément copié d'un hôte à l'autre :
 * - release : dossier de la release active (sources, fichiers générés) ;
 * - data : dossier des données du projet (binds relatifs, volumes en dossiers) ;
 * - volume : volume nommé de la stack (recréé sur la cible avec ses labels) ;
 * - bind : dossier de l'hôte monté hors du projet (même chemin sur la cible).
 */
export type MigrationItemKind = 'release' | 'data' | 'volume' | 'bind'

export interface MigrationItem {
  id: string
  kind: MigrationItemKind
  label: string
  /** Source sur le serveur d'origine (volume ou chemin) et destination sur la cible. */
  source: string
  destination: string
  services: string[]
  /** Taille mesurée (null : non mesurée) ; isFile : fichier isolé (non copiable). */
  sizeBytes: number | null
  isFile: boolean
  /** Toujours copié (release) ; sinon au choix. */
  required: boolean
  /** Coché par défaut. */
  selected: boolean
  /** Remarque affichée (contenu existant remplacé, fichier non copiable…). */
  note: string | null
}

export interface MigrationDestination {
  endpointId: string
  serverId: string
  serverName: string
  endpointName: string
  online: boolean
  transport: 'agent' | 'ssh'
  /** Raison pour laquelle la cible n'est pas proposée (null : possible). */
  unavailable: string | null
}

export interface MigrationPlan {
  from: { serverName: string, endpointName: string }
  to: { serverName: string, endpointName: string, endpointId: string }
  stackName: string
  items: MigrationItem[]
  /** Empêchements : chacun dit quoi faire pour le lever. */
  blockers: string[]
  /** Points d'attention (DNS, Watchtower, dossier du projet…). */
  notes: string[]
  /** Alertes de l'analyse du Compose avec les politiques de la cible. */
  warnings: string[]
  freeBytes: number | null
  /** Hôtes publiés par Traefik : DNS à faire pointer vers la cible. */
  hosts: string[]
}

export const migrationInput = z.object({
  endpointId: z.uuid(),
  /** Éléments à copier (identifiants du plan) ; les éléments obligatoires le sont toujours. */
  items: z.array(z.string().max(1024)).max(200),
  /** Nom de la stack ressaisi : la stack est arrêtée sur le serveur d'origine pendant la copie. */
  confirm: z.string(),
})
export type MigrationInput = z.infer<typeof migrationInput>

export const migrationCleanupInput = z.object({
  /** Supprime aussi les données d'origine (volumes de la stack et dossier des données du projet). */
  removeData: z.boolean().default(false),
  confirm: z.string(),
})

/** Options du job de migration (déploiement « migrate »). */
export interface MigrationJobOptions {
  toEndpointId: string
  items: string[]
}

export interface MigratedFrom {
  endpointId: string
  serverName: string
  endpointName: string
  stackId: number | null
  stackName: string
  /** Chemin de projet sur l'origine (null : racines par défaut). */
  projectPath: string | null
  /** Volumes nommés et dossier de données laissés sur l'origine. */
  volumes: string[]
  dataDir: string | null
  releaseSlugs: string[]
  at: string
  deploymentId: string
  /** Ancienne stack supprimée depuis la console. */
  cleanedAt: string | null
}
