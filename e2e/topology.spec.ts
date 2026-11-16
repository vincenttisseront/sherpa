/**
 * Topologie réseau (page Conteneurs en direct › Topologie) : nœuds de conteneurs, réseaux et domaines, mise en évidence
 * des liens, masquage des réseaux par défaut, ouverture du détail d'un conteneur au clavier.
 */
import { expect, test } from './fixtures'

test('topologie réseau : graphe, liens, réseaux par défaut, détail', async ({ page }) => {
  await page.goto('/containers')
  await expect(page.locator('.conn.on')).toContainText('En direct', { timeout: 20_000 })
  await page.getByTestId('view-topology').click()
  const topo = page.getByTestId('topology')
  await expect(topo.locator('svg').first()).toBeVisible()
  await expect(topo.locator('g.ctr').first()).toBeVisible({ timeout: 20_000 })
  expect(await topo.locator('g.net').count()).toBeGreaterThan(0)
  await expect(page.getByRole('radio', { name: 'Topologie' })).toHaveAttribute('aria-checked', 'true')

  // Réseaux par défaut masqués par défaut ; l'interrupteur les affiche.
  const builtin = topo.locator('g.net.builtin')
  await expect(builtin).toHaveCount(0)
  await topo.getByRole('switch', { name: /Masquer les réseaux par défaut/ }).click()
  expect(await builtin.count()).toBeGreaterThan(0)

  // Survol d'un conteneur : ses liens sont en évidence, les autres atténués.
  const first = topo.locator('g.ctr').first()
  await first.hover()
  await expect(topo.locator('path.edge.on').first()).toBeAttached()
  expect(await topo.locator('g.node.dim').count()).toBeGreaterThan(0)
  await page.mouse.move(0, 0)
  await expect(topo.locator('g.node.dim')).toHaveCount(0)

  // Clic : sélection épinglée ; Entrée sur le conteneur ouvre son détail.
  const name = (await first.getAttribute('data-container'))!
  await first.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog')).toContainText(name, { timeout: 20_000 })
  await page.keyboard.press('Escape')

  // Vue Liste : retour à l'affichage par stack.
  await page.getByRole('radio', { name: 'Liste' }).click()
  await expect(page.getByTestId('topology')).toHaveCount(0)
  await expect(page.locator('.group').first()).toBeVisible()
})
