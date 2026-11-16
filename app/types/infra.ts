import type { NetworkDecision } from '#shared/schemas/infra'

export interface NetworkRow extends NetworkDecision {
  name: string
  driver: string | null
  scope: string | null
  internal: boolean
  missing?: boolean
}

export interface StoredUpload {
  id: string
  originalName: string
  sizeBytes: number
  sha256: string
  report: {
    files: number
    totalBytes: number
    composeFiles: string[]
    dockerfiles: string[]
    rootFolder: string | null
    /** Chemins des fichiers de l'archive. */
    entries?: string[]
    /** Archive reçue en tar.gz ou tar, convertie en ZIP à la réception. */
    source?: { format: 'tar.gz' | 'tar', sizeBytes: number, sha256: string }
  }
  /** Archive importée depuis une release GitHub. */
  release?: { repository: string, tag: string, archive: string, htmlUrl: string }
}
