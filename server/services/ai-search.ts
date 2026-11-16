/**
 * Recherche en langage naturel d'un tableau (audit, déploiements) : le modèle ne reçoit que la
 * phrase de l'utilisateur (masquée) et la liste des filtres ; sa réponse est relue champ par champ
 * (`parseSearch`), les noms sont résolus parmi les projets, environnements et serveurs que
 * l'utilisateur voit, et le résultat est revalidé par le schéma de la requête du tableau. Jamais de
 * requête construite par le modèle.
 */
import { createError } from 'h3'
import { auditListQuery, deploymentListQuery } from '../../shared/schemas/lists'
import { PERIOD_LABEL, type Period } from '../../shared/schemas/common'
import type { NlSearchDto, SearchTable } from '../../shared/schemas/ollama'
import { db, schema } from '../db/client'
import { type NameRow, parseSearch, resolveName, SEARCH_FIELDS, SEARCH_PERMISSION, searchFormat, searchMessages } from '../lib/ollama/nl-search'
import type { AuthUser } from '../utils/auth'
import { noProgress, type Progress } from '../utils/progress'
import { visibleProjectIds, visibleServerIds } from './access'
import { callModel, cleaner, requireFeature } from './ai-task'

/** Paramètres de chaque tableau que la recherche remplace (les absents sont effacés). */
const QUERY_KEYS: Record<SearchTable, string[]> = {
  audit: ['period', 'outcome', 'action', 'actor', 'q', 'projectId', 'environmentId', 'serverId'],
  deployments: ['period', 'status', 'action', 'q', 'projectId', 'environmentId', 'serverId', 'buildFailed', 'unacknowledged'],
}
/** Champ du modèle → paramètre du tableau, pour les noms résolus en identifiants. */
const NAME_PARAM = { project: 'projectId', environment: 'environmentId', server: 'serverId' } as const

async function visibleNames(user: AuthUser, kind: keyof typeof NAME_PARAM, table: SearchTable): Promise<NameRow[]> {
  const permission = SEARCH_PERMISSION[table]
  if (kind === 'environment') {
    return (await db().select({ id: schema.environments.id, name: schema.environments.name, key: schema.environments.key }).from(schema.environments)).map(e => ({ id: e.id, names: [e.name, e.key] }))
  }
  if (kind === 'project') {
    const ids = await visibleProjectIds(user, permission)
    const rows = await db().select({ id: schema.projects.id, name: schema.projects.name, slug: schema.projects.slug }).from(schema.projects)
    return rows.filter(p => !ids || ids.includes(p.id)).map(p => ({ id: p.id, names: [p.name, p.slug] }))
  }
  const ids = await visibleServerIds(user, 'server:read')
  const rows = await db().select({ id: schema.portainerServers.id, name: schema.portainerServers.name }).from(schema.portainerServers)
  return rows.filter(s => !ids || ids.includes(s.id)).map(s => ({ id: s.id, names: [s.name] }))
}

export async function naturalSearch(user: AuthUser, table: SearchTable, text: string, progress: Progress = noProgress): Promise<NlSearchDto> {
  const ctx = await requireFeature('nl-search')
  await progress.step('Traduction de la demande par le modèle Ollama', 1, 2)
  const answer = await callModel('nl-search', { messages: searchMessages(table, cleaner()(text)), format: searchFormat(table), numPredict: 400 }, ctx)
  const parsed = parseSearch(table, answer.content)
  if (!parsed) throw createError({ statusCode: 422, statusMessage: 'Le modèle n\'a pas produit de filtres exploitables : reformuler la recherche' })

  await progress.step('Contrôle des filtres', 2, 2)
  const ignored = [...parsed.ignored]
  const fields = new Map(SEARCH_FIELDS[table].map(f => [f.key, f]))
  const query: Record<string, string> = {}
  const applied: NlSearchDto['applied'] = []
  const show = (key: string, value: string) => applied.push({ label: fields.get(key)?.label ?? key, value })

  for (const [key, value] of Object.entries(parsed.filters)) {
    if (key in NAME_PARAM) {
      const kind = key as keyof typeof NAME_PARAM
      const r = resolveName(String(value), await visibleNames(user, kind, table))
      if ('id' in r) { query[NAME_PARAM[kind]] = r.id; show(key, String(value)) }
      else ignored.push(`${fields.get(key)!.label} « ${String(value).slice(0, 60)} » : ${r.error === 'ambigu' ? 'plusieurs correspondances, préciser le nom' : 'introuvable parmi ceux que vous voyez'}`)
    }
    else if (Array.isArray(value)) { query[key] = value.join(','); show(key, value.join(', ')) }
    else if (typeof value === 'boolean') { query[key] = 'true'; show(key, 'oui') }
    else { query[key] = value; show(key, key === 'period' ? PERIOD_LABEL[value as Period] : value) }
  }

  // Dernier garde-fou : la requête obtenue doit être acceptée telle quelle par la liste.
  const schemaOf = table === 'audit' ? auditListQuery : deploymentListQuery
  if (!schemaOf.safeParse(query).success) throw createError({ statusCode: 422, statusMessage: 'Les filtres compris ne sont pas valides : reformuler la recherche' })
  // Rien d'applicable : on ne touche pas aux filtres en cours, on explique pourquoi.
  if (!applied.length) throw createError({ statusCode: 422, statusMessage: ignored.length ? `Aucun filtre appliqué — ${ignored.slice(0, 2).join(' ; ')}` : 'Aucun filtre compris : reformuler la recherche (période, résultat, projet, statut…)' })
  return { table, query, filterKeys: QUERY_KEYS[table], applied, ignored, meta: { model: answer.settings.model, durationMs: answer.durationMs } }
}
