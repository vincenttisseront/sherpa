<script setup lang="ts">
/**
 * Vue flux : URL publique → port de l'hôte → reverse proxy → stack. Liens tracés
 * en SVG d'après la position des cartes ; le survol éclaire le flux complet
 * (une URL : ses ports, son proxy et sa stack), le clic ouvre le détail.
 */
import { Boxes, Globe, Lock, LockOpen, Network, Plug, ShieldAlert, ShieldCheck, ShieldX, TriangleAlert } from 'lucide-vue-next'
import { type CertState, type GraphEdge, type MapSelection, type ProxyGraph, flowOf } from '#shared/utils/proxy-graph'

const props = defineProps<{ graph: ProxyGraph }>()
const emit = defineEmits<{ select: [MapSelection] }>()

const KIND: Record<string, string> = {
  'traefik': 'Traefik', 'caddy': 'Caddy', 'caddy-docker-proxy': 'Caddy (labels)', 'nginx': 'nginx', 'nginx-proxy': 'nginx-proxy',
  'nginx-proxy-manager': 'Nginx Proxy Manager', 'haproxy': 'HAProxy', 'envoy': 'Envoy', 'swag': 'SWAG', 'httpd': 'Apache httpd',
}
const CERT: Record<CertState, { label: string, tone: 'success' | 'warning' | 'danger' | 'info' | 'neutral' }> = {
  valid: { label: 'Certificat valide', tone: 'success' },
  expiring: { label: 'Expire bientôt', tone: 'warning' },
  expired: { label: 'Certificat expiré', tone: 'danger' },
  error: { label: 'Erreur ACME', tone: 'danger' },
  pending: { label: 'Certificat en attente', tone: 'info' },
  static: { label: 'Certificat fourni par le proxy', tone: 'neutral' },
  none: { label: 'HTTP, sans TLS', tone: 'neutral' },
}
const certIcon = (s: CertState) => (s === 'valid' ? ShieldCheck : s === 'expired' || s === 'error' ? ShieldX : s === 'none' ? LockOpen : s === 'static' ? Lock : ShieldAlert)
const bindingLabel = (h: string) => (h.startsWith('0.0.0.0:') ? `*:${h.split(':').pop()}` : h)

const wrap = ref<HTMLElement>()
const paths = ref<{ d: string, edge: GraphEdge, mid: { x: number, y: number } }[]>([])
const size = ref({ w: 0, h: 0 })
const stacked = ref(false)
const hovered = ref<string | null>(null)
const lit = computed(() => (hovered.value ? flowOf(props.graph, hovered.value) : null))
const dim = (id: string) => !!lit.value && !lit.value.has(id)
const edgeLit = (e: GraphEdge) => !!lit.value && lit.value.has(e.from) && lit.value.has(e.to)

function layout() {
  const el = wrap.value
  if (!el) return
  stacked.value = el.clientWidth < 900
  const box = el.getBoundingClientRect()
  size.value = { w: el.scrollWidth, h: el.scrollHeight }
  if (stacked.value) {
    paths.value = []
    return
  }
  const rect = (id: string) => el.querySelector<HTMLElement>(`[data-node="${CSS.escape(id)}"]`)?.getBoundingClientRect() ?? null
  const out: typeof paths.value = []
  for (const edge of props.graph.edges) {
    const a = rect(edge.from)
    const b = rect(edge.to)
    if (!a || !b) continue
    const x1 = a.right - box.left
    const y1 = a.top + a.height / 2 - box.top
    const x2 = b.left - box.left
    const y2 = b.top + b.height / 2 - box.top
    const dx = Math.max(30, (x2 - x1) / 2)
    out.push({ d: `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`, edge, mid: { x: (x1 + x2) / 2, y: (y1 + y2) / 2 } })
  }
  paths.value = out
}

let ro: ResizeObserver | undefined
onMounted(() => {
  ro = new ResizeObserver(() => layout())
  if (wrap.value) ro.observe(wrap.value)
  void nextTick(layout)
})
onBeforeUnmount(() => ro?.disconnect())
watch(() => props.graph, () => nextTick(layout))
</script>

<template>
  <div ref="wrap" class="diagram" :class="{ stacked }" @mouseleave="hovered = null">
    <svg v-if="!stacked" class="edges" :width="size.w" :height="size.h" aria-hidden="true">
      <g v-for="(p, i) in paths" :key="i" :class="['edge', p.edge.kind, { warn: p.edge.warn, lit: edgeLit(p.edge), faded: lit && !edgeLit(p.edge) }]">
        <path :d="p.d" />
        <text v-if="p.edge.label && (!lit || edgeLit(p.edge))" :x="p.mid.x" :y="p.mid.y - 5" text-anchor="middle">{{ p.edge.label }}</text>
      </g>
    </svg>

    <!-- 1. URL publiques -->
    <section class="col">
      <h4><Globe :size="14" /> URL</h4>
      <button
        v-for="u in graph.urls" :key="u.id" type="button" :data-node="u.id" class="node url" :class="[`cert-${CERT[u.cert].tone}`, { dim: dim(u.id), redirect: u.redirect }]"
        @mouseenter="hovered = u.id" @click="emit('select', { kind: 'routes', indexes: u.indexes })"
      >
        <span class="r-head" :title="[u.url, u.redirect ? 'Redirection vers HTTPS' : CERT[u.cert].label, ...u.warnings].join('\n')">
          <component :is="certIcon(u.cert)" :size="14" class="cert-ico" :aria-label="CERT[u.cert].label" />
          <span class="mono ellipsis">{{ u.url.replace(/^https?:\/\//, '') }}</span>
          <span v-if="u.redirect" class="muted small push">→ HTTPS</span>
          <span v-else-if="u.certs[0]?.notAfter" class="muted small push">{{ fmtDate(u.certs[0].notAfter) }}</span>
          <TriangleAlert v-if="u.warnings.length" :size="13" class="warn-ico" :class="{ push: !u.redirect && !u.certs[0]?.notAfter }" :aria-label="u.warnings[0]" />
        </span>
      </button>
      <p v-if="!graph.urls.length" class="muted small">Aucune URL</p>
    </section>

    <!-- 2. Ports de l'hôte -->
    <section class="col">
      <h4><Plug :size="14" /> Ports de l'hôte</h4>
      <div v-for="p in graph.ports" :key="p.id" :data-node="p.id" class="node port" :class="{ dim: dim(p.id), direct: !p.proxyId, exposed: p.host.startsWith('0.0.0.0') }" @mouseenter="hovered = p.id">
        <span class="mono">{{ bindingLabel(p.host) }}</span>
        <span class="muted small">{{ p.proxyId ? p.protocol : 'direct' }}</span>
      </div>
      <p v-if="!graph.ports.length" class="muted small">Aucun port publié</p>
    </section>

    <!-- 3. Reverse proxies -->
    <section class="col">
      <h4><Network :size="14" /> Reverse proxies</h4>
      <button
        v-for="p in graph.proxies" :key="p.id" type="button" :data-node="p.id" class="node proxy" :class="{ dim: dim(p.id), stopped: !p.proxy.container.running }"
        @mouseenter="hovered = p.id" @click="emit('select', { kind: 'proxy', id: p.proxy.container.id })"
      >
        <span class="r-head">
          <strong>{{ KIND[p.proxy.kind] ?? p.proxy.kind }}</strong>
          <span v-if="p.proxy.version" class="muted small">{{ p.proxy.version }}</span>
          <UiBadge v-if="p.proxy.container.stack === 'platform-traefik'" tone="info">géré</UiBadge>
          <UiBadge v-if="!p.proxy.container.running" tone="danger">arrêté</UiBadge>
          <span class="muted small push">{{ p.routes }} route{{ p.routes > 1 ? 's' : '' }}</span>
        </span>
        <span class="r-head">
          <span class="muted small mono ellipsis">{{ p.proxy.container.stack ?? p.proxy.container.name }}</span>
          <span v-if="p.proxy.warnings.length" class="warn small push" :title="p.proxy.warnings.join('\n')"><TriangleAlert :size="12" /> {{ p.proxy.warnings.length }}</span>
        </span>
      </button>
    </section>

    <!-- 4. Stacks -->
    <section class="col">
      <h4><Boxes :size="14" /> Stacks</h4>
      <button
        v-for="s in graph.stacks" :key="s.id" type="button" :data-node="s.id" class="node stack" :class="[s.kind, { dim: dim(s.id) }]"
        :title="s.kind === 'direct' ? `${s.name} : ports publiés hors proxy` : s.kind === 'unrouted' ? `${s.name} : sur le réseau du proxy, sans route` : s.name"
        @mouseenter="hovered = s.id" @click="emit('select', { kind: 'containers', ids: s.containers.map(c => c.id) })"
      >
        <span class="r-head">
          <strong class="ellipsis">{{ s.project?.name ?? s.name }}</strong>
          <UiBadge v-if="s.managed" tone="info">plateforme</UiBadge>
          <span class="muted small push">{{ s.containers.length }} conteneur{{ s.containers.length > 1 ? 's' : '' }}</span>
        </span>
        <span v-if="s.project && s.project.name !== s.name" class="muted small ellipsis">{{ s.name }}</span>
        <span class="chips">
          <span v-for="svc in s.services.slice(0, 4)" :key="svc.service" class="chip"><span class="state" :class="{ off: !svc.running }" />{{ svc.service }}<span v-if="svc.ports.length" class="mono">:{{ svc.ports.join(',') }}</span></span>
          <span v-if="s.services.length > 4" class="chip more">+{{ s.services.length - 4 }}</span>
        </span>
      </button>
      <p v-if="!graph.stacks.length" class="muted small">Aucune stack</p>
    </section>
  </div>
</template>

<style scoped>
.diagram { position: relative; display: grid; grid-template-columns: minmax(200px, 1.1fr) minmax(130px, .6fr) minmax(190px, .9fr) minmax(220px, 1.1fr); gap: var(--space-2) 64px; align-items: start; }
.diagram.stacked { grid-template-columns: 1fr; gap: var(--space-4); }
.edges { position: absolute; inset: 0; pointer-events: none; overflow: visible; z-index: 0; }
.col { position: relative; z-index: 1; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
h4 { margin: 0 0 4px; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted); display: flex; gap: 6px; align-items: center; font-weight: 600; }
.node { all: unset; box-sizing: border-box; display: flex; flex-direction: column; gap: 3px; padding: 5px 9px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); font-size: 13px; transition: opacity .15s, border-color .15s; min-width: 0; }
button.node { cursor: pointer; }
button.node:hover { border-color: var(--primary); }
button.node:focus-visible { outline: 2px solid var(--focus); }
.node.dim { opacity: .3; }
.r-head { display: flex; gap: 6px; align-items: center; min-width: 0; }
.push { margin-left: auto; white-space: nowrap; }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.small { font-size: 12px; }
.warn { color: var(--warning); display: flex; gap: 4px; align-items: center; }
.warn-ico { color: var(--warning); flex: none; }
.url { border-left: 3px solid var(--border-strong); }
.url.redirect { opacity: .75; border-style: dashed; border-left-style: solid; }
.url.cert-success { border-left-color: var(--success); }
.url.cert-warning { border-left-color: var(--warning); }
.url.cert-danger { border-left-color: var(--danger); }
.url.cert-info { border-left-color: var(--info); }
.cert-success .cert-ico { color: var(--success); }
.cert-warning .cert-ico { color: var(--warning); }
.cert-danger .cert-ico { color: var(--danger); }
.cert-info .cert-ico { color: var(--info); }
.cert-neutral .cert-ico { color: var(--text-muted); }
.port { flex-direction: row; justify-content: space-between; align-items: baseline; gap: 6px; padding: 4px 9px; white-space: nowrap; }
.port.direct { border-style: dashed; }
.port.direct.exposed { border-color: color-mix(in srgb, var(--warning) 60%, var(--border)); }
.proxy { border-left: 3px solid var(--primary); }
.proxy.stopped { border-left-color: var(--danger); }
.stack { border-left: 3px solid var(--success); }
.stack.direct { border-left-color: var(--warning); }
.stack.unrouted { border-left-color: var(--border-strong); border-style: dashed; border-left-style: solid; }
.chips { display: flex; flex-wrap: wrap; gap: 4px; }
.chip { display: inline-flex; gap: 4px; align-items: center; font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--border); color: var(--text-muted); }
.chip.more { border-style: dashed; }
.state { width: 6px; height: 6px; border-radius: 50%; background: var(--success); }
.state.off { background: var(--danger); }
.edge path { fill: none; stroke: var(--border-strong); stroke-width: 1.4; transition: opacity .15s, stroke .15s; }
.edge.url path { stroke: color-mix(in srgb, var(--primary) 50%, var(--border)); }
.edge.stack path { stroke: color-mix(in srgb, var(--success) 60%, var(--border)); }
.edge.network path { stroke-dasharray: 3 4; }
.edge.direct path { stroke: var(--warning); stroke-dasharray: 5 4; }
.edge.warn path { stroke: var(--warning); }
.edge.lit path { stroke-width: 2.4; stroke: var(--primary); }
.edge.faded { opacity: .12; }
.edge text { font-size: 10.5px; fill: var(--text-muted); paint-order: stroke; stroke: var(--bg); stroke-width: 3px; font-family: var(--font-mono); }
</style>
