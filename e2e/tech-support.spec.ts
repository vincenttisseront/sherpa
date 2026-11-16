/**
 * Export « tech support » depuis la page de diagnostic, sur l'infrastructure de dev : rapport texte
 * complet (cible, diagnostic, conteneurs, réseaux, configuration, déploiements, journaux) et aucun
 * secret, même quand le conteneur l'écrit dans ses journaux.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { expect, test } from './fixtures'

const SECRET = 'tech-secret-XYZ12345'

test('export tech support : rapport complet, secrets masqués partout', async ({ page, request }) => {
  test.setTimeout(600_000)
  const { csrfToken } = await (await request.get('/api/auth/me')).json() as { csrfToken: string }
  const headers = { 'x-csrf-token': csrfToken }
  const servers = await (await request.get('/api/servers?pageSize=100')).json() as { items: { id: string, name: string }[] }
  const server = servers.items.find(s => s.name === 'agent-local')
  test.skip(!server, 'serveur agent-local absent')
  const detail = await (await request.get(`/api/servers/${server!.id}`)).json() as { endpoints: { id: string, enabled: boolean, environments: { key: string }[] }[] }
  const ep = detail.endpoints.find(e => e.enabled && e.environments.length)!
  const env = ep.environments[0]!.key
  const slug = `ts-${Date.now().toString(36)}`
  const created = await request.post('/api/projects', { data: { slug, name: `Tech support ${slug}`, target: { endpointId: ep.id, environmentKey: env } }, headers })
  const { id } = await created.json() as { id: string }
  const targetId = ((await (await request.get(`/api/projects/${id}`)).json()) as { targets: { id: string }[] }).targets[0]!.id
  try {
    const vars = await request.put(`/api/targets/${targetId}/variables`, { data: [{ name: 'API_TOKEN', value: SECRET, secret: true }, { name: 'MODE', value: 'demo' }], headers })
    expect(vars.status(), await vars.text()).toBe(200)
    await page.goto(`/projects/${id}`)
    await expect(async () => {
      await page.getByRole('button', { name: 'Nouveau déploiement' }).click({ timeout: 5000 })
      await expect(page.getByRole('textbox', { name: 'Contenu du fichier Compose' })).toBeVisible({ timeout: 3000 })
    }).toPass({ timeout: 30_000 })
    // Le conteneur écrit le secret dans ses journaux : il doit être masqué dans le rapport.
    await page.getByRole('textbox', { name: 'Contenu du fichier Compose' }).fill('services:\n  app:\n    image: busybox:1.37\n    command: ["sh", "-c", "echo token=$$API_TOKEN mode=$$MODE; sleep 3600"]\n    environment:\n      API_TOKEN: ${API_TOKEN}\n      MODE: ${MODE}\n')
    await page.getByRole('button', { name: 'Analyser ce Compose' }).click({ timeout: 10_000 })
    await expect(page.getByRole('heading', { name: /Analyse/ })).toBeVisible({ timeout: 60_000 })
    await page.getByRole('button', { name: 'Déployer', exact: true }).click({ timeout: 30_000 })
    await page.getByRole('dialog').getByRole('button', { name: 'Déployer' }).click({ timeout: 10_000 })
    await expect(page.getByRole('log')).toContainText('Statut : HEALTHY', { timeout: 300_000 })

    await page.goto(`/diagnostic/${targetId}`)
    // Génération longue (sondes) : spinner et temps écoulé, puis téléchargement.
    const downloading = page.waitForEvent('download', { timeout: 120_000 })
    await page.getByRole('button', { name: 'Export tech support' }).click()
    await expect(page.getByRole('button', { name: /Génération du rapport… \d+ s/ })).toBeDisabled()
    const download = await downloading
    await expect(page.getByRole('button', { name: 'Export tech support' })).toBeEnabled()
    expect(download.suggestedFilename()).toMatch(new RegExp(`^tech-support-${slug}-${env}-.*\\.txt$`))
    const text = readFileSync((await download.path())!, 'utf8')
    for (const s of ['TECH SUPPORT', '=== Cible', '=== Release active', '=== Diagnostic', '=== Conteneurs (hôte)', '=== Réseaux de la stack', '=== Configuration : variables', '=== Configuration : Compose final', '=== Déploiements récents', '=== Journal du dernier déploiement', '=== Journaux des services', '=== Fin du rapport']) expect(text).toContain(s)
    expect(text).toContain('MODE = demo')
    expect(text).toContain('API_TOKEN = •••••• (secrète)')
    expect(text).toMatch(/environnement\s+.*API_TOKEN/)
    expect(text).toContain('mode=demo')
    expect(text).not.toContain(SECRET)
    expect(text).not.toMatch(/watchtower\/(profile-)?hook\/[0-9a-f-]{36}\/[A-Za-z0-9_-]{16,}/)
  }
  finally {
    await request.post(`/api/projects/${id}/removal`, { data: { mode: 'delete', confirm: slug }, headers }).catch(() => null)
  }
})

test('export tech support d\'un serveur : rapport complet depuis la fiche, aucun secret', async ({ page, request }) => {
  test.setTimeout(300_000)
  const servers = await (await request.get('/api/servers?pageSize=100')).json() as { items: { id: string, name: string }[] }
  const server = servers.items.find(s => s.name === 'agent-local')
  test.skip(!server, 'serveur agent-local absent')
  await page.goto(`/servers/${server!.id}`)
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export tech support' }).click()])
  expect(download.suggestedFilename()).toMatch(/^tech-support-serveur-agent-local-.*\.txt$/)
  const text = readFileSync((await download.path())!, 'utf8')
  for (const s of ['TECH SUPPORT — serveur agent-local', '=== Serveur', '=== Endpoint', '--- Moteur Docker', '--- Disque (Docker)', '--- Runner', '--- Chemins par environnement', '--- Traefik et proxy géré', '--- Plan d\'adressage', '--- Profils Watchtower', '--- Projets', '--- Conteneurs de l\'hôte', '=== Audit récent', '=== Fin du rapport']) expect(text).toContain(s)
  expect(text).toMatch(/Accès\s+agent .* \(AGENT_SECRET enregistré chiffré\)/)
  expect(text).toMatch(/Version\s+\d+\.\d+/)
  // Aucun secret : ni secret d'agent (fichier de dev), ni jeton de webhook.
  const agentSecret = (() => {
    try {
      return readFileSync('.data/dev-auth/agent.env', 'utf8').match(/AGENT_SECRET=(\S+)/)?.[1] ?? null
    }
    catch {
      return null
    }
  })()
  if (agentSecret) expect(text).not.toContain(agentSecret)
  expect(text).not.toMatch(/watchtower\/(profile-)?hook\/[0-9a-f-]{36}\/[A-Za-z0-9_-]{16,}/)
})

test('export tech support de la plateforme : depuis l\'administration, ni secret ni donnée personnelle', async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto('/admin/readiness')
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export tech support' }).click()])
  expect(download.suggestedFilename()).toMatch(/^tech-support-plateforme-.*\.txt$/)
  const text = readFileSync((await download.path())!, 'utf8')
  for (const s of ['TECH SUPPORT — plateforme', '=== Console', '=== Santé', '=== Base de données', '=== Files de tâches', '=== Configuration (environnement)', '=== Réglages enregistrés', '=== Utilisateurs (nombres seulement)', '=== Notifications', '=== Serveurs', '=== Projets', '=== Déploiements en échec récents', '=== Actions en échec ou refusées', '=== Fin du rapport']) expect(text).toContain(s)
  expect(text).toMatch(/Base de données\s+ok · PostgreSQL/)
  expect(text).toMatch(/Worker\s+présent/)
  expect(text).toMatch(/Migrations appliquées\s+\d+/)
  expect(text).toMatch(/File déploiements\s+en attente \d+/)
  // Secrets de la console de dev : clé maîtresse (.env) et mot de passe de la base.
  const master = (() => {
    try {
      return readFileSync('.env', 'utf8').match(/^MASTER_KEY=(\S+)/m)?.[1] ?? null
    }
    catch {
      return null
    }
  })()
  if (master) expect(text).not.toContain(master)
  expect(text).toMatch(/MASTER_KEY\s+•••••• \(définie\)/)
  expect(text).not.toContain('platform:platform@')
  // Aucune adresse e-mail hors de l'auteur du rapport.
  const emails = [...new Set(text.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) ?? [])]
  expect(emails.filter(e => e !== 'admin@acme.test' && !e.startsWith('noreply@'))).toEqual([])
})

test('alias uniques au déploiement et sondes du tech support : homonyme d\'un réseau partagé neutralisé, route de santé lente, nom du projet lisible', async ({ page, request }) => {
  test.setTimeout(600_000)
  const { csrfToken } = await (await request.get('/api/auth/me')).json() as { csrfToken: string }
  const headers = { 'x-csrf-token': csrfToken }
  const servers = await (await request.get('/api/servers?pageSize=100')).json() as { items: { id: string, name: string }[] }
  const server = servers.items.find(s => s.name === 'agent-local')
  test.skip(!server, 'serveur agent-local absent')
  const detail = await (await request.get(`/api/servers/${server!.id}`)).json() as { endpoints: { id: string, enabled: boolean, environments: { key: string }[] }[] }
  const ep = detail.endpoints.find(e => e.enabled && e.environments.length)!
  const env = ep.environments[0]!.key
  const slug = `tsnet-${Date.now().toString(36)}`
  // Réseau partagé avec un conteneur d'une autre stack qui porte le nom « redis ».
  const shared = `${slug}-shared`
  const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).trim()
  docker('network', 'create', shared)
  docker('run', '-d', '--name', `${slug}-intrus`, '--network', shared, '--network-alias', 'redis', '--label', 'com.docker.compose.project=autre', 'busybox:1.37', 'sleep', '3600')
  const created = await request.post('/api/projects', { data: { slug, name: `Sondes ${slug}`, target: { endpointId: ep.id, environmentKey: env } }, headers })
  const { id } = await created.json() as { id: string }
  const targetId = ((await (await request.get(`/api/projects/${id}`)).json()) as { targets: { id: string }[] }).targets[0]!.id
  try {
    // Réseau partagé découvert puis autorisé (politique de l'endpoint).
    expect((await request.post(`/api/servers/${server!.id}/discover`, { headers })).ok()).toBe(true)
    const nets = await (await request.get(`/api/endpoints/${ep.id}/networks`)).json() as { id: string, name: string }[]
    const netId = nets.find(n => n.name === shared)!.id
    const allowed = await request.patch(`/api/networks/${netId}`, { data: { policy: 'allowed' }, headers })
    expect(allowed.status(), await allowed.text()).toBe(200)
    // Variable secrète égale au nom du projet (POSTGRES_DB=edutis…) : ne doit pas masquer le projet partout.
    await request.put(`/api/targets/${targetId}/variables`, { data: [{ name: 'DB_NAME', value: slug, secret: true }, { name: 'DB_PASSWORD', value: 'Zk8-very-secret-pw', secret: true }, { name: 'CACHE_HOST', value: 'redis', secret: true }], headers })
    const compose = [
      'services:',
      '  web:',
      '    image: busybox:1.37',
      '    command:',
      '      - sh',
      '      - -c',
      '      - |',
      '        mkdir -p /www/cgi-bin',
      '        echo \'#!/bin/sh\' > /www/cgi-bin/slow',
      '        echo \'sleep 6; echo "Content-Type: text/plain"; echo; echo ok\' >> /www/cgi-bin/slow',
      '        chmod +x /www/cgi-bin/slow',
      '        exec httpd -f -p 3000 -h /www',
      '    environment:',
      '      REDIS_URL: redis://:${DB_PASSWORD}@redis:6379/0',
      '      DB_NAME: ${DB_NAME}',
      '      CACHE_HOST: ${CACHE_HOST}',
      '    healthcheck:',
      '      test: ["CMD-SHELL", "(wget -q -O /dev/null http://127.0.0.1:3000/cgi-bin/slow &) ; exit 0"]',
      '      interval: 5s',
      '      timeout: 3s',
      '    networks: [default, shared]',
      '  redis:',
      '    image: busybox:1.37',
      '    command: ["sleep", "3600"]',
      'networks:',
      '  shared:',
      '    external: true',
      `    name: ${shared}`,
      '',
    ].join('\n')
    await page.goto(`/projects/${id}`)
    await expect(async () => {
      await page.getByRole('button', { name: 'Nouveau déploiement' }).click({ timeout: 5000 })
      await expect(page.getByRole('textbox', { name: 'Contenu du fichier Compose' })).toBeVisible({ timeout: 3000 })
    }).toPass({ timeout: 30_000 })
    await page.getByRole('textbox', { name: 'Contenu du fichier Compose' }).fill(compose)
    await page.getByRole('button', { name: 'Analyser ce Compose' }).click({ timeout: 10_000 })
    await expect(page.getByRole('heading', { name: /Analyse/ })).toBeVisible({ timeout: 60_000 })
    await page.getByRole('button', { name: 'Déployer', exact: true }).click({ timeout: 30_000 })
    await page.getByRole('dialog').getByRole('button', { name: 'Déployer' }).click({ timeout: 10_000 })
    await expect(page.getByRole('log')).toContainText('Statut : HEALTHY', { timeout: 300_000 })

    // « Redéployer » depuis l'en-tête du projet : recrée la stack avec la configuration actuelle.
    await page.goto(`/projects/${id}`)
    await page.getByRole('button', { name: 'Redéployer', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Redéployer' }).click()
    await expect(page).toHaveURL(/\/deployments\//)
    await expect(page.getByRole('log')).toContainText('Statut : HEALTHY', { timeout: 300_000 })
    await expect(page.getByRole('log')).toContainText('Alias uniques des services appliqués aux variables secrètes : CACHE_HOST')

    const res = await request.get(`/api/targets/${targetId}/tech-support`)
    expect(res.status()).toBe(200)
    const text = await res.text()
    await test.info().attach('tech-support.txt', { body: text, contentType: 'text/plain' })
    const stack = `${slug}-${env}`
    // Déploiement : alias unique sur le réseau propre, hôtes réécrits (valeur littérale et variable secrète).
    expect(docker('exec', `${stack}-web-1`, 'printenv', 'REDIS_URL')).toBe(`redis://:Zk8-very-secret-pw@${stack}-redis:6379/0`)
    expect(docker('exec', `${stack}-web-1`, 'printenv', 'CACHE_HOST')).toBe(`${stack}-redis`)
    expect(docker('exec', `${stack}-web-1`, 'nslookup', `${stack}-redis`)).toMatch(/Address: 10\.|Address: 172\./)
    expect(text).toMatch(new RegExp(`aliases:\\s+- ${stack}-redis`))
    // Constats placés après le diagnostic, avant les conteneurs ; l'homonyme n'est plus utilisé.
    expect(text.indexOf('=== Constats des sondes')).toBeGreaterThan(text.indexOf('=== Diagnostic'))
    expect(text.indexOf('=== Constats des sondes')).toBeLessThan(text.indexOf('=== Conteneurs (hôte)'))
    expect(text).not.toContain('Homonyme sur le réseau partagé')
    expect(text).toMatch(new RegExp(`- ${shared} : « redis » est aussi porté par ${slug}-intrus \\(stack autre\\) — sans effet`))
    // Résolution vue depuis web : l'alias unique mène au redis de la stack, le nom court à l'intrus (sans effet).
    expect(text).toMatch(new RegExp(` {4}${stack}-redis → \\S+ \\(${stack}-redis-1 · `))
    expect(text).toMatch(/ {4}redis → .*hors stack\) \(homonyme sans effet : nom non utilisé\)/)
    // Route de santé : ~6 s mesurées, au-delà du délai de 3 s.
    expect(text).toMatch(/- web http:\/\/127\.0\.0\.1:3000\/cgi-bin\/slow → répond · [6-9],\d\d s · délai du healthcheck 3 s/)
    expect(text).toMatch(/au-delà du délai du healthcheck \(3 s\)/)
    expect(text).toMatch(/healthcheck\s+CMD-SHELL .* · intervalle 5 s · délai 3 s/)
    // Nom du projet lisible malgré la variable secrète, vrai secret masqué partout.
    expect(text).toContain(`platform.project: ${slug}`)
    expect(text).toContain('DB_NAME = •••••• (secrète)')
    expect(text).not.toContain('Zk8-very-secret-pw')
    // Sonde jetable supprimée.
    expect(docker('ps', '-a', '--filter', 'label=platform.probe=tech-support', '--format', '{{.Names}}')).toBe('')
  }
  finally {
    await request.post(`/api/projects/${id}/removal`, { data: { mode: 'delete', confirm: slug }, headers }).catch(() => null)
    docker('rm', '-f', `${slug}-intrus`)
    // Suppression du projet asynchrone : le réseau se libère quand la stack est retirée.
    await expect(async () => {
      execFileSync('docker', ['network', 'rm', shared], { stdio: 'ignore' })
    }).toPass({ timeout: 60_000 }).catch(() => null)
  }
})
