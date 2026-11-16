/**
 * Trace d'une demande d'assistance par Ollama (`ollama.analyze`) : fonction, source, modèle, nombre
 * de lignes, durée et issue. Jamais le contenu envoyé ni la réponse du modèle.
 */
import type { H3Event } from 'h3'
import type { AiReportDto, OllamaFeature } from '../../shared/schemas/ollama'
import { audit } from './audit'
import { type AuthUser, clientIp } from './auth'

export interface AssistAudit {
  feature: OllamaFeature
  targetType: string
  targetId: string
  serverId?: string | null
  environmentId?: string | null
  projectId?: string | null
  withQuestion?: boolean
}

export async function auditedAssist<T extends AiReportDto>(event: H3Event, user: AuthUser, info: AssistAudit, run: () => Promise<T>): Promise<T> {
  const base = {
    actorUserId: user.id,
    actorLabel: user.email,
    action: 'ollama.analyze',
    targetType: info.targetType,
    targetId: info.targetId,
    serverId: info.serverId ?? null,
    environmentId: info.environmentId ?? null,
    projectId: info.projectId ?? null,
    ip: clientIp(event),
  }
  try {
    const report = await run()
    await audit({ ...base, outcome: 'success', details: { feature: info.feature, model: report.meta.model, totalLines: report.meta.totalLines, sentLines: report.meta.sentLines, durationMs: report.meta.durationMs, withQuestion: !!info.withQuestion } })
    return report
  }
  catch (err) {
    await audit({ ...base, outcome: 'failure', details: { feature: info.feature, error: (err as { statusMessage?: string }).statusMessage ?? 'Erreur', withQuestion: !!info.withQuestion } })
    throw err
  }
}
