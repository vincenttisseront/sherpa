/**
 * Reprise d'une stack existante, sur l'infrastructure de dev : plage de sous-réseaux configurée
 * (aperçu sans erreur technique), /etc/localtime accepté en lecture seule, chemin système retiré
 * de la reprise depuis l'assistant des points bloquants.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from './fixtures'

test('reprise : aperçu avec plage de sous-réseaux, fuseau horaire accepté, chemin système retiré depuis l\'assistant', async ({ page, request }) => {
  test.setTimeout(300_000)
  const { csrfToken } = await (await request.get('/api/auth/me')).json() as { csrfToken: string }
  const headers = { 'x-csrf-token': csrfToken }
  const servers = await (await request.get('/api/servers?pageSize=100')).json() as { items: { id: string, name: string }[] }
  const server = servers.items.find(s => s.name === 'agent-local')
  test.skip(!server, 'serveur agent-local absent')
  const detail = await (await request.get(`/api/servers/${server!.id}`)).json() as { endpoints: { id: string, enabled: boolean, environments: { key: string }[] }[] }
  const ep = detail.endpoints.find(e => e.enabled && e.environments.length)!
  const before = await (await request.get(`/api/endpoints/${ep.id}/network-pool`)).json() as { pool: unknown }
  expect((await request.put(`/api/endpoints/${ep.id}/network-pool`, { data: { pool: { base: '10.236.0.0/24', prefix: 27, avoid: [] } }, headers })).ok()).toBe(true)

  const project = `adopt${Date.now().toString(36)}`
  const dir = mkdtempSync(join(tmpdir(), 'adopt-'))
  writeFileSync(join(dir, 'compose.yml'), 'services:\n  app:\n    image: busybox:1.37\n    command: ["sleep", "3600"]\n    volumes:\n      - /etc/localtime:/etc/localtime\n      - /etc/hostname:/host-name:ro\n')
  const compose = (...args: string[]) => execFileSync('docker', ['compose', '-p', project, '-f', join(dir, 'compose.yml'), ...args], { encoding: 'utf8' })
  compose('up', '-d')
  try {
    const body = { stack: project, projectName: project, slug: project, environmentKey: ep.environments[0]!.key }
    const res = await request.post(`/api/endpoints/${ep.id}/adoption/preview`, { data: body, headers })
    expect(res.status(), await res.text()).toBe(200)
    const preview = await res.json() as { analysis: { issues: { severity: string, code: string, message: string }[], mounts: { target: string, accepted: boolean, reason: string }[] } }
    const errors = preview.analysis.issues.filter(i => i.severity === 'error')
    // Plus d'erreur technique (réservation d'un sous-réseau pour une cible pas encore créée).
    expect(errors.map(e => e.message).join('\n')).not.toMatch(/Failed query|network_allocations/)
    expect(errors.filter(e => e.code === 'networks.pool')).toEqual([])
    expect(preview.analysis.mounts.find(m => m.target === '/etc/localtime')).toMatchObject({ accepted: true })
    expect(errors.map(e => e.code)).toEqual(['volumes.refused'])

    // Assistant : le chemin système est retiré de la reprise, l'analyse relancée n'a plus de point bloquant.
    await page.goto(`/servers/${server!.id}?tab=adopt&endpoint=${ep.id}&stack=${project}`)
    await page.getByRole('button', { name: 'Analyser la stack' }).click()
    await expect(page.getByRole('button', { name: 'Reprendre en projet' })).toBeVisible({ timeout: 60_000 })
    await page.getByRole('button', { name: /^Lever les 1 point bloquant$/ }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText(/Ce chemin ne peut pas être autorisé/)).toBeVisible()
    await dialog.getByRole('button', { name: 'Retirer et continuer' }).click()
    await expect(page.getByText(/Retirés de la reprise : montage \/host-name \(app\)/)).toBeVisible({ timeout: 60_000 })
    await expect(page.getByRole('button', { name: /^Lever les \d+ points? bloquants?$/ })).toHaveCount(0, { timeout: 60_000 })
    await expect(page.getByRole('button', { name: 'Reprendre en projet' })).toBeEnabled()
  }
  finally {
    compose('down')
    await request.put(`/api/endpoints/${ep.id}/network-pool`, { data: { pool: before.pool }, headers }).catch(() => null)
  }
})
