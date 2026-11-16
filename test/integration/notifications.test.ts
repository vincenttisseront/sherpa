/**
 * Notifications de bout en bout : évènement → répartition par canal → envoi réel
 * (webhook HTTP local, serveur SMTP local), suivi des envois et des échecs.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { SMTPServer } from 'smtp-server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { databaseAvailable, setupTestDatabase } from '../helpers/db'

const available = await databaseAvailable()

describe.skipIf(!available)('notifications (webhook et SMTP réels en local)', () => {
  let http: Server
  let smtp: SMTPServer
  let hookUrl: string
  const received: unknown[] = []
  const mails: string[] = []
  let failNext = 0
  let mod: typeof import('../../server/services/notifications')
  let dbm: typeof import('../../server/db/client')

  beforeAll(async () => {
    http = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        if (failNext > 0) {
          failNext--
          res.writeHead(503).end('indisponible')
          return
        }
        received.push(JSON.parse(body))
        res.writeHead(202).end()
      })
    })
    await new Promise<void>(r => http.listen(0, '127.0.0.1', r))
    hookUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}/hook`
    smtp = new SMTPServer({
      authOptional: true,
      disabledCommands: ['STARTTLS'],
      onData(stream, _s, cb) {
        let raw = ''
        stream.on('data', (c) => { raw += c })
        stream.on('end', () => { mails.push(raw); cb() })
      },
    })
    await new Promise<void>(r => smtp.listen(0, '127.0.0.1', r))
    process.env.SMTP_HOST = '127.0.0.1'
    process.env.SMTP_PORT = String((smtp.server.address() as AddressInfo).port)
    process.env.SMTP_FROM = 'Plateforme <noreply@test.local>'
    process.env.NOTIFY_WEBHOOK_ALLOWED_HOSTS = '127.0.0.1'
    process.env.APP_URL = 'http://plateforme.test'
    await setupTestDatabase('notifications')
    dbm = await import('../../server/db/client')
    mod = await import('../../server/services/notifications')
  }, 30_000)

  afterAll(async () => {
    http?.close()
    smtp?.close()
    await (await import('../../server/queue/queues')).notificationQueue().obliterate({ force: true }).catch(() => {})
    await (await import('../../server/queue/redis')).closeRedis()
    await dbm?.closeDb()
  })

  async function channel(kind: 'email' | 'teams_webhook', config: unknown, events: string[], environmentIds: string[] = []) {
    expect(mod.checkChannelConfig(kind, config)).toEqual({})
    const configSecretId = await mod.storeChannelConfig(kind, config)
    const [c] = await dbm.db().insert(dbm.schema.notificationChannels).values({ kind, name: `${kind} test`, configSecretId, events, environmentIds }).returning()
    return c!
  }

  async function deliveriesOf(eventId: string) {
    const { eq } = await import('drizzle-orm')
    return dbm.db().select().from(dbm.schema.notificationDeliveries).where(eq(dbm.schema.notificationDeliveries.eventId, eventId))
  }

  it('répartit un évènement sur les canaux abonnés et l\'envoie (Teams + email)', async () => {
    await channel('teams_webhook', { url: hookUrl }, ['deployment.failed'])
    await channel('email', { recipients: ['ops@test.local'] }, ['deployment.failed', 'server.unavailable'])
    await channel('teams_webhook', { url: hookUrl }, ['user.invited'])
    const eventId = await mod.emitNotification({
      event: 'deployment.failed', severity: 'error', title: 'Déploiement de shop (Production) en échec',
      summary: 'Healthchecks en échec : api (password=hunter2)', facts: [{ label: 'Projet', value: 'shop' }], path: '/deployments/1',
    })
    expect(await mod.dispatchEvent(eventId!)).toBe(2)
    const ds = await deliveriesOf(eventId!)
    for (const d of ds) await mod.deliver(d.id, 1)
    const after = await deliveriesOf(eventId!)
    expect(after.map(d => d.status)).toEqual(['sent', 'sent'])
    const card = received.at(-1) as { attachments: { content: { body: { text: string }[], actions: { url: string }[] } }[] }
    expect(card.attachments[0]!.content.body[0]!.text).toBe('Déploiement de shop (Production) en échec')
    expect(card.attachments[0]!.content.actions[0]!.url).toBe('http://plateforme.test/deployments/1')
    // Secrets masqués avant tout envoi.
    expect(JSON.stringify(card)).not.toContain('hunter2')
    expect(mails.at(-1)).toContain('Subject: =?UTF-8?Q?=5BPlateforme=5D_D=C3=A9ploiement')
    expect(mails.at(-1)).toContain('To: ops@test.local')
    expect(mails.at(-1)).not.toContain('hunter2')
  })

  it('filtre par environnement (les évènements sans environnement passent)', async () => {
    const [env] = await dbm.db().select().from(dbm.schema.environments).limit(1)
    const [other] = await dbm.db().select().from(dbm.schema.environments).limit(1).offset(1)
    await channel('teams_webhook', { url: hookUrl }, ['healthcheck.degraded'], [env!.id])
    const inEnv = await mod.emitNotification({ event: 'healthcheck.degraded', severity: 'warning', title: 'a', summary: 'b', facts: [], environmentId: env!.id })
    const outEnv = await mod.emitNotification({ event: 'healthcheck.degraded', severity: 'warning', title: 'a', summary: 'b', facts: [], environmentId: other!.id })
    expect(await mod.dispatchEvent(inEnv!)).toBe(1)
    expect(await mod.dispatchEvent(outEnv!)).toBe(0)
  })

  it('réessaie sur erreur temporaire puis abandonne après la dernière tentative', async () => {
    const eventId = await mod.emitNotification({ event: 'user.invited', severity: 'info', title: 'Invitation', summary: 'x', facts: [] })
    await mod.dispatchEvent(eventId!)
    const [d] = await deliveriesOf(eventId!)
    failNext = 1
    await expect(mod.deliver(d!.id, 1)).rejects.toThrow(/503/)
    expect((await deliveriesOf(eventId!))[0]).toMatchObject({ status: 'pending', attempts: 1 })
    await mod.deliver(d!.id, 2)
    expect((await deliveriesOf(eventId!))[0]).toMatchObject({ status: 'sent', attempts: 2, error: null })

    const e2 = await mod.emitNotification({ event: 'user.invited', severity: 'info', title: 'Invitation 2', summary: 'x', facts: [] })
    await mod.dispatchEvent(e2!)
    const [d2] = await deliveriesOf(e2!)
    failNext = 1
    await expect(mod.deliver(d2!.id, 4)).rejects.toThrow()
    expect((await deliveriesOf(e2!))[0]).toMatchObject({ status: 'failed', attempts: 4 })
    failNext = 0
  })

  it('refuse un webhook hors liste et un email sans SMTP', async () => {
    expect(mod.checkChannelConfig('teams_webhook', { url: 'https://evil.example.com/x' })).toHaveProperty(['config.url'])
    expect(mod.checkChannelConfig('email', { recipients: ['pas-un-email'] })).toHaveProperty(['config.recipients'])
  })

  it('purge par lots les données au-delà de la rétention, et seulement elles', async () => {
    const { sql } = await import('drizzle-orm')
    const old = new Date(Date.now() - 200 * 864e5)
    await dbm.db().insert(dbm.schema.auditEvents).values([{ actorLabel: 't', action: 'vieux', outcome: 'success', ts: old }, { actorLabel: 't', action: 'recent', outcome: 'success' }])
    const [ev] = await dbm.db().insert(dbm.schema.notificationEvents).values({ event: 'user.invited', severity: 'info', title: 'vieux', summary: 'x', createdAt: old }).returning()
    await dbm.db().insert(dbm.schema.notificationDeliveries).values({ eventId: ev!.id, channelName: 'c', kind: 'email', createdAt: old })
    const { purgeExpired, retentionStatus } = await import('../../server/worker/retention')
    const before = await retentionStatus(183)
    expect(before.tables.find(t => t.key === 'audit')!.expired).toBe(1)
    const r = await purgeExpired(183, { label: 'test' })
    expect(r).toMatchObject({ audit: 1, notifications: 1 })
    const left = await dbm.db().execute(sql`select action from audit_events where action in ('vieux', 'recent')`) as unknown as { action: string }[]
    expect(left.map(x => x.action)).toEqual(['recent'])
    // Envois supprimés avec leur évènement.
    const orphan = await dbm.db().execute(sql`select count(*)::int as n from notification_deliveries where event_id = ${ev!.id}`) as unknown as { n: number }[]
    expect(orphan[0]!.n).toBe(0)
    expect((await retentionStatus(183)).lastPurge?.by).toBe('test')
  })

  it('historique des envois filtrable', async () => {
    const r = await mod.listDeliveries({ page: 1, pageSize: 50, status: 'failed' })
    expect(r.items.every(i => i.status === 'failed')).toBe(true)
    expect(r.total).toBeGreaterThanOrEqual(1)
  })
})
