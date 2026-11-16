import { projectListQuery } from '../../../shared/schemas/projects'
import { requireAnyPermission } from '../../utils/auth'
import { visibleProjectIds } from '../../services/access'
import { listProjects } from '../../services/project-views'
import { tableResponse } from '../../utils/table'
import type { ProjectListItem } from '../../../shared/schemas/projects'
import type { CsvColumn } from '../../utils/table'

const CSV: CsvColumn<ProjectListItem>[] = [
  { key: 'name', label: 'Projet', value: r => r.name },
  { key: 'slug', label: 'Identifiant', value: r => r.slug },
  { key: 'targetCount', label: 'Cibles', value: r => r.targetCount },
  { key: 'lastStatus', label: 'Dernier statut', value: r => r.lastStatus },
  { key: 'lastDeployedAt', label: 'Dernière opération', value: r => r.lastDeployedAt },
  { key: 'createdAt', label: 'Créé le', value: r => r.createdAt },
]

defineRouteMeta({ openAPI: { tags: ['projects'], summary: 'Liste paginée des projets' } })

export default defineEventHandler(async (event) => {
  const user = await requireAnyPermission(event, 'project:read')
  const visible = await visibleProjectIds(user, 'project:read')
  const q = await getValidatedQuery(event, projectListQuery.parse)
  return tableResponse(event, q, x => listProjects(x, visible), { name: 'projets', columns: CSV, user })
})
