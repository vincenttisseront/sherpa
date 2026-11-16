<script setup lang="ts">
/**
 * Vue en direct des conteneurs (flux SSE) : moteur par endpoint, filtres,
 * regroupement par stack, détail dans un panneau latéral. Lecture seule.
 */
import type { LiveContainer, LiveEndpoint } from '#shared/schemas/live'
import type { MapContainer } from '#shared/schemas/proxy-map'
import type { Component } from 'vue'
import { Boxes, Brush, Stethoscope, Cpu, Globe, MemoryStick, Search, ServerCrash, Unplug } from 'lucide-vue-next'

/** Avec `title` : en-tête de page rendu ici, moteurs et indicateur « en direct » sur la ligne du titre. */
const props = defineProps<{ endpointId?: string, initialStack?: string, initialQuery?: string, title?: string, icon?: Component }>()
const { can, hasAny } = useAuth()
/** Stack externe reprenable en projet géré (droits serveur et création de projet). */
const canAdoptOn = (serverId: string) => can('server:manage', { serverId }) && hasAny('project:create')

const snapshots = ref<Record<string, LiveEndpoint>>({})
const seenAt = ref<Record<string, string>>({})
const connected = ref(false)
const loaded = ref(false)
const now = ref(Date.now())
let source: EventSource | null = null
let ticker: ReturnType<typeof setInterval> | undefined

function connect() {
  source?.close()
  source = new EventSource(`/api/live/stream${props.endpointId ? `?endpointId=${props.endpointId}` : ''}`)
  source.onopen = () => { connected.value = true }
  source.addEventListener('snapshot', (e) => {
    const s = JSON.parse((e as MessageEvent).data) as LiveEndpoint
    snapshots.value = { ...snapshots.value, [s.endpointId]: s }
    seenAt.value = { ...seenAt.value, [s.endpointId]: s.scannedAt }
    loaded.value = true
    connected.value = true
  })
  source.addEventListener('alive', (e) => {
    const a = JSON.parse((e as MessageEvent).data) as { endpointId: string, scannedAt: string }
    seenAt.value = { ...seenAt.value, [a.endpointId]: a.scannedAt }
    connected.value = true
  })
  source.onerror = () => { connected.value = false }
}
onMounted(() => {
  connect()
  ticker = setInterval(() => { now.value = Date.now() }, 1000)
  // Pas d'écoute inutile quand l'onglet est caché ; reprise immédiate au retour.
  document.addEventListener('visibilitychange', onVisibility)
})
onBeforeUnmount(() => {
  source?.close()
  clearInterval(ticker)
  document.removeEventListener('visibilitychange', onVisibility)
})
function onVisibility() {
  if (document.hidden) {
    source?.close()
    connected.value = false
  }
  else {
    connect()
  }
}

const endpoints = computed(() => Object.values(snapshots.value).sort((a, b) => `${a.serverName}/${a.endpointName}`.localeCompare(`${b.serverName}/${b.endpointName}`)))
const lastSeen = computed(() => {
  const times = Object.values(seenAt.value).map(t => new Date(t).getTime())
  return times.length ? Math.max(...times) : null
})
const ago = computed(() => (lastSeen.value ? Math.max(0, Math.round((now.value - lastSeen.value) / 1000)) : null))

// --- Filtres ---
type Filter = 'all' | 'running' | 'attention' | 'stopped'
const q = ref(props.initialQuery ?? props.initialStack ?? '')
const filter = ref<Filter>('all')
const onlyManaged = ref(false)
// Liste (par stack) ou topologie réseau (domaines, conteneurs, réseaux).
const view = ref<'list' | 'topology'>(typeof useRoute().query.view === 'string' && useRoute().query.view === 'topology' ? 'topology' : 'list')
const endpointFilter = ref('')
const needsAttention = (c: LiveContainer) => c.health === 'unhealthy' || c.health === 'starting' || c.state === 'restarting' || c.state === 'dead' || (c.state === 'exited' && /Exited \((?!0\))/.test(c.status))
const all = computed(() => endpoints.value.flatMap(e => e.containers.map(c => ({ ...c, endpoint: e }))))
const counts = computed(() => ({
  all: all.value.length,
  running: all.value.filter(c => c.state === 'running').length,
  attention: all.value.filter(needsAttention).length,
  stopped: all.value.filter(c => c.state !== 'running').length,
}))
const shown = computed(() => {
  const needle = q.value.trim().toLowerCase()
  return all.value.filter(c => (!endpointFilter.value || c.endpoint.endpointId === endpointFilter.value)
    && (!onlyManaged.value || c.managed)
    && (filter.value === 'all' || (filter.value === 'running' && c.state === 'running') || (filter.value === 'attention' && needsAttention(c)) || (filter.value === 'stopped' && c.state !== 'running'))
    && (!needle || [c.name, c.image, c.stack, c.service, c.project?.name, ...c.hosts].some(v => v?.toLowerCase().includes(needle))))
})
const groups = computed(() => {
  const map = new Map<string, { key: string, stack: string | null, endpoint: LiveEndpoint, project: LiveContainer['project'], managed: boolean, items: typeof shown.value }>()
  for (const c of shown.value) {
    const key = `${c.endpoint.endpointId}:${c.stack ?? '~'}`
    if (!map.has(key)) map.set(key, { key, stack: c.stack, endpoint: c.endpoint, project: c.project, managed: false, items: [] })
    const g = map.get(key)!
    g.items.push(c)
    g.managed ||= c.managed
  }
  // Projets de la plateforme d'abord, puis autres stacks, conteneurs isolés à la fin.
  return [...map.values()].sort((a, b) => Number(!a.project) - Number(!b.project) || Number(!a.stack) - Number(!b.stack) || (a.stack ?? '').localeCompare(b.stack ?? ''))
})
const FILTERS: { key: Filter, label: string }[] = [
  { key: 'all', label: 'Tous' },
  { key: 'running', label: 'En marche' },
  { key: 'attention', label: 'À surveiller' },
  { key: 'stopped', label: 'Arrêtés' },
]

// --- Détail ---
const selected = ref<(LiveContainer & { endpoint: LiveEndpoint }) | null>(null)
/** Conteneur au format de la carte des proxies (panneau « passer derrière le Traefik géré »). */
function asMapContainer(c: LiveContainer): MapContainer {
  return {
    id: c.id, name: c.name, image: c.image, stack: c.stack, service: c.service, running: c.state === 'running', state: c.state,
    health: c.health,
    managed: c.managed, project: c.project, proxyNetworks: [],
    hostPorts: c.ports.filter(p => p.publicPort).map(p => ({ host: `${p.ip && p.ip !== '0.0.0.0' ? p.ip : '0.0.0.0'}:${p.publicPort}`, container: p.privatePort, protocol: p.type })),
    ports: [...new Set(c.ports.filter(p => p.type === 'tcp').map(p => p.privatePort))].sort((a, b) => a - b),
  }
}
const drawer = computed({ get: () => !!selected.value, set: (v) => { if (!v) selected.value = null } })
const portLabel = (p: LiveContainer['ports'][number]) => (p.publicPort ? `${p.publicPort}→${p.privatePort}` : `${p.privatePort}`)
const uptime = (status: string) => status.replace(/\s*\((healthy|unhealthy|health: starting)\)/, '').replace(/^Up /, 'actif depuis ').replace(/^Exited \((\d+)\) /, 'arrêté (code $1) il y a ').replace(/ ago$/, '').replace(/About an? /, '1 ').replace(/seconds?/, 's').replace(/minutes?/, 'min').replace(/hours?/, 'h').replace(/days?/, 'j').replace(/weeks?/, 'sem.').replace(/months?/, 'mois')
</script>

<template>
  <div class="live">
    <UiPageHeader v-if="title" :title="title" :icon="icon">
      <template v-if="endpoints.length" #nav>
        <div class="pills">
          <span v-for="e in endpoints" :key="e.endpointId" class="pill" :class="{ on: endpointFilter === e.endpointId, ko: !e.ok }">
            <button
              type="button" class="p-main" :aria-pressed="endpointFilter === e.endpointId"
              :title="`${e.serverName}${e.engine?.serverVersion ? ` · Docker ${e.engine.serverVersion}` : ''}${e.engine ? ` · ${e.engine.cpus ?? '?'} CPU · ${e.engine.memoryBytes ? fmtBytesShort(e.engine.memoryBytes) : '?'} · lu en ${e.durationMs} ms` : ''}${e.ok ? '' : ` · injoignable : ${e.error}`} — cliquer pour filtrer`"
              @click="endpointFilter = endpointFilter === e.endpointId ? '' : e.endpointId"
            >
              <component :is="e.ok ? Boxes : ServerCrash" :size="13" aria-hidden="true" class="p-ico" />
              <strong>{{ e.endpointName }}</strong>
              <template v-if="e.ok && e.engine">
                <span><b class="ok">{{ e.engine.running }}</b> en marche</span>
                <span><b>{{ e.engine.stopped + e.engine.paused }}</b> arrêté{{ e.engine.stopped + e.engine.paused > 1 ? 's' : '' }}</span>
                <span><b>{{ e.engine.images }}</b> images</span>
              </template>
              <span v-else class="err">injoignable</span>
            </button>
            <NuxtLink v-if="e.ok && can('server:manage', { serverId: e.serverId })" :to="`/servers/${e.serverId}?tab=cleanup&endpoint=${e.endpointId}`" class="p-clean" title="Nettoyer (images, volumes, conteneurs arrêtés)" aria-label="Nettoyer"><Brush :size="13" /></NuxtLink>
          </span>
        </div>
      </template>
      <span v-if="loaded && endpoints.length" class="conn" :class="{ on: connected }" :title="ago !== null ? `Dernière mise à jour ${ago < 2 ? 'à l\'instant' : `il y a ${ago} s`}` : undefined">
        <span :class="connected ? 'pulse' : 'dot'" aria-hidden="true" />
        {{ connected ? 'En direct' : 'Reconnexion…' }}
      </span>
    </UiPageHeader>

    <div v-if="!loaded" class="engines">
      <div v-for="i in 2" :key="i" class="engine card skeleton" />
    </div>
    <UiEmpty v-else-if="!endpoints.length" class="card" :icon="Unplug" title="Aucun endpoint géré">
      <UiButton variant="primary" @click="navigateTo('/servers')">Serveurs</UiButton>
    </UiEmpty>
    <template v-else>
      <div v-if="!title" class="engines">
        <button v-for="e in endpoints" :key="e.endpointId" type="button" class="engine card" :class="{ on: endpointFilter === e.endpointId, ko: !e.ok }" :title="e.engine ? `${e.engine.cpus ?? '?'} CPU · ${e.engine.memoryBytes ? fmtBytesShort(e.engine.memoryBytes) : '?'} · lu en ${e.durationMs} ms` : undefined" :aria-pressed="endpointFilter === e.endpointId" @click="endpointFilter = endpointFilter === e.endpointId ? '' : e.endpointId">
          <div class="e-head">
            <span class="e-ico" aria-hidden="true"><component :is="e.ok ? Boxes : ServerCrash" :size="14" /></span>
            <span class="e-name"><strong>{{ e.endpointName }}</strong><small>{{ e.serverName }}{{ e.engine?.serverVersion ? ` · Docker ${e.engine.serverVersion}` : '' }}</small></span>
          </div>
          <template v-if="e.ok && e.engine">
            <div class="e-counts">
              <span><strong class="ok">{{ e.engine.running }}</strong> en marche</span>
              <span><strong>{{ e.engine.stopped + e.engine.paused }}</strong> arrêté{{ e.engine.stopped + e.engine.paused > 1 ? 's' : '' }}</span>
              <span><strong>{{ e.engine.images }}</strong> images</span>
            </div>
            <div class="e-res muted">
              <NuxtLink v-if="can('server:manage', { serverId: e.serverId })" :to="`/servers/${e.serverId}?tab=cleanup&endpoint=${e.endpointId}`" class="clean" @click.stop>Nettoyer</NuxtLink>
              <template v-if="endpoints.length === 1">
                <span v-if="e.engine.cpus"><Cpu :size="13" aria-hidden="true" /> {{ e.engine.cpus }} CPU</span>
                <span v-if="e.engine.memoryBytes"><MemoryStick :size="13" aria-hidden="true" /> {{ fmtBytesShort(e.engine.memoryBytes) }}</span>
                <span>lu en {{ e.durationMs }} ms</span>
              </template>
            </div>
          </template>
          <p v-else class="e-err">Injoignable : {{ e.error }}</p>
        </button>
      </div>

      <div class="toolbar card">
        <label class="search"><Search :size="15" aria-hidden="true" /><input v-model="q" type="search" placeholder="Nom, image, stack, projet…" aria-label="Rechercher un conteneur"></label>
        <div class="seg" role="radiogroup" aria-label="État">
          <button v-for="f in FILTERS" :key="f.key" type="button" role="radio" :aria-checked="filter === f.key" :class="{ on: filter === f.key, warn: f.key === 'attention' && counts.attention }" @click="filter = f.key">
            {{ f.label }} <span class="n">{{ counts[f.key] }}</span>
          </button>
        </div>
        <UiSwitch v-model="onlyManaged" label="Déployés par la plateforme" />
        <div class="seg" role="radiogroup" aria-label="Affichage">
          <button type="button" role="radio" :aria-checked="view === 'list'" :class="{ on: view === 'list' }" @click="view = 'list'">Liste</button>
          <button type="button" role="radio" :aria-checked="view === 'topology'" :class="{ on: view === 'topology' }" data-testid="view-topology" @click="view = 'topology'">Topologie</button>
        </div>
        <span v-if="!title" class="conn toolbar-conn" :class="{ on: connected }">
          <span :class="connected ? 'pulse' : 'dot'" aria-hidden="true" />
          {{ connected ? 'En direct' : 'Reconnexion…' }}
          <span v-if="ago !== null" class="muted">· {{ ago < 2 ? 'à l\'instant' : `il y a ${ago} s` }}</span>
        </span>

      </div>

      <UiEmpty v-if="!groups.length" class="card" compact :icon="Search" title="Aucun conteneur ne correspond" />

      <NetworkTopology v-else-if="view === 'topology'" :containers="shown" @select="selected = $event" />

      <section v-for="g in view === 'list' ? groups : []" :key="g.key" class="group card">
        <header class="g-head">
          <div class="g-title">
            <strong>{{ g.stack ?? 'Conteneurs hors stack' }}</strong>
            <NuxtLink v-if="g.project" :to="`/projects/${g.project.id}`" class="g-proj">{{ g.project.name }} · {{ g.project.environment }}</NuxtLink>
            <NuxtLink v-if="g.project?.targetId && g.items.some(i => i.state !== 'running' || i.health === 'unhealthy' || i.health === 'starting')" :to="`/diagnostic/${g.project.targetId}`" class="g-diag" title="Cause probable et actions pour les services en difficulté"><Stethoscope :size="12" /> Diagnostic</NuxtLink>
            <UiBadge v-else-if="g.managed" tone="neutral" title="Déployée par la plateforme puis détachée (ou projet supprimé) : n'est plus gérée">détachée</UiBadge>
            <UiBadge v-else-if="g.stack">stack externe</UiBadge>
            <NuxtLink v-if="g.stack && !g.project && canAdoptOn(g.endpoint.serverId)" :to="adoptLink(g.endpoint.serverId, g.endpoint.endpointId, g.stack)" class="g-adopt" title="Reprendre cette stack en projet géré par la plateforme">Reprendre en projet →</NuxtLink>
          </div>
          <span class="muted small">{{ g.items.filter(i => i.state === 'running').length }} / {{ g.items.length }} en marche<template v-if="endpoints.length > 1"> · {{ g.endpoint.endpointName }}</template></span>
        </header>
        <ul class="rows">
          <li v-for="c in g.items" :key="c.id">
            <button type="button" class="row" @click="selected = c">
              <ContainerState :state="c.state" :health="c.health" :status="c.status" class="st" />
              <span class="name">
                <strong>{{ c.service ?? c.name }}</strong>
                <small class="mono" :title="c.image">{{ displayImage(c.image) }}</small>
                <small v-if="c.hosts.length" class="hosts" :title="c.hosts.join(', ')"><Globe :size="11" /> {{ c.hosts[0] }}<template v-if="c.hosts.length > 1"> +{{ c.hosts.length - 1 }}</template></small>
              </span>
              <span class="ports">
                <span v-for="(p, i) in c.ports.slice(0, 3)" :key="i" class="port mono">{{ portLabel(p) }}</span>
                <span v-if="c.ports.length > 3" class="port">+{{ c.ports.length - 3 }}</span>
              </span>
              <span class="since muted">{{ uptime(c.status) }}</span>
            </button>
          </li>
        </ul>
      </section>
    </template>

    <UiDrawer v-model:open="drawer" :title="selected?.name ?? ''" width="640px">
      <template #subtitle>
        <span v-if="selected">{{ selected.endpoint.serverName }} / {{ selected.endpoint.endpointName }}</span>
        <span v-if="selected?.stack" class="mono">· {{ selected.stack }}</span>
      </template>
      <ContainerDetail v-if="selected" :key="selected.id" :endpoint-id="selected.endpoint.endpointId" :container-id="selected.id" />
      <!-- Conteneur hors plateforme avec des ports : le passer derrière le Traefik géré (même panneau que la carte des proxies). -->
      <ProxyRouteForm v-if="selected && !selected.managed && selected.ports.some(p => p.type === 'tcp')" :key="`route-${selected.id}`" class="route-panel" :endpoint-id="selected.endpoint.endpointId" :server-id="selected.endpoint.serverId" :containers="[asMapContainer(selected)]" />
    </UiDrawer>
  </div>
</template>

<style scoped>
.live { display: flex; flex-direction: column; gap: var(--space-2); }
.live > :deep(.ph) { margin-bottom: 0; }
.conn { display: inline-flex; align-items: center; gap: var(--space-2); font-weight: 600; color: var(--text-faint); font-size: 13px; flex: none; }
.conn.on { color: var(--success); }
.toolbar-conn { margin-left: auto; }
.conn .muted { font-weight: 400; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
.small { font-size: 12.5px; }

.pills { display: flex; flex-wrap: wrap; gap: 6px; }
.pill { display: inline-flex; align-items: center; background: var(--surface); border: 1px solid var(--border); border-radius: 999px; font-size: 12.5px; }
.pill.on { border-color: var(--primary); box-shadow: 0 0 0 1px var(--primary); }
.pill.ko { border-color: color-mix(in srgb, var(--danger) 50%, var(--border)); }
.p-main { all: unset; cursor: pointer; display: inline-flex; align-items: baseline; gap: 8px; padding: 3px 10px; color: var(--text-muted); white-space: nowrap; }
.p-main:focus-visible, .p-clean:focus-visible { outline: 2px solid var(--focus); border-radius: 999px; }
.p-main strong { color: var(--text); font-weight: 600; }
.p-main b { color: var(--text); font-variant-numeric: tabular-nums; }
.p-main b.ok, .ok { color: var(--success); }
.p-ico { align-self: center; color: var(--primary); }
.pill.ko .p-ico, .err { color: var(--danger); }
.p-clean { display: grid; place-items: center; padding: 3px 9px 3px 6px; color: var(--text-muted); border-left: 1px solid var(--border); }
.p-clean:hover { color: var(--primary); }
.engines { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2) var(--space-3); }
.engine { all: unset; box-sizing: border-box; cursor: pointer; padding: 6px var(--space-3); display: flex; flex-direction: row; flex-wrap: wrap; align-items: center; gap: var(--space-2) var(--space-4); flex: 1 1 420px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow); transition: box-shadow .15s, border-color .15s; }
.engine:hover { box-shadow: var(--shadow-hover); }
.engine:focus-visible { outline: 2px solid var(--focus); }
.engine.on { border-color: var(--primary); box-shadow: 0 0 0 1px var(--primary), var(--shadow); }
.engine.skeleton { min-height: 44px; cursor: default; background: linear-gradient(90deg, var(--surface) 0%, var(--surface-2) 50%, var(--surface) 100%); background-size: 200% 100%; animation: shimmer 1.2s infinite; }
@keyframes shimmer { to { background-position: -200% 0; } }
.e-head { display: flex; gap: var(--space-2); align-items: center; }
.e-ico { width: 26px; height: 26px; border-radius: 7px; display: grid; place-items: center; background: var(--primary-soft); color: var(--primary); }
.engine.ko .e-ico { background: var(--danger-bg); color: var(--danger); }
.e-name { display: flex; flex-direction: column; min-width: 0; line-height: 1.2; font-size: 13px; }
.e-name small { color: var(--text-muted); font-size: 11.5px; }
.e-counts { display: flex; gap: var(--space-3); font-size: 12.5px; color: var(--text-muted); align-items: baseline; }
.e-counts strong { font-size: 15px; color: var(--text); font-variant-numeric: tabular-nums; margin-right: 2px; }
.e-counts strong.ok { color: var(--success); }
.e-res { display: flex; gap: var(--space-3); font-size: 12px; flex-wrap: wrap; flex: 1; align-items: center; }
.e-res span { display: inline-flex; gap: 4px; align-items: center; }
.clean { order: 9; margin-left: auto; font-weight: 550; }
.e-err { margin: 0; color: var(--danger); font-size: 12.5px; overflow-wrap: anywhere; }

.toolbar { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; padding: var(--space-2) var(--space-3); }
.search { display: flex; align-items: center; gap: var(--space-2); flex: 1; min-width: 220px; padding: 0 var(--space-3); border: 1px solid var(--border-strong); border-radius: var(--radius); color: var(--text-faint); background: var(--surface); }
.search:focus-within { border-color: var(--primary); box-shadow: 0 0 0 4px color-mix(in srgb, var(--primary) 18%, transparent); }
.search input { all: unset; flex: 1; padding: 5px 0; color: var(--text); font-size: 13px; }
.seg { display: inline-flex; padding: 3px; background: var(--surface-3); border-radius: calc(var(--radius) + 2px); gap: 2px; }
.seg button { all: unset; cursor: pointer; padding: 3px 10px; border-radius: var(--radius); font-size: 13px; font-weight: 550; color: var(--text-muted); display: inline-flex; gap: 6px; align-items: center; }
.seg button.on { background: var(--surface); color: var(--text); box-shadow: var(--shadow); }
.seg button:focus-visible { outline: 2px solid var(--focus); }
.seg .n { font-size: 11.5px; padding: 0 6px; border-radius: 999px; background: var(--neutral-bg); color: var(--text-muted); font-variant-numeric: tabular-nums; }
.seg button.warn .n { background: var(--warning-bg); color: var(--warning); }

.group { overflow: hidden; }
.g-head { display: flex; justify-content: space-between; align-items: center; gap: var(--space-3); flex-wrap: wrap; padding: 5px var(--space-4); background: var(--surface-2); border-bottom: 1px solid var(--border); }
.g-title { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.g-adopt { font-size: 12.5px; font-weight: 550; }
.g-diag { display: inline-flex; gap: 4px; align-items: center; font-size: 12.5px; font-weight: 550; color: var(--danger); }
.g-proj { font-size: 12.5px; font-weight: 550; padding: 1px 8px; border-radius: 999px; background: var(--primary-soft); }
.rows { list-style: none; margin: 0; padding: 0; }
.rows li + li { border-top: 1px solid var(--border); }
.row { all: unset; box-sizing: border-box; width: 100%; cursor: pointer; display: grid; grid-template-columns: 100px minmax(0, 1fr) auto 130px; gap: var(--space-3); align-items: center; padding: 4px var(--space-4); transition: background-color .1s; }
.row:hover { background: var(--surface-2); }
.row:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
.name { display: flex; align-items: baseline; gap: var(--space-2); min-width: 0; }
.name strong { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.name .hosts { color: var(--primary); display: inline-flex; gap: 4px; align-items: center; }
.name small { color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.name strong { flex: 0 1 auto; max-width: 45%; }
.name small.mono { flex: 0 1 auto; min-width: 0; }
.name .hosts { flex: none; }
.ports { display: flex; gap: 4px; flex-wrap: wrap; }
.ports { justify-content: flex-end; }
.port { padding: 0 6px; border-radius: var(--radius-sm); background: var(--surface-3); font-size: 11.5px; }
.since { font-size: 12px; text-align: right; white-space: nowrap; }
@media (max-width: 820px) {
  .row { grid-template-columns: auto minmax(0, 1fr); gap: var(--space-2); padding: 4px var(--space-3); }
  /* État réduit à sa pastille (libellé lu par les lecteurs d'écran). */
  .st :deep(> span:not(.pulse):not(.dot)) { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .name { flex-wrap: wrap; column-gap: var(--space-2); row-gap: 0; }
  .name strong { max-width: 100%; }
  .name small.mono { flex-basis: 100%; }
  .ports, .since { display: none; }
  .search { flex-basis: 100%; }
  .seg { max-width: 100%; overflow-x: auto; }
  .seg button { white-space: nowrap; }
  .g-head { padding: 5px var(--space-3); }
  .g-head > .muted { display: none; }
  .pills { width: 100%; }
  .pill { max-width: 100%; }
  .p-main { flex-wrap: wrap; row-gap: 0; white-space: normal; }
}
.route-panel { margin-top: var(--space-4); }
</style>
