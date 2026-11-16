/**
 * Analyse de logs par Ollama : les lignes sont masquées (secrets), regroupées et bornées avant
 * envoi ; la réponse du modèle est lue de façon tolérante, masquée à nouveau et seulement affichée
 * (le modèle n'a accès à aucun outil et ne déclenche aucune action). Le contenu des logs n'est
 * jamais conservé ni écrit dans l'audit : seuls le nombre de lignes et la durée le sont.
 */
import { eq } from 'drizzle-orm'
import { createError } from 'h3'
import type { LogAnalysisDto } from '../../shared/schemas/ollama'
import { OllamaError, ollama } from '../adapters/ollama'
import { db, schema } from '../db/client'
import { buildMessages, maxExcerptChars, parseModelOutput, RESULT_FORMAT } from '../lib/ollama/prompt'
import { prepareExcerpt } from '../lib/ollama/excerpt'
import { env } from '../utils/env'
import { type Redactor, redactPatterns } from '../utils/redact'
import { ollamaConnection } from './ollama'
import { type LogLevel, type LogLine, type LogPhase, queryLogs } from './logs'

/** Longueur maximale de la réponse du modèle (tokens). */
const NUM_PREDICT = 1024

let running = 0

/** Une analyse mobilise le modèle plusieurs secondes : au-delà du plafond, on refuse plutôt que d'empiler. */
async function withSlot<T>(task: () => Promise<T>): Promise<T> {
  if (running >= env().OLLAMA_MAX_CONCURRENT) {
    throw createError({ statusCode: 429, statusMessage: 'Le modèle est déjà occupé par d\'autres analyses : réessayer dans un instant' })
  }
  running++
  try {
    return await task()
  }
  finally {
    running--
  }
}

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

function toHttpError(err: unknown): never {
  if (!(err instanceof OllamaError)) throw err
  const status = err.code === 'timeout' ? 504 : err.code === 'model-missing' || err.code === 'invalid-url' ? 422 : 502
  throw createError({ statusCode: status, statusMessage: `Ollama : ${err.message}` })
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

export async function analyzeLogsWithOllama(req: LogAnalysisRequest): Promise<LogAnalysisDto> {
  const { conn, settings } = await ollamaConnection()
  if (!settings.enabled) throw createError({ statusCode: 409, statusMessage: 'L\'analyse par Ollama n\'est pas activée (Administration → Ollama)' })

  // Masquage AVANT tout le reste : rien de ce qui part vers le modèle n'a échappé au Redactor.
  const clean = (s: string) => (req.redactor ? req.redactor.redact(s) : redactPatterns(s))
  const lines = req.lines.map(clean)
  if (!lines.some(l => l.trim())) throw createError({ statusCode: 422, statusMessage: 'Aucune ligne de log à analyser' })

  const excerpt = prepareExcerpt(lines, maxExcerptChars(settings.contextTokens))
  const messages = buildMessages({ source: clean(req.source), excerpt, focus: req.focus ? clean(req.focus) : undefined })

  const started = Date.now()
  const res = await withSlot(() => ollama().chat(conn, {
    model: settings.model,
    messages,
    format: RESULT_FORMAT,
    numCtx: settings.contextTokens,
    numPredict: NUM_PREDICT,
    temperature: 0.1,
  })).catch(toHttpError)

  const parsed = parseModelOutput(res.content)
  const meta: LogAnalysisDto['meta'] = {
    model: res.model,
    at: new Date().toISOString(),
    durationMs: Date.now() - started,
    totalLines: excerpt.totalLines,
    sentLines: excerpt.sentLines,
    truncated: excerpt.truncated,
  }
  if (!parsed) {
    // Format non respecté (petit modèle) : on affiche le texte tel quel plutôt que de perdre l'analyse.
    return { severity: 'warning', summary: clean(res.content).trim().slice(0, 1500) || 'Réponse vide du modèle.', causes: [], actions: [], structured: false, meta }
  }
  return {
    severity: parsed.severity,
    summary: clean(parsed.summary),
    causes: parsed.causes.map(c => ({ title: clean(c.title), evidence: clean(c.evidence) })),
    actions: parsed.actions.map(clean),
    structured: true,
    meta,
  }
}
