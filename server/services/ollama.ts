/**
 * Connecteur Ollama : réglages d'administration (adresse, modèle, délai, contexte), jeton éventuel
 * chiffré dans `secrets` (référencé par id, jamais renvoyé) et test de connexion.
 * Désactivé par défaut : sans réglage enregistré, aucune analyse n'est possible.
 */
import { eq } from 'drizzle-orm'
import { createError } from 'h3'
import type { OllamaFeature, OllamaSettingsDto, OllamaSettingsInput, OllamaStatusDto, OllamaTestInput, OllamaTestResult } from '../../shared/schemas/ollama'
import { OLLAMA_DEFAULT_URL, OLLAMA_FEATURE_KEYS } from '../../shared/schemas/ollama'
import { byCode } from '../../shared/utils/compare'
import { type OllamaConnection, OllamaError, ollama } from '../adapters/ollama'
import { db, schema } from '../db/client'
import { checkOllamaUrl, normalizeOllamaUrl } from '../lib/ollama/url'
import { decryptSecret, encryptSecret } from '../utils/crypto'
import { redactPatterns } from '../utils/redact'

const SETTINGS_KEY = 'ollama.settings'
const SECRET_PURPOSE = 'ollama_token'

/** Réglages tels que conservés dans `app_settings` : jamais le jeton, seulement la référence de son secret. */
export interface OllamaStoredSettings {
  enabled: boolean
  baseUrl: string
  model: string
  timeoutSec: number
  contextTokens: number
  features: OllamaFeature[]
  tokenSecretId: string | null
}

const DEFAULTS: OllamaStoredSettings = {
  enabled: false,
  baseUrl: OLLAMA_DEFAULT_URL,
  model: 'llama3.1:8b',
  timeoutSec: 120,
  contextTokens: 8192,
  features: [...OLLAMA_FEATURE_KEYS],
  tokenSecretId: null,
}

export async function ollamaSettings(): Promise<OllamaStoredSettings> {
  const [row] = await db().select().from(schema.appSettings).where(eq(schema.appSettings.key, SETTINGS_KEY))
  return { ...DEFAULTS, ...(row?.value as Partial<OllamaStoredSettings> | undefined) }
}

const toDto = (s: OllamaStoredSettings): OllamaSettingsDto => ({
  enabled: s.enabled,
  baseUrl: s.baseUrl,
  model: s.model,
  timeoutSec: s.timeoutSec,
  contextTokens: s.contextTokens,
  features: s.features,
  hasToken: s.tokenSecretId !== null,
})

export async function ollamaSettingsDto(): Promise<OllamaSettingsDto> {
  return toDto(await ollamaSettings())
}

/** Ce que voit un lecteur de logs : disponible ou non, et le modèle ; jamais l'adresse du serveur. */
export async function ollamaStatus(): Promise<OllamaStatusDto> {
  const s = await ollamaSettings()
  return { enabled: s.enabled, model: s.enabled ? s.model : null, features: s.enabled ? s.features : [] }
}

async function readToken(secretId: string | null): Promise<string | null> {
  if (!secretId) return null
  const [s] = await db().select({ envelope: schema.secrets.envelope }).from(schema.secrets).where(eq(schema.secrets.id, secretId))
  return s ? decryptSecret(s.envelope) : null
}

/** Connexion prête à l'emploi d'après les réglages enregistrés (jeton déchiffré le temps de l'appel). */
export async function ollamaConnection(s?: OllamaStoredSettings): Promise<{ conn: OllamaConnection, settings: OllamaStoredSettings }> {
  const settings = s ?? await ollamaSettings()
  return { conn: { baseUrl: settings.baseUrl, token: await readToken(settings.tokenSecretId), timeoutMs: settings.timeoutSec * 1000 }, settings }
}

const invalid = (field: string, message: string) => createError({ statusCode: 422, statusMessage: message, data: { errors: { [field]: message } } })

export async function saveOllamaSettings(input: OllamaSettingsInput, userId: string | null): Promise<{ settings: OllamaSettingsDto, credentialChanged: boolean }> {
  const problem = checkOllamaUrl(input.baseUrl)
  if (problem) throw invalid('baseUrl', problem)
  const baseUrl = normalizeOllamaUrl(input.baseUrl)
  const current = await ollamaSettings()

  // Le jeton enregistré n'est jamais relisible : il ne doit pas pouvoir partir vers une autre adresse sans être ressaisi.
  if (current.tokenSecretId && baseUrl !== current.baseUrl && input.token === undefined && !input.clearToken) {
    throw invalid('token', 'L\'adresse change : ressaisir le jeton, ou le supprimer')
  }

  let tokenSecretId = current.tokenSecretId
  let credentialChanged = false
  await db().transaction(async (tx) => {
    if (input.clearToken && tokenSecretId) {
      await tx.delete(schema.secrets).where(eq(schema.secrets.id, tokenSecretId))
      tokenSecretId = null
      credentialChanged = true
    }
    if (input.token) {
      const { envelope, keyId } = encryptSecret(input.token)
      if (tokenSecretId) {
        await tx.update(schema.secrets).set({ envelope, keyId, rotatedAt: new Date() }).where(eq(schema.secrets.id, tokenSecretId))
      }
      else {
        const [secret] = await tx.insert(schema.secrets).values({ purpose: SECRET_PURPOSE, envelope, keyId }).returning({ id: schema.secrets.id })
        tokenSecretId = secret!.id
      }
      credentialChanged = true
    }
    const value: OllamaStoredSettings = {
      enabled: input.enabled,
      baseUrl,
      model: input.model,
      timeoutSec: input.timeoutSec,
      contextTokens: input.contextTokens,
      features: OLLAMA_FEATURE_KEYS.filter(k => input.features.includes(k)),
      tokenSecretId,
    }
    await tx.insert(schema.appSettings).values({ key: SETTINGS_KEY, value, updatedBy: userId })
      .onConflictDoUpdate({ target: schema.appSettings.key, set: { value, updatedBy: userId, updatedAt: new Date() } })
  })
  return { settings: toDto(await ollamaSettings()), credentialChanged }
}

/**
 * Teste la connexion : version du serveur, modèles installés, présence du modèle. Une erreur est
 * rendue dans le résultat (ok: false) et non levée, pour l'afficher à côté du formulaire.
 */
export async function testOllama(input: OllamaTestInput = {}): Promise<OllamaTestResult> {
  const saved = await ollamaSettings()
  const baseUrl = input.baseUrl ?? saved.baseUrl
  const problem = checkOllamaUrl(baseUrl)
  if (problem) return { ok: false, version: null, models: [], modelPresent: false, error: problem }
  const normalized = normalizeOllamaUrl(baseUrl)
  // Le jeton enregistré ne sert que pour l'adresse enregistrée.
  const token = input.token ?? (normalized === saved.baseUrl ? await readToken(saved.tokenSecretId) : null)
  const conn: OllamaConnection = { baseUrl: normalized, token, timeoutMs: Math.min(saved.timeoutSec, 30) * 1000 }
  const model = input.model || saved.model
  try {
    const [version, models] = await Promise.all([ollama().version(conn), ollama().models(conn)])
    const sorted = models.toSorted((a, b) => byCode(a.name, b.name))
    return { ok: true, version, models: sorted, modelPresent: sorted.some(m => m.name === model || m.name === `${model}:latest`), error: null }
  }
  catch (err) {
    const message = err instanceof OllamaError ? err.message : 'Échec du test de connexion'
    return { ok: false, version: null, models: [], modelPresent: false, error: redactPatterns(message) }
  }
}
