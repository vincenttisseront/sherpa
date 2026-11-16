/**
 * Connecteurs GitHub : packages publiés (GitHub Packages) et artefacts des workflows Actions
 * d'un compte, avec alertes (version déployée disparue, artefact expiré ou bientôt expiré).
 */
import { z } from 'zod'

export const githubConnectorInput = z.object({
  name: z.string().trim().min(1, 'Nom requis').max(100),
  apiUrl: z.string().trim().url().max(300).default('https://api.github.com'),
  owner: z.string().trim().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, 'Organisation ou utilisateur GitHub'),
  /** Jeton : read:packages, et actions:read (ou repo) pour les artefacts. undefined : inchangé. */
  token: z.string().trim().min(10, 'Jeton requis').max(500).optional(),
  /** Dépôts dont les artefacts sont suivis ; vide : dépôts liés aux packages et sources des projets. */
  repositories: z.array(z.string().trim().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'org/dépôt')).max(100).default([]),
  /** Registre des images de conteneur du compte. */
  registryHost: z.string().trim().regex(/^[a-z0-9.-]+(?::\d+)?$/i, 'Hôte du registre').default('ghcr.io'),
  expiringDays: z.number().int().min(1).max(90).default(7),
  enabled: z.boolean().default(true),
})
export type GithubConnectorInput = z.infer<typeof githubConnectorInput>

export interface GithubAlert {
  key: string
  level: 'error' | 'warning'
  kind: 'package.missing' | 'package.version-missing' | 'artifact.expired' | 'artifact.expiring'
  subject: string
  message: string
  url: string | null
  /** Cibles concernées (version déployée). */
  targets: { targetId: string, projectId: string, label: string }[]
}

export interface PackageUsage { targetId: string, projectId: string, label: string, service: string, image: string, present: boolean }

export interface PackageView {
  name: string
  type: string
  repository: string | null
  visibility: string | null
  url: string
  versions: number
  latest: { name: string, tags: string[], createdAt: string } | null
  usedBy: PackageUsage[]
}

export interface ArtifactView {
  repository: string
  name: string
  sizeBytes: number
  createdAt: string | null
  expiresAt: string | null
  expired: boolean
  branch: string | null
  /** Artefacts de ce nom conservés (expirés compris). */
  count: number
}

export interface GithubScanSnapshot {
  scannedAt: string
  packages: PackageView[]
  artifacts: ArtifactView[]
  alerts: GithubAlert[]
  errors: string[]
}

export interface GithubConnectorDto {
  id: string
  name: string
  apiUrl: string
  owner: string
  ownerType: 'org' | 'user'
  repositories: string[]
  registryHost: string
  expiringDays: number
  enabled: boolean
  lastScanAt: string | null
  lastError: string | null
  counts: { packages: number, artifacts: number, errors: number, warnings: number }
}
