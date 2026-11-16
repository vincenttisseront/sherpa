import { describe, expect, it } from 'vitest'
import { flatFromArgs } from '../../server/lib/proxy/flat'
import { type TopoContainer, buildTopology, evalConstraint } from '../../server/lib/proxy/topology'
import { interpretStatic } from '../../server/lib/proxy/traefik'
import { buildProxyGraph, flowOf, worstCert } from '../../shared/utils/proxy-graph'
import type { ProxyMapDto } from '../../shared/schemas/proxy-map'

const c = (o: Partial<TopoContainer> & { id: string }): TopoContainer => ({ name: o.id, image: 'app:1', state: 'running', labels: {}, networks: [], ports: [], ...o })

describe('contrainte du fournisseur Docker', () => {
  it('évalue Label, LabelRegex, négation et combinaisons', () => {
    const l = { 'platform.managed': 'true', 'env': 'staging' }
    expect(evalConstraint('Label(`platform.managed`,`true`)', l)).toBe(true)
    expect(evalConstraint('Label(`platform.managed`, `true`) && !Label(`env`,`prod`)', l)).toBe(true)
    expect(evalConstraint('Label(`env`,`prod`) || LabelRegex(`env`,`^stag`)', l)).toBe(true)
    expect(evalConstraint('(Label(`env`,`prod`))', {})).toBe(false)
    expect(evalConstraint('Tag(`x`)', l)).toBeNull()
  })
})

// Deux Traefik : celui de l'hôte (sans contrainte) et celui de la plateforme (platform.managed).
const hostT = c({ id: 'th', name: 'traefik', image: 'traefik:v3.6', networks: ['edge'], ports: [{ ip: null, privatePort: 443, publicPort: 443, type: 'tcp' }] })
const managedT = c({ id: 'tm', name: 'platform-traefik', image: 'traefik:v3.6', networks: ['platform-edge'], ports: [{ ip: '127.0.0.1', privatePort: 443, publicPort: 28443, type: 'tcp' }] })
const st = (extra: string[]) => interpretStatic(flatFromArgs(['--providers.docker=true', '--providers.docker.exposedbydefault=false', '--entrypoints.websecure.address=:443', '--entrypoints.websecure.http.tls.certresolver=le', '--certificatesresolvers.le.acme.storage=/letsencrypt/acme.json', ...extra]), 'cli', null)
const app = (id: string, net: string, managed: boolean, host: string) => c({
  id, name: `${id}-1`, networks: [net], ports: [{ ip: null, privatePort: 80, publicPort: null, type: 'tcp' }],
  labels: { 'com.docker.compose.project': id, 'com.docker.compose.service': 'web', 'traefik.enable': 'true', [`traefik.http.routers.${id}.rule`]: `Host(\`${host}\`)`, ...(managed ? { 'platform.managed': 'true' } : {}) },
})
const ipam = app('ipam', 'platform-edge', true, 'ipam.localhost')
const legacy = app('legacy', 'edge', false, 'legacy.example.org')
const db = c({ id: 'db', name: 'db-1', networks: ['platform-edge'], ports: [{ ip: null, privatePort: 5432, publicPort: 5432, type: 'tcp' }] })
const topo = buildTopology('ep', [hostT, managedT, ipam, legacy, db], [
  { kind: 'traefik', containerId: 'th', static: st([]), dynamic: [], sites: [], configFiles: [], warnings: [] },
  { kind: 'traefik', containerId: 'tm', static: st(['--providers.docker.constraints=Label(`platform.managed`,`true`)']), dynamic: [], sites: [], configFiles: [], warnings: [] },
])

describe('attribution des routes', () => {
  it('chaque conteneur est servi par le Traefik qui l\'accepte et le joint', () => {
    expect(topo.routes.find(r => r.hosts.includes('ipam.localhost'))?.proxyId).toBe('tm')
    expect(topo.routes.find(r => r.hosts.includes('legacy.example.org'))?.proxyId).toBe('th')
    expect(topo.warnings.join(' ')).not.toMatch(/non évaluée/)
  })
})

describe('vue flux : URL → port → proxy → stack', () => {
  const map: ProxyMapDto = {
    topology: topo,
    containers: [
      { id: 'ipam', name: 'ipam-1', image: 'app:1', stack: 'ipam', service: 'web', running: true, state: 'running', health: 'healthy', managed: true, project: { id: 'p1', name: 'phpIPAM', environment: 'staging' }, proxyNetworks: ['platform-edge'], hostPorts: [] },
      { id: 'legacy', name: 'legacy-1', image: 'app:1', stack: 'legacy', service: 'web', running: true, state: 'running', health: null, managed: false, project: null, proxyNetworks: ['edge'], hostPorts: [] },
      { id: 'db', name: 'db-1', image: 'postgres', stack: 'tools', service: 'db', running: true, state: 'running', health: null, managed: false, project: null, proxyNetworks: ['platform-edge'], hostPorts: [{ host: '0.0.0.0:5432', container: 5432, protocol: 'tcp' }] },
    ],
    resolvers: [],
    certificates: [
      { proxyId: 'tm', host: 'ipam.localhost', resolver: 'le', state: 'valid', issuer: 'R10', notAfter: '2027-01-01T00:00:00Z', staging: false, error: null },
      { proxyId: 'th', host: 'legacy.example.org', resolver: 'le', state: 'error', issuer: null, notAfter: null, staging: false, error: 'NXDOMAIN' },
    ],
    acmeErrors: [],
  }

  it('URL avec le port public réel, puis port de l\'hôte, proxy et stack', () => {
    const g = buildProxyGraph(map)
    const ipam = g.urls.find(u => u.host === 'ipam.localhost')!
    expect(ipam.url).toBe('https://ipam.localhost:28443')
    expect(ipam.cert).toBe('valid')
    expect(g.urls.find(u => u.host === 'legacy.example.org')).toMatchObject({ url: 'https://legacy.example.org', cert: 'error' })
    expect(g.edges).toContainEqual(expect.objectContaining({ from: ipam.id, to: 'port:tm:127.0.0.1:28443/tcp', kind: 'url' }))
    expect(g.edges).toContainEqual(expect.objectContaining({ from: 'port:tm:127.0.0.1:28443/tcp', to: 'proxy:tm', kind: 'port' }))
    expect(g.edges).toContainEqual(expect.objectContaining({ from: 'proxy:tm', to: 'stack:ipam', kind: 'stack', label: 'web:80' }))
    expect(ipam.stacks).toEqual(['stack:ipam'])
  })

  it('ports publiés hors proxy : port → stack directement ; aucun nœud conteneur', () => {
    const g = buildProxyGraph(map)
    expect(g.edges).toContainEqual(expect.objectContaining({ from: 'port:db:0.0.0.0:5432/tcp', to: 'stack:tools', kind: 'direct', warn: true }))
    expect(g.stacks.map(s => s.id)).toEqual(['stack:ipam', 'stack:legacy', 'stack:tools'])
    expect(g.stacks.find(s => s.id === 'stack:tools')!.kind).toBe('direct')
  })

  it('survol : une URL n\'éclaire que son flux, pas les autres stacks du même proxy', () => {
    const g = buildProxyGraph(map, { showDirect: false, showUnrouted: false })
    const ipam = g.urls.find(u => u.host === 'ipam.localhost')!
    const lit = flowOf(g, ipam.id)
    expect([...lit]).toEqual(expect.arrayContaining([ipam.id, 'port:tm:127.0.0.1:28443/tcp', 'proxy:tm', 'stack:ipam']))
    expect(lit.has('stack:legacy')).toBe(false)
    const fromStack = flowOf(g, 'stack:legacy')
    expect(fromStack.has(g.urls.find(u => u.host === 'legacy.example.org')!.id)).toBe(true)
    expect(fromStack.has(ipam.id)).toBe(false)
    expect(worstCert([], false)).toBe('none')
  })

  it('filtres : proxy et recherche', () => {
    expect(buildProxyGraph(map, { proxyId: 'tm', showDirect: false, showUnrouted: false }).urls.map(u => u.host)).toEqual(['ipam.localhost'])
    expect(buildProxyGraph(map, { query: 'legacy' }).urls.map(u => u.host)).toEqual(['legacy.example.org'])
  })
})
