import { AGENT_IMAGE, DEFAULT_RUNNER_IMAGE } from '../../../shared/utils/host-install'
import { requireAnyPermission } from '../../utils/auth'

defineRouteMeta({ openAPI: { tags: ['servers'], summary: 'Images proposées pour installer un hôte : agent Portainer et Target Runner (RUNNER_IMAGE)' } })

export default defineEventHandler(async (event) => {
  await requireAnyPermission(event, 'server:manage')
  // Image du Runner publiée sur un registre joignable des hôtes (sinon l'image construite localement par le rôle Ansible).
  const runnerImage = process.env.RUNNER_IMAGE?.trim() || DEFAULT_RUNNER_IMAGE
  return { agentImage: AGENT_IMAGE, runnerImage, runnerImageConfigured: !!process.env.RUNNER_IMAGE?.trim() }
})
