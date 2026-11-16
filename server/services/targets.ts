/**
 * Création d'une cible (projet × endpoint × environnement) : contrôles communs
 * à l'ajout d'une cible et à la création d'un projet avec sa première cible.
 */
import { and, eq } from 'drizzle-orm'
import type { z } from 'zod'
import type { targetCreateInput } from '../../shared/schemas/projects'
import { db, schema } from '../db/client'
import { stackNameFor } from '../lib/compose/analyze'
import { validationError } from '../utils/validation'
import { validatePlacement } from './placement'
import { environmentMaps, getEndpointOr404 } from './servers'

export type TargetInput = z.infer<typeof targetCreateInput>
type Tx = Parameters<Parameters<ReturnType<typeof db>['transaction']>[0]>[0]

/** Endpoint et environnement de la cible ; refuse ce qui ne peut pas être déployé. */
export async function resolveTarget(input: TargetInput) {
  const ep = await getEndpointOr404(input.endpointId)
  const { idByKey } = await environmentMaps()
  const environmentId = idByKey.get(input.environmentKey)
  if (!environmentId) throw validationError({ environmentKey: 'Environnement inconnu' })
  return { ep, environmentId }
}

/** Contrôles de déployabilité et de placement (projectId absent : projet en cours de création). */
export async function checkTarget(input: TargetInput, ctx: { ep: Awaited<ReturnType<typeof getEndpointOr404>>, environmentId: string, projectSlug: string, projectId?: string }) {
  const { ep, environmentId } = ctx
  if (!ep.enabled || ep.missing) throw validationError({ endpointId: 'Endpoint désactivé ou absent' })
  const linked = await db().$count(schema.endpointEnvironments, and(eq(schema.endpointEnvironments.endpointId, ep.id), eq(schema.endpointEnvironments.environmentId, environmentId)))
  if (!linked) throw validationError({ environmentKey: `L'endpoint ${ep.name} n'accepte pas l'environnement ${input.environmentKey}` })
  const paths = await db().$count(schema.pathConfigs, and(eq(schema.pathConfigs.endpointId, ep.id), eq(schema.pathConfigs.environmentId, environmentId)))
  if (!paths) throw validationError({ environmentKey: `Chemins de travail non configurés pour ${ep.name} / ${input.environmentKey}` })
  const placement = await validatePlacement({ endpointId: ep.id, environmentId, projectSlug: ctx.projectSlug, projectPath: input.projectPath, proxyNetwork: input.proxyNetwork })
  if (Object.keys(placement).length) throw validationError(placement)
  if (ctx.projectId) {
    // Un projet n'a qu'une cible par environnement (stack nommée <projet>-<environnement>).
    const sameEnv = await db().$count(schema.projectTargets, and(eq(schema.projectTargets.projectId, ctx.projectId), eq(schema.projectTargets.environmentId, environmentId)))
    if (sameEnv) throw validationError({ environmentKey: 'Le projet a déjà une cible pour cet environnement' })
  }
}

export async function insertTarget(tx: Tx, projectId: string, projectSlug: string, input: TargetInput, environmentId: string, userId: string | null): Promise<string> {
  const [t] = await tx.insert(schema.projectTargets).values({
    projectId,
    endpointId: input.endpointId,
    environmentId,
    stackName: stackNameFor(projectSlug, input.environmentKey),
    projectPath: input.projectPath,
    volumesAsFolders: input.projectPath ? input.volumesAsFolders : false,
    proxyNetwork: input.proxyNetwork,
    createdBy: userId,
  }).returning({ id: schema.projectTargets.id })
  return t!.id
}
