import YAML from 'yaml'
import { describe, expect, it } from 'vitest'
import type { ProxyRoute } from '../../shared/schemas/proxy'
import { type AnalyzeContext, analyzeCompose } from '../../server/lib/compose/analyze'
import { convertCompose, dropMounts, dropPublishedPorts } from '../../server/lib/adoption/convert'

const route = (o: Partial<ProxyRoute>): ProxyRoute => ({
  router: 'r@docker', provider: 'docker', kind: 'http', rule: 'Host(`qb.example.org`)', hosts: ['qb.example.org'], pathPrefix: null, entrypoints: ['websecure'],
  tls: true, certResolver: 'le', tlsOptions: null, passthrough: false, redirectsToHttps: false, middlewares: [], service: null,
  container: { id: 'c1', name: 'seedbox-qbittorrent-1', stack: 'seedbox', service: 'qbittorrent', managed: false }, targetPort: 8080, targetUrl: null, network: 'edge', convertible: true, warnings: [],
  ...o,
})
const ctxFor = (routes: ProxyRoute[]) => ({ stackName: 'seedbox', traefikNetwork: 'edge', certResolver: 'le', routes, stackMiddlewares: new Map<string, string>(), foreignMiddlewareUsers: new Map<string, string[]>(), mounts: {}, runningImages: {} })
const SEED = 'services:\n  qbittorrent:\n    image: linuxserver/qbittorrent:5\n    ports: ["6881:6881/udp", "8080:8080"]\n    volumes:\n      - /etc/localtime:/etc/localtime\n      - ./config:/config # réglages\n'

const actx = (over: Partial<AnalyzeContext> = {}): AnalyzeContext => ({
  projectSlug: 'seedbox', projectId: 'p1', environmentKey: 'production', environmentId: 'e1', releaseSlug: 'r-0001-aaaaaa', composeDir: '',
  files: new Set(), variables: {}, portRules: [], portApprovals: [], volumeRules: [], runtimeDir: '/srv/data/seedbox', workingRoots: [],
  networks: [], dockerVolumes: [], traefik: null, exposures: [], takenHosts: [], ...over,
})

describe('reprise : points bloquants levables', () => {
  it('routeur automatique de Traefik (règle {{ normalize .Name }}) ignoré sans bloquer, silencieux si une vraie route existe', () => {
    const auto = route({ router: 'qbittorrent-seedbox@docker', rule: 'Host(`{{ normalize .Name }}`)', hosts: [], convertible: false })
    const withReal = convertCompose(SEED, ctxFor([route({}), auto]))
    expect(withReal.droppedRoutes).toEqual([])
    expect(withReal.notes.some(n => n.message.includes('{{'))).toBe(false)
    const alone = convertCompose(SEED, ctxFor([auto]))
    expect(alone.droppedRoutes).toEqual([])
    expect(alone.notes.find(n => n.message.includes('Routeur automatique'))).toMatchObject({ level: 'info', service: 'qbittorrent' })
  })

  it('/etc/localtime accepté sans règle, monté en lecture seule', () => {
    const r = analyzeCompose('services:\n  qbittorrent:\n    image: linuxserver/qbittorrent:5\n    volumes:\n      - /etc/localtime:/etc/localtime\n      - /etc/timezone:/etc/timezone:ro\n', actx())
    expect(r.issues.filter(i => i.severity === 'error')).toEqual([])
    expect(YAML.parse(r.finalYaml!).services.qbittorrent.volumes).toEqual(['/etc/localtime:/etc/localtime:ro', '/etc/timezone:/etc/timezone:ro'])
    expect(r.mounts.find(m => m.target === '/etc/localtime')?.reason).toContain('Fuseau horaire')
    // Les autres chemins système restent refusés.
    expect(analyzeCompose('services:\n  a:\n    image: x\n    volumes: ["/etc/passwd:/etc/passwd:ro"]\n', actx()).issues.some(i => i.code === 'volumes.refused')).toBe(true)
  })

  it('montage et port retirés de la reprise, commentaires conservés', () => {
    const m = dropMounts(SEED, [{ service: 'qbittorrent', target: '/etc/localtime' }, { service: 'autre', target: '/x' }])
    expect(m.removed).toEqual([{ service: 'qbittorrent', target: '/etc/localtime' }])
    expect(m.composeText).not.toContain('/etc/localtime')
    expect(m.composeText).toContain('# réglages')
    const p = dropPublishedPorts(m.composeText, [{ service: 'qbittorrent', published: 6881, protocol: 'udp' }])
    expect(p.removed).toHaveLength(1)
    expect(YAML.parse(p.composeText).services.qbittorrent.ports).toEqual(['8080:8080'])
  })
})
