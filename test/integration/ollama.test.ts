/**
 * Analyse de logs par Ollama, avec base : réglages (jeton chiffré, jamais relisible), masquage des
 * secrets AVANT envoi au modèle, réponse masquée à son tour, plafond d'analyses simultanées.
 * Le modèle est simulé (OLLAMA_ADAPTER=mock) : on inspecte ce qui lui est réellement transmis.
 */
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { databaseAvailable, setupTestDatabase } from '../helpers/db'

const available = await databaseAvailable()

describe.skipIf(!available)('connecteur Ollama (base de test, modèle simulé)', () => {
  let svc: typeof import('../../server/services/ollama')
  let analysis: typeof import('../../server/services/log-analysis')
  let dbm: typeof import('../../server/db/client')
  let mock: import('../../server/adapters/ollama').MockOllamaAdapter
  let Redactor: typeof import('../../server/utils/redact').Redactor
  let envMod: typeof import('../../server/utils/env')

  const TOKEN = 'jeton-ollama-0123456789'
  const base = { enabled: true, baseUrl: 'http://ollama:11434', model: 'llama3.1:8b', timeoutSec: 60, contextTokens: 8192, clearToken: false }

  beforeAll(async () => {
    process.env.OLLAMA_ADAPTER = 'mock'
    await setupTestDatabase('ollama')
    envMod = await import('../../server/utils/env')
    envMod.resetEnvCache()
    dbm = await import('../../server/db/client')
    svc = await import('../../server/services/ollama')
    analysis = await import('../../server/services/log-analysis')
    ;({ Redactor } = await import('../../server/utils/redact'))
    const { ollama } = await import('../../server/adapters/ollama')
    mock = ollama() as typeof mock
  })
  afterAll(async () => {
    delete process.env.OLLAMA_ADAPTER
    delete process.env.OLLAMA_MAX_CONCURRENT
    envMod?.resetEnvCache()
    await dbm?.closeDb()
  })
  beforeEach(() => {
    mock.calls.length = 0
    mock.reply = null
    mock.failWith = null
    mock.models_ = ['llama3.1:8b']
  })

  const lastPrompt = () => mock.calls.at(-1)!.req.messages.map(m => m.content).join('\n')

  it('désactivé par défaut : aucune analyse, rien n\'est envoyé', async () => {
    expect(await svc.ollamaStatus()).toEqual({ enabled: false, model: null })
    await expect(analysis.analyzeLogsWithOllama({ lines: ['une ligne'], source: 's' })).rejects.toMatchObject({ statusCode: 409 })
    expect(mock.calls).toHaveLength(0)
  })

  it('refuse une adresse de métadonnées ou avec identifiants', async () => {
    await expect(svc.saveOllamaSettings({ ...base, baseUrl: 'http://169.254.169.254' }, null)).rejects.toMatchObject({ statusCode: 422, data: { errors: { baseUrl: expect.any(String) } } })
    await expect(svc.saveOllamaSettings({ ...base, baseUrl: 'http://u:p@ollama:11434' }, null)).rejects.toMatchObject({ statusCode: 422 })
  })

  it('enregistre les réglages : jeton chiffré en base, jamais renvoyé', async () => {
    const { settings, credentialChanged } = await svc.saveOllamaSettings({ ...base, baseUrl: 'http://ollama:11434/', token: TOKEN }, null)
    expect(credentialChanged).toBe(true)
    expect(settings).toEqual({ enabled: true, baseUrl: 'http://ollama:11434', model: 'llama3.1:8b', timeoutSec: 60, contextTokens: 8192, hasToken: true })
    expect(JSON.stringify(settings)).not.toContain(TOKEN)
    expect(await svc.ollamaStatus()).toEqual({ enabled: true, model: 'llama3.1:8b' })

    const [row] = await dbm.db().select().from(dbm.schema.appSettings).where(eq(dbm.schema.appSettings.key, 'ollama.settings'))
    expect(JSON.stringify(row)).not.toContain(TOKEN)
    const [secret] = await dbm.db().select().from(dbm.schema.secrets).where(eq(dbm.schema.secrets.purpose, 'ollama_token'))
    expect(secret!.envelope).not.toContain(TOKEN)
    const { conn } = await svc.ollamaConnection()
    expect(conn).toEqual({ baseUrl: 'http://ollama:11434', token: TOKEN, timeoutMs: 60_000 })
  })

  it('le jeton enregistré ne peut pas partir vers une autre adresse sans être ressaisi', async () => {
    await expect(svc.saveOllamaSettings({ ...base, baseUrl: 'http://autre-hote:11434' }, null)).rejects.toMatchObject({ statusCode: 422, data: { errors: { token: expect.any(String) } } })
    // Même adresse, jeton non renseigné : conservé.
    const same = await svc.saveOllamaSettings({ ...base, model: 'qwen2.5:7b' }, null)
    expect(same.settings).toMatchObject({ model: 'qwen2.5:7b', hasToken: true })
    expect(same.credentialChanged).toBe(false)
    // Le test de connexion n'utilise le jeton enregistré que pour l'adresse enregistrée.
    const tokens: (string | null | undefined)[] = []
    const original = mock.version
    mock.version = async (c) => { tokens.push(c.token); return original(c) }
    try {
      await svc.testOllama({ baseUrl: 'http://autre-hote:11434' })
      await svc.testOllama()
    }
    finally {
      mock.version = original
    }
    expect(tokens).toEqual([null, TOKEN])
    await svc.saveOllamaSettings({ ...base }, null)
  })

  it('test de connexion : version, modèles, présence du modèle', async () => {
    mock.models_ = ['qwen2.5:7b', 'llama3.1:8b']
    const ok = await svc.testOllama({ model: 'llama3.1:8b' })
    expect(ok).toMatchObject({ ok: true, version: '0.0.0-mock', modelPresent: true, error: null })
    expect(ok.models.map(m => m.name)).toEqual(['llama3.1:8b', 'qwen2.5:7b'])
    expect((await svc.testOllama({ model: 'absent:1b' })).modelPresent).toBe(false)
    expect(await svc.testOllama({ baseUrl: 'http://169.254.169.254' })).toMatchObject({ ok: false, error: expect.stringContaining('réservée') })
  })

  it('masque les secrets AVANT l\'envoi au modèle', async () => {
    const known = 's3cr3t-valeur-connue-xyz'
    const redactor = new Redactor().add(known)
    const lines = [
      '2026-11-16T10:00:00Z INFO démarrage',
      'DB_URL=postgres://app:MotDePasseTresSecret@db:5432/app',
      'Authorization: Bearer abcdefghijklmnop1234567890',
      'connexion avec ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      `valeur connue ${known}`,
      'password=hunter2hunter2',
      '2026-11-16T10:00:05Z ERROR échec de connexion à la base',
    ]
    const r = await analysis.analyzeLogsWithOllama({ lines, source: `Conteneur web (clé ${known})`, focus: 'pourquoi password=hunter2hunter2 échoue ?', redactor })
    const sent = lastPrompt()
    for (const secret of [known, 'MotDePasseTresSecret', 'abcdefghijklmnop1234567890', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'hunter2hunter2']) {
      expect(sent).not.toContain(secret)
    }
    expect(sent).toContain('••••••')
    expect(sent).toContain('échec de connexion à la base')
    // Le jeton du connecteur sert à l'appel, il n'est pas dans la consigne.
    expect(mock.calls.at(-1)!.conn.token).toBe(TOKEN)
    expect(sent).not.toContain(TOKEN)
    expect(r).toMatchObject({ structured: true, severity: 'error', meta: { model: 'llama3.1:8b', totalLines: 7, truncated: false } })
  })

  it('borne l\'extrait selon la fenêtre de contexte demandée', async () => {
    await svc.saveOllamaSettings({ ...base, contextTokens: 2048 }, null)
    const lines = Array.from({ length: 3000 }, (_, i) => `ligne ${i} un message de journal assez long pour consommer du budget`)
    const r = await analysis.analyzeLogsWithOllama({ lines, source: 's' })
    expect(r.meta).toMatchObject({ totalLines: 3000, truncated: true })
    expect(r.meta.sentLines).toBeLessThan(200)
    expect(mock.calls.at(-1)!.req).toMatchObject({ numCtx: 2048, numPredict: 1024 })
    expect(lastPrompt().length).toBeLessThan(2000 + 3000)
    await svc.saveOllamaSettings({ ...base }, null)
  })

  it('masque aussi la réponse du modèle et tolère un format non respecté', async () => {
    mock.reply = JSON.stringify({ severity: 'warning', summary: 'Mot de passe vu : password=hunter2hunter2', causes: [{ title: 'Jeton Bearer abcdefghijklmnop1234567890', evidence: 'x' }], actions: ['Relire'] })
    const r = await analysis.analyzeLogsWithOllama({ lines: ['rien'], source: 's' })
    expect(JSON.stringify(r)).not.toContain('hunter2hunter2')
    expect(JSON.stringify(r)).not.toContain('abcdefghijklmnop1234567890')

    mock.reply = 'Je pense que le service manque de mémoire. password=hunter2hunter2'
    const raw = await analysis.analyzeLogsWithOllama({ lines: ['rien'], source: 's' })
    expect(raw).toMatchObject({ structured: false, severity: 'warning', causes: [], actions: [] })
    expect(raw.summary).toContain('manque de mémoire')
    expect(raw.summary).not.toContain('hunter2hunter2')
  })

  it('refuse un extrait vide', async () => {
    await expect(analysis.analyzeLogsWithOllama({ lines: ['', '   '], source: 's' })).rejects.toMatchObject({ statusCode: 422 })
    expect(mock.calls).toHaveLength(0)
  })

  it('traduit les erreurs d\'Ollama en erreurs HTTP lisibles', async () => {
    const { OllamaError } = await import('../../server/adapters/ollama')
    mock.failWith = new OllamaError('Délai dépassé : le modèle n\'a pas répondu à temps', 'timeout')
    await expect(analysis.analyzeLogsWithOllama({ lines: ['x'], source: 's' })).rejects.toMatchObject({ statusCode: 504, statusMessage: expect.stringContaining('Délai dépassé') })
    mock.failWith = new OllamaError('Modèle introuvable sur le serveur Ollama', 'model-missing')
    await expect(analysis.analyzeLogsWithOllama({ lines: ['x'], source: 's' })).rejects.toMatchObject({ statusCode: 422 })
    mock.failWith = new OllamaError('Ollama injoignable (connexion refusée)', 'unreachable')
    await expect(analysis.analyzeLogsWithOllama({ lines: ['x'], source: 's' })).rejects.toMatchObject({ statusCode: 502 })
  })

  it('plafonne les analyses simultanées (429) puis libère la place', async () => {
    process.env.OLLAMA_MAX_CONCURRENT = '1'
    envMod.resetEnvCache()
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const original = mock.chat
    mock.chat = async (c, r) => { await gate; return original(c, r) }
    try {
      const first = analysis.analyzeLogsWithOllama({ lines: ['a'], source: 's' })
      await expect(analysis.analyzeLogsWithOllama({ lines: ['b'], source: 's' })).rejects.toMatchObject({ statusCode: 429 })
      release()
      await first
      await expect(analysis.analyzeLogsWithOllama({ lines: ['c'], source: 's' })).resolves.toMatchObject({ structured: true })
    }
    finally {
      mock.chat = original
      delete process.env.OLLAMA_MAX_CONCURRENT
      envMod.resetEnvCache()
    }
  })

  it('supprime le jeton à la demande', async () => {
    const { settings, credentialChanged } = await svc.saveOllamaSettings({ ...base, clearToken: true }, null)
    expect(settings.hasToken).toBe(false)
    expect(credentialChanged).toBe(true)
    expect(await dbm.db().select().from(dbm.schema.secrets).where(eq(dbm.schema.secrets.purpose, 'ollama_token'))).toHaveLength(0)
    expect((await svc.ollamaConnection()).conn.token).toBeNull()
  })
})
