/**
 * Socle des fonctions d'assistance par Ollama : réglages et fonction activée, masquage, bornage du
 * contexte, plafond d'appels simultanés, appel du modèle, lecture tolérante et masquage de la
 * réponse. Les fonctions (logs, diagnostic, tri des vulnérabilités…) n'apportent que leurs données
 * et leur consigne. Le modèle n'a accès à aucun outil : sa réponse est seulement affichée, et le
 * contenu envoyé n'est jamais conservé ni écrit dans l'audit.
 */
import { createError } from 'h3'
import type { AiReportDto, OllamaFeature } from '../../shared/schemas/ollama'
import { type OllamaChatResponse, OllamaError, ollama } from '../adapters/ollama'
import { type ContextPart, packContext } from '../lib/ollama/context'
import { buildMessages, maxExcerptChars, parseModelOutput, type PromptMessage, resultFormat } from '../lib/ollama/prompt'
import { taskFor } from '../lib/ollama/tasks'
import { env } from '../utils/env'
import { type Redactor, redactPatterns } from '../utils/redact'
import { type OllamaStoredSettings, ollamaConnection } from './ollama'

/** Longueur maximale de la réponse du modèle (tokens). */
const NUM_PREDICT = 1024

let running = 0

/** Une demande mobilise le modèle plusieurs secondes : au-delà du plafond, on refuse plutôt que d'empiler. */
async function withSlot<T>(task: () => Promise<T>): Promise<T> {
  if (running >= env().OLLAMA_MAX_CONCURRENT) {
    throw createError({ statusCode: 429, statusMessage: 'Le modèle est déjà occupé par d\'autres demandes : réessayer dans un instant' })
  }
  running++
  try {
    return await task()
  }
  finally {
    running--
  }
}

function toHttpError(err: unknown): never {
  if (!(err instanceof OllamaError)) throw err
  const status = err.code === 'timeout' ? 504 : err.code === 'model-missing' || err.code === 'invalid-url' ? 422 : 502
  throw createError({ statusCode: status, statusMessage: `Ollama : ${err.message}` })
}

/** Connexion et réglages si le connecteur et la fonction sont activés, sinon 409. */
export async function requireFeature(feature: OllamaFeature) {
  const r = await ollamaConnection()
  if (!r.settings.enabled) throw createError({ statusCode: 409, statusMessage: 'L\'assistance par Ollama n\'est pas activée (Administration → Ollama)' })
  if (!r.settings.features.includes(feature)) throw createError({ statusCode: 409, statusMessage: 'Cette fonction n\'est pas activée (Administration → Ollama)' })
  return r
}

/** Masque un texte : valeurs secrètes connues du déroulement (si fournies) puis motifs génériques. */
export const cleaner = (redactor?: Redactor) => (s: string): string => (redactor ? redactor.redact(s) : redactPatterns(s))

export interface ModelCall {
  messages: PromptMessage[]
  format: object
  /** Longueur maximale de la réponse (tokens). */
  numPredict?: number
}

export interface ModelAnswer extends OllamaChatResponse {
  durationMs: number
  settings: OllamaStoredSettings
}

/** Appel du modèle sous plafond, erreurs d'Ollama traduites en erreurs HTTP lisibles. */
export async function callModel(feature: OllamaFeature, call: ModelCall, ctx?: Awaited<ReturnType<typeof requireFeature>>): Promise<ModelAnswer> {
  const { conn, settings } = ctx ?? await requireFeature(feature)
  const started = Date.now()
  const res = await withSlot(() => ollama().chat(conn, {
    model: settings.model,
    messages: call.messages,
    format: call.format,
    numCtx: settings.contextTokens,
    numPredict: call.numPredict ?? NUM_PREDICT,
    temperature: 0.1,
  })).catch(toHttpError)
  return { ...res, durationMs: Date.now() - started, settings }
}

export interface AiReportRequest {
  feature: OllamaFeature
  /** Contexte court en tête (origine, période…), une ligne par fait. */
  header: readonly string[]
  parts: readonly ContextPart[]
  /** Question de l'utilisateur (facultative). */
  focus?: string
  /** Valeurs secrètes connues du déroulement, en plus des motifs génériques. */
  redactor?: Redactor
  /** Rapport avec un texte prêt à copier (champ `draft`). */
  withDraft?: boolean
}

export async function runAiReport(req: AiReportRequest): Promise<AiReportDto> {
  const ctx = await requireFeature(req.feature)
  const clean = cleaner(req.redactor)
  // Masquage AVANT tout le reste : rien de ce qui part vers le modèle n'a échappé au masquage.
  const parts = req.parts.map(p => ({ ...p, title: clean(p.title), lines: p.lines.map(clean) }))
  if (!parts.some(p => p.lines.some(l => l.trim()))) throw createError({ statusCode: 422, statusMessage: 'Aucune donnée à analyser' })

  const packed = packContext(parts, maxExcerptChars(ctx.settings.contextTokens))
  const task = taskFor(req.feature)
  const messages = buildMessages({ task, header: req.header.map(clean), parts: packed.parts, focus: req.focus ? clean(req.focus) : undefined })
  const withDraft = !!req.withDraft && !!task.draft
  const res = await callModel(req.feature, { messages, format: resultFormat(withDraft) }, ctx)

  const parsed = parseModelOutput(res.content)
  const meta: AiReportDto['meta'] = {
    model: res.model,
    at: new Date().toISOString(),
    durationMs: res.durationMs,
    totalLines: packed.totalLines,
    sentLines: packed.sentLines,
    truncated: packed.truncated,
  }
  if (!parsed) {
    // Format non respecté (petit modèle) : on affiche le texte tel quel plutôt que de perdre l'analyse.
    return { severity: 'warning', summary: clean(res.content).trim().slice(0, 1500) || 'Réponse vide du modèle.', causes: [], actions: [], draft: null, structured: false, meta }
  }
  return {
    severity: parsed.severity,
    summary: clean(parsed.summary),
    causes: parsed.causes.map(c => ({ title: clean(c.title), evidence: clean(c.evidence) })),
    actions: parsed.actions.map(clean),
    draft: withDraft && parsed.draft ? clean(parsed.draft) : null,
    structured: true,
    meta,
  }
}
