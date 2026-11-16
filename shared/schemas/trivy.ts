/**
 * Analyse de vulnérabilités des images (Trivy) : réglages (rythme, sévérités, périmètre),
 * résultats par image et par serveur, vulnérabilités relevées.
 */
import { z } from 'zod'

export const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'] as const
export type Severity = (typeof SEVERITIES)[number]
export const SEVERITY_LABEL: Record<Severity, string> = { CRITICAL: 'Critique', HIGH: 'Haute', MEDIUM: 'Moyenne', LOW: 'Basse', UNKNOWN: 'Inconnue' }

/** Expression cron à 5 champs (minute heure jour-du-mois mois jour-de-semaine). */
export const CRON_RE = /^(\S+\s+){4}\S+$/

export const trivySettingsInput = z.object({
  enabled: z.boolean().default(true),
  /** Par défaut : chaque lundi à 03:00. */
  cron: z.string().trim().regex(CRON_RE, 'Expression cron à 5 champs (ex. 0 3 * * 1)').max(100).default('0 3 * * 1'),
  timezone: z.string().trim().min(1).max(60).default('Europe/Paris'),
  severities: z.array(z.enum(SEVERITIES)).min(1, 'Au moins une sévérité').default(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
  /** Vulnérabilités sans correctif publié ignorées. */
  ignoreUnfixed: z.boolean().default(false),
  /** Images des conteneurs gérés par la console, ou de tous les conteneurs en marche. */
  scope: z.enum(['managed', 'all']).default('managed'),
  image: z.string().trim().regex(/^[a-z0-9][a-z0-9._/-]*(?::\d+)?\/?[a-z0-9._/-]*:[A-Za-z0-9._-]+$/, 'Image avec son tag (ex. aquasec/trivy:0.67.2)').default('aquasec/trivy:0.67.2'),
  /** Miroir de la base de vulnérabilités (registre OCI), pour un réseau sans accès à mirror.gcr.io / ghcr.io. */
  dbRepository: z.string().trim().regex(/^[a-z0-9][a-z0-9._:/-]+$/i, 'Dépôt OCI (ex. registre.interne/trivy-db:2)').max(300).nullable().default(null),
  /** Notification des nouvelles vulnérabilités à partir de cette sévérité. */
  notifyMin: z.enum(['CRITICAL', 'HIGH', 'off']).default('CRITICAL'),
  timeoutMin: z.number().int().min(1).max(60).default(15),
  /** Images construites par la console analysées après le build, avant le déploiement. */
  buildScan: z.boolean().default(true),
  /** Dépendances du code source (fichiers de verrouillage, manifestes) analysées avant le déploiement et lors des analyses planifiées. */
  sourceScan: z.boolean().default(true),
  /** Le seuil de blocage s'applique aussi aux dépendances du code source. */
  sourceBlock: z.boolean().default(false),
  /** Images des registres récupérées sur l'hôte et analysées avant le déploiement. */
  registryScan: z.boolean().default(true),
  /** Déploiement bloqué si une image analysée avant lui (construite ou des registres) a des vulnérabilités à partir de cette sévérité. */
  buildBlock: z.enum(['off', 'CRITICAL', 'HIGH']).default('off'),
  /** Blocage limité aux vulnérabilités qui ont un correctif publié. */
  buildBlockFixableOnly: z.boolean().default(true),
})
export type TrivySettings = z.infer<typeof trivySettingsInput>

export interface Finding {
  id: string
  pkg: string
  installed: string
  fixed: string | null
  severity: Severity
  title: string | null
  url: string | null
  /** Cible du rapport (système, dépendances d'une application…). */
  target: string
  /** Paquets du système (os-pkgs) ou dépendances d'une application (lang-pkgs). */
  class?: 'os-pkgs' | 'lang-pkgs'
  /** Écosystème : debian, alpine, pip, npm, gomod, jar… */
  type?: string
}

export type SeverityCounts = Record<Severity, number>

export interface ImageScanDto {
  id: string
  endpointId: string
  serverName: string
  endpointName: string
  image: string
  imageId: string
  scannedAt: string
  status: 'ok' | 'error'
  error: string | null
  os: string | null
  counts: SeverityCounts
  fixable: number
  targets: { targetId: string, projectId: string, label: string, services: string[] }[]
  /** Dépôt d'origine déclaré par l'image (label org.opencontainers.image.source). */
  sourceUrl?: string | null
  trigger?: ScanTrigger | null
  deploymentId?: string | null
  /** Version déclarée par l'image (label OCI), en plus du tag et de l'empreinte. */
  imageVersion?: string | null
  /** Analyse demandée (en file) ou en cours. */
  scanState?: ScanState | null
}

export type ScanState = 'queued' | 'running'

/** Origine d'une analyse : déploiement (avant la mise en service), planifiée, à la demande. */
export type ScanTrigger = 'deploy' | 'planned' | 'manual'

export interface SourceScanDto {
  id: string
  targetId: string
  projectId: string
  label: string
  serverName: string
  /** Dépôt GitHub et référence (branche, tag) ; null pour une archive déposée. */
  repository: string | null
  ref: string | null
  commitSha: string | null
  release: string | null
  scannedAt: string
  status: 'ok' | 'error'
  error: string | null
  counts: SeverityCounts
  fixable: number
  /** Fichiers de dépendances trouvés (package-lock.json, requirements.txt, go.sum…). */
  manifests: string[]
  trigger?: ScanTrigger | null
  deploymentId?: string | null
  scanState?: ScanState | null
}

export interface TrivyRun {
  running: boolean
  trigger: string
  startedAt: string
  finishedAt: string | null
  total: number
  done: number
  failed: number
  current: string | null
  /** Première erreur de l'analyse (image indisponible, Trivy injoignable…). */
  lastError?: string | null
  /** Information : rien à analyser (image arrêtée ou supprimée…). */
  note?: string | null
}

/** File des analyses : demandes en attente, analyse en cours, dernier échec. */
export interface TrivyQueue { waiting: number, active: number, activeSince: string | null, lastFailure: { at: string, reason: string } | null }

export interface TrivyStatus { settings: TrivySettings, run: TrivyRun | null, queue?: TrivyQueue | null }

export const scanRequestInput = z.object({
  endpointId: z.string().uuid().optional(),
  targetId: z.string().uuid().optional(),
  /** Une seule image (ligne de la page Vulnérabilités), ou le seul code source d'une cible. */
  imageScanId: z.string().uuid().optional(),
  sourceScanId: z.string().uuid().optional(),
})

/** Nettoyage des analyses (page Vulnérabilités) : motifs cumulables, aperçu sans suppression. */
export const scanCleanupInput = z.object({
  /** Images qui ne tournent plus (ni empreinte ni référence parmi les conteneurs en marche). */
  stale: z.boolean().default(false),
  /** Analyses plus anciennes d'une même image sur un même serveur (seule la plus récente reste). */
  duplicates: z.boolean().default(false),
  failed: z.boolean().default(false),
  /** Code source des cibles sans release active ou de projets archivés. */
  sources: z.boolean().default(false),
  all: z.boolean().default(false),
  dryRun: z.boolean().default(true),
})
export type ScanCleanupInput = z.infer<typeof scanCleanupInput>
export interface ScanCleanupResult {
  images: number
  sources: number
  byReason: { stale: number, duplicates: number, failed: number, sources: number }
  /** Serveurs injoignables : leurs images ne sont pas comptées comme arrêtées. */
  unreachable: string[]
  dryRun: boolean
}

/** Version de Trivy en service et dernière version publiée (carte « Mises à jour d'images »). */
export interface TrivyEngineDto {
  image: string
  repository: string
  tag: string
  latest: string | null
  latestError: string | null
  /** Une version plus récente est publiée. */
  updateAvailable: boolean
}
