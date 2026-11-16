/**
 * Porte de déploiement : validation par une autre personne (pas de validation de sa propre demande), planification,
 * fenêtres de déploiement (refus hors fenêtre, planification dans une fenêtre, demande urgente validée) et annulation.
 * Aucun déploiement réel : les demandes sont refusées ou annulées avant exécution.
 */
import type { APIRequestContext } from '@playwright/test'
import { expect, test } from './fixtures'
import { api, csrf, freshContext, makeUser, resetRateLimits, uiLogin } from './helpers/accounts'

test.beforeEach(() => resetRateLimits())

const COMPOSE = 'services:\n  w:\n    image: busybox:1.37\n    command: ["sleep", "300"]\n'

interface Detail { status: string, error: string | null, gate: { approval: { state: string, reason: string } | null, scheduledFor: string | null } }
const detail = async (r: APIRequestContext, id: string) => (await (await r.get(`/api/deployments/${id}`)).json()) as Detail

async function post(r: APIRequestContext, url: string, data: unknown) {
  return r.post(url, { data, headers: { 'x-csrf-token': await csrf(r), 'idempotency-key': crypto.randomUUID() } })
}

test('porte de déploiement : validation, planification, fenêtres, urgence', async ({ browser, page, request }) => {
  test.setTimeout(240_000)
  const stamp = Date.now().toString(36)
  const opts = await (await request.get('/api/deploy-options')).json() as { endpointId: string, environments: { key: string }[] }[]
  const o = opts.find(x => x.environments.some(e => e.key === 'staging'))!
  const p = await api<{ id: string }>(request, 'post', '/api/projects', { slug: `gate-${stamp}`, name: `Porte ${stamp}`, target: { endpointId: o.endpointId, environmentKey: 'staging' } })
  const targetId = ((await (await request.get(`/api/projects/${p.id}`)).json()) as { targets: { id: string }[] }).targets[0]!.id
  const policies = (await (await request.get('/api/admin/deploy-policies')).json() as { policies: { environmentId: string, environment: string, requireApproval: boolean, timezone: string, windows: unknown[] }[] }).policies
  const staging = policies.find(x => x.environment.toLowerCase() === 'staging')!
  const original = { environmentId: staging.environmentId, requireApproval: staging.requireApproval, timezone: staging.timezone, windows: staging.windows }
  const setPolicy = (patch: Record<string, unknown>) => api(request, 'put', '/api/admin/deploy-policies', { ...original, requireApproval: false, windows: [], ...patch })

  const requester = await makeUser(request, 'gate', true)
  const ctx = await freshContext(browser)
  const rp = await ctx.newPage()
  try {
    await uiLogin(rp, requester.email)
    await rp.waitForURL(u => !u.pathname.startsWith('/login'))
    const rq = ctx.request
    const upload = async () => (await api<{ id: string }>(request, 'post', '/api/uploads/compose', { content: COMPOSE, name: `gate-${stamp}` })).id
    const deploy = async (schedule?: unknown) => post(rq, `/api/targets/${targetId}/deployments`, { uploadId: await upload(), composePath: 'compose.yml', portApprovals: [], schedule })
    const decide = (id: string, who: APIRequestContext, decision: string) => post(who, `/api/deployments/${id}/decision`, { decision, comment: 'essai e2e' })

    // 1. Validation exigée : en attente, jamais validée par son demandeur ; refus par une autre personne.
    await setPolicy({ requireApproval: true })
    const a = await deploy()
    expect(a.status(), await a.text()).toBe(202)
    const aId = ((await a.json()) as { deploymentId: string }).deploymentId
    expect(await detail(request, aId)).toMatchObject({ status: 'QUEUED', gate: { approval: { state: 'pending', reason: 'policy' } } })
    const self = await decide(aId, rq, 'approve')
    expect(self.status()).toBe(409)
    expect(await self.text()).toContain('autre personne')
    // Une cible dont une demande attend n'accepte pas une seconde opération.
    expect((await deploy()).status()).toBe(409)
    // Interface : bandeau de décision pour la personne qui valide.
    await page.goto(`/deployments/${aId}`)
    await expect(page.getByTestId('gate')).toContainText('Validation requise', { timeout: 30_000 })
    await page.getByTestId('reject').click()
    await expect(page.getByTestId('gate')).toContainText('Refusé par', { timeout: 30_000 })
    expect(await detail(request, aId)).toMatchObject({ status: 'CANCELLED', gate: { approval: { state: 'rejected' } } })
    expect((await detail(request, aId)).error).toContain('Refusé par')

    // 2. Planification avec validation : validée, elle reste planifiée (job différé) puis s'annule sans s'exécuter.
    const when = new Date(Date.now() + 3 * 3600_000).toISOString()
    const b = await deploy({ at: when })
    const bId = ((await b.json()) as { deploymentId: string }).deploymentId
    expect(await detail(request, bId)).toMatchObject({ status: 'QUEUED', gate: { approval: { state: 'pending' }, scheduledFor: when } })
    expect((await decide(bId, request, 'approve')).status()).toBe(200)
    expect(await detail(request, bId)).toMatchObject({ status: 'QUEUED', gate: { approval: { state: 'approved' }, scheduledFor: when } })
    expect((await decide(bId, rq, 'cancel')).status()).toBe(200)
    expect(await detail(request, bId)).toMatchObject({ status: 'CANCELLED' })

    // 3. Planification simple sans validation, date passée refusée.
    await setPolicy({})
    const c = await deploy({ at: when })
    const cId = ((await c.json()) as { deploymentId: string }).deploymentId
    expect(await detail(request, cId)).toMatchObject({ status: 'QUEUED', gate: { approval: null, scheduledFor: when } })
    expect((await decide(cId, rq, 'cancel')).status()).toBe(200)
    expect((await deploy({ at: new Date(Date.now() - 3600_000).toISOString() })).status()).toBe(422)

    // 4. Fenêtre fermée : refus, planification dans la fenêtre, demande urgente soumise à validation.
    const otherDay = ((new Date().getUTCDay() + 3) % 7) || 7 // 1 = lundi … 7 = dimanche, loin d'aujourd'hui
    await setPolicy({ timezone: 'UTC', windows: [{ days: [otherDay], from: '10:00', to: '12:00' }] })
    const refused = await deploy()
    expect(refused.status()).toBe(409)
    expect(await refused.text()).toContain('Hors des fenêtres')
    const inWindow = new Date(Date.now() + 86_400_000 * ([1, 2, 3, 4, 5, 6, 7].find(n => ((new Date(Date.now() + n * 86_400_000).getUTCDay()) || 7) === otherDay)!))
    inWindow.setUTCHours(10, 30, 0, 0)
    const d = await deploy({ at: inWindow.toISOString() })
    expect(d.status(), await d.text()).toBe(202)
    const dId = ((await d.json()) as { deploymentId: string }).deploymentId
    expect(await detail(request, dId)).toMatchObject({ status: 'QUEUED', gate: { scheduledFor: inWindow.toISOString() } })
    expect((await decide(dId, rq, 'cancel')).status()).toBe(200)
    const outside = new Date(inWindow.getTime() + 3 * 3600_000)
    expect((await deploy({ at: outside.toISOString() })).status()).toBe(422)
    const e = await deploy({ urgent: true })
    expect(e.status()).toBe(202)
    const eId = ((await e.json()) as { deploymentId: string }).deploymentId
    expect(await detail(request, eId)).toMatchObject({ status: 'QUEUED', gate: { approval: { state: 'pending', reason: 'urgent' } } })
    expect((await decide(eId, request, 'reject')).status()).toBe(200)

    // L'arrêt et le redémarrage ne sont jamais soumis à la porte.
    const gate = await (await request.get(`/api/targets/${targetId}/gate`)).json() as { open: boolean, windows: unknown[] }
    expect(gate.open).toBe(false)
    expect(gate.windows).toHaveLength(1)
  }
  finally {
    await api(request, 'put', '/api/admin/deploy-policies', original).catch(() => undefined)
    await ctx.close()
    await api(request, 'patch', `/api/admin/users/${requester.id}`, { status: 'suspended' }).catch(() => undefined)
  }
})
