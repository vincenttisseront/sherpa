/** Sous-réseaux des réseaux de projets : calcul d'adresses, réseaux d'un Compose, application à l'analyse. */
import { describe, expect, it } from 'vitest'
import YAML from 'yaml'
import { type AnalyzeContext, analyzeCompose } from '../../server/lib/compose/analyze'
import { capacity, firstFree, overlaps, parseCidr, within } from '../../server/lib/subnets'
import { composeNetworkKeys } from '../../server/services/network-pool'

const c = (t: string) => parseCidr(t)!
const ctx = (over: Partial<AnalyzeContext> = {}): AnalyzeContext => ({
  projectSlug: 'edutis', projectId: 'p1', environmentKey: 'production', environmentId: 'e1', releaseSlug: 'r-0001-abcdef',
  composeDir: '', files: new Set(['compose.yml']), variables: {}, portRules: [], portApprovals: [], volumeRules: [],
  runtimeDir: '/srv/apps-data/production/edutis', workingRoots: ['/srv/deployments/production'], networks: [], dockerVolumes: [],
  ...over,
})

describe('calcul de sous-réseaux', () => {
  it('lecture normalisée, invalides refusés', () => {
    expect(parseCidr('10.210.3.7/16')!.text).toBe('10.210.0.0/16')
    expect(parseCidr('10.210.0.0/33')).toBeNull()
    expect(parseCidr('300.1.1.1/8')).toBeNull()
    expect(parseCidr('10.0.0.0')).toBeNull()
  })

  it('recouvrement et inclusion', () => {
    expect(overlaps(c('172.24.0.0/16'), c('172.24.10.0/24'))).toBe(true)
    expect(overlaps(c('10.210.0.0/27'), c('10.210.0.32/27'))).toBe(false)
    expect(within(c('10.210.0.32/27'), c('10.210.0.0/16'))).toBe(true)
    expect(within(c('10.211.0.0/27'), c('10.210.0.0/16'))).toBe(false)
  })

  it('premier /27 libre, hors des plages prises ; plage épuisée', () => {
    const pool = c('10.210.0.0/24')
    expect(firstFree(pool, 27, [])!.text).toBe('10.210.0.0/27')
    expect(firstFree(pool, 27, [c('10.210.0.0/27'), c('10.210.0.64/26')])!.text).toBe('10.210.0.32/27')
    expect(firstFree(pool, 27, [c('10.210.0.0/24')])).toBeNull()
    expect(capacity(c('10.210.0.0/16'), 27)).toBe(2048)
  })
})

describe('réseaux créés par une stack', () => {
  it('déclarés non externes, et « default » si un service y est rattaché', () => {
    expect(composeNetworkKeys('services:\n  a:\n    image: x\n  b:\n    image: y\n    networks: [back]\nnetworks:\n  back: {}\n  proxy:\n    external: true\n')).toEqual(['back', 'default'])
    expect(composeNetworkKeys('services:\n  a:\n    image: x\n    networks: [back]\nnetworks:\n  back: {}\n')).toEqual(['back'])
    expect(composeNetworkKeys('services:\n  a:\n    image: x\n    network_mode: host\n')).toEqual([])
  })
})

describe('analyse : sous-réseaux de la plage', () => {
  it('ajoutés aux réseaux de la stack, « default » implicite compris ; IPAM du Compose conservé', () => {
    const r = analyzeCompose('services:\n  a:\n    image: nginx:1.27\n  b:\n    image: nginx:1.27\n    networks: [back, own]\nnetworks:\n  back: {}\n  own:\n    ipam:\n      config:\n        - subnet: 192.168.50.0/24\n', ctx({
      networkSubnets: { default: '10.210.0.0/27', back: '10.210.0.32/27', own: '10.210.0.64/27' },
    }))
    const nets = (YAML.parse(r.finalYaml!) as { networks: Record<string, { ipam?: { config: { subnet: string }[] } }> }).networks
    expect(nets.default!.ipam!.config[0]!.subnet).toBe('10.210.0.0/27')
    expect(nets.back!.ipam!.config[0]!.subnet).toBe('10.210.0.32/27')
    expect(nets.own!.ipam!.config[0]!.subnet).toBe('192.168.50.0/24')
    expect(r.issues.some(i => i.code === 'networks.subnet_kept')).toBe(true)
  })
})
