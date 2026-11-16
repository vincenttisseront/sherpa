/**
 * Analyse de logs par Ollama : lecture des lignes (journal de déploiement, logs de conteneur) puis
 * rapport par le socle commun (`ai-task.ts` : masquage, bornage, appel, lecture de la réponse).
 * Le contenu des logs n'est jamais conservé ni écrit dans l'audit.
 */
import { eq } from 'drizzle-orm'
import type { AiReportDto } from '../../shared/schemas/ollama'
import { db, schema } from '../db/client'
import type { Redactor } from '../utils/redact'
import { runAiReport } from './ai-task'
import { type LogLevel, type LogLine, type LogPhase, queryLogs } from './logs'

/** Ligne de déploiement au même format que l'export texte des logs. */
export const formatDeploymentLine = (l: LogLine): string =>
  `${l.ts} ${l.level.toUpperCase().padEnd(5)} [${l.phase}${l.service ? `/${l.service}` : ''}] ${l.message}`

export interface DeploymentLogFilter {
  levels?: LogLevel[]
  phases?: LogPhase[]
  service?: string
  /** Nombre de lignes les plus récentes lues (filtres appliqués). */
  limit: number
}

/** Dernières lignes du journal d'un déploiement (déjà masquées à l'écriture), au format de l'export texte. */
export async function deploymentLogLines(deploymentId: string, filter: DeploymentLogFilter): Promise<string[]> {
  return (await queryLogs(deploymentId, filter)).lines.map(formatDeploymentLine)
}

/** « Déploiement du projet X, environnement Y » : contexte d'une ligne pour le modèle. */
export async function deploymentSource(scope: { projectId: string, environmentId: string }): Promise<string> {
  const [project] = await db().select({ name: schema.projects.name }).from(schema.projects).where(eq(schema.projects.id, scope.projectId))
  const [environment] = await db().select({ name: schema.environments.name }).from(schema.environments).where(eq(schema.environments.id, scope.environmentId))
  return `Déploiement du projet ${project?.name ?? '?'}, environnement ${environment?.name ?? '?'}`
}

export interface LogAnalysisRequest {
  lines: readonly string[]
  /** Origine de l'extrait, en une ligne (ex. « Conteneur web (hôte prod-1) »). */
  source: string
  /** Question de l'utilisateur (facultative). */
  focus?: string
  /** Valeurs secrètes connues du job, en plus des motifs génériques. */
  redactor?: Redactor
}

export function analyzeLogsWithOllama(req: LogAnalysisRequest): Promise<AiReportDto> {
  return runAiReport({
    feature: 'logs',
    header: [`Source : ${req.source}`],
    parts: [{ title: 'Logs', lines: req.lines }],
    focus: req.focus,
    redactor: req.redactor,
  })
}
