/**
 * Watchtower (§12) : mise à jour des images des services, configurée par
 * cible (donc par environnement), désactivée par défaut.
 *
 * Politiques :
 * - manual     : Watchtower détecte et signale les nouvelles images, sans rien mettre à jour ;
 * - scheduled  : mises à jour selon une planification (cron) ;
 * - automatic  : mises à jour à intervalle régulier ;
 * - labels     : la sélection des services vient des labels Watchtower du Compose.
 * Par service (hors mode labels) : off (exclu), monitor (signalé seulement), update (mis à jour).
 */
import { z } from 'zod'

export const WATCHTOWER_MODES = ['manual', 'scheduled', 'automatic', 'labels'] as const
export const SERVICE_POLICIES = ['off', 'monitor', 'update'] as const

/** Cron à 6 champs (secondes incluses), comme Watchtower : « 0 0 4 * * * ». */
export const CRON6_RE = /^(\S+\s+){5}\S+$/

export const watchtowerConfig = z.object({
  enabled: z.boolean().default(false),
  mode: z.enum(WATCHTOWER_MODES).default('manual'),
  schedule: z.string().trim().regex(CRON6_RE, 'Cron à 6 champs attendu (ex. 0 0 4 * * *)').default('0 0 4 * * *'),
  intervalSec: z.number().int().min(300, '5 minutes minimum').max(7 * 24 * 3600).default(86_400),
  services: z.record(z.string().max(100), z.enum(SERVICE_POLICIES)).default({}),
  cleanup: z.boolean().default(true),
  stopTimeoutSec: z.number().int().min(5).max(600).default(30),
  /** Après une mise à jour qui laisse un service en échec : prévenir seulement, ou mettre Watchtower en pause. */
  onFailure: z.enum(['notify', 'pause']).default('pause'),
  /** Source Git : reconnaissance explicite que l'exécution pourra différer du dépôt. */
  acknowledgeGitDrift: z.boolean().default(false),
  /**
   * Profil Watchtower du serveur (rythme, nettoyage) : un seul conteneur Watchtower par profil et
   * par serveur. Null : profil du serveur reprenant le rythme ci-dessus (créé au besoin).
   */
  profileId: z.uuid().nullable().default(null),
})
export type WatchtowerConfig = z.infer<typeof watchtowerConfig>

export const DEFAULT_WATCHTOWER: WatchtowerConfig = watchtowerConfig.parse({})

export const MODE_LABEL: Record<(typeof WATCHTOWER_MODES)[number], string> = {
  manual: 'Mise à jour manuelle (détection seule)',
  scheduled: 'Mise à jour planifiée',
  automatic: 'Mise à jour automatique',
  labels: 'Pilotage par labels du Compose',
}

export const UPDATE_KIND_LABEL: Record<ImageUpdateDto['kind'], string> = {
  updated: 'Mise à jour par Watchtower',
  available: 'Nouvelle image disponible',
  failed: 'Échec de mise à jour',
  external: 'Changement hors plateforme',
}

export interface ImageUpdateDto {
  id: string
  service: string
  image: string
  kind: 'updated' | 'available' | 'failed' | 'external'
  fromImageId: string | null
  toImageId: string | null
  digest: string | null
  releaseNumber: number | null
  detail: string | null
  detectedAt: string
}

export interface WatchtowerServiceRow {
  service: string
  image: string
  /** Image construite par la plateforme : jamais mise à jour par Watchtower. */
  built: boolean
  pinned: boolean
  /** Image exécutée différente de celle déployée par la plateforme. */
  drifted: boolean
}

/** Origine des informations affichées pour une cible (§12) : quatre sources distinctes. */
export interface TargetProvenance {
  /** 1. Configuration : d'où vient le Compose de la release active. */
  config: { kind: 'zip' | 'github', release: number, repository: string | null, commit: string | null, archiveSha256: string | null } | null
  /** 2. Dernier déploiement de la plateforme. */
  lastDeployment: { id: string, action: string, status: string, at: string, by: string | null, release: number | null } | null
  /** 3. Dernière mise à jour d'image par Watchtower (ou changement hors plateforme). */
  lastImageUpdate: { at: string, service: string, kind: ImageUpdateDto['kind'] } | null
  /** 4. Politique Watchtower appliquée. */
  policy: { enabled: boolean, mode: (typeof WATCHTOWER_MODES)[number] | null, paused: boolean, pending: boolean }
  /** Services dont l'image exécutée n'est plus celle du dernier déploiement. */
  driftedServices: string[]
}

export interface TargetWatchtowerDto {
  config: WatchtowerConfig
  applied: WatchtowerConfig | null
  /** Configuration enregistrée mais pas encore appliquée à la stack (redéploiement nécessaire). */
  pending: boolean
  pausedAt: string | null
  deployed: boolean
  /** Profil du serveur en service pour la cible, et profils disponibles sur son serveur. */
  profile: { id: string, name: string, scope: string } | null
  profiles: { id: string, name: string, summary: string }[]
  /** Fiche du serveur, onglet Watchtower (gestion des profils). */
  serverLink: string | null
  /** État réel du conteneur Watchtower sur l'hôte (null : non appliqué). */
  runtime: { state: 'running' | 'stopped' | 'missing' | 'unknown', detail: string | null } | null
  services: WatchtowerServiceRow[]
  provenance: TargetProvenance
  updates: ImageUpdateDto[]
}

/** Profil Watchtower d'un serveur : rythme et réglages communs à tous les projets qui l'utilisent. */
export const watchtowerProfileInput = z.object({
  name: z.string().trim().min(2).max(60),
  timing: z.enum(['interval', 'schedule']).default('interval'),
  intervalSec: z.number().int().min(300, '5 minutes minimum').max(7 * 24 * 3600).default(86_400),
  schedule: z.string().trim().regex(CRON6_RE, 'Cron à 6 champs attendu (ex. 0 0 4 * * *)').default('0 0 4 * * *'),
  cleanup: z.boolean().default(true),
  stopTimeoutSec: z.number().int().min(5).max(600).default(30),
  /**
   * Registres privés : identifiants transmis au Watchtower du profil (config.json Docker, une entrée
   * par registre). Mot de passe chiffré, jamais réaffiché ; absent en modification : inchangé.
   */
  registries: z.array(z.object({
    registry: z.string().trim().toLowerCase().regex(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/, 'Hôte du registre attendu (ex. registry.example.com ou harbor.local:5000)'),
    username: z.string().trim().min(1).max(200),
    password: z.string().max(2000).optional(),
  })).max(20).default([]),
})
export type WatchtowerProfileInput = z.infer<typeof watchtowerProfileInput>

export interface WatchtowerProfileDto extends Omit<WatchtowerProfileInput, 'registries'> {
  /** Registres privés (mots de passe jamais renvoyés). */
  registries: { registry: string, username: string, hasPassword: boolean }[]
  id: string
  endpointId: string
  /** Périmètre Watchtower (scope) porté par les conteneurs des projets du profil. */
  scope: string
  /** Réglages en service sur l'hôte (null : jamais appliqué) ; différents des réglages : à appliquer. */
  appliedAt: string | null
  pending: boolean
  image: string | null
  runtime: { state: 'running' | 'stopped' | 'missing' | 'unknown', detail: string | null }
  projects: { targetId: string, project: string, environment: string, paused: boolean }[]
  /** Conteneurs exclus (projets en pause). */
  excluded: string[]
}
