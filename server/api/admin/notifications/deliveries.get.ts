import { z } from 'zod'
import { tableQuery } from '../../../../shared/schemas/common'
import type { DeliveryDto } from '../../../../shared/schemas/notifications'
import { requirePermission } from '../../../utils/auth'
import { type CsvColumn, tableResponse } from '../../../utils/table'
import { listDeliveries } from '../../../services/notifications'

defineRouteMeta({ openAPI: { tags: ['notifications'], summary: 'Historique des envois de notifications, export CSV' } })

const query = tableQuery.extend({ status: z.enum(['pending', 'sent', 'failed']).optional(), event: z.string().max(60).optional(), channelId: z.uuid().optional() })
const CSV: CsvColumn<DeliveryDto>[] = [
  { key: 'createdAt', label: 'Date', value: r => r.createdAt },
  { key: 'event', label: 'Évènement', value: r => r.event },
  { key: 'title', label: 'Titre', value: r => r.title },
  { key: 'channelName', label: 'Canal', value: r => r.channelName },
  { key: 'kind', label: 'Type', value: r => r.kind },
  { key: 'status', label: 'Statut', value: r => r.status },
  { key: 'attempts', label: 'Tentatives', value: r => r.attempts },
  { key: 'sentAt', label: 'Envoyé le', value: r => r.sentAt },
  { key: 'error', label: 'Erreur', value: r => r.error },
]

export default defineEventHandler(async (event) => {
  const user = await requirePermission(event, 'notification:manage')
  const q = await getValidatedQuery(event, query.parse)
  return tableResponse(event, q, listDeliveries, { name: 'notifications', columns: CSV, user })
})
