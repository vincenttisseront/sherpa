import { describe, expect, it } from 'vitest'
import YAML from 'yaml'
import { type AnalyzeContext, analyzeCompose } from '../../server/lib/compose/analyze'
import { managedTraefikArgs, managedTraefikCompose } from '../../server/lib/proxy/managed'
import { evaluateBind } from '../../server/utils/bind-guard'
import { PathViolation, projectLayout, validateProjectPath } from '../../server/utils/path-guard'
import { managedProxyConfig } from '../../shared/schemas/managed-proxy'

const roots = { workingRoot: '/srv/deployments/staging', buildRoot: '/srv/builds/staging', tmpRoot: '/srv/tmp/staging', runtimeRoot: '/srv/apps-data/staging', forbiddenPaths: ['/srv/apps-data/staging/secret'] }

describe('chemin choisi pour un projet', () => {
  it('releases et données sous le même dossier', () => {
    const l = projectLayout(roots, 'phpipam', '/srv/apps-data/staging/ipam')
    expect(l.projectDir).toBe('/srv/apps-data/staging/ipam')
    expect(l.releasesDir).toBe('/srv/apps-data/staging/ipam/releases')
    expect(l.runtimeDir).toBe('/srv/apps-data/staging/ipam/data')
    expect(l.tmpDir).toBe('/srv/tmp/staging/phpipam')
  })
  it('sans chemin choisi : racines de l\'environnement', () => {
    const l = projectLayout(roots, 'phpipam', null)
    expect(l.projectDir).toBe('/srv/deployments/staging/phpipam')
    expect(l.runtimeDir).toBe('/srv/apps-data/staging/phpipam')
  })
  it.each([
    ['/opt/ipam', /sous/],
    ['/srv/apps-data/staging', /sous/],
    ['/srv/apps-data/staging/../x', /segment/],
    ['/srv/apps-data/staging/secret/ipam', /interdit/],
    ['/etc/ipam', /système/],
    ['relatif/ipam', /relatif/],
  ])('refuse %s', (p, reason) => {
    expect(() => validateProjectPath(roots, p)).toThrow(PathViolation)
    try {
      validateProjectPath(roots, p)
    }
    catch (e) {
      expect((e as PathViolation).reason).toMatch(reason)
    }
  })
  it('données montables même sous la racine de travail, releases jamais', () => {
    const l = projectLayout(roots, 'phpipam', '/srv/deployments/staging/ipam')
    const req = (hostPath: string) => evaluateBind({ hostPath, mode: 'rw', environmentId: 'e', projectId: 'p', projectRuntimeDir: l.runtimeDir, workingRoots: [roots.workingRoot] }, [])
    expect(req(`${l.runtimeDir}/mariadb`).allowed).toBe(true)
    expect(req(`${l.releasesDir}/r-0001`).allowed).toBe(false)
  })
})

const ctx = (over: Partial<AnalyzeContext> = {}): AnalyzeContext => ({
  projectSlug: 'phpipam', projectId: 'p1', environmentKey: 'staging', environmentId: 'e1', releaseSlug: 'r-0001-aaaaaa', composeDir: '',
  files: new Set(['compose.yml']), variables: {}, portRules: [], portApprovals: [], volumeRules: [], runtimeDir: '/srv/apps-data/staging/ipam/data', workingRoots: [],
  networks: [], dockerVolumes: ['shared-ca'], traefik: null, exposures: [], takenHosts: [],
  ...over,
})
const COMPOSE = `services:
  db:
    image: mariadb:11
    volumes:
      - db-data:/var/lib/mysql
  web:
    image: phpipam/phpipam-www:1.7
    volumes:
      - type: volume
        source: logo
        target: /phpipam/css/images/logo
      - ca:/usr/local/share/ca-certificates:ro
volumes:
  db-data: {}
  logo:
  ca:
    external: true
    name: shared-ca
`

describe('volumes du Compose en dossiers du projet', () => {
  it('volumes locaux → dossiers sous data/, volumes externes conservés', () => {
    const r = analyzeCompose(COMPOSE, ctx({ volumesAsFolders: true }))
    expect(r.issues.filter(i => i.severity === 'error')).toEqual([])
    const f = YAML.parse(r.finalYaml!)
    expect(f.services.db.volumes).toEqual(['/srv/apps-data/staging/ipam/data/db-data:/var/lib/mysql'])
    expect(f.services.web.volumes[0]).toMatchObject({ type: 'bind', source: '/srv/apps-data/staging/ipam/data/logo', target: '/phpipam/css/images/logo' })
    expect(f.services.web.volumes[1]).toBe('ca:/usr/local/share/ca-certificates:ro')
    expect(Object.keys(f.volumes ?? {})).toEqual(['ca'])
    expect(r.changes.some(c => /db-data.*data\/db-data/.test(c.message))).toBe(true)
  })
  it('option désactivée : volumes Docker inchangés', () => {
    const f = YAML.parse(analyzeCompose(COMPOSE, ctx()).finalYaml!)
    expect(f.services.db.volumes).toEqual(['db-data:/var/lib/mysql'])
  })
})

describe('Traefik géré par la plateforme', () => {
  const base = { networks: ['platform-edge', 'apps'], acme: { enabled: true, email: 'ops@exploitation.fr', challenge: 'http' } }
  it('arguments : fournisseur Docker contraint, redirection, résolveur par défaut, autorité de test', () => {
    const args = managedTraefikArgs(managedProxyConfig.parse(base))
    expect(args).toContain('--providers.docker.network=platform-edge')
    expect(args).toContain('--providers.docker.constraints=Label(`platform.managed`,`true`)')
    expect(args).toContain('--entrypoints.web.http.redirections.entrypoint.to=websecure')
    expect(args).toContain('--certificatesresolvers.le.acme.httpchallenge.entrypoint=web')
    expect(args).toContain('--certificatesresolvers.le.acme.caserver=https://acme-staging-v02.api.letsencrypt.org/directory')
    expect(args).toContain('--entrypoints.websecure.http.tls.certresolver=le')
  })
  it('challenge DNS : identifiants en références, jamais en clair', () => {
    const c = managedProxyConfig.parse({ ...base, bindAddress: '10.0.0.5', httpPort: 8080, httpsPort: 8443, acme: { ...base.acme, challenge: 'dns', dnsProvider: 'ovh', staging: false } })
    const y = YAML.parse(managedTraefikCompose(c, ['OVH_APPLICATION_KEY']).replace(/^#.*\n/, ''))
    const svc = y.services.traefik
    expect(svc.ports).toEqual(['10.0.0.5:8080:80', '10.0.0.5:8443:443'])
    expect(svc.environment).toEqual({ OVH_APPLICATION_KEY: '${OVH_APPLICATION_KEY}' })
    expect(svc.command).toContain('--certificatesresolvers.le.acme.dnschallenge.provider=ovh')
    expect(svc.command.some((a: string) => a.includes('caserver'))).toBe(false)
    expect(y.networks).toEqual({ 'platform-edge': { external: true, name: 'platform-edge' }, 'apps': { external: true, name: 'apps' } })
    expect(y.volumes).toEqual({ letsencrypt: {} })
    // Le $ des contraintes Traefik serait interpolé par Compose : doublé.
    expect(svc.command.find((a: string) => a.includes('constraints'))).toBe('--providers.docker.constraints=Label(`platform.managed`,`true`)')
  })
  it('validation : e-mail et fournisseur DNS requis, ports distincts', () => {
    expect(managedProxyConfig.safeParse({ networks: ['e'], acme: { enabled: true } }).success).toBe(false)
    expect(managedProxyConfig.safeParse({ networks: ['e'], acme: { enabled: true, email: 'a@b.fr', challenge: 'dns' } }).success).toBe(false)
    expect(managedProxyConfig.safeParse({ networks: ['e'], httpPort: 443, httpsPort: 443 }).success).toBe(false)
    // Let's Encrypt refuse les domaines réservés ; une autorité interne peut les accepter.
    expect(managedProxyConfig.safeParse({ networks: ['e'], acme: { enabled: true, email: 'ops@acme.test' } }).success).toBe(false)
    expect(managedProxyConfig.safeParse({ networks: ['e'], acme: { enabled: true, email: 'admin@localhost' } }).success).toBe(false)
    expect(managedProxyConfig.safeParse({ networks: ['e'], acme: { enabled: true, email: 'ops@contest.com' } }).success).toBe(true)
    expect(managedProxyConfig.safeParse({ networks: ['e'], acme: { enabled: true, email: 'ops@acme.test', caServer: 'https://ca.internal/acme/directory' } }).success).toBe(true)
    expect(managedProxyConfig.safeParse({ networks: ['e'], image: 'evil/traefik:latest' }).success).toBe(false)
  })
})
