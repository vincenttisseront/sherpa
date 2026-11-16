/** Plage d'adresses des réseaux des projets d'un endpoint. */
import { z } from 'zod'

const cidr = z.string().trim().regex(/^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/, 'Notation CIDR attendue (ex. 10.210.0.0/16)')

export const networkPoolInput = z.object({
  /** Plage découpée pour les réseaux des projets (ex. 10.210.0.0/16). */
  base: cidr,
  /** Taille de chaque réseau : /24 (254 adresses) à /29 (6 adresses). */
  prefix: z.number().int().min(16).max(29).default(27),
  /** Plages à ne jamais attribuer (réseaux de l'entreprise, VPN, AWX…). */
  avoid: z.array(cidr).max(50).default([]),
})
export type NetworkPool = z.infer<typeof networkPoolInput>

export interface NetworkAllocationDto {
  project: string
  environment: string
  network: string
  subnet: string
  createdAt: string
}

export interface NetworkPoolDto {
  pool: NetworkPool | null
  /** Réseaux de taille prefix que contient la plage, et combien sont déjà attribués. */
  capacity: number | null
  allocations: NetworkAllocationDto[]
  /** Sous-réseaux déjà utilisés sur l'hôte par d'autres réseaux Docker (évités). */
  hostSubnets: { network: string, subnet: string }[]
}
