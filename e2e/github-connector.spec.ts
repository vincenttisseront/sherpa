/**
 * Connecteur GitHub (faux GitHub de la stack de dev) : ajout depuis l'administration, relevé des
 * packages et des artefacts Actions, alertes d'artefacts expirés ou bientôt expirés.
 */
import type { Server } from 'node:http'
import { createMockGithub } from '../scripts/mock-github'
import { expect, test } from './fixtures'

const day = 864e5
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * day).toISOString()
let server: Server

test.skip(!!process.env.E2E_BASE_URL && !process.env.E2E_GITHUB_MOCK, 'Faux GitHub joignable uniquement depuis la stack de développement')

test.beforeAll(async () => {
  server = createMockGithub({
    'acme/app': {
      files: { 'compose.yml': 'services: {}\n' },
      artifacts: [
        { id: 1, name: 'bundle', sizeBytes: 2048, expired: false, createdAt: iso(-87), expiresAt: iso(3) },
        { id: 2, name: 'report', sizeBytes: 512, expired: true, createdAt: iso(-120), expiresAt: iso(-30) },
        { id: 3, name: 'docs', sizeBytes: 4096, expired: false, createdAt: iso(-1), expiresAt: iso(89) },
      ],
    },
  }, {
    owners: { acme: { type: 'Organization', packages: [
      { name: 'app', type: 'container', repository: 'acme/app', versions: [{ id: 11, name: 'sha256:aaa', tags: ['1.3.0', 'latest'], createdAt: iso(-2) }, { id: 10, name: 'sha256:bbb', tags: ['1.2.0'], createdAt: iso(-20) }] },
      { name: 'lib', type: 'npm', repository: 'acme/app', versions: [{ id: 20, name: '0.4.1', createdAt: iso(-5) }] },
    ] } },
  })
  await new Promise<void>(r => server.listen(18300, '0.0.0.0', r))
})
test.afterAll(() => server?.close())

test('connecteur GitHub : packages, artefacts et alertes d\'expiration', async ({ page, request }) => {
  test.setTimeout(300_000)
  const name = `e2e-gh-${Date.now().toString(36)}`
  await page.goto('/admin/github')
  await page.getByRole('button', { name: 'Ajouter un connecteur' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Nom').fill(name)
  await dialog.getByLabel('Organisation ou utilisateur').fill('acme')
  await dialog.getByLabel('API GitHub').fill('http://host.docker.internal:18300')
  await dialog.getByLabel('Jeton').fill('ghp_jeton_de_test_e2e_0123456789')
  await dialog.getByRole('button', { name: 'Vérifier et ajouter' }).click()
  await expect(dialog).toBeHidden({ timeout: 60_000 })
  try {
    await expect(page.getByText('Artefact bientôt expiré')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText('acme/app · bundle')).toBeVisible()
    await expect(page.getByText('Artefact expiré', { exact: true })).toBeVisible()
    await expect(page.getByText('acme/app · report')).toBeVisible()
    await page.getByRole('tab', { name: /Packages/ }).click()
    await expect(page.getByRole('link', { name: 'app', exact: true })).toBeVisible()
    await expect(page.getByRole('cell', { name: /1\.3\.0, latest/ })).toBeVisible()
    await page.getByRole('tab', { name: /Artefacts/ }).click()
    await expect(page.getByRole('cell', { name: 'docs' })).toBeVisible()
    // Le jeton n'est jamais renvoyé.
    const list = await (await request.get('/api/admin/github-connectors')).text()
    expect(list).toContain(name)
    expect(list).not.toContain('ghp_jeton_de_test_e2e')
  }
  finally {
    const c = ((await (await request.get('/api/admin/github-connectors')).json()) as { id: string, name: string }[]).find(x => x.name === name)
    if (c) {
      const { csrfToken } = await (await request.get('/api/auth/me')).json() as { csrfToken: string }
      await request.delete(`/api/admin/github-connectors/${c.id}`, { headers: { 'x-csrf-token': csrfToken } })
    }
  }
})
