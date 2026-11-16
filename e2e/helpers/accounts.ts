/** Comptes jetables et connexions par l'interface, partagés par les tests de bout en bout. */
import { execFileSync } from 'node:child_process'
import { request as pwRequest, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { expect } from '../fixtures'

export const PASSWORD = 'Sherpa-e2e-Passw0rd!Zq'
export const base = process.env.E2E_BASE_URL ?? 'http://localhost:3100'

export async function csrf(request: APIRequestContext) {
  return ((await (await request.get('/api/auth/me')).json()) as { csrfToken: string }).csrfToken
}
export async function api<T>(request: APIRequestContext, method: 'get' | 'post' | 'put' | 'patch' | 'delete', url: string, data?: unknown): Promise<T> {
  const res = await request[method](url, { data, headers: { 'x-csrf-token': await csrf(request) } })
  expect(res.status(), await res.text()).toBeLessThan(300)
  return res.json() as Promise<T>
}

/** Compte local jetable : créé par l'administrateur, invitation acceptée par l'API (aucun navigateur). */
export async function makeUser(admin: APIRequestContext, label: string, asAdmin = false, roleKey = 'admin') {
  const email = `mfa-${label}-${Date.now().toString(36)}@e2e.test`
  const created = await api<{ id: string, invitationUrl: string }>(admin, 'post', '/api/admin/users', { email, displayName: `MFA ${label}`, kind: 'local' })
  const anon = await pwRequest.newContext({ baseURL: base })
  const accepted = await anon.post(`/api/auth/invitations/${created.invitationUrl.split('/').pop()}`, { data: { password: PASSWORD } })
  expect(accepted.status(), await accepted.text()).toBeLessThan(300)
  await anon.dispose()
  if (asAdmin || roleKey !== 'admin') {
    const { roles } = await (await admin.get('/api/admin/roles')).json() as { roles: { id: string, key: string }[] }
    await api(admin, 'post', '/api/admin/bindings', { roleId: roles.find(r => r.key === roleKey)!.id, subjectType: 'user', subjectId: created.id })
  }
  return { id: created.id, email }
}

export async function freshContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ baseURL: base, storageState: { cookies: [], origins: [] }, locale: 'fr-FR' })
}

export async function uiLogin(page: Page, email: string, password = PASSWORD) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Mot de passe').fill(password)
  await page.getByRole('button', { name: 'Se connecter', exact: true }).click()
}


/** Les limites de débit (connexion, invitation, double authentification) sont partagées : on repart d'un compteur vide. */
export function resetRateLimits() {
  try {
    execFileSync('docker', ['exec', 'sherpa-dev-redis-1', 'sh', '-c', 'redis-cli --scan --pattern "rl:*" | xargs -r redis-cli del'], { stdio: 'ignore' })
  }
  catch { /* pile hors Docker : les limites s'appliquent normalement */ }
}
