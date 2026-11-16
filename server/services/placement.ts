/**
 * Placement d'une cible sur son hôte : chemin racine du projet (releases et
 * données) et réseau du reverse proxy. Contrôles : chemin sous une racine de
 * l'environnement, jamais en recouvrement d'un autre projet de l'endpoint,
 * réseau autorisé sur l'endpoint.
 */
import { and, eq, ne } from 'drizzle-orm'
import type { FieldErrors } from '../../shared/schemas/infra'
import { db, schema } from '../db/client'
import { PathViolation, isWithin, projectLayout } from '../utils/path-guard'

export interface PlacementInput {
  endpointId: string
  environmentId: string
  projectSlug: string
  projectPath: string | null
  proxyNetwork: string | null
  /** Cible modifiée (exclue du contrôle de recouvrement). */
  targetId?: string
}

export async function validatePlacement(i: PlacementInput): Promise<FieldErrors> {
  const errors: FieldErrors = {}
  const [paths] = await db().select().from(schema.pathConfigs).where(and(eq(schema.pathConfigs.endpointId, i.endpointId), eq(schema.pathConfigs.environmentId, i.environmentId)))
  if (!paths) {
    errors.environmentKey = 'Chemins de travail non configurés pour cet environnement'
    return errors
  }
  let layout: ReturnType<typeof projectLayout> | null = null
  try {
    layout = projectLayout(paths, i.projectSlug, i.projectPath)
  }
  catch (err) {
    errors.projectPath = err instanceof PathViolation ? `${err.path} : ${err.reason}` : 'Chemin invalide'
  }

  if (layout && i.projectPath) {
    const others = await db().select({ t: schema.projectTargets, slug: schema.projects.slug })
      .from(schema.projectTargets)
      .innerJoin(schema.projects, eq(schema.projects.id, schema.projectTargets.projectId))
      .where(and(eq(schema.projectTargets.endpointId, i.endpointId), i.targetId ? ne(schema.projectTargets.id, i.targetId) : undefined))
    for (const o of others) {
      const [op] = await db().select().from(schema.pathConfigs).where(and(eq(schema.pathConfigs.endpointId, i.endpointId), eq(schema.pathConfigs.environmentId, o.t.environmentId)))
      if (!op) continue
      let ol: ReturnType<typeof projectLayout>
      try {
        ol = projectLayout(op, o.slug, o.t.projectPath)
      }
      catch {
        continue
      }
      const theirs = [ol.projectDir, ol.runtimeDir]
      const clash = theirs.find(d => isWithin(layout!.projectDir, d) || isWithin(d, layout!.projectDir))
      if (clash) {
        errors.projectPath = `Recouvre les dossiers du projet ${o.slug} (${clash})`
        break
      }
    }
  }

  if (i.proxyNetwork) {
    const [n] = await db().select().from(schema.networks).where(and(eq(schema.networks.endpointId, i.endpointId), eq(schema.networks.name, i.proxyNetwork)))
    if (!n || n.missing) errors.proxyNetwork = `Réseau ${i.proxyNetwork} absent de l'endpoint`
    else if (n.policy !== 'allowed') errors.proxyNetwork = `Réseau ${i.proxyNetwork} non autorisé (Réseaux et volumes)`
  }
  return errors
}
