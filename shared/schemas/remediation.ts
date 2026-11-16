/**
 * Demandes de correction des vulnérabilités (issue ou PR GitHub) préparées et suivies depuis la
 * page Vulnérabilités : brouillon (dépôt, texte, modifications proposées), création, suivi.
 */
import { z } from 'zod'

const REPOSITORY_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/

export const remediationSubject = z.object({ type: z.enum(['image', 'source']), id: z.string().uuid() })
export type RemediationSubject = z.infer<typeof remediationSubject>

export const remediationDraftInput = z.object({
  subject: remediationSubject,
  minSeverity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']).default('HIGH'),
  fixableOnly: z.boolean().default(true),
  lang: z.enum(['fr', 'en']).default('fr'),
  /** Serveur, projets et lien vers la console dans le texte (déconseillé pour un dépôt public). */
  includeContext: z.boolean().default(false),
  kind: z.enum(['issue', 'pr']).optional(),
  /** Dépôt saisi à la place de celui détecté. */
  repository: z.string().trim().regex(REPOSITORY_RE, 'org/dépôt').nullable().optional(),
})
export type RemediationDraftInput = z.infer<typeof remediationDraftInput>

export const remediationCreateInput = remediationDraftInput.extend({
  kind: z.enum(['issue', 'pr']),
  title: z.string().trim().min(5, 'Titre requis').max(250),
  body: z.string().trim().min(10, 'Texte requis').max(60_000),
  /** Fichiers modifiés retenus pour la PR. */
  paths: z.array(z.string().max(500)).max(50).default([]),
  /** Jeton utilisé pour cette seule demande (jamais conservé). */
  token: z.string().trim().min(10).max(500).nullable().optional(),
})
export type RemediationCreateInput = z.infer<typeof remediationCreateInput>

export const remediationTrackInput = z.object({ subject: remediationSubject, url: z.string().trim().url().max(500) })

export interface RemediationRequestDto {
  id: string
  kind: 'issue' | 'pr'
  subjectKey: string
  label: string
  repository: string
  number: number
  url: string
  title: string
  state: 'open' | 'closed' | 'merged' | 'resolved'
  vulnCount: number
  createdAt: string
  createdBy: string | null
  lastSyncAt: string | null
  resolvedAt: string | null
}

export interface RemediationDraft {
  subjectKey: string
  subjectLabel: string
  repository: string | null
  /** Origine du dépôt : source GitHub du projet, label OCI de l'image, package d'un connecteur, saisie. */
  repositoryOrigin: 'project' | 'label' | 'package' | 'manual' | null
  apiUrl: string
  /** Interface web de GitHub (lien « nouvelle issue »). */
  webUrl: string
  repositoryUrl: string | null
  visibility: 'public' | 'private' | 'internal' | null
  repositoryError: string | null
  kind: 'issue' | 'pr'
  title: string
  body: string
  packages: number
  vulnerabilities: number
  pr: { available: boolean, reason: string | null, base: string | null, changes: { path: string, summary: string }[] }
  /** Jeton disponible pour créer la demande (son origine, jamais sa valeur). */
  token: string | null
  newIssueUrl: string | null
  requests: RemediationRequestDto[]
}

export const REMEDIATION_STATE_LABEL: Record<RemediationRequestDto['state'], string> = { open: 'ouverte', closed: 'fermée', merged: 'fusionnée', resolved: 'résolue' }

/** Clé d'un sujet : image d'un endpoint (sans le tag de release d'une image construite) ou code source d'une cible. */
export const imageRefKey = (image: string) => (image.startsWith('platform/') ? image.replace(/:[^/:@]+$/, '') : image)
export const imageSubjectKey = (endpointId: string, image: string) => `image:${endpointId}:${imageRefKey(image)}`
export const sourceSubjectKey = (targetId: string) => `source:${targetId}`
