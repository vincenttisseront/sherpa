import { z } from 'zod'
import { schema } from '../../../db/client'
import { deploymentScope } from '../../../services/deployments'
import { requirePermission } from '../../../utils/auth'
import { idParam } from '../../../utils/validation'
import { queryLogs } from '../../../services/logs'

defineRouteMeta({ openAPI: { tags: ['deployments'], summary: 'Logs d\'un déploiement : pagination par curseur, filtres niveau/phase/service/texte/période' } })

const MAX_EXPORT_LINES = 200_000

const csv = <T extends string>(values: readonly [T, ...T[]]) => z.string().optional().transform(v => (v ? v.split(',') : undefined)).pipe(z.array(z.enum(values)).optional())

const query = z.object({
  afterId: z.string().regex(/^\d+$/).optional(),
  beforeId: z.string().regex(/^\d+$/).optional(),
  limit: z.coerce.number().int().min(1).max(2000).default(500),
  levels: csv(schema.logLevel.enumValues),
  phases: csv(schema.logPhase.enumValues),
  service: z.string().max(200).optional(),
  q: z.string().trim().max(200).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  format: z.enum(['json', 'text']).default('json'),
})

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, idParam.parse)
  await requirePermission(event, 'logs:read', await deploymentScope(id))
  const q = await getValidatedQuery(event, query.parse)
  if (q.format === 'text') {
    // Téléchargement : tout le journal filtré (par lots, dans l'ordre), pas seulement la fin.
    const out: string[] = []
    let afterId = q.afterId ?? '0'
    for (;;) {
      const page = await queryLogs(id, { ...q, afterId, beforeId: undefined, limit: 2000 })
      for (const l of page.lines) out.push(`${l.ts} ${l.level.toUpperCase().padEnd(5)} [${l.phase}${l.service ? `/${l.service}` : ''}] ${l.message}`)
      if (!page.hasMore || !page.lines.length || out.length >= MAX_EXPORT_LINES) break
      afterId = page.lines.at(-1)!.id
    }
    setHeader(event, 'content-type', 'text/plain; charset=utf-8')
    setHeader(event, 'content-disposition', `attachment; filename="deploiement-${id}.log"`)
    return `${out.join('\n')}\n`
  }
  return queryLogs(id, q)
})
