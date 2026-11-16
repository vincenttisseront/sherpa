/** Recherche globale (⌘K / Ctrl+K, « / ») : pages, actions, projets selon la saisie, clavier, fermeture. */
import { expect, test } from './fixtures'

test('recherche globale : raccourcis, pages, projets, clavier', async ({ page, request }) => {
  const stamp = Date.now().toString(36)
  const slug = `palette-${stamp}`
  const { csrfToken } = await (await request.get('/api/auth/me')).json() as { csrfToken: string }
  const created = await request.post('/api/projects', { data: { slug, name: `Boutique ${stamp}` }, headers: { 'x-csrf-token': csrfToken } })
  expect(created.status(), await created.text()).toBe(201)
  const { id } = await created.json() as { id: string }
  try {
    await page.goto('/')
    const dialog = page.getByRole('dialog', { name: 'Recherche globale' })
    const box = page.getByRole('combobox', { name: 'Rechercher' })
    // Raccourci clavier, retrouvé au clavier ; le bouton de la barre l'ouvre aussi.
    await expect(async () => {
      await page.keyboard.press('ControlOrMeta+k')
      await expect(dialog).toBeVisible({ timeout: 2000 })
    }).toPass({ timeout: 30_000 })
    await expect(box).toBeFocused()
    await expect(page.getByRole('option', { name: /Tableau de bord/ })).toBeVisible()
    await expect(page.getByRole('option', { name: /Nouveau projet/ })).toBeVisible()

    // Pages : filtre sans accents, Entrée ouvre la première.
    await box.fill('serveur')
    await expect(page.getByRole('option').first()).toContainText('Serveurs')
    await box.press('Enter')
    await expect(page).toHaveURL(/\/servers$/)
    await expect(dialog).toBeHidden()

    // Projets : recherche côté serveur, flèches puis Entrée.
    await page.keyboard.press('/')
    await expect(dialog).toBeVisible()
    await box.fill(`Boutique ${stamp}`)
    const option = page.getByRole('option', { name: new RegExp(`Boutique ${stamp}`) })
    await expect(option).toBeVisible({ timeout: 15_000 })
    await expect(option).toContainText(slug)
    await expect(box).toHaveAttribute('aria-activedescendant', /.+/)
    await box.press('ArrowDown')
    await box.press('ArrowUp')
    await option.click()
    await expect(page).toHaveURL(new RegExp(`/projects/${id}$`))

    // Aucun résultat, puis Échap : fermé, focus rendu.
    await page.getByRole('button', { name: /Rechercher \(raccourci/ }).click()
    await box.fill('zzzz-introuvable-zzzz')
    await expect(page.getByText('Aucun résultat.')).toBeVisible({ timeout: 15_000 })
    await box.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(page.getByRole('button', { name: /Rechercher \(raccourci/ })).toBeFocused()

    // « / » dans un champ de saisie : pas de recherche (on tape normalement).
    await page.goto('/projects')
    const field = page.getByRole('textbox').first()
    if (await field.count()) {
      await field.click()
      await page.keyboard.type('a/b')
      await expect(dialog).toBeHidden()
    }
  }
  finally {
    await request.post(`/api/projects/${id}/removal`, { data: { mode: 'delete', confirm: slug }, headers: { 'x-csrf-token': csrfToken } }).catch(() => null)
  }
})
