import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { discordAdapter, discordPayload } from '../../server/adapters/notifications/discord'
import { gotifyAdapter, gotifyPayload } from '../../server/adapters/notifications/gotify'
import { ntfyAdapter, ntfyPayload } from '../../server/adapters/notifications/ntfy'
import { slackAdapter, slackPayload } from '../../server/adapters/notifications/slack'
import { NotificationError, type NotificationMessage } from '../../server/adapters/notifications/types'
import { resetEnvCache } from '../../server/utils/env'

const msg: NotificationMessage = { event: 'deployment.failed', title: 'Échec <shop> & co', summary: 'Ligne 1\nLigne 2 <@everyone>', severity: 'error', facts: [{ label: 'Projet', value: 'shop' }], link: 'https://plateforme/deployments/1' }

describe('charges utiles', () => {
  it('Slack : échappe le mrkdwn, bouton vers la plateforme', () => {
    const p = slackPayload(msg)
    expect(JSON.stringify(p)).toContain('&lt;@everyone&gt;')
    expect(p.blocks.at(-1)).toMatchObject({ type: 'actions' })
    expect(p.text).toContain('🔴')
  })
  it('Discord : couleur par gravité, aucune mention autorisée', () => {
    const p = discordPayload(msg)
    expect(p.allowed_mentions).toEqual({ parse: [] })
    expect(p.embeds[0]).toMatchObject({ color: 0xEF4444, url: msg.link })
    expect(p.embeds[0]!.fields).toEqual([{ name: 'Projet', value: 'shop', inline: true }])
  })
  it('ntfy : JSON UTF-8, priorité maximale pour une erreur, lien cliquable', () => {
    expect(ntfyPayload('ops', msg)).toMatchObject({ topic: 'ops', priority: 5, click: msg.link, title: msg.title })
  })
  it('Gotify : Markdown et lien de notification', () => {
    const p = gotifyPayload(msg)
    expect(p.priority).toBe(8)
    expect(p.message).toContain('- **Projet** : shop')
    expect(p.extras['client::notification']).toEqual({ click: { url: msg.link } })
  })
  it('tronque les textes démesurés', () => {
    expect(slackPayload({ ...msg, title: 'x'.repeat(500) }).blocks[0]!.text!.text.length).toBeLessThanOrEqual(150)
    expect(discordPayload({ ...msg, summary: 'y'.repeat(9000) }).embeds[0]!.description.length).toBeLessThanOrEqual(4000)
  })
})

describe('envois HTTP', () => {
  const seen: { url: string, headers: IncomingMessage['headers'], body: string }[] = []
  let status = 200
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', c => (body += c))
    req.on('end', () => {
      seen.push({ url: req.url ?? '', headers: req.headers, body })
      res.statusCode = status
      res.end(status >= 300 ? 'refusé' : 'ok')
    })
  })
  let base = ''
  beforeAll(async () => {
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    process.env.NOTIFY_WEBHOOK_ALLOWED_HOSTS = '127.0.0.1'
    process.env.NODE_ENV = 'test'
    resetEnvCache()
  })
  afterAll(() => {
    server.close()
    delete process.env.NOTIFY_WEBHOOK_ALLOWED_HOSTS
    resetEnvCache()
  })

  it('Slack et Discord postent le JSON sur l\'URL du webhook', async () => {
    seen.length = 0
    await slackAdapter.send({ url: `${base}/services/T/B/X` }, msg)
    await discordAdapter.send({ url: `${base}/api/webhooks/1/abc` }, msg)
    expect(seen.map(s => s.url)).toEqual(['/services/T/B/X', '/api/webhooks/1/abc'])
    expect(JSON.parse(seen[0]!.body).blocks).toBeDefined()
    expect(JSON.parse(seen[1]!.body).embeds).toBeDefined()
  })
  it('ntfy : jeton en Bearer ; Gotify : jeton en en-tête, jamais dans l\'URL', async () => {
    seen.length = 0
    await ntfyAdapter.send({ server: base, topic: 'ops', token: 'tk_secret' }, msg)
    await gotifyAdapter.send({ url: `${base}/`, token: 'gt_secret' }, msg)
    expect(seen[0]!.headers.authorization).toBe('Bearer tk_secret')
    expect(JSON.parse(seen[0]!.body).topic).toBe('ops')
    expect(seen[1]!.url).toBe('/message')
    expect(seen[1]!.headers['x-gotify-key']).toBe('gt_secret')
  })
  it('classe les erreurs : 4xx définitif, 5xx et 429 à reprendre', async () => {
    status = 403
    await expect(slackAdapter.send({ url: `${base}/x` }, msg)).rejects.toMatchObject({ retryable: false })
    status = 503
    await expect(slackAdapter.send({ url: `${base}/x` }, msg)).rejects.toMatchObject({ retryable: true })
    status = 429
    await expect(discordAdapter.send({ url: `${base}/x` }, msg)).rejects.toMatchObject({ retryable: true })
    status = 200
  })
  it('refuse un hôte hors liste autorisée, sans appel réseau', async () => {
    seen.length = 0
    await expect(slackAdapter.send({ url: 'http://169.254.169.254/latest' }, msg)).rejects.toBeInstanceOf(NotificationError)
    expect(seen).toHaveLength(0)
  })
})
