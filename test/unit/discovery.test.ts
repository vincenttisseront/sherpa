import { describe, expect, it } from 'vitest'
import { createMockPortainerAdapter } from '../../server/adapters/portainer/mock'
import type { DockerContainer } from '../../server/adapters/portainer/types'
import { compareVersions, computeCapabilities, defaultNetworkDecision, detectTraefik, discoverServer, planSync } from '../../server/services/discovery'

const container = (over: Partial<DockerContainer>): DockerContainer => ({
  id: 'abcdef1234567890', names: ['c'], image: 'nginx:1', state: 'running', status: 'Up', labels: {}, networks: [], createdAt: '', ...over,
})

describe('versions et capacités', () => {
  it('compare les versions numériquement', () => {
    expect(compareVersions('2.19.0', '2.9.9')).toBeGreaterThan(0)
    expect(compareVersions('2.18.4', '2.19.0')).toBeLessThan(0)
    expect(compareVersions('2.19', '2.19.0')).toBe(0)
  })

  it('déduit les routes disponibles de la version', () => {
    expect(computeCapabilities('2.18.4', []).stacksStandaloneString).toBe(false)
    expect(computeCapabilities('2.27.4', [{ kind: 'docker_standalone' }])).toMatchObject({ stacksStandaloneString: true, dockerStandalone: true, kubernetes: false })
  })
})

describe('détection de Traefik', () => {
  it('trouve le conteneur Traefik et ses réseaux non système', () => {
    const t = detectTraefik([container({ names: ['proxy'], image: 'docker.io/library/traefik:v3.5', networks: ['bridge', 'edge'] })])
    expect(t).toEqual({ container: 'proxy', image: 'docker.io/library/traefik:v3.5', networks: ['edge'] })
  })

  it('ignore les images qui contiennent seulement le mot', () => {
    expect(detectTraefik([container({ image: 'acme/traefik-exporter:1' })])).toBeNull()
  })

  it('préfère un conteneur en cours d\'exécution', () => {
    const t = detectTraefik([
      container({ names: ['old'], image: 'traefik:v2', state: 'exited' }),
      container({ names: ['live'], image: 'traefik:v3', state: 'running' }),
    ])
    expect(t?.container).toBe('live')
  })
})

describe('politique par défaut des réseaux', () => {
  it('interdit les réseaux système', () => {
    for (const name of ['bridge', 'host', 'none']) expect(defaultNetworkDecision({ name }, []).policy).toBe('forbidden')
  })
  it('autorise le réseau de Traefik avec le rôle traefik', () => {
    expect(defaultNetworkDecision({ name: 'edge' }, ['edge'])).toMatchObject({ policy: 'allowed', role: 'traefik' })
    // Réseau privé d'une stack : créé par son Compose, utilisé par elle seule → interdit automatiquement.
    const compose = { 'com.docker.compose.project': 'shop', 'com.docker.compose.network': 'default' }
    expect(defaultNetworkDecision({ name: 'shop_default', labels: compose, stacks: ['shop'] }, [])).toMatchObject({ policy: 'forbidden', tags: ['auto'], description: expect.stringMatching(/stack « shop »/) })
    expect(defaultNetworkDecision({ name: 'shop_default', labels: compose, stacks: [] }, []).policy).toBe('forbidden')
    // Partagé avec une autre stack ou un conteneur isolé, ou créé à la main : décision de l'administrateur.
    expect(defaultNetworkDecision({ name: 'shop_default', labels: compose, stacks: ['shop', 'billing'] }, []).policy).toBe('unreviewed')
    expect(defaultNetworkDecision({ name: 'shop_default', labels: compose, stacks: ['shop', '(legacy-api)'] }, []).policy).toBe('unreviewed')
    expect(defaultNetworkDecision({ name: 'proxy', labels: {}, stacks: ['shop'] }, []).policy).toBe('unreviewed')
  })
  it('laisse les autres à examiner', () => {
    expect(defaultNetworkDecision({ name: 'apps' }, ['edge']).policy).toBe('unreviewed')
  })
})

describe('planSync', () => {
  it('sépare ajouts, mises à jour et disparitions', () => {
    expect(planSync(['a', 'b'], ['b', 'c'])).toEqual({ insert: ['c'], update: ['b'], missing: ['a'] })
  })
})

describe('discoverServer (mock)', () => {
  const conn = { url: 'https://p', token: 'ptr_valid_token', tlsVerify: true }

  it('découvre les endpoints avec inventaire, sans interroger les hors-ligne', async () => {
    const r = await discoverServer(createMockPortainerAdapter(), conn)
    expect(r.version).toBe('2.27.4')
    const local = r.endpoints.find(e => e.name === 'local')!
    expect(local.supported).toBe(true)
    expect(local.inventory.traefik?.networks).toEqual(['traefik-public'])
    const swarm = r.endpoints.find(e => e.name === 'swarm-lab')!
    expect(swarm).toMatchObject({ supported: false, error: 'Endpoint hors ligne', networks: [] })
  })

  it('refuse un Portainer 1.x', async () => {
    await expect(discoverServer(createMockPortainerAdapter(), { ...conn, token: 'ptr_v1_token' })).rejects.toThrow(/non supporté/)
  })
})
