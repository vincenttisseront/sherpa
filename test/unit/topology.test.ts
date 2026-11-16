import { describe, expect, it } from 'vitest'
import { type TopoInput, layoutTopology } from '../../app/utils/topology'

const c = (id: string, over: Partial<TopoInput> = {}): TopoInput => ({ id, name: `app-${id}-1`, service: id, stack: 'shop', state: 'running', health: null, networks: ['shop_default'], hosts: [], managed: true, project: 'Boutique', ...over })

describe('topologie réseau', () => {
  const items = [
    c('web', { networks: ['shop_default', 'platform-edge'], hosts: ['shop.example.org'] }),
    c('api', { networks: ['shop_default'] }),
    c('db', { networks: ['shop_default'] }),
    c('proxy', { stack: 'traefik', networks: ['platform-edge', 'bridge'], hosts: ['shop.example.org', 'traefik.example.org'], project: null }),
    c('solo', { stack: null, networks: ['host'] }),
  ]
  const l = layoutTopology(items)

  it('regroupe les conteneurs par stack, les isolés à la fin', () => {
    expect(l.groups.map(g => g.label)).toEqual(['shop', 'traefik', 'Conteneurs hors stack'])
    expect(l.containers.map(x => x.service)).toEqual(['api', 'db', 'web', 'proxy', 'solo'])
  })
  it('crée un nœud par réseau et par domaine, avec leurs membres', () => {
    expect(Object.fromEntries(l.networks.map(n => [n.name, n.members]))).toEqual({ shop_default: 3, 'platform-edge': 2, bridge: 1, host: 1 })
    expect(l.domains.map(d => d.host).sort()).toEqual(['shop.example.org', 'traefik.example.org'])
  })
  it('relie chaque conteneur à ses réseaux et chaque domaine à ses conteneurs', () => {
    expect(l.edges.filter(e => e.kind === 'net')).toHaveLength(7)
    expect(l.edges.filter(e => e.kind === 'host')).toHaveLength(3)
    expect(l.edges.every(e => /^M[\d.]+ [\d.]+ C/.test(e.path))).toBe(true)
  })
  it('masque les réseaux par défaut de Docker à la demande', () => {
    const h = layoutTopology(items, { hideBuiltin: true })
    expect(h.networks.map(n => n.name).sort()).toEqual(['platform-edge', 'shop_default'])
    expect(h.edges.filter(e => e.kind === 'net')).toHaveLength(5)
    expect(l.networks.filter(n => n.builtin).map(n => n.name).sort()).toEqual(['bridge', 'host'])
  })
  it('ne superpose jamais deux nœuds d\'une même colonne', () => {
    for (const col of [l.networks, l.domains, l.containers] as { y: number, h: number }[][]) {
      const s = [...col].sort((a, b) => a.y - b.y)
      for (let i = 1; i < s.length; i++) expect(s[i]!.y).toBeGreaterThanOrEqual(s[i - 1]!.y + s[i - 1]!.h)
    }
    expect(l.height).toBeGreaterThan(l.containers.at(-1)!.y)
  })
  it('supporte une liste vide', () => {
    const e = layoutTopology([])
    expect(e.containers).toEqual([])
    expect(Number.isFinite(e.height)).toBe(true)
  })
})
