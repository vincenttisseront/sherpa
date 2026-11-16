/**
 * Connecteur Ollama : réglages d'administration et analyse de logs par un modèle local.
 * Le jeton éventuel (proxy placé devant Ollama) est chiffré côté serveur et n'est jamais renvoyé.
 */
import { z } from 'zod'

export const OLLAMA_DEFAULT_URL = 'http://localhost:11434'

/** Fonctions qui s'appuient sur Ollama : chacune s'active séparément (réglages), toutes par défaut. */
export const OLLAMA_FEATURES = [
  { key: 'logs', label: 'Analyse des logs', hint: 'Logs d\'un déploiement ou d\'un conteneur' },
  { key: 'deploy-failure', label: 'Diagnostic d\'un déploiement en échec', hint: 'Logs, étape en échec, contexte de la cible' },
  { key: 'analysis-blockers', label: 'Explication des blocages d\'analyse', hint: 'Ports, volumes, domaines, Compose refusés' },
  { key: 'vulnerabilities', label: 'Tri des vulnérabilités', hint: 'Priorités et texte d\'issue pour une image' },
  { key: 'release-notes', label: 'Notes de version avant mise à niveau', hint: 'Résumé des releases GitHub, changements cassants' },
  { key: 'nl-search', label: 'Recherche en langage naturel', hint: 'Audit : une phrase devient des filtres' },
  { key: 'digest', label: 'Résumé d\'activité', hint: 'Synthèse des déploiements, échecs et alertes' },
  { key: 'proxy', label: 'Explication des reverse proxies', hint: 'Routes et domaines d\'un hôte' },
  { key: 'support', label: 'Synthèse du tech support', hint: 'Symptôme, hypothèses, ordre de vérification' },
  { key: 'metrics', label: 'Lecture de l\'historique des ressources', hint: 'CPU, mémoire, redémarrages d\'un conteneur' },
  { key: 'compose-gen', label: 'Du « docker run » au Compose', hint: 'Compose conforme, revalidé par l\'analyse' },
] as const
export type OllamaFeature = (typeof OLLAMA_FEATURES)[number]['key']
export const OLLAMA_FEATURE_KEYS = OLLAMA_FEATURES.map(f => f.key) as [OllamaFeature, ...OllamaFeature[]]

export const ollamaSettingsInput = z.object({
  enabled: z.boolean().default(false),
  baseUrl: z.string().trim().url('Adresse http(s) attendue').max(300).default(OLLAMA_DEFAULT_URL),
  model: z.string().trim().min(1, 'Modèle requis').max(120).regex(/^[\w.:/-]+$/, 'Nom de modèle Ollama (ex. llama3.1:8b)').default('llama3.1:8b'),
  /** Délai maximal d'une analyse (secondes) : un modèle local froid peut mettre plusieurs dizaines de secondes à charger. */
  timeoutSec: z.number().int().min(10).max(900).default(120),
  /** Fenêtre de contexte demandée au modèle (tokens) : borne la quantité de logs envoyée. */
  contextTokens: z.number().int().min(2048).max(131_072).default(8192),
  /** Fonctions actives (si le connecteur l'est) : toutes par défaut. */
  features: z.array(z.enum(OLLAMA_FEATURE_KEYS)).max(OLLAMA_FEATURE_KEYS.length).default([...OLLAMA_FEATURE_KEYS]),
  /** Jeton Bearer. undefined : inchangé. */
  token: z.string().trim().min(8, 'Jeton trop court').max(500).optional(),
  /** Supprime le jeton enregistré. */
  clearToken: z.boolean().default(false),
})
export type OllamaSettingsInput = z.infer<typeof ollamaSettingsInput>

/** Test de connexion : adresse et jeton saisis, ou réglages enregistrés si le corps est vide. */
export const ollamaTestInput = z.object({
  baseUrl: z.string().trim().url('Adresse http(s) attendue').max(300).optional(),
  token: z.string().trim().min(8).max(500).optional(),
  model: z.string().trim().max(120).optional(),
})
export type OllamaTestInput = z.infer<typeof ollamaTestInput>

export interface OllamaSettingsDto {
  enabled: boolean
  baseUrl: string
  model: string
  timeoutSec: number
  contextTokens: number
  features: OllamaFeature[]
  hasToken: boolean
}

/** Ce que voit un lecteur de logs : l'analyse est-elle disponible, sans l'adresse du serveur. */
export interface OllamaStatusDto {
  enabled: boolean
  model: string | null
  /** Fonctions disponibles (vide si le connecteur est désactivé). */
  features: OllamaFeature[]
}

export interface OllamaTestResult {
  ok: boolean
  version: string | null
  models: { name: string, sizeBytes: number | null }[]
  /** Le modèle configuré (ou saisi) est installé sur le serveur. */
  modelPresent: boolean
  error: string | null
}

export const LOG_SEVERITIES = ['ok', 'warning', 'error'] as const
export type LogSeverity = (typeof LOG_SEVERITIES)[number]

export interface LogAnalysisCause {
  title: string
  /** Ligne ou fait des logs qui l'appuie. */
  evidence: string
}

/** Rapport rendu par une fonction d'assistance (logs, diagnostic, tri, notes de version…) : même forme pour toutes. */
export interface AiReportDto {
  severity: LogSeverity
  summary: string
  /** Points clés (causes probables, vulnérabilités à traiter, changements cassants… selon la fonction). */
  causes: LogAnalysisCause[]
  actions: string[]
  /** Texte prêt à copier (corps d'issue, message…), pour les fonctions qui en produisent. */
  draft: string | null
  /** false : le modèle n'a pas respecté le format demandé, le texte brut est repris dans le résumé. */
  structured: boolean
  meta: {
    model: string
    at: string
    durationMs: number
    /** Lignes lues, lignes réellement envoyées au modèle (après regroupement des répétitions et bornage). */
    totalLines: number
    sentLines: number
    truncated: boolean
  }
}
export type LogAnalysisDto = AiReportDto

/** Corps commun aux routes d'analyse : question libre facultative pour orienter le modèle. */
export const FOCUS_MAX = 300
export const logAnalysisFocus = z.string().trim().max(FOCUS_MAX).optional()
