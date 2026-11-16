/**
 * Connexion de l'administrateur de développement, une seule fois par exécution
 * (la limitation de débit des connexions s'applique aussi aux tests).
 * Identifiants : E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD_FILE (défaut : compte de dev).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { chromium, type FullConfig } from '@playwright/test'

export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]!.use.baseURL!
  // Instance vierge (premier démarrage) : aucune session préalable.
  if (process.env.E2E_FRESH) {
    mkdirSync('.data/e2e', { recursive: true })
    writeFileSync('.data/e2e/admin.json', JSON.stringify({ cookies: [], origins: [] }))
    return
  }
  const email = process.env.E2E_ADMIN_EMAIL ?? 'admin@acme.test'
  const password = readFileSync(process.env.E2E_ADMIN_PASSWORD_FILE ?? '.data/dev-auth/admin-password', 'utf8').trim()
  mkdirSync('.data/e2e', { recursive: true })
  const browser = await chromium.launch({ channel: 'chrome' })
  const page = await browser.newPage({ baseURL })
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Mot de passe').fill(password)
  await page.getByRole('button', { name: 'Se connecter' }).click()
  await page.waitForURL(url => !url.pathname.startsWith('/login'))
  await page.context().storageState({ path: '.data/e2e/admin.json' })
  await browser.close()
}
