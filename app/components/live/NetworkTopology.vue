<script setup lang="ts">
/**
 * Topologie réseau : pour chaque hôte, les domaines (déclarés par les labels), les conteneurs regroupés par stack
 * et les réseaux Docker qui les relient. Survol, focus clavier ou clic sur un nœud : ses liens sont mis en évidence.
 */
import type { LiveContainer, LiveEndpoint } from '#shared/schemas/live'
import { type TopoInput, layoutTopology } from '~/utils/topology'

type Item = LiveContainer & { endpoint: LiveEndpoint }
const props = defineProps<{ containers: Item[] }>()
const emit = defineEmits<{ select: [container: Item] }>()

const hideBuiltin = ref(true)
const pinned = ref<string | null>(null)
const hovered = ref<string | null>(null)
const active = computed(() => hovered.value ?? pinned.value)

const hosts = computed(() => {
  const m = new Map<string, { endpoint: LiveEndpoint, items: Item[] }>()
  for (const c of props.containers) {
    const e = m.get(c.endpoint.endpointId) ?? { endpoint: c.endpoint, items: [] }
    e.items.push(c)
    m.set(c.endpoint.endpointId, e)
  }
  return [...m.values()].map(h => ({
    ...h,
    layout: layoutTopology(h.items.map(c => ({ id: c.id, name: c.name, service: c.service, stack: c.stack, state: c.state, health: c.health, networks: c.networks, hosts: c.hosts, managed: c.managed, project: c.project?.name ?? null } satisfies TopoInput)), { hideBuiltin: hideBuiltin.value }),
  }))
})

type Layout = (typeof hosts.value)[number]['layout']
/** Nœud actif et ses voisins directs : le reste est atténué. */
function related(l: Layout, key: string | null): Set<string> | null {
  if (!key) return null
  const s = new Set<string>([key])
  for (const e of l.edges) {
    if (e.from === key || e.to === key) { s.add(e.from); s.add(e.to) }
  }
  return s
}
const dim = (l: Layout, key: string) => { const r = related(l, active.value); return !!r && !r.has(key) }
/** Un lien est mis en évidence quand il touche le nœud actif. */
const edgeOn = (e: Layout['edges'][number]) => e.from === active.value || e.to === active.value
function toggle(key: string) { pinned.value = pinned.value === key ? null : key }

const stateTone = (c: { state: string, health: string | null }) => (c.state !== 'running' ? 'off' : c.health === 'unhealthy' ? 'bad' : c.health === 'starting' ? 'warn' : 'ok')
const find = (id: string) => props.containers.find(c => c.id === id)
const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
</script>

<template>
  <div class="topo" data-testid="topology">
    <div class="bar">
      <UiSwitch v-model="hideBuiltin" label="Masquer les réseaux par défaut (bridge, host, none)" />
      <span class="muted small">Survoler ou cliquer un conteneur, un réseau ou un domaine met en évidence ses liens ; Entrée ouvre le détail d'un conteneur.</span>
    </div>
    <p v-if="!hosts.length" class="muted">Aucun conteneur à représenter.</p>
    <section v-for="h in hosts" :key="h.endpoint.endpointId" class="host card">
      <h3>{{ h.endpoint.serverName }} / {{ h.endpoint.endpointName }} <span class="muted small">{{ h.layout.containers.length }} conteneur{{ h.layout.containers.length > 1 ? 's' : '' }} · {{ h.layout.networks.length }} réseau{{ h.layout.networks.length > 1 ? 'x' : '' }}</span></h3>
      <div class="cols muted small" aria-hidden="true"><span>Domaines</span><span>Conteneurs par stack</span><span>Réseaux</span></div>
      <svg :viewBox="`0 0 ${h.layout.width} ${h.layout.height}`" class="svg" role="group" :aria-label="`Topologie de ${h.endpoint.endpointName}`" @pointerleave="hovered = null">
        <rect v-for="g in h.layout.groups" :key="g.key" :x="g.x" :y="g.y" :width="g.w" :height="g.h" rx="8" class="grp" />
        <text v-for="g in h.layout.groups" :key="`${g.key}-t`" :x="g.x + 10" :y="g.y + 17" class="grp-t">{{ g.label }}<tspan v-if="g.project" class="grp-p"> · {{ g.project }}</tspan></text>

        <path v-for="e in h.layout.edges" :key="e.key" :d="e.path" class="edge" :class="[e.kind, { on: !!active && edgeOn(e), off: !!active && !edgeOn(e) }]" />

        <g v-for="d in h.layout.domains" :key="d.key" class="node dom" :class="{ dim: dim(h.layout, d.key), sel: pinned === d.key }" tabindex="0" role="button" :aria-pressed="pinned === d.key" :aria-label="`Domaine ${d.host}`" @pointerenter="hovered = d.key" @focus="hovered = d.key" @blur="hovered = null" @click="toggle(d.key)" @keydown.enter.prevent="toggle(d.key)">
          <rect :x="d.x" :y="d.y" :width="d.w" :height="d.h" rx="15" />
          <text :x="d.x + 12" :y="d.y + 19">{{ trunc(d.host, 32) }}</text>
        </g>

        <g v-for="c in h.layout.containers" :key="c.key" class="node ctr" :class="[stateTone(c), { dim: dim(h.layout, c.key), sel: pinned === c.key }]" tabindex="0" role="button" :aria-label="`Conteneur ${c.service ?? c.name}, ${c.state}, réseaux : ${c.networks.join(', ') || 'aucun'}`" :data-container="c.name" @pointerenter="hovered = c.key" @focus="hovered = c.key" @blur="hovered = null" @click="toggle(c.key)" @dblclick="find(c.id) && emit('select', find(c.id)!)" @keydown.enter.prevent="find(c.id) && emit('select', find(c.id)!)">
          <rect :x="c.x" :y="c.y" :width="c.w" :height="c.h" rx="7" />
          <circle :cx="c.x + 14" :cy="c.y + c.h / 2" r="4.5" class="dot" />
          <text :x="c.x + 28" :y="c.y + 15" class="t1">{{ trunc(c.service ?? c.name, 30) }}</text>
          <text :x="c.x + 28" :y="c.y + 27" class="t2">{{ trunc(c.name, 40) }}</text>
          <text v-if="!c.managed" :x="c.x + c.w - 10" :y="c.y + 20" text-anchor="end" class="t2">externe</text>
        </g>

        <g v-for="n in h.layout.networks" :key="n.key" class="node net" :class="{ builtin: n.builtin, dim: dim(h.layout, n.key), sel: pinned === n.key }" tabindex="0" role="button" :aria-pressed="pinned === n.key" :aria-label="`Réseau ${n.name}, ${n.members} conteneur${n.members > 1 ? 's' : ''}`" :data-network="n.name" @pointerenter="hovered = n.key" @focus="hovered = n.key" @blur="hovered = null" @click="toggle(n.key)" @keydown.enter.prevent="toggle(n.key)">
          <rect :x="n.x" :y="n.y" :width="n.w" :height="n.h" rx="7" />
          <text :x="n.x + 12" :y="n.y + 19">{{ trunc(n.name, 28) }}</text>
          <text :x="n.x + n.w - 12" :y="n.y + 19" text-anchor="end" class="cnt">{{ n.members }}</text>
        </g>
      </svg>
    </section>
  </div>
</template>

<style scoped>
.topo { display: flex; flex-direction: column; gap: var(--space-3); }
.bar { display: flex; align-items: center; gap: var(--space-4); flex-wrap: wrap; }
.small { font-size: 12.5px; }
.host { padding: var(--space-3) var(--space-4); overflow-x: auto; }
h3 { margin: 0 0 var(--space-2); font-size: 14px; display: flex; gap: var(--space-2); align-items: baseline; }
.cols { display: grid; grid-template-columns: 24% 1fr 25%; min-width: 760px; margin-bottom: 4px; }
.cols span:nth-child(2) { padding-left: 4%; }
.cols span:nth-child(3) { text-align: right; }
.svg { width: 100%; min-width: 760px; height: auto; display: block; }
.grp { fill: var(--surface-2); stroke: var(--border); }
.grp-t { fill: var(--text-muted); font-size: 11.5px; font-weight: 600; }
.grp-p { font-weight: 400; }
.edge { fill: none; stroke: var(--border-strong, var(--border)); stroke-width: 1.3; transition: opacity .12s; }
.edge.host { stroke: var(--primary); stroke-dasharray: 5 4; }
.edge.on { stroke: var(--primary); stroke-width: 2.2; }
.edge.off { opacity: .08; }
.node { cursor: pointer; transition: opacity .12s; outline: none; }
.node.dim { opacity: .22; }
.node rect { fill: var(--surface); stroke: var(--border-strong, var(--border)); stroke-width: 1; }
.node text { fill: var(--text); font-size: 12px; }
.node .t1 { font-weight: 600; font-size: 12px; }
.node .t2 { fill: var(--text-muted); font-size: 10px; }
.node .cnt { fill: var(--text-muted); font-size: 11px; }
.node:hover rect, .node:focus-visible rect { stroke: var(--primary); stroke-width: 2; }
.node.sel rect { stroke: var(--primary); stroke-width: 2.2; fill: var(--primary-soft, var(--surface-2)); }
.dom rect { fill: var(--primary-soft, var(--surface-2)); stroke: var(--primary); }
.net.builtin rect { stroke-dasharray: 3 3; }
.net.builtin text { fill: var(--text-muted); }
.ctr .dot { fill: var(--success); }
.ctr.warn .dot { fill: var(--warning); }
.ctr.bad .dot { fill: var(--danger); }
.ctr.off .dot { fill: var(--text-faint, var(--text-muted)); }
.ctr.off rect { stroke-dasharray: 4 3; }
</style>
