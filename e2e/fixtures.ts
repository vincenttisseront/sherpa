/** Garde-fous communs : aucune boîte de dialogue native, aucune violation CSP, aucune erreur JS. */
import { test as base, expect } from '@playwright/test'

export const test = base.extend<{ guard: { errors: string[] } }>({
  guard: [async ({ page }, use) => {
    const errors: string[] = []
    page.on('dialog', async (d) => {
      errors.push(`Boîte de dialogue native interdite : ${d.type()} « ${d.message()} »`)
      await d.dismiss()
    })
    page.on('pageerror', e => errors.push(`Erreur JavaScript : ${e.message}`))
    page.on('console', (m) => {
      const t = m.text()
      if (m.type() === 'error' && (/Content Security Policy|Refused to (execute|load|apply)/i.test(t) || /Hydration/i.test(t))) errors.push(`Console : ${t}`)
    })
    await use({ errors })
    expect(errors, errors.join('\n')).toEqual([])
  }, { auto: true }],
})

export { expect }
