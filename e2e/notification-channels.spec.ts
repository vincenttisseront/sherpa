/**
 * Canaux Slack, Discord, ntfy et Gotify (récepteur local joignable par la stack de développement), message de test,
 * envoi immédiat, et canal en mode résumé : rien d'immédiat, puis un récapitulatif unique à la demande.
 */
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { APIRequestContext } from '@playwright/test'
import { expect, test } from './fixtures'
import { api } from './helpers/accounts'

interface Seen { url: string, headers: IncomingMessage['headers'], body: Record<string, unknown> }

test('canaux Slack, Discord, ntfy, Gotify et résumé périodique', async ({ page, request }) => {
  test.setTimeout(180_000)
  const stamp = Date.now().toString(36)
  const seen: Seen[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', c => (raw += c))
    req.on('end', () => {
      seen.push({ url: req.url ?? '', headers: req.headers, body: raw ? JSON.parse(raw) : {} })
      res.end('ok')
    })
  })
  await new Promise<void>(r => server.listen(0, '0.0.0.0', r))
  const base = `http://host.docker.internal:${(server.address() as AddressInfo).port}`
  const ids: string[] = []
  const make = async (kind: string, config: unknown, extra: Record<string, unknown> = {}) => {
    const r = await api<{ id: string }>(request, 'post', '/api/admin/notifications/channels', { kind, config, name: `E2E ${kind} ${stamp}`, events: ['user.invited'], ...extra })
    ids.push(r.id)
    return r.id
  }
  try {
    // Messages de test : forme propre à chaque service.
    const slack = await make('slack_webhook', { url: `${base}/services/T/B/${stamp}` })
    const discord = await make('discord_webhook', { url: `${base}/api/webhooks/1/${stamp}` })
    const ntfy = await make('ntfy', { server: base, topic: 'ops', token: 'tk_e2e' })
    const gotify = await make('gotify', { url: base, token: 'gt_e2e' })
    for (const id of [slack, discord, ntfy, gotify]) await api(request, 'post', `/api/admin/notifications/channels/${id}/test`)
    const byUrl = (u: string) => seen.find(s => s.url.startsWith(u))!
    expect(byUrl('/services/T/B/').body).toMatchObject({ blocks: expect.any(Array) })
    expect((byUrl('/api/webhooks/1/').body.embeds as unknown[])).toHaveLength(1)
    expect(seen.find(s => s.url === '/' && s.headers.authorization === 'Bearer tk_e2e')!.body).toMatchObject({ topic: 'ops' })
    expect(byUrl('/message').headers['x-gotify-key']).toBe('gt_e2e')

    // Secrets jamais renvoyés par l'API.
    const listed = JSON.stringify(await (await request.get('/api/admin/notifications/channels')).json())
    expect(listed).not.toContain('tk_e2e')
    expect(listed).not.toContain('gt_e2e')

    // Hôte non autorisé et configuration invalide refusés avec un message par champ.
    const bad = await request.post('/api/admin/notifications/channels', { data: { kind: 'ntfy', config: { server: 'https://evil.example.org', topic: 'x' }, name: `E2E mauvais ${stamp}`, events: ['user.invited'] }, headers: { 'x-csrf-token': ((await (await request.get('/api/auth/me')).json()) as { csrfToken: string }).csrfToken } })
    expect(bad.status()).toBe(422)
    expect(await bad.text()).toContain('config.server')

    // Résumé : l'évènement n'est pas envoyé un par un ; le résumé part à la demande.
    const digest = await make('slack_webhook', { url: `${base}/services/DIGEST/${stamp}` }, { digest: 'daily', digestHour: 8 })
    seen.length = 0
    const inviteEmail = `digest-${stamp}@e2e.test`
    const user = await api<{ id: string }>(request, 'post', '/api/admin/users', { email: inviteEmail, displayName: `Digest ${stamp}`, kind: 'local' })
    await expect.poll(() => seen.length, { timeout: 30_000 }).toBeGreaterThan(0)
    await new Promise(r => setTimeout(r, 3000))
    expect(seen.some(s => s.url.startsWith('/services/DIGEST/'))).toBe(false)
    const r = await api<{ events: number }>(request, 'post', `/api/admin/notifications/channels/${digest}/digest`)
    expect(r.events).toBeGreaterThanOrEqual(1)
    await expect.poll(() => seen.some(s => s.url.startsWith('/services/DIGEST/')), { timeout: 30_000 }).toBe(true)
    const msg = JSON.stringify(seen.find(s => s.url.startsWith('/services/DIGEST/'))!.body)
    expect(msg).toContain('Résumé quotidien')
    // Rien de nouveau : plus rien à résumer.
    expect((await api<{ events: number }>(request, 'post', `/api/admin/notifications/channels/${digest}/digest`)).events).toBe(0)
    // Un canal immédiat refuse le résumé à la demande.
    const refused = await request.post(`/api/admin/notifications/channels/${slack}/digest`, { headers: { 'x-csrf-token': ((await (await request.get('/api/auth/me')).json()) as { csrfToken: string }).csrfToken } })
    expect(refused.status()).toBe(409)

    // Interface : types proposés et mode résumé visible dans la liste.
    await page.goto('/admin/notifications')
    await expect(page.getByText(`E2E slack_webhook ${stamp}`).first()).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText('résumé quotidien à 08:00').first()).toBeVisible()
    await page.getByRole('button', { name: 'Ajouter un canal' }).click()
    const kinds = await page.getByLabel('Type').locator('option').allTextContents()
    expect(kinds.join('|')).toMatch(/Slack.*Discord.*ntfy.*Gotify/)
    await page.keyboard.press('Escape')
    void user
  }
  finally {
    for (const id of ids) await api(request as APIRequestContext, 'delete', `/api/admin/notifications/channels/${id}`).catch(() => undefined)
    server.close()
  }
})
