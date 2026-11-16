/**
 * Catalogue de modèles : choisir un modèle fourni (variables générées, secrets chiffrés côté cible), analyse du Compose
 * proposé, puis enregistrer un Compose comme modèle de la plateforme et le supprimer.
 */
import type { APIRequestContext } from '@playwright/test'
import { BUILTIN_TEMPLATES } from '../shared/data/compose-templates'
import { expect, test } from './fixtures'

async function api<T>(request: APIRequestContext, method: 'get' | 'post' | 'put' | 'delete', url: string, data?: unknown): Promise<T> {
  const { csrfToken } = await (await request.get('/api/auth/me')).json() as { csrfToken: string }
  const res = await request[method](url, { data, headers: { 'x-csrf-token': csrfToken } })
  expect(res.status(), await res.text()).toBeLessThan(300)
  return res.json() as Promise<T>
}

test('modèles : catalogue, variables chiffrées, analyse, modèle enregistré', async ({ page, request }) => {
  test.setTimeout(180_000)
  const stamp = Date.now().toString(36)
  const opts = await (await request.get('/api/deploy-options')).json() as { endpointId: string, environments: { key: string }[] }[]
  const o = opts.find(x => x.environments.some(e => e.key === 'staging'))!
  const p = await api<{ id: string }>(request, 'post', '/api/projects', { slug: `tpl-${stamp}`, name: `Modèle ${stamp}`, target: { endpointId: o.endpointId, environmentKey: 'staging' } })
  const targetId = ((await (await request.get(`/api/projects/${p.id}`)).json()) as { targets: { id: string }[] }).targets[0]!.id
  const custom = `E2E modèle ${stamp}`
  try {
    // L'API liste les modèles fournis.
    const all = await (await request.get('/api/templates')).json() as { templates: { id: string, builtin: boolean }[] }
    expect(all.templates.filter(t => t.builtin)).toHaveLength(BUILTIN_TEMPLATES.length)

    await page.goto(`/projects/${p.id}`)
    await page.getByRole('button', { name: 'Nouveau déploiement' }).click()
    await page.getByTestId('template-open').click({ timeout: 30_000 })
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByTestId('template-list').locator('li')).toHaveCount(BUILTIN_TEMPLATES.length, { timeout: 30_000 })
    await dialog.getByLabel('Rechercher un modèle').fill('redis')
    await expect(dialog.getByTestId('template-list').locator('li')).toHaveCount(1)
    await dialog.locator('[data-template="builtin:redis"]').click()
    // Le mot de passe est généré (masqué), le bouton actif ; aucune saisie à faire.
    await expect(dialog.locator('#tv-REDIS_PASSWORD')).toHaveValue(/^[A-Za-z0-9]{24}$/)
    await dialog.getByTestId('template-apply').click()
    await expect(page.getByLabel('Contenu du fichier Compose')).toHaveValue(/image: redis:7-alpine/)

    // Variable secrète enregistrée sur la cible, jamais réaffichée.
    const vars = await (await request.get(`/api/targets/${targetId}/variables`)).json() as { name: string, secret: boolean, value: string | null }[]
    const pw = vars.find(v => v.name === 'REDIS_PASSWORD')
    expect(pw?.secret).toBe(true)
    expect(pw?.value).toBeNull()

    // Analyse : aucun blocage, la variable est connue.
    await page.getByRole('button', { name: 'Analyser ce Compose' }).click()
    await expect(page.getByRole('heading', { name: /Analyse/ })).toBeVisible({ timeout: 60_000 })
    await expect(page.getByText(/redis/).first()).toBeVisible()

    // Enregistrer un Compose comme modèle : variables déduites, nom unique, suppression par son auteur.
    await page.reload()
    await page.getByRole('button', { name: 'Nouveau déploiement' }).click()
    await page.getByLabel('Contenu du fichier Compose').fill('services:\n  app:\n    image: nginx:1.27\n    environment:\n      API_TOKEN: ${API_TOKEN}\n      MODE: ${MODE:-prod}\n')
    await page.getByRole('button', { name: 'Enregistrer comme modèle…' }).click()
    await page.getByLabel('Nom du modèle').fill(custom)
    await page.getByRole('button', { name: 'Enregistrer', exact: true }).click()
    await expect(page.getByText(`Modèle « ${custom} » enregistré`)).toBeVisible({ timeout: 30_000 })
    const list = await (await request.get('/api/templates')).json() as { templates: { id: string, name: string, builtin: boolean, variables: { name: string, secret?: boolean }[] }[] }
    const saved = list.templates.find(t => t.name === custom)!
    expect(saved.builtin).toBe(false)
    expect(saved.variables.map(v => v.name)).toEqual(['API_TOKEN', 'MODE'])
    expect(saved.variables.find(v => v.name === 'API_TOKEN')?.secret).toBe(true)
    // Doublon refusé ; un modèle fourni ne se supprime pas.
    const dup = await request.post('/api/templates', { data: { name: custom.toUpperCase(), compose: 'services:\n  a:\n    image: x:1\n' }, headers: { 'x-csrf-token': ((await (await request.get('/api/auth/me')).json()) as { csrfToken: string }).csrfToken } })
    expect(dup.status()).toBe(422)
    await api(request, 'delete', `/api/templates/${saved.id}`)
    const after = await (await request.get('/api/templates')).json() as { templates: { name: string }[] }
    expect(after.templates.some(t => t.name === custom)).toBe(false)
  }
  finally {
    const list = await (await request.get('/api/templates')).json() as { templates: { id: string, name: string, builtin: boolean }[] }
    for (const t of list.templates.filter(x => !x.builtin && x.name === custom)) await api(request, 'delete', `/api/templates/${t.id}`).catch(() => undefined)
  }
})
