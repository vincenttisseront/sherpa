/**
 * Double authentification : TOTP (anti-rejeu, codes de secours à usage unique), passkey (authentificateur virtuel Chromium)
 * en second facteur et en connexion sans mot de passe, politique obligatoire et session limitée au compte, réinitialisation.
 * Comptes jetables : l'administrateur de test n'est jamais soumis à la politique (elle est posée par un administrateur jetable).
 */
import { stepOf, totpAt } from '../server/lib/totp'
import { expect, test } from './fixtures'
import { PASSWORD, api, csrf, freshContext, makeUser, resetRateLimits, uiLogin } from './helpers/accounts'

test.beforeEach(() => resetRateLimits())

const nextCode = (secret: string, offset = 1) => totpAt(secret, stepOf(Date.now()) + offset)

test('TOTP : activation, anti-rejeu, codes de secours à usage unique, réinitialisation par un administrateur', async ({ browser, request }) => {
  test.setTimeout(180_000)
  const user = await makeUser(request, 'totp')
  const ctx = await freshContext(browser)
  const page = await ctx.newPage()
  try {
    await uiLogin(page, user.email)
    await page.waitForURL(u => !u.pathname.startsWith('/login'))
    await page.goto('/account')
    await page.getByRole('button', { name: 'Configurer' }).click({ timeout: 30_000 })
    const secret = (await page.getByTestId('totp-secret').textContent())!.trim()
    expect(secret).toMatch(/^[A-Z2-7]{32}$/)
    await expect(page.getByAltText(/QR code/)).toBeVisible()

    // Mauvais code refusé, bon code accepté ; les codes de secours ne s'affichent qu'une fois.
    await page.locator('#mfa-code').fill('000000')
    await page.getByRole('button', { name: 'Activer', exact: true }).click()
    await expect(page.getByText('Code incorrect').first()).toBeVisible()
    await page.locator('#mfa-code').fill(totpAt(secret, stepOf(Date.now())))
    await page.getByRole('button', { name: 'Activer', exact: true }).click()
    await expect(page.getByTestId('recovery-codes')).toBeVisible({ timeout: 30_000 })
    const codes = await page.getByTestId('recovery-codes').locator('li').allTextContents()
    expect(codes).toHaveLength(10)
    await page.getByRole('button', { name: 'J\'ai conservé les codes' }).click()
    await expect(page.getByTestId('recovery-codes')).toHaveCount(0)
    await page.reload()
    await expect(page.getByText('9 code(s)')).toHaveCount(0)
    await expect(page.getByText('10 code(s) restant(s)')).toBeVisible({ timeout: 30_000 })

    // Connexion : le mot de passe seul n'ouvre plus de session.
    await ctx.clearCookies()
    await uiLogin(page, user.email)
    await expect(page.locator('#l-code')).toBeVisible({ timeout: 30_000 })
    expect((await ctx.request.get('/api/account/sessions')).status()).toBe(401)
    await page.locator('#l-code').fill('000000')
    await page.getByRole('button', { name: 'Valider' }).click()
    await expect(page.getByRole('alert')).toContainText('Code incorrect')
    // Le code déjà utilisé pour l'activation est rejoué : refusé ; le suivant est accepté.
    await page.locator('#l-code').fill(totpAt(secret, stepOf(Date.now())))
    await page.getByRole('button', { name: 'Valider' }).click()
    await expect(page.getByRole('alert')).toContainText('Code incorrect')
    const code = nextCode(secret)
    await page.locator('#l-code').fill(code)
    await page.getByRole('button', { name: 'Valider' }).click()
    await page.waitForURL(u => !u.pathname.startsWith('/login'), { timeout: 30_000 })
    expect((await ctx.request.get('/api/account/sessions')).status()).toBe(200)

    // Anti-rejeu : le même code ne rouvre pas de session.
    await ctx.clearCookies()
    await uiLogin(page, user.email)
    await page.locator('#l-code').fill(code)
    await page.getByRole('button', { name: 'Valider' }).click()
    await expect(page.getByRole('alert')).toContainText('Code incorrect')

    // Code de secours : accepté une seule fois.
    await page.getByRole('button', { name: 'Utiliser un code de secours' }).click()
    await page.locator('#l-recovery').fill(codes[0]!)
    await page.getByRole('button', { name: 'Valider' }).click()
    await page.waitForURL(u => !u.pathname.startsWith('/login'), { timeout: 30_000 })
    await ctx.clearCookies()
    await uiLogin(page, user.email)
    await page.getByRole('button', { name: 'Utiliser un code de secours' }).click()
    await page.locator('#l-recovery').fill(codes[0]!)
    await page.getByRole('button', { name: 'Valider' }).click()
    await expect(page.getByRole('alert')).toContainText('Code incorrect')

    // Cinq échecs détruisent le défi : retour au mot de passe.
    for (let i = 0; i < 4; i++) {
      await page.locator('#l-recovery').fill(`FAUX-${i}`)
      await page.getByRole('button', { name: 'Valider' }).click()
      await expect(page.getByRole('alert')).toBeVisible()
    }
    await page.locator('#l-recovery').fill(codes[1]!)
    await page.getByRole('button', { name: 'Valider' }).click()
    await expect(page.getByRole('alert')).toContainText('expiré')

    // Réinitialisation par un administrateur : retour à une connexion par mot de passe seul.
    await api(request, 'post', `/api/admin/users/${user.id}/mfa-reset`)
    await ctx.clearCookies()
    await uiLogin(page, user.email)
    await page.waitForURL(u => !u.pathname.startsWith('/login'), { timeout: 30_000 })
  }
  finally {
    await ctx.close()
    await api(request, 'patch', `/api/admin/users/${user.id}`, { status: 'suspended' }).catch(() => undefined)
  }
})

test('passkey : second facteur et connexion sans mot de passe', async ({ browser, request }) => {
  test.setTimeout(180_000)
  const user = await makeUser(request, 'passkey')
  const ctx = await freshContext(browser)
  const page = await ctx.newPage()
  try {
    // Authentificateur virtuel : clé résidente, vérification de l'utilisateur réussie.
    const cdp = await ctx.newCDPSession(page)
    await cdp.send('WebAuthn.enable')
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } })

    await uiLogin(page, user.email)
    await page.waitForURL(u => !u.pathname.startsWith('/login'))
    await page.goto('/account')
    await page.locator('#mfa-pwd').fill('mauvais mot de passe')
    await page.getByLabel('Nom de la passkey').fill('Clé de test')
    await page.getByTestId('passkey-add').click()
    await expect(page.getByText('Mot de passe incorrect')).toBeVisible({ timeout: 30_000 })
    await page.locator('#mfa-pwd').fill(PASSWORD)
    await page.getByTestId('passkey-add').click()
    await expect(page.getByTestId('recovery-codes')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText('Clé de test')).toBeVisible()

    // Connexion sans mot de passe.
    await ctx.clearCookies()
    await page.goto('/login')
    await page.getByTestId('passkey-login').click()
    await page.waitForURL(u => !u.pathname.startsWith('/login'), { timeout: 30_000 })
    const me = await (await ctx.request.get('/api/auth/me')).json() as { authenticated: boolean, user: { email: string } }
    expect(me.user.email).toBe(user.email)

    // Mot de passe puis passkey : seconde étape automatique.
    await ctx.clearCookies()
    await uiLogin(page, user.email)
    await page.waitForURL(u => !u.pathname.startsWith('/login'), { timeout: 30_000 })
    expect((await ctx.request.get('/api/account/sessions')).status()).toBe(200)

    // Retirer la dernière passkey : le mot de passe suffit de nouveau.
    await page.goto('/account')
    await page.locator('#mfa-pwd').fill(PASSWORD)
    await page.getByRole('button', { name: 'Supprimer la passkey Clé de test' }).click()
    await page.getByRole('button', { name: 'Supprimer', exact: true }).last().click()
    await expect(page.getByText('Clé de test')).toHaveCount(0, { timeout: 30_000 })
  }
  finally {
    await ctx.close()
    await api(request, 'patch', `/api/admin/users/${user.id}`, { status: 'suspended' }).catch(() => undefined)
  }
})

test('politique obligatoire : session limitée au compte jusqu\'à l\'activation', async ({ browser, request }) => {
  test.setTimeout(240_000)
  const boss = await makeUser(request, 'boss', true)
  const worker = await makeUser(request, 'worker')
  const bossCtx = await freshContext(browser)
  const workerCtx = await freshContext(browser)
  try {
    const bossPage = await bossCtx.newPage()
    await uiLogin(bossPage, boss.email)
    await bossPage.waitForURL(u => !u.pathname.startsWith('/login'))
    const b = bossCtx.request
    // Garde-fou : on ne peut pas imposer la double authentification sans avoir activé la sienne.
    const refused = await b.put('/api/admin/mfa-policy', { data: { required: 'all' }, headers: { 'x-csrf-token': await csrf(b) } })
    expect(refused.status()).toBe(409)
    const setup = await api<{ secret: string }>(b, 'post', '/api/account/mfa/totp/setup')
    await api(b, 'post', '/api/account/mfa/totp/confirm', { code: totpAt(setup.secret, stepOf(Date.now())) })

    try {
      await api(b, 'put', '/api/admin/mfa-policy', { required: 'all' })
      expect((await api<{ required: string }>(b, 'get', '/api/admin/mfa-policy')).required).toBe('all')

      // Compte sans facteur : connecté, mais limité à sa page.
      const page = await workerCtx.newPage()
      await uiLogin(page, worker.email)
      await page.waitForURL('**/account', { timeout: 30_000 })
      await expect(page.getByTestId('mfa-required')).toBeVisible({ timeout: 30_000 })
      const blocked = await workerCtx.request.get('/api/account/sessions')
      expect(blocked.status()).toBe(403)
      expect(((await blocked.json()) as { data?: { mfaEnrollRequired?: boolean } }).data?.mfaEnrollRequired).toBe(true)
      // Pas de contournement par un jeton d'API (gestion du compte réservée à la session) ni par une autre page.
      expect((await workerCtx.request.get('/api/account/tokens')).status()).toBe(403)
      await page.goto('/admin')
      await page.waitForURL('**/account')

      // Activation : l'accès est rendu aussitôt.
      await page.getByRole('button', { name: 'Configurer' }).click()
      const secret = (await page.getByTestId('totp-secret').textContent())!.trim()
      await page.locator('#mfa-code').fill(totpAt(secret, stepOf(Date.now())))
      await page.getByRole('button', { name: 'Activer', exact: true }).click()
      await expect(page.getByTestId('recovery-codes')).toBeVisible({ timeout: 30_000 })
      await expect(page.getByTestId('mfa-required')).toHaveCount(0)
      expect((await workerCtx.request.get('/api/account/sessions')).status()).toBe(200)
      await page.goto('/')
      await expect(page).not.toHaveURL(/\/account/)
    }
    finally {
      await api(b, 'put', '/api/admin/mfa-policy', { required: 'off' })
    }
    // Politique levée : l'administrateur de test n'est plus limité.
    expect((await request.get('/api/account/sessions')).status()).toBe(200)
  }
  finally {
    await bossCtx.close()
    await workerCtx.close()
    for (const u of [boss, worker]) await api(request, 'patch', `/api/admin/users/${u.id}`, { status: 'suspended' }).catch(() => undefined)
  }
})
