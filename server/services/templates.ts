/** Modèles de Compose : ceux fournis avec la plateforme et ceux enregistrés par les utilisateurs. */
import { asc, eq } from 'drizzle-orm'
import YAML from 'yaml'
import { BUILTIN_TEMPLATES } from '../../shared/data/compose-templates'
import type { TemplateDto, TemplateVariable } from '../../shared/schemas/templates'
import { db, schema } from '../db/client'
import { findVariables } from '../lib/compose/interpolate'

const SECRET_NAME = /PASS(WORD)?|SECRET|TOKEN|KEY|CREDENTIAL/i

/** Variables d'un Compose : une par référence `${NOM}` ; secrète (et générée) si le nom le suggère. */
export function deriveVariables(compose: string): TemplateVariable[] {
  return findVariables(compose).map((u) => {
    const secret = SECRET_NAME.test(u.name)
    return { name: u.name, label: u.name, ...(secret ? { secret: true, generate: 'password' as const } : {}) }
  })
}

/** Compose acceptable comme modèle : YAML valide avec au moins un service ; messages lisibles sinon. */
export function validateTemplateCompose(compose: string): string | null {
  let doc: unknown
  try {
    doc = YAML.parse(compose)
  }
  catch (err) {
    return `YAML invalide : ${(err as Error).message.split('\n')[0]}`
  }
  const services = (doc as { services?: Record<string, unknown> } | null)?.services
  if (!services || typeof services !== 'object' || !Object.keys(services).length) return 'Aucun service dans ce Compose'
  return null
}

const builtin = (): TemplateDto[] => BUILTIN_TEMPLATES.map(t => ({
  id: `builtin:${t.key}`, name: t.name, description: t.description, category: t.category, builtin: true,
  compose: t.compose, variables: t.variables, notes: t.notes ?? null, createdBy: null, createdAt: null,
}))

export async function listTemplates(): Promise<TemplateDto[]> {
  const rows = await db().select({ t: schema.composeTemplates, by: schema.users.email }).from(schema.composeTemplates)
    .leftJoin(schema.users, eq(schema.users.id, schema.composeTemplates.createdBy)).orderBy(asc(schema.composeTemplates.name))
  const custom: TemplateDto[] = rows.map(r => ({
    id: r.t.id, name: r.t.name, description: r.t.description, category: 'Personnalisé', builtin: false,
    compose: r.t.compose, variables: r.t.variables, notes: null, createdBy: r.by, createdAt: r.t.createdAt.toISOString(),
  }))
  return [...builtin(), ...custom]
}
