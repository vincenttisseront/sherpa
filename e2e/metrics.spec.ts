/**
 * Historique des ressources : relevés par minute des conteneurs déployés par la plateforme, courbes dans le détail d'un
 * conteneur, règles d'alerte (seuil volontairement très bas sur la mémoire de Traefik), alerte en cours, notification
 * émise, puis retour à la normale quand la règle est retirée.
 */
import { execFileSync } from 'node:child_process'
import type { APIRequestContext } from '@playwright/test'
import { expect, test } from './fixtures'
import { api } from './helpers/accounts'

interface Live { endpointId: string, serverName: string, containers: { id: string, name: string, state: string, managed: boolean }[] }
interface Overview { rules: unknown[], active: { container: string, rule: string, resolvedAt: string | null }[], samples: { containers: number } }

const overview = async (request: APIRequestContext) => (await (await request.get('/api/admin/metric-alerts')).json()) as Overview

test('historique : relevés, courbes, alerte de ressources et retour à la normale', async ({ page, request }) => {
  test.setTimeout(600_000)
  const live = await (await request.get('/api/live')).json() as Live[]
  const ep = live.find(e => e.containers.some(c => c.managed && c.state === 'running' && /traefik/.test(c.name)))
  test.skip(!ep, 'aucun Traefik géré en marche')
  const tracked = ep!.containers.find(c => c.managed && c.state === 'running' && /traefik/.test(c.name))!
  const original = (await overview(request)).rules

  try {
    // Le worker relève chaque minute : au moins un conteneur suivi dans les trois minutes.
    await expect.poll(async () => (await overview(request)).samples.containers, { timeout: 180_000, intervals: [5_000] }).toBeGreaterThan(0)
    const m = await expect.poll(async () => {
      const r = await (await request.get(`/api/endpoints/${ep!.endpointId}/containers/${tracked.id}/metrics?range=1h`)).json() as { tracked: boolean, points: { t: string, memory: number | null }[] }
      return r.tracked ? r : null
    }, { timeout: 120_000, intervals: [5_000] }).not.toBeNull()
    void m

    // Courbes : onglet Historique du détail du conteneur.
    await page.goto('/containers')
    await page.getByLabel('Rechercher un conteneur').fill(tracked.name)
    await page.locator('.rows .row').first().click()
    const drawer = page.getByRole('dialog')
    await drawer.getByRole('tab', { name: 'Historique' }).click({ timeout: 30_000 })
    await expect(drawer.getByRole('img', { name: /^CPU : actuel/ })).toBeVisible({ timeout: 30_000 })
    await expect(drawer.getByRole('img', { name: /^Mémoire : actuel/ })).toBeVisible()
    await drawer.getByRole('button', { name: '6 h' }).click()
    await expect(drawer.getByRole('img', { name: /^CPU : actuel/ })).toBeVisible()
    await page.keyboard.press('Escape')

    // Règle très basse sur la mémoire (en pourcentage de la limite ou de l'hôte) : l'alerte se déclenche en quelques minutes.
    await api(request, 'put', '/api/admin/metric-alerts', { rules: [{ id: 'e2e-mem', name: 'E2E mémoire', metric: 'memory', threshold: 0.01, minutes: 2, enabled: true }] })
    await expect.poll(async () => (await overview(request)).active.some(a => a.rule === 'E2E mémoire' && a.container === tracked.name), { timeout: 240_000, intervals: [5_000] }).toBe(true)
    const detail = await (await request.get(`/api/endpoints/${ep!.endpointId}/containers/${tracked.id}/metrics`)).json() as { alerts: { rule: string }[] }
    expect(detail.alerts.some(a => a.rule === 'E2E mémoire')).toBe(true)

    // Interface d'administration : alerte visible dans la page Notifications.
    await page.goto('/admin/notifications')
    await expect(page.getByTestId('active-alerts')).toContainText(tracked.name, { timeout: 30_000 })

    // Notification émise au franchissement du seuil.
    try {
      const n = execFileSync('docker', ['exec', 'sherpa-dev-postgres-1', 'psql', '-U', 'platform', '-d', 'platform', '-tAc', `select count(*) from notification_events where event = 'resource.alert' and title like '%E2E mémoire%'`], { encoding: 'utf8' }).trim()
      expect(Number(n)).toBeGreaterThan(0)
    }
    catch (err) {
      if ((err as { status?: number }).status === undefined) throw err
    }
  }
  finally {
    // Règles d'origine rétablies : l'alerte de l'essai est close au relevé suivant.
    await api(request, 'put', '/api/admin/metric-alerts', { rules: original }).catch(() => undefined)
  }
  await expect.poll(async () => (await overview(request)).active.some(a => a.rule === 'E2E mémoire'), { timeout: 150_000, intervals: [5_000] }).toBe(false)
})
