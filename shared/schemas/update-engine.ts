/**
 * Moteur de mise à jour des images (sidecar platform-watchtower) : image choisie
 * parmi des dépôts vérifiés, figée par empreinte. Le projet containrrr/watchtower
 * est archivé (17/12/2025) : refusé ; le fork maintenu le remplace sans perte.
 */
import { z } from 'zod'

export interface UpdateEngineCatalogEntry {
  /** Dépôt tel qu'écrit dans le Compose. */
  repository: string
  maintainer: string
  source: string
  status: 'maintained' | 'archived'
  note: string
}

export const UPDATE_ENGINE_CATALOG: UpdateEngineCatalogEntry[] = [
  { repository: 'nickfedor/watchtower', maintainer: 'Nicholas Fedor (fork de Watchtower)', source: 'https://github.com/nicholas-fedor/watchtower', status: 'maintained', note: 'Fork actif, remplaçant direct, compatible Docker 29 (négociation de l\'API).' },
  { repository: 'ghcr.io/nicholas-fedor/watchtower', maintainer: 'Nicholas Fedor (fork de Watchtower)', source: 'https://github.com/nicholas-fedor/watchtower', status: 'maintained', note: 'Même image, publiée sur GitHub Container Registry.' },
  { repository: 'containrrr/watchtower', maintainer: 'containrrr', source: 'https://github.com/containrrr/watchtower', status: 'archived', note: 'Projet archivé le 17/12/2025, incompatible avec Docker 29 : refusé.' },
  { repository: 'ghcr.io/containrrr/watchtower', maintainer: 'containrrr', source: 'https://github.com/containrrr/watchtower', status: 'archived', note: 'Projet archivé : refusé.' },
]

/** Dépôts d'images Watchtower reconnus (anciens compris), pour le nettoyage des hôtes. */
export const WATCHTOWER_REPOSITORIES = ['containrrr/watchtower', 'nickfedor/watchtower', 'v2tec/watchtower', 'ghcr.io/containrrr/watchtower', 'ghcr.io/nicholas-fedor/watchtower']

export const updateEngineInput = z.object({
  repository: z.string().refine(r => UPDATE_ENGINE_CATALOG.some(c => c.repository === r && c.status === 'maintained'), 'Dépôt non autorisé (projets maintenus du catalogue uniquement)'),
  tag: z.string().regex(/^v?\d+\.\d+\.\d+$/, 'Version stable attendue (x.y.z)'),
})
export type UpdateEngineInput = z.infer<typeof updateEngineInput>

export interface UpdateEngineDto {
  /** Image effective injectée dans les stacks (dépôt:tag@empreinte). */
  image: string
  repository: string
  tag: string
  digest: string | null
  /** Origine : réglage de l'administration, ou variable WATCHTOWER_IMAGE (non figée). */
  source: 'setting' | 'env'
  catalog: UpdateEngineCatalogEntry
  pinnedAt: string | null
  pinnedBy: string | null
  /** Dernière version stable publiée, si le registre a répondu. */
  latest: string | null
  latestError: string | null
  /** Cibles avec Watchtower déployé sur une autre image (à redéployer). */
  outdated: { targetId: string, projectId: string, project: string, environment: string, appliedImage: string | null }[]
  /** Profils Watchtower des serveurs dont le conteneur utilise une autre image. */
  outdatedProfiles: { profileId: string, name: string, server: string, endpoint: string, appliedImage: string | null }[]
  /** WATCHTOWER_IMAGE pointe vers une image archivée (ignorée). */
  envRetired: string | null
}

export interface LegacyWatchtowerItem {
  endpointId: string
  endpoint: string
  server: string
  kind: 'container' | 'image'
  id: string
  name: string
  image: string
  /** Conteneur d'une stack de la plateforme : remplacé au redéploiement de sa cible. */
  platformStack: string | null
  removable: boolean
  reason: string
}
