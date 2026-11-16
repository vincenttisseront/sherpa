/**
 * Disposition de la topologie réseau d'un hôte (fonction pure, sans dépendance à l'interface) :
 * domaines à gauche, conteneurs regroupés par stack au centre, réseaux à droite.
 * Les arêtes relient un domaine au conteneur qui le déclare, et un conteneur à chacun de ses réseaux.
 */
export interface TopoInput {
  id: string
  name: string
  service: string | null
  stack: string | null
  state: string
  health: string | null
  networks: string[]
  hosts: string[]
  managed: boolean
  project: string | null
}

export interface TopoNode { x: number, y: number, w: number, h: number }
export interface TopoLayout {
  width: number
  height: number
  groups: (TopoNode & { key: string, label: string, project: string | null })[]
  containers: (TopoInput & TopoNode & { key: string })[]
  networks: (TopoNode & { key: string, name: string, members: number, builtin: boolean })[]
  domains: (TopoNode & { key: string, host: string })[]
  edges: { key: string, kind: 'net' | 'host', from: string, to: string, path: string }[]
}

export const BUILTIN_NETWORKS = ['bridge', 'host', 'none']
const W = 1000
const COL = { domain: { x: 8, w: 230 }, container: { x: 330, w: 320 }, network: { x: 742, w: 250 } }
const ROW = { h: 34, gap: 6, groupTop: 26, groupPad: 8, groupGap: 14, nodeH: 30, nodeGap: 12 }

const label = (c: TopoInput) => c.service ?? c.name

/** Positions sans chevauchement : triées par ordonnée souhaitée, décalées vers le bas au besoin. */
function spread<T extends { want: number }>(items: T[], h: number, gap: number): (T & { y: number })[] {
  let bottom = -Infinity
  return [...items].sort((a, b) => a.want - b.want).map((it) => {
    const y = Math.max(it.want - h / 2, bottom + gap)
    bottom = y + h
    return { ...it, y }
  })
}

export function layoutTopology(items: readonly TopoInput[], opts: { hideBuiltin?: boolean } = {}): TopoLayout {
  const containers: TopoLayout['containers'] = []
  const groups: TopoLayout['groups'] = []

  // Conteneurs par stack (isolés à la fin), puis par service.
  const byStack = new Map<string, TopoInput[]>()
  for (const c of items) byStack.set(c.stack ?? '~', [...(byStack.get(c.stack ?? '~') ?? []), c])
  let y = 8
  for (const [stack, list] of [...byStack.entries()].sort(([a], [b]) => (a === '~' ? 1 : b === '~' ? -1 : a.localeCompare(b)))) {
    list.sort((a, b) => label(a).localeCompare(label(b)))
    const top = y
    y += ROW.groupTop
    for (const c of list) {
      containers.push({ ...c, key: `c:${c.id}`, x: COL.container.x, y, w: COL.container.w, h: ROW.h })
      y += ROW.h + ROW.gap
    }
    y += ROW.groupPad - ROW.gap
    groups.push({ key: `g:${stack}`, label: stack === '~' ? 'Conteneurs hors stack' : stack, project: list.find(c => c.project)?.project ?? null, x: COL.container.x - 8, y: top, w: COL.container.w + 16, h: y - top })
    y += ROW.groupGap
  }
  const center = (c: { y: number, h: number }) => c.y + c.h / 2

  // Réseaux : à la hauteur moyenne de leurs conteneurs.
  const members = new Map<string, TopoLayout['containers']>()
  for (const c of containers) {
    for (const n of new Set(c.networks)) {
      if (opts.hideBuiltin && BUILTIN_NETWORKS.includes(n)) continue
      members.set(n, [...(members.get(n) ?? []), c])
    }
  }
  const networks: TopoLayout['networks'] = spread([...members.entries()].map(([name, cs]) => ({ name, cs, want: cs.reduce((s, c) => s + center(c), 0) / cs.length })), ROW.nodeH, ROW.nodeGap)
    .map(n => ({ key: `n:${n.name}`, name: n.name, members: n.cs.length, builtin: BUILTIN_NETWORKS.includes(n.name), x: COL.network.x, y: n.y, w: COL.network.w, h: ROW.nodeH }))

  // Domaines : à la hauteur moyenne des conteneurs qui les déclarent.
  const hosts = new Map<string, TopoLayout['containers']>()
  for (const c of containers) for (const h of new Set(c.hosts)) hosts.set(h, [...(hosts.get(h) ?? []), c])
  const domains: TopoLayout['domains'] = spread([...hosts.entries()].map(([host, cs]) => ({ host, cs, want: cs.reduce((s, c) => s + center(c), 0) / cs.length })), ROW.nodeH, ROW.nodeGap)
    .map(d => ({ key: `d:${d.host}`, host: d.host, x: COL.domain.x, y: d.y, w: COL.domain.w, h: ROW.nodeH }))

  const edges: TopoLayout['edges'] = []
  const curve = (x1: number, y1: number, x2: number, y2: number) => { const m = (x1 + x2) / 2; return `M${x1} ${y1} C${m} ${y1} ${m} ${y2} ${x2} ${y2}` }
  for (const d of domains) {
    for (const c of hosts.get(d.host)!) edges.push({ key: `${d.key}>${c.key}`, kind: 'host', from: d.key, to: c.key, path: curve(d.x + d.w, d.y + d.h / 2, c.x, center(c)) })
  }
  for (const n of networks) {
    for (const c of members.get(n.name)!) edges.push({ key: `${c.key}>${n.key}`, kind: 'net', from: c.key, to: n.key, path: curve(c.x + c.w, center(c), n.x, n.y + n.h / 2) })
  }
  const bottoms = [y, ...networks.map(n => n.y + n.h + 8), ...domains.map(d => d.y + d.h + 8)]
  return { width: W, height: Math.max(...bottoms), groups, containers, networks, domains, edges }
}
