/**
 * Analyse de vulnérabilités (Trivy) sur l'infrastructure de dev (agent-local) : image d'un projet
 * déployé analysée à la demande, résultats dans l'onglet du projet et la page Vulnérabilités,
 * réglages de la planification.
 */
import type { APIRequestContext } from '@playwright/test'
import { expect, test } from './fixtures'

async function api<T>(request: APIRequestContext, method: 'get' | 'post' | 'put', url: string, data?: unknown): Promise<T> {
  const { csrfToken } = await (await request.get('/api/auth/me')).json() as { csrfToken: string }
  const res = await request[method](url, { data, headers: { 'x-csrf-token': csrfToken } })
  expect(res.status(), await res.text()).toBeLessThan(300)
  return res.json() as Promise<T>
}

test('Trivy : analyse des images d\'un projet, résultats et réglages', async ({ page, request }) => {
  test.setTimeout(900_000)
  const servers = await (await request.get('/api/servers?pageSize=100')).json() as { items: { id: string, name: string }[] }
  const server = servers.items.find(s => s.name === 'agent-local')
  test.skip(!server, 'serveur agent-local absent')
  const detail = await (await request.get(`/api/servers/${server!.id}`)).json() as { endpoints: { id: string, enabled: boolean, environments: { key: string }[] }[] }
  const ep = detail.endpoints.find(e => e.enabled && e.environments.length)!
  const slug = `trivy-${Date.now().toString(36)}`
  const { id } = await api<{ id: string }>(request, 'post', '/api/projects', { slug, name: `Trivy ${slug}`, target: { endpointId: ep.id, environmentKey: ep.environments[0]!.key } })
  const previous = await api<{ settings: Record<string, unknown> }>(request, 'get', '/api/admin/trivy')
  try {
    await page.goto(`/projects/${id}`)
    await expect(async () => {
      await page.getByRole('button', { name: 'Nouveau déploiement' }).click({ timeout: 5000 })
      await expect(page.getByRole('textbox', { name: 'Contenu du fichier Compose' })).toBeVisible({ timeout: 3000 })
    }).toPass({ timeout: 30_000 })
    await page.getByRole('textbox', { name: 'Contenu du fichier Compose' }).fill('services:\n  web:\n    image: python:3.12-slim\n    command: ["python", "-m", "http.server", "8000"]\n')
    await page.getByRole('button', { name: 'Analyser ce Compose' }).click({ timeout: 10_000 })
    await page.getByRole('button', { name: 'Déployer', exact: true }).click({ timeout: 60_000 })
    await page.getByRole('dialog').getByRole('button', { name: 'Déployer' }).click({ timeout: 10_000 })
    await expect(page.getByRole('log')).toContainText(/Statut : (HEALTHY|FAILED|DEGRADED)/, { timeout: 300_000 })
    await expect(page.getByRole('log')).toContainText('Statut : HEALTHY')
    // Sans blocage (réglage par défaut) : l'analyse suit le déploiement, qui ne l'attend pas.
    await expect(page.getByRole('log')).toContainText('Analyses Trivy après le déploiement (blocage désactivé) : 1 image(s) et le code source')
    await expect(page.getByRole('log')).not.toContainText('Analyse Trivy de 1 image(s) des registres')
    const targetId = ((await (await request.get(`/api/projects/${id}`)).json()) as { targets: { id: string }[] }).targets[0]!.id

    // Analyse du déploiement rattachée à lui, sans relancer d'analyse.
    const atDeploy = async () => (await api<{ images: { image: string, trigger: string | null, deploymentId: string | null, status: string }[] }>(request, 'get', `/api/targets/${targetId}/vulnerabilities`)).images.find(i => i.image === 'python:3.12-slim')
    await expect.poll(async () => (await atDeploy())?.trigger, { timeout: 300_000, intervals: [3000] }).toBe('deploy')
    expect(await atDeploy()).toMatchObject({ status: 'ok', deploymentId: expect.any(String) })
    await page.goto('/vulnerabilities')
    await expect(page.getByRole('row', { name: new RegExp(`python:3\\.12-slim.*Trivy ${slug}`) })).toBeVisible({ timeout: 30_000 })

        // Analyse d'une seule image depuis sa ligne.
    const imgRow = page.getByRole('row', { name: new RegExp(`python:3\\.12-slim.*Trivy ${slug}`) })
    await expect(imgRow).toContainText(/[0-9a-f]{12}/)
    await imgRow.getByRole('button', { name: 'Analyser python:3.12-slim' }).click({ timeout: 30_000 })
    await expect(imgRow.getByRole('status')).toContainText(/en file d'attente|analyse en cours/, { timeout: 15_000 })
    await expect.poll(async () => (await api<{ images: { image: string, trigger: string | null }[] }>(request, 'get', `/api/targets/${targetId}/vulnerabilities`)).images.find(i => i.image === 'python:3.12-slim')?.trigger, { timeout: 300_000, intervals: [3000] }).toBe('manual')

    // Carte Trivy de « Mises à jour d'images » : version en service, mise à jour si plus récente.
    await page.goto('/images')
    const engine = await api<{ image: string, latest: string | null, updateAvailable: boolean }>(request, 'get', '/api/trivy/engine')
    await expect(page.getByText(`En service : ${engine.image}`)).toBeVisible({ timeout: 30_000 })
    if (engine.updateAvailable) {
      await page.getByRole('button', { name: `Mettre à jour vers ${engine.latest}` }).click({ timeout: 30_000 })
      await page.getByRole('dialog').getByRole('button', { name: 'Mettre à jour' }).click({ timeout: 30_000 })
      await expect.poll(async () => (await api<{ settings: { image: string } }>(request, 'get', '/api/admin/trivy')).settings.image, { timeout: 30_000 }).toBe(`aquasec/trivy:${engine.latest}`)
      await api(request, 'put', '/api/admin/trivy', previous.settings)
    }

        // Blocage : vulnérabilités hautes refusées → le redéploiement s'arrête avant le déploiement.
    await api(request, 'put', '/api/admin/trivy', { ...previous.settings, registryScan: true, buildBlock: 'HIGH', buildBlockFixableOnly: false })
    const blocked = await api<{ deploymentId: string }>(request, 'post', `/api/targets/${targetId}/actions`, { action: 'redeploy' })
    const dep = async () => (await api<{ status: string, error: string | null }>(request, 'get', `/api/deployments/${blocked.deploymentId}`))
    await expect.poll(async () => (await dep()).status, { timeout: 300_000 }).toMatch(/FAILED|HEALTHY|DEGRADED|ROLLED_BACK/)
    expect(await dep()).toMatchObject({ status: 'FAILED', error: expect.stringContaining('déploiement bloqué') })
    const log = await (await request.get(`/api/deployments/${blocked.deploymentId}/logs?format=text`)).text()
    expect(log).toContain('analyse du')
    expect(log).toContain('reprise')
    await api(request, 'put', '/api/admin/trivy', previous.settings)

    // Analyse des seules images de la cible.
    await api(request, 'post', '/api/vulnerabilities/scan', { targetId })
    type Scan = { image: string, status: string, error: string | null, os: string | null, counts: Record<string, number>, findings: { id: string }[], targets: { targetId: string }[] }
    const scans = async () => (await api<{ run: { running: boolean } | null, images: Scan[] }>(request, 'get', `/api/targets/${targetId}/vulnerabilities`))
    await expect.poll(async () => { const r = await scans(); return r.images.length && !r.run?.running }, { timeout: 600_000, intervals: [3000] }).toBeTruthy()
    const [scan] = (await scans()).images
    expect(scan, JSON.stringify(scan)).toMatchObject({ image: 'python:3.12-slim', status: 'ok', os: expect.stringContaining('debian'), targets: [{ targetId }] })
    expect(scan!.findings.length).toBe(Object.values(scan!.counts).reduce((a, b) => a + b, 0))

    await page.goto(`/projects/${id}?tab=vulnerabilities`)
    await page.getByRole('button', { name: /python:3\.12-slim/ }).click({ timeout: 30_000 })
    await expect(page.getByRole('columnheader', { name: 'Vulnérabilité' })).toBeVisible()
    await page.goto('/vulnerabilities')
    await page.getByRole('row', { name: new RegExp(`python:3\\.12-slim.*Trivy ${slug}`) }).click({ timeout: 30_000 })
    await expect(page.getByRole('dialog').getByText(`Trivy ${slug}`)).toBeVisible()
    await page.keyboard.press('Escape')

    // Regroupement par techno : une ligne python, ses versions en sous-lignes.
    await page.getByRole('radio', { name: 'Par techno' }).click()
    const versions = page.getByRole('button', { name: 'Versions de python', exact: true })
    await versions.click({ timeout: 30_000 })
    await expect(versions).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByRole('row', { name: new RegExp(`3\\.12-slim.*Trivy ${slug}`) })).toBeVisible()
    await page.getByRole('radio', { name: 'Liste' }).click()

    // Nettoyage : aperçu, puis images arrêtées et doublons ; l'image en service reste.
    await page.getByRole('button', { name: 'Nettoyer…' }).click()
    const clean = page.getByRole('dialog')
    await expect(clean.getByText(/À supprimer :/)).toBeVisible({ timeout: 60_000 })
    await expect(clean.getByLabel(/Images qui ne tournent plus/)).toBeChecked()
    await clean.getByLabel(/Tout effacer/).check()
    await expect(clean.getByLabel(/Analyses en échec/)).toBeDisabled()
    await clean.getByRole('button', { name: 'Annuler' }).click()
    const cleaned = await api<{ dryRun: boolean }>(request, 'post', '/api/vulnerabilities/cleanup', { stale: true, duplicates: true, dryRun: false })
    expect(cleaned.dryRun).toBe(false)
    expect((await scans()).images.map(i => i.image)).toContain('python:3.12-slim')

    // Réglages : chaque jour à 4 h.
    await page.getByRole('button', { name: 'Réglages' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Fréquence').selectOption('daily')
    await dialog.getByLabel('Heure').selectOption('4')
    await dialog.getByRole('button', { name: 'Enregistrer' }).click()
    await expect(page.getByText('chaque jour à 4:00')).toBeVisible({ timeout: 10_000 })
    expect((await api<{ settings: { cron: string } }>(request, 'get', '/api/admin/trivy')).settings.cron).toBe('0 4 * * *')
  }
  finally {
    await api(request, 'put', '/api/admin/trivy', previous.settings).catch(() => {})
    const t = ((await (await request.get(`/api/projects/${id}`)).json()) as { targets: { id: string, currentRelease: unknown }[] }).targets[0]
    if (t?.currentRelease) await api(request, 'post', `/api/projects/${id}/removal`, { mode: 'delete', confirm: slug }).catch(() => {})
  }
})
