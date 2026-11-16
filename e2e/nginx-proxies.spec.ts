/**
 * Reverse proxies nginx (au même titre que Traefik), sur l'infrastructure de dev (agent-local) :
 * - nginx-proxy (jwilder) : variables VIRTUAL_HOST… posées sur le service exposé, routage effectif ;
 * - nginx classique : fichier server { } écrit dans conf.d, nginx rechargé, routage effectif, fichier
 *   vidé à la suppression du projet.
 * - certificats : certificat importé (auto-signé, généré pour le test) déposé dans le conteneur nginx,
 *   site servi en HTTPS avec redirection ; détection du proxy depuis l'onglet Reverse proxy.
 * - Let's Encrypt : défi HTTP-01 (Pebble), et DNS-01 avec certificat générique par un faux Cloudflare.
 * Un réseau et un proxy jetables par scénario ; configuration du reverse proxy de l'endpoint restaurée.
 */
import { execFileSync } from 'node:child_process'
import { type Server, createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { APIRequestContext, Page } from '@playwright/test'
import { expect, test } from './fixtures'

const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).trim()
const tryDocker = (...args: string[]) => {
  try {
    return docker(...args)
  }
  catch {
    return ''
  }
}
/** Requête HTTP vers le proxy depuis un conteneur du même réseau (nom d'hôte demandé : Host). */
const via = (net: string, proxy: string, host: string) => tryDocker('run', '--rm', '--network', net, 'busybox:1.37', 'wget', '-qO-', '-T', '5', '--header', `Host: ${host}`, `http://${proxy}/`)

interface Ctx { headers: Record<string, string>, server: { id: string }, ep: { id: string }, env: string, previous: unknown }

async function setup(request: APIRequestContext, net: string): Promise<Ctx | null> {
  const { csrfToken } = await (await request.get('/api/auth/me')).json() as { csrfToken: string }
  const headers = { 'x-csrf-token': csrfToken }
  const servers = await (await request.get('/api/servers?pageSize=100')).json() as { items: { id: string, name: string }[] }
  const server = servers.items.find(s => s.name === 'agent-local')
  if (!server) return null
  const detail = await (await request.get(`/api/servers/${server.id}`)).json() as { endpoints: { id: string, enabled: boolean, environments: { key: string }[] }[] }
  const ep = detail.endpoints.find(e => e.enabled && e.environments.length)!
  const previous = ((await (await request.get(`/api/endpoints/${ep.id}/config`)).json()) as { traefik: unknown }).traefik
  docker('network', 'create', net)
  expect((await request.post(`/api/servers/${server.id}/discover`, { headers })).ok()).toBe(true)
  const nets = await (await request.get(`/api/endpoints/${ep.id}/networks`)).json() as { id: string, name: string }[]
  expect((await request.patch(`/api/networks/${nets.find(n => n.name === net)!.id}`, { data: { policy: 'allowed' }, headers })).status()).toBe(200)
  return { headers, server, ep, env: ep.environments[0]!.key, previous }
}

async function deploy(page: Page, request: APIRequestContext, c: Ctx, slug: string, host: string) {
  const { id } = await (await request.post('/api/projects', { data: { slug, name: `Proxy ${slug}`, target: { endpointId: c.ep.id, environmentKey: c.env } }, headers: c.headers })).json() as { id: string }
  const targetId = ((await (await request.get(`/api/projects/${id}`)).json()) as { targets: { id: string }[] }).targets[0]!.id
  const ex = await request.put(`/api/targets/${targetId}/exposures`, { data: [{ service: 'web', host, port: 80, pathPrefix: null, middlewares: [] }], headers: c.headers })
  expect(ex.status(), await ex.text()).toBe(200)
  await page.goto(`/projects/${id}`)
  await expect(async () => {
    await page.getByRole('button', { name: 'Nouveau déploiement' }).click({ timeout: 5000 })
    await expect(page.getByRole('textbox', { name: 'Contenu du fichier Compose' })).toBeVisible({ timeout: 3000 })
  }).toPass({ timeout: 30_000 })
  await page.getByRole('textbox', { name: 'Contenu du fichier Compose' }).fill('services:\n  web:\n    image: traefik/whoami:v1.10\n')
  await page.getByRole('button', { name: 'Analyser ce Compose' }).click({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Déployer', exact: true }).click({ timeout: 60_000 })
  await page.getByRole('dialog').getByRole('button', { name: 'Déployer' }).click({ timeout: 10_000 })
  await expect(page.getByRole('log')).toContainText(/Statut : (HEALTHY|FAILED|DEGRADED)/, { timeout: 300_000 })
  await expect(page.getByRole('log')).toContainText('Statut : HEALTHY')
  return { id }
}

test.describe.serial('reverse proxies nginx', () => {
  test('nginx-proxy : variables VIRTUAL_HOST posées, site servi par le proxy', async ({ page, request }) => {
    test.setTimeout(900_000)
    const tag = Date.now().toString(36)
    const net = `ngxp-${tag}`
    const proxy = `ngxp-${tag}-proxy`
    const c = await setup(request, net)
    test.skip(!c, 'serveur agent-local absent')
    docker('run', '-d', '--name', proxy, '--network', net, '-v', '/var/run/docker.sock:/tmp/docker.sock:ro', 'nginxproxy/nginx-proxy:1.6')
    const slug = `ngxp-${tag}`
    const host = `app.${tag}.ngx.test`
    let project: { id: string } | null = null
    try {
      const put = await request.put(`/api/endpoints/${c!.ep.id}/traefik`, { data: { networkName: net, allowedDomains: ['*.ngx.test', `*.${tag}.ngx.test`], exposure: 'internal', redirectToHttps: false, provider: 'nginx-proxy' }, headers: c!.headers })
      expect(put.status(), await put.text()).toBe(200)
      project = await deploy(page, request, c!, slug, host)
      const web = `${slug}-${c!.env}-web-1`
      expect(docker('inspect', '-f', '{{range .Config.Env}}{{println .}}{{end}}', web)).toContain(`VIRTUAL_HOST=${host}`)
      await expect.poll(() => via(net, proxy, host), { timeout: 60_000 }).toContain(`Hostname: `)
      expect(via(net, proxy, host)).toContain(`X-Forwarded-Host: ${host}`)
    }
    finally {
      if (project) await request.post(`/api/projects/${project.id}/removal`, { data: { mode: 'delete', confirm: slug }, headers: c!.headers }).catch(() => null)
      if (c!.previous) await request.put(`/api/endpoints/${c!.ep.id}/traefik`, { data: c!.previous, headers: c!.headers }).catch(() => null)
      tryDocker('rm', '-f', proxy)
      await expect(async () => expect(tryDocker('network', 'rm', net)).toBe(net)).toPass({ timeout: 60_000 }).catch(() => {})
    }
  })

  test('nginx classique : fichier conf.d écrit et nginx rechargé, site servi ; fichier vidé à la suppression', async ({ page, request }) => {
    test.setTimeout(900_000)
    const tag = Date.now().toString(36)
    const net = `ngxc-${tag}`
    const proxy = `ngxc-${tag}-nginx`
    const c = await setup(request, net)
    test.skip(!c, 'serveur agent-local absent')
    docker('run', '-d', '--name', proxy, '--network', net, 'nginx:1.27-alpine')
    const slug = `ngxc-${tag}`
    const host = `app.${tag}.ngx.test`
    let project: { id: string } | null = null
    try {
      const put = await request.put(`/api/endpoints/${c!.ep.id}/traefik`, { data: { networkName: net, allowedDomains: [`*.${tag}.ngx.test`], exposure: 'internal', redirectToHttps: true, provider: 'nginx', nginxContainer: proxy, nginxConfDir: '/etc/nginx/conf.d' }, headers: c!.headers })
      expect(put.status(), await put.text()).toBe(200)
      // Conteneur absent ou hors du réseau : refusé à l'enregistrement.
      const bad = await request.put(`/api/endpoints/${c!.ep.id}/traefik`, { data: { networkName: net, allowedDomains: [`*.${tag}.ngx.test`], provider: 'nginx', nginxContainer: 'inexistant-xyz' }, headers: c!.headers })
      expect(bad.status()).toBe(422)
      project = await deploy(page, request, c!, slug, host)
      await expect(page.getByRole('log')).toContainText(`nginx : 1 site(s) écrits dans /etc/nginx/conf.d/platform-${slug}-${c!.env}.conf et nginx rechargé`)
      const conf = docker('exec', proxy, 'cat', `/etc/nginx/conf.d/platform-${slug}-${c!.env}.conf`)
      expect(conf).toContain(`server_name ${host};`)
      expect(conf).toContain(`http://${slug}-${c!.env}-web:80`)
      await expect.poll(() => via(net, proxy, host), { timeout: 60_000 }).toContain('Hostname: ')

      // Logs d'accès : format de la console (domaine, durée), lus par cible et par proxy.
      expect(conf).toContain('access_log /dev/stdout platform_json;')
      expect(docker('exec', proxy, 'cat', '/etc/nginx/conf.d/platform--log-format.conf')).toContain('log_format platform_json escape=json')
      tryDocker('run', '--rm', '--network', net, 'busybox:1.37', 'wget', '-qO-', '-T', '5', '--header', `Host: ${host}`, `http://${proxy}/introuvable-e2e`)
      const targetId = ((await (await request.get(`/api/projects/${project.id}`)).json()) as { targets: { id: string }[] }).targets[0]!.id
      type Logs = { hosts: string[], entries: { host: string | null, path: string, status: number, duration: number | null, format: string }[], stats: { requests: number, status: Record<string, number> }, hint: string | null }
      await expect.poll(async () => ((await (await request.get(`/api/targets/${targetId}/access-logs`)).json()) as Logs).stats.requests, { timeout: 30_000 }).toBeGreaterThanOrEqual(2)
      const logs = (await (await request.get(`/api/targets/${targetId}/access-logs`)).json()) as Logs
      expect(logs.hosts).toEqual([host])
      expect(logs.hint).toBeNull()
      expect(logs.entries[0]).toMatchObject({ host, format: 'console' })
      expect(logs.entries.find(e => e.path === '/introuvable-e2e')?.status).toBe(200)
      const filtered = (await (await request.get(`/api/targets/${targetId}/access-logs?status=2xx&search=introuvable`)).json()) as Logs
      expect(filtered.entries.every(e => e.path.includes('introuvable'))).toBe(true)
      const nginxId = docker('inspect', '-f', '{{.Id}}', proxy)
      const byProxy = (await (await request.get(`/api/endpoints/${c!.ep.id}/proxy/${nginxId}/access-logs?hosts=${host}`)).json()) as Logs
      expect(byProxy.stats.requests).toBe(logs.stats.requests)
      await page.goto(`/projects/${project.id}?tab=access`)
      await expect(page.getByRole('cell', { name: '/introuvable-e2e' }).first()).toBeVisible({ timeout: 30_000 })

      // Suppression du projet : fichier vidé, nginx rechargé, le site ne répond plus.
      await request.post(`/api/projects/${project.id}/removal`, { data: { mode: 'delete', confirm: slug }, headers: c!.headers })
      project = null
      await expect.poll(() => tryDocker('exec', proxy, 'cat', `/etc/nginx/conf.d/platform-${slug}-${c!.env}.conf`), { timeout: 180_000 }).not.toContain('server {')
      await expect.poll(() => via(net, proxy, host), { timeout: 60_000 }).not.toContain('Hostname: ')
    }
    finally {
      if (project) await request.post(`/api/projects/${project.id}/removal`, { data: { mode: 'delete', confirm: slug }, headers: c!.headers }).catch(() => null)
      if (c!.previous) await request.put(`/api/endpoints/${c!.ep.id}/traefik`, { data: c!.previous, headers: c!.headers }).catch(() => null)
      tryDocker('rm', '-f', proxy)
      await expect(async () => expect(tryDocker('network', 'rm', net)).toBe(net)).toPass({ timeout: 60_000 }).catch(() => {})
    }
  })

  test('nginx classique : certificat importé déposé, HTTPS et redirection ; détection du proxy', async ({ page, request }) => {
    test.setTimeout(900_000)
    const tag = Date.now().toString(36)
    const net = `ngxt-${tag}`
    const proxy = `ngxt-${tag}-nginx`
    const c = await setup(request, net)
    test.skip(!c, 'serveur agent-local absent')
    // Image personnalisée (nom sans « nginx » reconnaissable) : techno lue dans sa configuration.
    docker('tag', 'nginx:1.27-alpine', 'local/bastion-pro-web:e2e')
    docker('run', '-d', '--name', proxy, '--network', net, '-p', '127.0.0.1::80', '-p', '127.0.0.1::443', 'local/bastion-pro-web:e2e')
    const slug = `ngxt-${tag}`
    const host = `app.${tag}.ngx.test`
    // Certificat auto-signé jetable, généré pour ce test.
    const dir = mkdtempSync(join(tmpdir(), 'ngx-cert-'))
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30', '-subj', `/CN=${host}`, '-addext', `subjectAltName=DNS:${host}`, '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem')], { stdio: 'ignore' })
    let project: { id: string } | null = null
    let certId: string | null = null
    try {
      // Détection : le conteneur nginx publiant 80/443 est proposé, avec son réseau.
      const sugg = await (await request.get(`/api/endpoints/${c!.ep.id}/proxy/suggestion?container=${proxy}`)).json() as { available: boolean, config: Record<string, unknown>, candidates: { container: string, provider: string | null, selected: boolean }[] }
      expect(sugg.candidates.find(x => x.container === proxy)).toMatchObject({ provider: 'nginx', selected: true })
      expect(sugg.config).toMatchObject({ provider: 'nginx', nginxContainer: proxy, networkName: net, redirectToHttps: true })

      const put = await request.put(`/api/endpoints/${c!.ep.id}/traefik`, { data: { ...sugg.config, allowedDomains: [`*.${tag}.ngx.test`] }, headers: c!.headers })
      expect(put.status(), await put.text()).toBe(200)
      const imp = await request.post(`/api/endpoints/${c!.ep.id}/managed-proxy/certificates`, { data: { certPem: readFileSync(join(dir, 'c.pem'), 'utf8'), keyPem: readFileSync(join(dir, 'k.pem'), 'utf8'), isDefault: false }, headers: c!.headers })
      expect(imp.status(), await imp.text()).toBe(201)
      certId = ((await imp.json()) as { certificate: { id: string } }).certificate.id

      project = await deploy(page, request, c!, slug, host)
      await expect(page.getByRole('log')).toContainText('(1 en HTTPS, certificats dans /etc/nginx/platform-certs)')
      expect(docker('exec', proxy, 'ls', '-l', `/etc/nginx/platform-certs/${host}.key`)).toMatch(/^-rw-------/)
      const conf = docker('exec', proxy, 'cat', `/etc/nginx/conf.d/platform-${slug}-${c!.env}.conf`)
      expect(conf).toContain(`ssl_certificate /etc/nginx/platform-certs/${host}.crt;`)
      const curl = (...args: string[]) => tryDocker('run', '--rm', '--network', net, 'curlimages/curl:8.11.1', '-sk', '-m', '5', '--connect-to', `${host}:443:${proxy}:443`, '--connect-to', `${host}:80:${proxy}:80`, ...args)
      await expect.poll(() => curl(`https://${host}/`), { timeout: 60_000 }).toContain('Hostname: ')
      expect(curl('-o', '/dev/null', '-w', '%{http_code} %{redirect_url}', `http://${host}/x`)).toBe(`301 https://${host}/x`)
      expect(curl('-v', '-o', '/dev/null', `https://${host}/`, '--stderr', '-')).toContain(`subject: CN=${host}`)

      // Mise en service à la demande : fichiers redéposés, nginx rechargé.
      const sync = await request.post(`/api/endpoints/${c!.ep.id}/nginx-certificates/sync`, { headers: c!.headers })
      expect(sync.status(), await sync.text()).toBe(200)
      expect(((await sync.json()) as { results: { pushed: number, errors: string[] }[] }).results[0]).toMatchObject({ pushed: 1, errors: [] })

      // Lecture des proxies (onglet Proxy, page Reverse proxies) : nginx déclaré présenté comme Traefik.
      const topo = await (await request.get(`/api/endpoints/${c!.ep.id}/proxy?refresh=1`)).json() as { proxies: { kind: string, container: { name: string }, nginx: { managed: { provider: string } | null, platformSites: number } | null }[], routes: { hosts: string[], tls: boolean, redirectsToHttps: boolean, warnings: string[], container: { stack: string | null } | null }[] }
      expect(topo.proxies.find(p => p.container.name === proxy)).toMatchObject({ kind: 'nginx', nginx: { managed: { provider: 'nginx' }, platformSites: 1 } })
      expect(topo.routes.find(r => r.hosts.includes(host) && r.tls)).toMatchObject({ redirectsToHttps: true, warnings: [], container: { stack: `${slug}-${c!.env}` } })
      const pmap = await (await request.get(`/api/endpoints/${c!.ep.id}/proxy-map?refresh=1`)).json() as { certificates: { host: string, issuer: string | null, state: string }[] }
      expect(pmap.certificates.find(x => x.host === host)).toMatchObject({ state: 'valid', issuer: expect.stringContaining('(importé)') })
      await page.goto(`/servers/${c!.server.id}?tab=proxy&endpoint=${c!.ep.id}`)
      await expect(page.locator('section', { hasText: proxy }).getByText('reverse proxy des projets')).toBeVisible({ timeout: 60_000 })
      await expect(page.getByRole('cell', { name: host }).first()).toBeVisible()
      await page.goto(`/proxies?endpoint=${c!.ep.id}`)
      await expect(page.getByRole('combobox', { name: 'Proxy' })).toContainText(`nginx (${proxy})`, { timeout: 60_000 })

      // Onglet Reverse proxy : certificats nginx affichés, candidats détectés.
      await page.goto(`/servers/${c!.server.id}?tab=traefik&endpoint=${c!.ep.id}`)
      await expect(page.getByRole('heading', { name: 'Certificats nginx' })).toBeVisible({ timeout: 30_000 })
      // nginx en service : pas de Traefik géré proposé à côté, état du reverse proxy affiché.
      await expect(page.getByText('Traefik géré par la plateforme')).toHaveCount(0)
      await expect(page.getByText(`nginx (${proxy}) · ${net}`)).toBeVisible()
      await expect(page.getByRole('cell', { name: host }).first()).toBeVisible()
      await page.getByRole('button', { name: 'Détecter le reverse proxy' }).click()
      await expect(page.getByText('Conteneurs détectés')).toBeVisible({ timeout: 60_000 })
      await expect(page.locator('.candidates li', { hasText: proxy })).toBeVisible()
    }
    finally {
      if (project) await request.post(`/api/projects/${project.id}/removal`, { data: { mode: 'delete', confirm: slug }, headers: c!.headers }).catch(() => null)
      if (certId) await request.delete(`/api/endpoints/${c!.ep.id}/managed-proxy/certificates/${certId}`, { headers: c!.headers }).catch(() => null)
      if (c!.previous) await request.put(`/api/endpoints/${c!.ep.id}/traefik`, { data: c!.previous, headers: c!.headers }).catch(() => null)
      rmSync(dir, { recursive: true, force: true })
      tryDocker('rm', '-f', proxy)
      tryDocker('rmi', 'local/bastion-pro-web:e2e')
      await expect(async () => expect(tryDocker('network', 'rm', net)).toBe(net)).toPass({ timeout: 60_000 }).catch(() => {})
    }
  })

  // Autorité ACME de test (Pebble, validation toujours acceptée) joignable par le worker sous « pebble » :
  // docker run -d --name pebble --network sherpa-dev_default -e PEBBLE_VA_ALWAYS_VALID=1 ghcr.io/letsencrypt/pebble
  // et son AC (test/certs/pebble.minica.pem de l'image) ajoutée à .data/ca/runtime-ca.pem.
  test('nginx classique : Let\'s Encrypt par la console (Pebble), certificat obtenu et servi', async ({ page, request }) => {
    test.skip(tryDocker('inspect', '-f', '{{.State.Running}}', 'pebble') !== 'true', 'autorité ACME de test (pebble) absente')
    test.setTimeout(900_000)
    const tag = Date.now().toString(36)
    const net = `ngxa-${tag}`
    const proxy = `ngxa-${tag}-nginx`
    const c = await setup(request, net)
    test.skip(!c, 'serveur agent-local absent')
    docker('run', '-d', '--name', proxy, '--network', net, 'nginx:1.27-alpine')
    const slug = `ngxa-${tag}`
    const host = `app.${tag}.ngx.test`
    let project: { id: string } | null = null
    try {
      const put = await request.put(`/api/endpoints/${c!.ep.id}/traefik`, { data: { networkName: net, allowedDomains: [`*.${tag}.ngx.test`], exposure: 'internal', redirectToHttps: true, provider: 'nginx', nginxContainer: proxy, nginxAcmeEmail: 'admin@example.org', nginxAcmeDirectory: 'https://pebble:14000/dir' }, headers: c!.headers })
      expect(put.status(), await put.text()).toBe(200)
      project = await deploy(page, request, c!, slug, host)
      await expect(page.getByRole('log')).toContainText(`Let's Encrypt : certificat obtenu pour ${host}`)
      await expect(page.getByRole('log')).toContainText('(1 en HTTPS, certificats dans /etc/nginx/platform-certs)')
      const conf = docker('exec', proxy, 'cat', `/etc/nginx/conf.d/platform-${slug}-${c!.env}.conf`)
      expect(conf).toContain('location ^~ /.well-known/acme-challenge/ {')
      const curl = (...args: string[]) => tryDocker('run', '--rm', '--network', net, 'curlimages/curl:8.11.1', '-sk', '-m', '5', '--connect-to', `${host}:443:${proxy}:443`, ...args)
      await expect.poll(() => curl(`https://${host}/`), { timeout: 60_000 }).toContain('Hostname: ')
      expect(curl('-v', '-o', '/dev/null', `https://${host}/`, '--stderr', '-')).toMatch(/issuer: CN=Pebble Intermediate/)
      const certs = await (await request.get(`/api/endpoints/${c!.ep.id}/managed-proxy/certificates`)).json() as { domains: string[], source: string }[]
      expect(certs.find(x => x.domains.includes(host))).toMatchObject({ source: 'acme' })
      // Déjà valable : pas de nouvelle demande à la mise en service.
      const sync = await (await request.post(`/api/endpoints/${c!.ep.id}/nginx-certificates/sync`, { headers: c!.headers })).json() as { results: { pushed: number, issued: string[], errors: string[] }[] }
      expect(sync.results[0]).toMatchObject({ pushed: 1, issued: [], errors: [] })
    }
    finally {
      if (project) await request.post(`/api/projects/${project.id}/removal`, { data: { mode: 'delete', confirm: slug }, headers: c!.headers }).catch(() => null)
      const certs = await (await request.get(`/api/endpoints/${c!.ep.id}/managed-proxy/certificates`)).json().catch(() => []) as { id: string, domains: string[] }[]
      for (const x of certs.filter(x => x.domains.includes(host))) await request.delete(`/api/endpoints/${c!.ep.id}/managed-proxy/certificates/${x.id}`, { headers: c!.headers }).catch(() => null)
      if (c!.previous) await request.put(`/api/endpoints/${c!.ep.id}/traefik`, { data: c!.previous, headers: c!.headers }).catch(() => null)
      tryDocker('rm', '-f', proxy)
      await expect(async () => expect(tryDocker('network', 'rm', net)).toBe(net)).toPass({ timeout: 60_000 }).catch(() => {})
    }
  })

  // DNS-01 : faux Cloudflare servi par ce test sur l'hôte, la console lancée avec
  // ACME_DNS_CLOUDFLARE_API=http://host.docker.internal:18310/client/v4 ACME_DNS_PROPAGATION_SEC=0, et Pebble (ci-dessus).
  test('Let\'s Encrypt par DNS-01 (faux Cloudflare, Pebble) : certificat générique partagé, TXT retirés', async ({ page, request }) => {
    const cfApi = tryDocker('exec', 'sherpa-dev-worker-1', 'printenv', 'ACME_DNS_CLOUDFLARE_API')
    test.skip(tryDocker('inspect', '-f', '{{.State.Running}}', 'pebble') !== 'true' || cfApi !== 'http://host.docker.internal:18310/client/v4', 'Pebble ou faux Cloudflare non configurés')
    test.setTimeout(900_000)
    const tag = Date.now().toString(36)
    const zone = `${tag}.dns.test`
    // Faux Cloudflare : zones, enregistrements TXT créés et retirés.
    const records = new Map<string, { name: string, content: string }>()
    const log: string[] = []
    const cf: Server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        const ok = (result: unknown, info?: unknown) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: true, errors: [], result, result_info: info }))
        if (req.headers.authorization !== 'Bearer jeton-cloudflare-e2e') return res.writeHead(403).end(JSON.stringify({ success: false, errors: [{ message: 'Invalid API Token' }] }))
        const url = req.url ?? ''
        if (req.method === 'GET' && url.startsWith('/client/v4/zones?')) return ok([{ id: 'zone1', name: zone }], { total_pages: 1 })
        const m = url.match(/^\/client\/v4\/zones\/zone1\/dns_records(?:\/(\w+))?$/)
        if (m && req.method === 'POST') {
          const r = JSON.parse(body) as { name: string, content: string }
          const id = `r${records.size + log.length}`
          records.set(id, r)
          log.push(`+${r.name}`)
          return ok({ id })
        }
        if (m?.[1] && req.method === 'DELETE') {
          log.push(`-${records.get(m[1])?.name}`)
          records.delete(m[1])
          return ok({ id: m[1] })
        }
        res.writeHead(404).end(JSON.stringify({ success: false, errors: [{ message: 'not found' }] }))
      })
    })
    await new Promise<void>(r => cf.listen(18310, '0.0.0.0', r))
    const net = `ngxd-${tag}`
    const proxy = `ngxd-${tag}-nginx`
    const c = await setup(request, net)
    test.skip(!c, 'serveur agent-local absent')
    docker('run', '-d', '--name', proxy, '--network', net, 'nginx:1.27-alpine')
    const slug = `ngxd-${tag}`
    const host = `app.${zone}`
    let project: { id: string } | null = null
    let accountId: string | null = null
    try {
      const bad = await request.post('/api/admin/dns-accounts', { data: { name: `cf-${tag}`, credentials: { provider: 'cloudflare', apiToken: 'mauvais-jeton-e2e' } }, headers: c!.headers })
      expect(bad.status()).toBe(422)
      const acc = await request.post('/api/admin/dns-accounts', { data: { name: `cf-${tag}`, wildcard: true, credentials: { provider: 'cloudflare', apiToken: 'jeton-cloudflare-e2e' } }, headers: c!.headers })
      expect(acc.status(), await acc.text()).toBe(201)
      const created = (await acc.json()) as { account: { id: string, zones: string[] } }
      accountId = created.account.id
      expect(created.account.zones).toEqual([zone])
      expect(JSON.stringify(await (await request.get('/api/admin/dns-accounts')).json())).not.toContain('jeton-cloudflare-e2e')

      const put = await request.put(`/api/endpoints/${c!.ep.id}/traefik`, { data: { networkName: net, allowedDomains: [`*.${zone}`], exposure: 'internal', redirectToHttps: true, provider: 'nginx', nginxContainer: proxy, nginxAcmeEmail: 'admin@example.org', nginxAcmeDirectory: 'https://pebble:14000/dir' }, headers: c!.headers })
      expect(put.status(), await put.text()).toBe(200)
      project = await deploy(page, request, c!, slug, host)
      await expect(page.getByRole('log')).toContainText(`Let's Encrypt : certificat obtenu pour *.${zone}, ${zone} (dns-01, compte DNS cf-${tag}`)
      // Deux défis (générique et parent) : deux TXT créés puis retirés.
      expect(log.filter(l => l === `+_acme-challenge.${zone}`)).toHaveLength(2)
      expect(log.filter(l => l === `-_acme-challenge.${zone}`)).toHaveLength(2)
      expect(records.size).toBe(0)
      const certs = await (await request.get(`/api/endpoints/${c!.ep.id}/managed-proxy/certificates`)).json() as { domains: string[], source: string, covers: string[] }[]
      expect(certs.find(x => x.domains.includes(`*.${zone}`))).toMatchObject({ source: 'acme', covers: [host] })
      const curl = (...args: string[]) => tryDocker('run', '--rm', '--network', net, 'curlimages/curl:8.11.1', '-sk', '-m', '5', '--connect-to', `${host}:443:${proxy}:443`, ...args)
      await expect.poll(() => curl(`https://${host}/`), { timeout: 60_000 }).toContain('Hostname: ')

      await page.goto('/admin/dns')
      await expect(page.getByRole('row', { name: new RegExp(`cf-${tag}`) })).toContainText(zone)
    }
    finally {
      if (project) await request.post(`/api/projects/${project.id}/removal`, { data: { mode: 'delete', confirm: slug }, headers: c!.headers }).catch(() => null)
      const certs = await (await request.get(`/api/endpoints/${c!.ep.id}/managed-proxy/certificates`)).json().catch(() => []) as { id: string, domains: string[] }[]
      for (const x of certs.filter(x => x.domains.some(d => d.endsWith(zone)))) await request.delete(`/api/endpoints/${c!.ep.id}/managed-proxy/certificates/${x.id}`, { headers: c!.headers }).catch(() => null)
      if (accountId) await request.delete(`/api/admin/dns-accounts/${accountId}`, { headers: c!.headers }).catch(() => null)
      if (c!.previous) await request.put(`/api/endpoints/${c!.ep.id}/traefik`, { data: c!.previous, headers: c!.headers }).catch(() => null)
      tryDocker('rm', '-f', proxy)
      cf.close()
      await expect(async () => expect(tryDocker('network', 'rm', net)).toBe(net)).toPass({ timeout: 60_000 }).catch(() => {})
    }
  })
})
