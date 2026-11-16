/** Routes du Traefik géré vers des conteneurs non déployés par la plateforme. */
import { z } from 'zod'

export const proxyRouteInput = z.object({
  containerId: z.string().regex(/^[a-f0-9]{12,64}$/),
  host: z.string().trim().toLowerCase().min(3).max(253),
  pathPrefix: z.string().trim().max(200).nullable().optional(),
  port: z.number().int().min(1).max(65_535),
  https: z.boolean().default(true),
})
export type ProxyRouteInput = z.infer<typeof proxyRouteInput>

export const proxyRoutesCreate = z.object({ routes: z.array(proxyRouteInput).min(1).max(20) })

export interface ProxyRouteDto {
  id: string
  stack: string | null
  service: string | null
  containerName: string
  host: string
  pathPrefix: string | null
  port: number
  https: boolean
  network: string
  /** Conteneur présent sur l'hôte. */
  containerFound: boolean
  /** Rattaché au réseau du proxy. */
  attached: boolean
  /** Route écrite dans la configuration en service du Traefik géré. */
  applied: boolean
  /** Ports encore publiés en direct sur l'hôte (à retirer du Compose d'origine). */
  publishedPorts: string[]
}
