import type { UpdateEngineDto } from '../../../shared/schemas/update-engine'
import { requireAnyPermission } from '../../utils/auth'
import { getUpdateEngine } from '../../services/update-engine'

defineRouteMeta({ openAPI: { tags: ['watchtower'], summary: 'Moteur de mise à jour des images : image effective, dernière version publiée, cibles à basculer' } })

export default defineEventHandler(async (event): Promise<UpdateEngineDto> => {
  await requireAnyPermission(event, 'deployment:read')
  return getUpdateEngine()
})
