/** Toute attente montre ce que fait la plateforme et où elle en est (étape publiée par le serveur). */
import { expect, test } from './fixtures'

/** Endpoint de l'hôte joint par agent (Traefik et stacks de démonstration), pas l'hôte SSH de test. */
async function agentEndpoint(request: import('@playwright/test').APIRequestContext) {
  const servers = await (await request.get('/api/servers?pageSize=100')).json() as { items: { id: string, transport: string }[] }
  const agents = new Set(servers.items.filter(s => s.transport !== 'ssh').map(s => s.id))
  const live = await (await request.get('/api/live')).json() as { serverId: string, endpointId: string }[]
  return live.find(e => agents.has(e.serverId))!
}

test('analyse de l\'occupation disque : opération et étape serveur affichées pendant l\'attente', async ({ page, request }) => {
  const ep = await agentEndpoint(request)
  const seen = new Set<string>()
  page.on('response', async (r) => {
    if (r.url().includes('/api/progress/') && r.ok()) {
      const p = await r.json().catch(() => null) as { label: string } | null
      if (p) seen.add(p.label)
    }
  })
  await page.goto(`/servers/${ep!.serverId}?tab=cleanup&endpoint=${ep!.endpointId}`)
  await expect(page.locator('.host .act').filter({ hasText: 'Analyse de l\'occupation disque' })).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('.usage .u')).toHaveCount(4, { timeout: 30_000 })
  expect([...seen].some(l => l.includes('docker system df'))).toBe(true)
  // L'indicateur disparaît une fois l'opération terminée.
  await expect(page.locator('.host .act')).toHaveCount(0, { timeout: 10_000 })
})

test('relance de la découverte : étapes déterminées (inventaire des endpoints n/N)', async ({ page, request }) => {
  const [ep] = await (await request.get('/api/live')).json() as { serverId: string }[]
  await page.goto(`/servers/${ep!.serverId}`)
  const seen = new Set<string>()
  page.on('response', async (r) => {
    if (r.url().includes('/api/progress/') && r.ok()) {
      const p = await r.json().catch(() => null) as { label: string } | null
      if (p) seen.add(p.label)
    }
  })
  // Sous 350 ms l'indicateur reste masqué (pas de clignotement) : on vérifie les étapes reçues.
  const done = page.waitForResponse(r => /\/api\/servers\/[^/]+\/discover$/.test(r.url()), { timeout: 60_000 })
  await page.getByRole('button', { name: 'Redécouvrir' }).click()
  await done
  await expect(page.locator('.host .act')).toHaveCount(0, { timeout: 10_000 })
  // Les étapes lues pendant l'attente viennent du serveur.
  expect([...seen].some(l => /Connexion à Portainer|Liste des endpoints|Inventaire des endpoints|Enregistrement de l'inventaire/.test(l))).toBe(true)
})
