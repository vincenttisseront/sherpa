import { afterEach, describe, expect, it } from 'vitest'
import { renderEmail } from '../../server/adapters/notifications/email'
import { adaptiveCard, checkWebhookUrl, hostAllowed } from '../../server/adapters/notifications/teams-webhook'
import { resetEnvCache } from '../../server/utils/env'
import { csvCell, periodRange, toCsv } from '../../server/utils/table'

const msg = { event: 'deployment.failed' as const, title: 'Échec <b>shop</b>', summary: 'Ligne 1\nLigne 2', severity: 'error' as const, facts: [{ label: 'Projet', value: 'shop & co' }], link: 'https://plateforme/deployments/1' }

describe('export CSV', () => {
  it('protège contre l\'injection de formules', () => {
    for (const v of ['=HYPERLINK("x")', '+1', '-2+3', '@SUM(A1)']) expect(csvCell(v).replace(/^"|"$/g, '').startsWith('\'')).toBe(true)
    expect(csvCell(-5)).toBe('-5')
  })
  it('échappe guillemets, séparateurs et retours à la ligne', () => {
    expect(csvCell('a;b')).toBe('"a;b"')
    expect(csvCell('dit "oui"')).toBe('"dit ""oui"""')
    expect(csvCell('l1\nl2')).toBe('"l1\nl2"')
    expect(csvCell(null)).toBe('')
    expect(csvCell(['a', 'b'])).toBe('a, b')
  })
  it('formate les dates en heure de Paris', () => {
    expect(csvCell('2026-01-15T12:00:00.000Z')).toBe('2026-01-15 13:00:00')
  })
  it('produit un fichier lisible par Excel (BOM, « ; », CRLF)', () => {
    const csv = toCsv([{ a: 1, b: 'x' }], [{ key: 'a', label: 'A', value: r => r.a }, { key: 'b', label: 'B', value: r => r.b }])
    expect(csv).toBe('﻿A;B\r\n1;x\r\n')
  })
  it('période relative ou absolue', () => {
    const r = periodRange({ period: '24h' })
    expect(Date.now() - r.from!.getTime()).toBeGreaterThan(86_000_000)
    expect(r.to).toBeUndefined()
    expect(periodRange({ from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z' }).to?.toISOString()).toBe('2026-02-01T00:00:00.000Z')
  })
})

describe('webhook Teams', () => {
  const savedDatabaseUrl = process.env.DATABASE_URL
  afterEach(() => {
    delete process.env.NOTIFY_WEBHOOK_ALLOWED_HOSTS
    process.env.NODE_ENV = 'test'
    if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = savedDatabaseUrl
    resetEnvCache()
  })
  it('n\'accepte que les hôtes autorisés (motifs *.domaine)', () => {
    const allowed = ['*.webhook.office.com', 'hooks.interne.fr']
    expect(hostAllowed('acme.webhook.office.com', allowed)).toBe(true)
    expect(hostAllowed('webhook.office.com.evil.com', allowed)).toBe(false)
    expect(hostAllowed('evilwebhook.office.com', allowed)).toBe(false)
    expect(hostAllowed('hooks.interne.fr', allowed)).toBe(true)
    expect(hostAllowed('x.hooks.interne.fr', allowed)).toBe(false)
  })
  it('refuse HTTP en production, les identifiants dans l\'URL et les hôtes inconnus', () => {
    process.env.NODE_ENV = 'production'
    process.env.DATABASE_URL = 'postgres://platform@db.example.test:5432/platform'
    process.env.NOTIFY_WEBHOOK_ALLOWED_HOSTS = '*.logic.azure.com'
    resetEnvCache()
    expect(checkWebhookUrl('https://prod-1.westeurope.logic.azure.com/workflows/x')).toBeNull()
    expect(checkWebhookUrl('http://prod-1.westeurope.logic.azure.com/x')).toMatch(/HTTPS/)
    expect(checkWebhookUrl('https://u:p@prod-1.westeurope.logic.azure.com/x')).toMatch(/Identifiants/)
    expect(checkWebhookUrl('https://169.254.169.254/latest')).toMatch(/non autorisé/)
  })
  it('carte adaptative : titre coloré, faits, lien', () => {
    const c = adaptiveCard(msg)
    const content = c.attachments[0]!.content
    expect(content.body[0]).toMatchObject({ text: msg.title, color: 'attention' })
    expect(content.body[2]).toMatchObject({ type: 'FactSet', facts: [{ title: 'Projet', value: 'shop & co' }] })
    expect(content.actions[0]).toMatchObject({ type: 'Action.OpenUrl', url: msg.link })
  })
})

describe('email', () => {
  it('échappe le HTML et garde une version texte', () => {
    const m = renderEmail(msg)
    expect(m.subject).toBe('[Plateforme] Échec <b>shop</b>')
    expect(m.html).toContain('Échec &lt;b&gt;shop&lt;/b&gt;')
    expect(m.html).toContain('shop &amp; co')
    expect(m.text).toContain('Projet : shop & co')
    expect(m.text).toContain(msg.link)
  })
})
