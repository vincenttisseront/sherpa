/**
 * Tests de bout en bout (navigateur) contre une plateforme en marche :
 * par défaut la stack de développement (npm run stack:up), sinon E2E_BASE_URL.
 * Le navigateur est le Google Chrome installé (aucun téléchargement).
 */
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // Une seule session d'administration partagée : exécution en série.
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  globalSetup: './e2e/global-setup.ts',
  outputDir: '.data/e2e/results',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3100',
    channel: 'chrome',
    headless: true,
    storageState: '.data/e2e/admin.json',
    locale: 'fr-FR',
    timezoneId: 'Europe/Paris',
    trace: 'retain-on-failure',
  },
})
