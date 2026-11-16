/** Explorateur des fichiers d'un service (montages, dossiers, fichiers texte). */
import { z } from 'zod'

export interface ServiceMountDto {
  /** Chemin dans le conteneur (ex. /config) : identifie le montage (l'ordre renvoyé par Docker varie d'un démarrage à l'autre). */
  destination: string
  source: string
  type: 'volume' | 'bind'
  writable: boolean
}

export interface FileEntryDto { name: string, kind: 'dir' | 'file' | 'link' | 'other', size: number, mtime: string, mode: string, uid: number, gid: number }

export interface ServiceFilesDto {
  service: string
  container: string
  running: boolean
  mounts: ServiceMountDto[]
  mount: string | null
  path: string
  /** Le montage est un fichier isolé (pas un dossier). */
  isFile: boolean
  entries: FileEntryDto[]
  truncated: boolean
}

export interface ServiceFileDto {
  path: string
  size: number
  mtime: string
  mode: string
  uid: number
  gid: number
  /** null : fichier binaire ou trop volumineux (raison dans `reason`). */
  content: string | null
  sha256: string | null
  reason: string | null
  writable: boolean
}

export const serviceFileWrite = z.object({
  /** Chemin du montage dans le conteneur (ex. /config). */
  mount: z.string().regex(/^\/[^\0\n]{0,1023}$/),
  path: z.string().max(1024),
  content: z.string().max(1024 * 1024),
  /** Empreinte du contenu lu (null : création d'un nouveau fichier). */
  sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  /** Arrêter le service pendant l'écriture puis le relancer (services qui réécrivent leur configuration à l'arrêt). */
  stopService: z.boolean().default(false),
})
export type ServiceFileWrite = z.infer<typeof serviceFileWrite>

export interface ServiceFileSearchDto {
  mount: string
  path: string
  q: string
  content: boolean
  truncated: boolean
  /** Chemin relatif au montage de chaque résultat. */
  results: (FileEntryDto & { path: string })[]
}
