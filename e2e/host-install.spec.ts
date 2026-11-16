/**
 * « Installer un hôte » (tableau de bord) : type d'hôte et composants, commande complète,
 * puis assistant d'ajout prérempli avec le secret de l'agent (hors URL).
 */
import { expect, test } from './fixtures'

test('installer un hôte : commande selon le profil, secret transmis à l\'assistant', async ({ page }) => {
  await page.goto('/')
  await expect(async () => {
    await page.getByRole('button', { name: 'Installer un hôte' }).click({ timeout: 5000 })
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 3000 })
  }).toPass({ timeout: 30_000 })
  const dialog = page.getByRole('dialog')
  const command = dialog.getByLabel('Commande d\'installation')

  // Par défaut : Docker, agent + Runner ; secret masqué à l'affichage.
  await expect(dialog.getByRole('radio', { name: 'Agent + Runner' })).toHaveAttribute('aria-checked', 'true')
  await expect(command).toContainText('sudo bash <<\'INSTALL\'')
  await expect(command).toContainText('-v "/var/run/docker.sock:/var/run/docker.sock"')
  await expect(command).toContainText('AGENT_SECRET=\'••••••••••••\'')
  await expect(command).toContainText('openssl req -x509')
  const secret = await dialog.getByLabel('AGENT_SECRET').inputValue()
  expect(secret).toMatch(/^[0-9a-f]{64}$/)
  await dialog.getByRole('button', { name: 'Afficher le secret' }).click()
  await expect(command).toContainText(`AGENT_SECRET='${secret}'`)

  // Podman : socket et --privileged ; PKI : fichiers de l'hôte.
  await dialog.getByLabel('Type d\'hôte').selectOption('podman')
  await expect(command).toContainText('systemctl enable --now podman.socket')
  await expect(command).toContainText('podman run -d --name portainer_agent --restart=always --privileged')
  await dialog.getByLabel(/PKI d'entreprise/).check()
  await dialog.getByLabel(/Certificat \(SAN/).fill('/etc/pki/tls/runner.crt')
  await expect(command).toContainText('install -m 0400 "/etc/pki/tls/runner.crt"')
  await expect(command).not.toContainText('openssl req')

  // Saisie invalide : pas de commande.
  await dialog.getByLabel('IP d\'écoute (administration)').fill('10.0.0.300')
  await expect(dialog.getByText('Adresse IPv4 attendue')).toBeVisible()
  await expect(command).toHaveCount(0)
  await dialog.getByLabel('IP d\'écoute (administration)').fill('10.0.0.11')

  // Rootless, agent seul : variables de l'utilisateur, ni sudo ni Runner.
  await dialog.getByLabel('Type d\'hôte').selectOption('rootless')
  await dialog.getByRole('radio', { name: 'Agent seul' }).click()
  await expect(command).toContainText('-v "$XDG_RUNTIME_DIR/docker.sock:/var/run/docker.sock"')
  await expect(command).not.toContainText('sudo')
  await expect(command).not.toContainText('platform-runner')

  // SSH : utilisateur, clé générée, empreinte de la clé d'hôte ; ni agent ni secret.
  await dialog.getByLabel('Type d\'hôte').selectOption('docker')
  await dialog.getByRole('radio', { name: 'SSH' }).click()
  await expect(command).toContainText('useradd --create-home --shell /bin/sh "$SSH_USER"')
  await expect(command).toContainText('ssh-keygen -q -t ed25519')
  await expect(command).not.toContainText('AGENT_SECRET')
  await dialog.getByLabel(/Clé publique existante/).check()
  await dialog.getByLabel('Clé publique', { exact: true }).fill('pas une clé')
  await expect(dialog.getByText(/Clé publique OpenSSH attendue/)).toBeVisible()
  await dialog.getByLabel('Clé publique', { exact: true }).fill('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl ops@poste')
  await expect(command).toContainText('grep -qxF "$PUBKEY"')
  await dialog.getByRole('button', { name: 'Ajouter ce serveur…' }).click()
  await page.waitForURL('**/servers/new')
  await page.getByRole('textbox', { name: 'Nom du serveur' }).fill('hote-ssh', { timeout: 30_000 })
  await page.getByRole('button', { name: 'Suivant' }).click()
  await expect(page.getByRole('radio', { name: 'SSH' })).toHaveAttribute('aria-checked', 'true')
  await expect(page.locator('#w-ssh-user')).toHaveValue('deploy')

  // Agent : assistant d'ajout prérempli, secret absent de l'URL.
  await page.goto('/')
  await expect(async () => {
    await page.getByRole('button', { name: 'Installer un hôte' }).click({ timeout: 5000 })
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 3000 })
  }).toPass({ timeout: 30_000 })
  await dialog.getByLabel('AGENT_SECRET').fill(secret)
  await dialog.getByRole('button', { name: 'Ajouter ce serveur…' }).click()
  await page.waitForURL('**/servers/new')
  expect(page.url()).not.toContain(secret)
  await expect(page.getByLabel('AGENT_SECRET')).toHaveValue(secret, { timeout: 30_000 })
})
