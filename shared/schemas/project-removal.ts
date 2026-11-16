/** Fin de vie d'un projet : suppression définitive ou détachement. */
import { z } from 'zod'

export interface ProjectRemovalPlan {
  projectId: string
  slug: string
  targets: {
    targetId: string
    environment: string
    server: string
    /** Stack déployée (null : rien sur l'hôte). */
    stack: string | null
    /** Compose en service sur l'hôte (à réutiliser après un détachement). */
    composeFile: string | null
    dataDir: string | null
    watchtower: boolean
    secretVariables: boolean
  }[]
}

export const projectRemovalInput = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('delete'), confirm: z.string() }),
  z.object({ mode: z.literal('detach'), confirm: z.string(), stopWatchtower: z.boolean().default(false) }),
])
export type ProjectRemovalInput = z.infer<typeof projectRemovalInput>
