/**
 * Premier démarrage sur une instance vierge (configuration de production) :
 * jeton d'initialisation → administrateur → assistant complet → tableau de bord.
 *   scripts/prod-smoke.sh up && scripts/prod-smoke.sh e2e
 * Le jeton est lu dans un fichier (jamais affiché) ; le mot de passe est généré ici.
 */
import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { expect, test } from './fixtures'

test.skip(!process.env.E2E_FRESH, 'Réservé à une instance vierge (E2E_FRESH=1)')
test.use({ storageState: { cookies: [], origins: [] } })

test('premier démarrage : administrateur puis assistant d\'initialisation de bout en bout', async ({ page }) => {
  test.setTimeout(180_000)
  const token = readFileSync(process.env.E2E_SETUP_TOKEN_FILE!, 'utf8').trim()
  const password = `${randomBytes(18).toString('base64url')}-Aa1`
  writeFileSync(process.env.E2E_ADMIN_PASSWORD_OUT ?? '.data/e2e/fresh-admin-password', password, { mode: 0o600 })

  // Sans compte : toute page mène à l'initialisation.
  await page.goto('/projects')
  await expect(page).toHaveURL(/\/setup$/)
  await page.getByLabel('Jeton d\'initialisation').fill(token)
  await page.getByLabel('Nom').fill('Admin Recette')
  await page.getByLabel('Email').fill('admin@recette.test')
  await page.locator('#s-pwd').fill(password)
  await page.locator('#s-confirm').fill(password)
  await page.getByRole('button', { name: 'Créer le compte administrateur' }).click()

  // 1. Vérifications : instance d'essai en HTTP local, donc HTTPS signalé.
  await expect(page).toHaveURL(/\/onboarding/)
  await expect(page.getByRole('heading', { name: 'Initialisation de la plateforme' })).toBeVisible()
  await expect(page.getByText('Worker actif')).toBeVisible()
  await page.getByRole('button', { name: 'Continuer' }).click()

  // 2. Accès : groupes de départ et second administrateur.
  await expect(page.getByRole('heading', { name: 'Accès', level: 2 })).toBeVisible()
  await page.getByRole('button', { name: 'Créer les groupes sélectionnés' }).click()
  await expect(page.getByText('Groupes créés avec leurs rôles')).toBeVisible()
  for (const g of ['Administrateurs plateforme', 'Équipes DevOps', 'Lecture']) await expect(page.getByRole('cell', { name: g, exact: true })).toBeVisible()
  await page.getByLabel('Nom', { exact: true }).fill('Second Admin')
  await page.getByLabel('Email', { exact: true }).fill('admin2@recette.test')
  await page.getByRole('button', { name: 'Inviter comme administrateur' }).click()
  await expect(page.getByLabel('Lien d\'invitation')).toHaveValue(/\/invitation\//)
  await page.getByRole('button', { name: 'Continuer' }).click()

  // 3. SSO : formulaire, URI de redirection, échec de découverte expliqué (émetteur injoignable).
  await expect(page.getByRole('heading', { name: 'SSO', level: 2 })).toBeVisible()
  await page.getByRole('group', { name: 'Fournisseur' }).getByRole('button', { name: 'Keycloak' }).click()
  await expect(page.locator('.redirect code')).toHaveText(/\/api\/auth\/oidc\/keycloak\/callback$/)
  await page.getByLabel('Émetteur (issuer)').fill('https://keycloak.invalid/realms/recette')
  await page.getByLabel('Client secret').fill(randomBytes(16).toString('hex'))
  await page.getByRole('button', { name: 'Enregistrer et tester' }).click()
  await expect(page.getByText(/Découverte en échec/)).toBeVisible({ timeout: 30_000 })
  await expect(page.getByPlaceholder('/nom-du-groupe')).toHaveCount(3)
  await page.getByRole('button', { name: 'Passer cette étape' }).click()

  // 4. Notifications : sans SMTP, l'email est expliqué ; étape passée.
  await expect(page.getByText(/SMTP n'est pas configuré/)).toBeVisible()
  await page.getByRole('button', { name: 'Passer cette étape' }).click()

  // 5. Serveurs : l'assistant serveur s'ouvre avec retour prévu ici.
  await page.getByRole('button', { name: 'Ajouter un serveur' }).click()
  await expect(page).toHaveURL(/\/servers\/new\?returnTo=/)
  await page.goBack()
  await expect(page.getByRole('heading', { name: 'Serveurs', level: 2 })).toBeVisible()
  await page.getByRole('button', { name: 'Passer cette étape' }).click()

  // 6. GitHub : test de joignabilité (résultat affiché, quel que soit l'accès réseau de l'instance).
  await page.getByRole('button', { name: 'Tester la connexion depuis la plateforme' }).click()
  await expect(page.getByText(/joignable|injoignable/).first()).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: 'Continuer' }).click()

  // 7. Récapitulatif puis fin : page Mise en service, plus de redirection vers l'assistant.
  await expect(page.getByRole('cell', { name: 'Accès' })).toBeVisible()
  await page.getByRole('button', { name: 'Terminer l\'initialisation' }).click()
  await expect(page).toHaveURL(/\/admin\/readiness$/)
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Tableau de bord' })).toBeVisible()
})
