/**
 * Analyse de logs par Ollama, avec base : réglages (jeton chiffré, jamais relisible), masquage des
 * secrets AVANT envoi au modèle, réponse masquée à son tour, plafond d'analyses simultanées.
 * Le modèle est simulé (OLLAMA_ADAPTER=mock) : on inspecte ce qui lui est réellement transmis.
 */
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { OLLAMA_FEATURE_KEYS } from '../../shared/schemas/ollama'
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
  const base = { enabled: true, baseUrl: 'http://ollama:11434', model: 'llama3.1:8b', timeoutSec: 60, contextTokens: 8192, features: [...OLLAMA_FEATURE_KEYS], clearToken: false }

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
    expect(await svc.ollamaStatus()).toEqual({ enabled: false, model: null, features: [] })
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
    expect(settings).toEqual({ enabled: true, baseUrl: 'http://ollama:11434', model: 'llama3.1:8b', timeoutSec: 60, contextTokens: 8192, features: [...OLLAMA_FEATURE_KEYS], hasToken: true })
    expect(JSON.stringify(settings)).not.toContain(TOKEN)
    expect(await svc.ollamaStatus()).toEqual({ enabled: true, model: 'llama3.1:8b', features: [...OLLAMA_FEATURE_KEYS] })

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

  it('chaque fonction s\'active séparément', async () => {
    await svc.saveOllamaSettings({ ...base, features: ['metrics'] }, null)
    expect(await svc.ollamaStatus()).toMatchObject({ enabled: true, features: ['metrics'] })
    await expect(analysis.analyzeLogsWithOllama({ lines: ['x'], source: 's' })).rejects.toMatchObject({ statusCode: 409, statusMessage: expect.stringContaining('fonction') })
    expect(mock.calls).toHaveLength(0)
    await svc.saveOllamaSettings({ ...base }, null)
    await expect(analysis.analyzeLogsWithOllama({ lines: ['x'], source: 's' })).resolves.toMatchObject({ draft: null })
  })

  it('socle commun : masque chaque bloc, renvoie le brouillon et masque aussi la réponse', async () => {
    const { runAiReport } = await import('../../server/services/ai-task')
    mock.reply = JSON.stringify({
      severity: 'warning',
      summary: 'Le certificat échoue (Authorization: Bearer abcdefghijklmnop1234567890).',
      causes: [{ title: 'Quota ACME', evidence: 'too many failed authorizations' }],
      actions: ['Attendre une heure'],
      draft: 'Titre : certificat\nToken: ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    })
    const report = await runAiReport({
      feature: 'support',
      header: ['Cible Billing'],
      parts: [
        { title: 'Journal', lines: ['password=hunter2hunter2', 'ERROR boom'], weight: 3 },
        { title: 'Configuration', lines: ['API_KEY=abcdefghijklmnopqrstuvwxyz012345'], weight: 0.4 },
      ],
      focus: 'et le jeton ghp_abcdefghijklmnopqrstuvwxyz0123456789 ?',
      withDraft: true,
    })
    const sent = lastPrompt()
    for (const secret of ['hunter2hunter2', 'abcdefghijklmnopqrstuvwxyz012345', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789']) expect(sent).not.toContain(secret)
    expect(sent).toContain('<data titre="Journal"')
    expect(sent).toContain('<data titre="Configuration"')
    expect(report.severity).toBe('warning')
    expect(report.causes).toEqual([{ title: 'Quota ACME', evidence: 'too many failed authorizations' }])
    expect(report.draft).toContain('Titre : certificat')
    expect(JSON.stringify(report)).not.toContain('abcdefghijklmnop1234567890')
    expect(JSON.stringify(report)).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789')
  })

  it('socle commun : une fonction désactivée n\'envoie rien au modèle', async () => {
    const { runAiReport } = await import('../../server/services/ai-task')
    await svc.saveOllamaSettings({ ...base, features: ['logs'] }, null)
    await expect(runAiReport({ feature: 'proxy', header: [], parts: [{ title: 'Routes', lines: ['a'] }] })).rejects.toMatchObject({ statusCode: 409 })
    expect(mock.calls).toHaveLength(0)
    await svc.saveOllamaSettings({ ...base }, null)
  })

  it('registre : ne sert que les fonctions déclarées et valide strictement le corps', async () => {
    const { assistFor } = await import('../../server/services/ai-registry')
    expect(() => assistFor('digest')).toThrowError(expect.objectContaining({ statusCode: 404 }))
    const blockers = assistFor('analysis-blockers')
    expect(blockers.permission).toBe('deployment:execute')
    const stripped = blockers.input.parse({ targetId: '0b2a3c4d-1111-4222-8333-444455556666', ok: false, issues: [], sourceYaml: 'password: x' })
    expect(stripped).not.toHaveProperty('sourceYaml')
    expect(assistFor('metrics').input.safeParse({ endpointId: '0b2a3c4d-1111-4222-8333-444455556666', containerId: 'pas-un-id', range: '1h' }).success).toBe(false)
    expect(assistFor('logs').input.safeParse({ source: 'deployment', deploymentId: 'x' }).success).toBe(false)
  })

  it('blocages Compose : seuls les constats partent vers le modèle, masqués', async () => {
    const { explainAnalysisBlockers } = await import('../../server/services/ai-assist')
    const { analysisExplainInput } = await import('../../shared/schemas/ollama')
    const input = analysisExplainInput.parse({
      ok: false,
      issues: [{ severity: 'error', code: 'port.forbidden', service: 'db', message: 'Port 5432 interdit (password=hunter2hunter2)' }],
      sourceYaml: 'services: { db: { environment: { PASSWORD: tres-secret-compose } } }',
    })
    const r = await explainAnalysisBlockers(input, { stack: 'billing-prod' })
    const sent = lastPrompt()
    expect(sent).toContain('port.forbidden')
    expect(sent).toContain('billing-prod')
    expect(sent).not.toContain('hunter2hunter2')
    expect(sent).not.toContain('tres-secret-compose')
    expect(r.meta.model).toBe('llama3.1:8b')
  })

  it('tri Trivy : seules les CVE, paquets et versions partent, le contexte interne seulement sur demande', async () => {
    const { triageVulnerabilities } = await import('../../server/services/ai-assist')
    const scan = {
      id: 'x', type: 'image' as const, endpointId: 'e', name: 'ghcr.io/acme/app:1.4', os: 'debian 12', scannedAt: '2026-11-16T03:00:00.000Z',
      counts: { CRITICAL: 1, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 }, fixable: 1,
      findings: [{ id: 'CVE-2026-0001', pkg: 'openssl', installed: '3.0.1', fixed: '3.0.9', severity: 'CRITICAL' as const, title: 'titre-a-ne-pas-envoyer', url: 'https://avd.example/x', target: 'debian 12', class: 'os-pkgs' as const }],
      usedBy: [{ label: 'Billing (prod)', services: ['web'] }],
    }
    mock.reply = JSON.stringify({ severity: 'error', summary: 'Reconstruire l\'image.', causes: [], actions: ['Reconstruire'], draft: 'Titre : mise à jour openssl\n\nVersion 3.0.9' })
    const r = await triageVulnerabilities(scan, { minSeverity: 'HIGH', fixableOnly: true, lang: 'en', includeContext: false })
    const sent = lastPrompt()
    expect(sent).toContain('openssl 3.0.1 → 3.0.9')
    expect(sent).toContain('CVE-2026-0001')
    expect(sent).toContain('en anglais')
    expect(sent).not.toContain('titre-a-ne-pas-envoyer')
    expect(sent).not.toContain('Billing (prod)')
    expect(r.draft).toContain('Titre : mise à jour openssl')

    await triageVulnerabilities(scan, { minSeverity: 'HIGH', fixableOnly: true, lang: 'fr', includeContext: true })
    expect(lastPrompt()).toContain('Billing (prod) (services web)')

    mock.calls.length = 0
    await expect(triageVulnerabilities({ ...scan, findings: [] }, { minSeverity: 'HIGH', fixableOnly: true, lang: 'fr', includeContext: false })).rejects.toMatchObject({ statusCode: 422 })
    expect(mock.calls).toHaveLength(0)
  })

  it('recherche en langage naturel : seule la phrase part, noms résolus parmi ce que l\'utilisateur voit', async () => {
    const { naturalSearch } = await import('../../server/services/ai-search')
    const { encryptSecret } = await import('../../server/utils/crypto')
    const { envelope, keyId } = encryptSecret('t')
    const [sec] = await dbm.db().insert(dbm.schema.secrets).values({ purpose: 'agent_secret', envelope, keyId }).returning()
    const [visible, hidden] = await dbm.db().insert(dbm.schema.projects).values([{ slug: 'billing', name: 'Billing' }, { slug: 'secret-lab', name: 'Secret Lab' }]).returning()
    await dbm.db().insert(dbm.schema.portainerServers).values({ name: 'srv-paris', url: 'https://p.test', tokenSecretId: sec!.id } as never)
    const admin = { id: null, email: 'a@x.fr', displayName: 'A', kind: 'dev' as const, grants: [{ permissions: ['audit:read', 'deployment:read', 'server:read'], scope: {} }] }
    // Droit limité au projet Billing : « Secret Lab » n'existe pas pour lui.
    const limited = { ...admin, grants: [{ permissions: ['audit:read', 'deployment:read', 'server:read'], scope: { projectId: visible!.id } }] }

    mock.reply = JSON.stringify({ period: '7d', status: ['FAILED'], environment: 'prod', project: 'billing', sql: 'DROP TABLE audit_log' })
    const r = await naturalSearch(admin, 'deployments', 'échecs de production de Billing cette semaine, password=hunter2hunter2')
    expect(mock.calls).toHaveLength(1)
    const sent = lastPrompt()
    expect(sent).toContain('échecs de production de Billing cette semaine')
    expect(sent).not.toContain('hunter2hunter2')
    expect(sent).not.toContain('Secret Lab')
    expect(mock.calls[0]!.req.format).toBeTruthy()
    const env = (await dbm.db().select().from(dbm.schema.environments)).find(e => e.key === 'production')!
    expect(r.query).toEqual({ period: '7d', status: 'FAILED', environmentId: env.id, projectId: visible!.id })
    expect(r.ignored.join('\n')).toContain('sql')
    expect(r.applied.map(a => a.label)).toEqual(['Période', 'Statut', 'Environnement', 'Projet'])
    expect(JSON.stringify(r)).not.toContain('DROP TABLE')

    mock.reply = JSON.stringify({ project: 'secret lab' })
    const none = await naturalSearch(limited, 'audit', 'le projet Secret Lab').catch(e => e)
    expect(none).toMatchObject({ statusCode: 422, statusMessage: expect.stringContaining('introuvable') })
    mock.reply = JSON.stringify({ project: 'secret lab', outcome: ['denied'] })
    const partial = await naturalSearch(limited, 'audit', 'refus du projet Secret Lab')
    expect(partial.query).toEqual({ outcome: 'denied' })
    expect(partial.ignored.join('\n')).toContain('introuvable')
    expect(Object.values(partial.query)).not.toContain(hidden!.id)

    mock.reply = JSON.stringify({ server: 'paris', buildFailed: true, unacknowledged: true })
    const srv = await naturalSearch(admin, 'deployments', 'échecs de build à Paris non acquittés')
    expect(srv.query).toMatchObject({ buildFailed: 'true', unacknowledged: 'true' })
    expect(srv.query.serverId).toMatch(/^[0-9a-f-]{36}$/)

    mock.reply = 'impossible'
    await expect(naturalSearch(admin, 'audit', 'quelque chose')).rejects.toMatchObject({ statusCode: 422 })
    mock.reply = '{}'
    await expect(naturalSearch(admin, 'audit', 'rien de précis')).rejects.toMatchObject({ statusCode: 422 })
  })

  it('recherche en langage naturel : fonction désactivée, rien n\'est envoyé', async () => {
    const { naturalSearch } = await import('../../server/services/ai-search')
    const user = { id: null, email: 'a@x.fr', displayName: 'A', kind: 'dev' as const, grants: [{ permissions: ['audit:read'], scope: {} }] }
    await svc.saveOllamaSettings({ ...base, features: ['logs'] }, null)
    mock.calls.length = 0
    await expect(naturalSearch(user, 'audit', 'refus de la semaine')).rejects.toMatchObject({ statusCode: 409 })
    expect(mock.calls).toHaveLength(0)
    await svc.saveOllamaSettings({ ...base }, null)
  })

  it('résumé périodique : synthèse en texte brut en tête, jamais bloquante', async () => {
    const { narrateDigest } = await import('../../server/services/ai-digest')
    const at = (min: number) => new Date(Date.UTC(2026, 10, 10, 7, 0) - min * 60_000)
    const events = [
      { event: 'deployment.failed', severity: 'error', title: 'Billing (prod) : déploiement en échec — password=hunter2hunter2', createdAt: at(20) },
      { event: 'deployment.succeeded', severity: 'info', title: 'Portail déployé', createdAt: at(5) },
    ]
    const from = at(24 * 60)
    const to = at(0)

    // Fonction non cochée : rien n'est envoyé.
    await svc.saveOllamaSettings({ ...base, features: ['logs'] }, null)
    expect(await narrateDigest(events, 'daily', from, to)).toBeNull()
    expect(mock.calls).toHaveLength(0)
    await svc.saveOllamaSettings({ ...base }, null)

    mock.reply = JSON.stringify({ severity: 'error', summary: 'Un échec sur Billing. Voir https://evil.example/x @channel <b>vite</b>.', causes: [], actions: ['Relancer Billing'] })
    const memo = new Map()
    const text = await narrateDigest(events, 'daily', from, to, memo)
    expect(text).toBe('Un échec sur Billing. Voir [lien retiré] channel vite.\nÀ surveiller :\n• Relancer Billing')
    const sent = lastPrompt()
    expect(sent).toContain('Billing (prod) : déploiement en échec')
    expect(sent).toContain('1 erreur(s), 0 alerte(s), 1 information(s)')
    expect(sent).not.toContain('hunter2hunter2')
    // Mêmes évènements sur un autre canal : un seul appel au modèle.
    expect(await narrateDigest(events, 'daily', from, to, memo)).toBe(text)
    expect(mock.calls).toHaveLength(1)

    // Rien à résumer : le modèle n'est pas appelé.
    mock.calls.length = 0
    expect(await narrateDigest([], 'daily', from, to)).toBeNull()
    expect(mock.calls).toHaveLength(0)

    // Modèle injoignable ou occupé : pas d'erreur, le résumé part sans synthèse.
    const { OllamaError } = await import('../../server/adapters/ollama')
    mock.failWith = new OllamaError('Ollama injoignable (connexion refusée)', 'unreachable')
    expect(await narrateDigest(events, 'weekly', from, to)).toBeNull()
  })

  it('docker run → Compose : valeurs sensibles jamais envoyées, écarts relevés, analyse de la cible', async () => {
    const { composeFromDockerRun } = await import('../../server/services/ai-compose')
    const { getTargetOr404 } = await import('../../server/services/projects')
    const { assistFor } = await import('../../server/services/ai-registry')
    const { encryptSecret } = await import('../../server/utils/crypto')
    const { envelope, keyId } = encryptSecret('t')
    const [sec] = await dbm.db().insert(dbm.schema.secrets).values({ purpose: 'agent_secret', envelope, keyId }).returning()
    const [server] = await dbm.db().insert(dbm.schema.portainerServers).values({ name: 'srv-gen', url: 'https://g.test', tokenSecretId: sec!.id } as never).returning()
    const [ep] = await dbm.db().insert(dbm.schema.serverEndpoints).values({ serverId: server!.id, portainerEndpointId: 1, name: 'local', type: 'docker_standalone', enabled: true } as never).returning()
    const [env] = await dbm.db().select().from(dbm.schema.environments).where(eq(dbm.schema.environments.key, 'staging'))
    const [p] = await dbm.db().insert(dbm.schema.projects).values({ slug: 'gen', name: 'Gen' }).returning()
    const [row] = await dbm.db().insert(dbm.schema.projectTargets).values({ projectId: p!.id, endpointId: ep!.id, environmentId: env!.id, stackName: 'gen-staging' } as never).returning()
    const t = await getTargetOr404(row!.id)

    const cmd = 'docker run -d --name cache --restart unless-stopped -p 127.0.0.1:6379:6379 -v redisdata:/data -e REDIS_PASSWORD=hunter2-valeur-secrete -e TZ=Europe/Paris redis:7'
    const good = (extra = '') => 'services:\n  cache:\n    image: redis:7\n    restart: unless-stopped\n    ports:\n      - "127.0.0.1:6379:6379"\n    volumes:\n      - redisdata:/data\n    environment:\n      REDIS_PASSWORD: ${REDIS_PASSWORD}\n      TZ: Europe/Paris\n' + extra + 'volumes:\n  redisdata:\n'
    mock.reply = JSON.stringify({ compose: good(), notes: ['Mot de passe : password=hunter2hunter2'] })
    const r = await composeFromDockerRun(t, cmd)
    const sent = lastPrompt()
    expect(sent).not.toContain('hunter2-valeur-secrete')
    expect(sent).toContain('-e REDIS_PASSWORD=${REDIS_PASSWORD}')
    expect(sent).toContain('-e TZ=Europe/Paris')
    expect(mock.calls[0]!.req.format).toBeTruthy()
    expect(r.compose).toContain('REDIS_PASSWORD: ${REDIS_PASSWORD}')
    expect(r.fidelity).toEqual([])
    expect(r.variables).toEqual([{ name: 'REDIS_PASSWORD', known: false }])
    expect(r.analysis).not.toBeNull()
    expect(r.analysis!.issues.some(i => i.code === 'paths.missing' || i.severity === 'info' || i.severity === 'warning' || i.severity === 'error')).toBe(true)
    expect(JSON.stringify(r)).not.toContain('hunter2')
    expect(r.meta.sentLines).toBeGreaterThan(3)

    // Un Compose qui ajoute un service privilégié et un port : écarts relevés, jamais présentés comme conformes.
    mock.reply = JSON.stringify({ compose: good('    privileged: true\n').replace('      - "127.0.0.1:6379:6379"\n', '      - "6379:6379"\n') })
    const bad = await composeFromDockerRun(t, cmd)
    expect(bad.fidelity).toEqual(expect.arrayContaining(['privileged ajouté par le modèle', 'Port 127.0.0.1:6379:6379 de la commande absent du Compose']))
    expect(bad.analysis?.ok).toBe(false)
    expect(bad.analysis?.issues.map(i => i.code)).toContain('service.privileged')

    // Réponse inexploitable : aucun Compose proposé.
    mock.reply = 'Je ne peux pas.'
    expect(await composeFromDockerRun(t, cmd)).toMatchObject({ compose: null, structured: false, fidelity: [] })

    // Commande invalide ou dangereuse : refusée avant tout appel au modèle.
    mock.calls.length = 0
    for (const bad of ['docker ps', 'docker run nginx; id', 'docker run --inconnue nginx']) await expect(composeFromDockerRun(t, bad)).rejects.toMatchObject({ statusCode: 422 })
    expect(mock.calls).toHaveLength(0)

    // Fonction non cochée : rien n'est envoyé. Corps du registre strict.
    await svc.saveOllamaSettings({ ...base, features: ['logs'] }, null)
    await expect(composeFromDockerRun(t, cmd)).rejects.toMatchObject({ statusCode: 409 })
    expect(mock.calls).toHaveLength(0)
    await svc.saveOllamaSettings({ ...base }, null)
    const spec = assistFor('compose-gen')
    expect(spec.permission).toBe('deployment:execute')
    expect(spec.input.safeParse({ targetId: row!.id, command: 'docker run nginx', sourceYaml: 'x' }).success).toBe(true)
    expect(spec.input.safeParse({ targetId: row!.id, command: 'court' }).success).toBe(false)
    expect(spec.input.safeParse({ targetId: 'x', command: 'docker run nginx' }).success).toBe(false)
  })

  it('supprime le jeton à la demande', async () => {
    const { settings, credentialChanged } = await svc.saveOllamaSettings({ ...base, clearToken: true }, null)
    expect(settings.hasToken).toBe(false)
    expect(credentialChanged).toBe(true)
    expect(await dbm.db().select().from(dbm.schema.secrets).where(eq(dbm.schema.secrets.purpose, 'ollama_token'))).toHaveLength(0)
    expect((await svc.ollamaConnection()).conn.token).toBeNull()
  })
})
