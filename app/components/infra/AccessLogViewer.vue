<script setup lang="ts">
/**
 * Logs d'accès d'un reverse proxy nginx (ou des domaines d'une cible) : indicateurs, requêtes par
 * minute, domaines, chemins et clients les plus actifs, dernières requêtes, erreurs de nginx.
 * Lecture à la demande des dernières lignes du conteneur ; actualisation automatique facultative.
 */
import type { AccessEntry, AccessError, AccessStats, StatusClass } from '#shared/utils/access-log'
import { formatBytes } from '#shared/utils/format'
import { RefreshCw, TriangleAlert } from 'lucide-vue-next'

interface Result {
  container: string
  scannedLines: number
  unparsed: number
  formats: Record<AccessEntry['format'], number>
  hosts: string[]
  entries: AccessEntry[]
  stats: AccessStats
  errors: AccessError[]
  hint: string | null
}

const props = defineProps<{ url: string }>()

const tail = ref(2000)
const status = ref<StatusClass | ''>('')
const host = ref('')
const search = ref('')
const auto = ref(false)
const data = ref<Result | null>(null)
const error = ref<string | null>(null)
const loading = ref(false)

async function load() {
  loading.value = true
  try {
    data.value = await $fetch<Result>(props.url, { query: { tail: tail.value, ...(status.value ? { status: status.value } : {}), ...(host.value ? { hosts: host.value } : {}), ...(search.value.trim() ? { search: search.value.trim() } : {}) } })
    error.value = null
  }
  catch (err) {
    error.value = apiError(err).message
  }
  finally {
    loading.value = false
  }
}
let searchTimer: ReturnType<typeof setTimeout> | undefined
watch([tail, status, host], () => void load())
watch(search, () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => void load(), 400)
})
let timer: ReturnType<typeof setInterval> | undefined
watch(auto, (on) => {
  clearInterval(timer)
  if (on) timer = setInterval(() => { if (!loading.value) void load() }, 10_000)
})
onMounted(() => void load())
onBeforeUnmount(() => {
  clearInterval(timer)
  clearTimeout(searchTimer)
})

const STATUS_TONE: Record<StatusClass, 'success' | 'info' | 'warning' | 'danger' | 'neutral'> = { '2xx': 'success', '3xx': 'info', '4xx': 'warning', '5xx': 'danger', 'other': 'neutral' }
const toneOf = (s: number): StatusClass => (s >= 200 && s < 300 ? '2xx' : s >= 300 && s < 400 ? '3xx' : s >= 400 && s < 500 ? '4xx' : s >= 500 && s < 600 ? '5xx' : 'other')
const ms = (s: number | null) => (s === null ? '—' : s < 1 ? `${Math.round(s * 1000)} ms` : `${s.toFixed(2)} s`)
const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 1000) / 10} %` : '—')
const peak = computed(() => Math.max(1, ...(data.value?.stats.perMinute.map(m => m.requests) ?? [1])))
const timeOf = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('fr-FR') : '—')
</script>

<template>
  <div class="alog">
    <div class="bar">
      <select v-model.number="tail" class="input sm" aria-label="Lignes lues">
        <option :value="500">500 dernières lignes</option>
        <option :value="2000">2 000 dernières lignes</option>
        <option :value="10000">10 000 dernières lignes</option>
      </select>
      <select v-if="(data?.hosts.length ?? 0) > 1" v-model="host" class="input sm" aria-label="Domaine">
        <option value="">Tous les domaines</option>
        <option v-for="h in data!.hosts" :key="h" :value="h">{{ h }}</option>
      </select>
      <div class="chips" role="group" aria-label="Statut">
        <button v-for="s in ['', '2xx', '3xx', '4xx', '5xx'] as const" :key="s" type="button" class="chip" :class="{ on: status === s }" @click="status = s">{{ s || 'Tous' }}</button>
      </div>
      <input v-model="search" class="input sm grow" placeholder="Chemin, client, agent, statut…" aria-label="Rechercher dans les requêtes">
      <label class="small auto"><input v-model="auto" type="checkbox"> Actualiser (10 s)</label>
      <UiButton size="sm" variant="ghost" :loading="loading" aria-label="Relire" @click="load"><RefreshCw :size="14" /></UiButton>
    </div>

    <p v-if="error" class="alert" role="alert">{{ error }}</p>
    <div v-else-if="!data" class="muted small">Lecture des logs d'accès…</div>
    <template v-else>
      <p v-if="data.hint" class="hint small"><TriangleAlert :size="13" /> {{ data.hint }}</p>
      <div class="kpis">
        <div class="kpi"><strong>{{ data.stats.requests.toLocaleString('fr-FR') }}</strong><span>requêtes</span></div>
        <div class="kpi"><strong :class="{ warn: data.stats.status['4xx'] }">{{ pct(data.stats.status['4xx'], data.stats.requests) }}</strong><span>4xx</span></div>
        <div class="kpi"><strong :class="{ bad: data.stats.status['5xx'] }">{{ pct(data.stats.status['5xx'], data.stats.requests) }}</strong><span>5xx</span></div>
        <div class="kpi"><strong>{{ ms(data.stats.p50) }}</strong><span>médiane</span></div>
        <div class="kpi"><strong>{{ ms(data.stats.p95) }}</strong><span>95e centile</span></div>
        <div class="kpi"><strong>{{ formatBytes(data.stats.bytes) }}</strong><span>envoyés</span></div>
      </div>
      <p class="muted small">
        {{ data.container }} · {{ data.scannedLines.toLocaleString('fr-FR') }} ligne(s) lue(s)<template v-if="data.stats.first"> · de {{ timeOf(data.stats.first) }} à {{ timeOf(data.stats.last) }}</template>
        <template v-if="data.formats.console"> · format de la console</template><template v-if="data.formats.vhost"> · nginx-proxy</template><template v-if="data.formats.combined"> · combined (sans domaine ni durée)</template>
      </p>

      <div v-if="data.stats.perMinute.length > 1" class="hist" role="img" :aria-label="`Requêtes par minute, au plus ${peak}`">
        <span v-for="m in data.stats.perMinute" :key="m.minute" class="col" :title="`${timeOf(m.minute)} : ${m.requests} requête(s)${m.errors ? `, ${m.errors} en 5xx` : ''}`">
          <i class="req" :style="{ height: `${(m.requests / peak) * 100}%` }"><i v-if="m.errors" class="err" :style="{ height: `${(m.errors / m.requests) * 100}%` }" /></i>
        </span>
      </div>

      <div class="tops">
        <section v-if="data.stats.hosts.length">
          <h4>Domaines</h4>
          <table class="table">
            <thead class="sr-only"><tr><th>Domaine</th><th>Requêtes</th><th>Erreurs 5xx</th><th>Latence p95</th></tr></thead>
            <tbody>
              <tr v-for="h in data.stats.hosts" :key="h.host" class="clickable" @click="host = host === h.host ? '' : h.host">
                <td class="mono">{{ h.host }}</td><td class="num">{{ h.requests }}</td>
                <td class="num"><UiBadge v-if="h.errors" tone="danger">{{ h.errors }} 5xx</UiBadge></td><td class="num muted">{{ ms(h.p95) }}</td>
              </tr>
            </tbody>
          </table>
        </section>
        <section v-if="data.stats.paths.length">
          <h4>Chemins</h4>
          <table class="table">
            <thead class="sr-only"><tr><th>Chemin</th><th>Requêtes</th><th>Erreurs</th></tr></thead>
            <tbody>
              <tr v-for="p in data.stats.paths" :key="p.path"><td class="mono path">{{ p.path }}</td><td class="num">{{ p.requests }}</td><td class="num"><UiBadge v-if="p.errors" tone="danger">{{ p.errors }}</UiBadge></td></tr>
            </tbody>
          </table>
        </section>
        <section v-if="data.stats.remotes.length">
          <h4>Clients</h4>
          <table class="table">
            <thead class="sr-only"><tr><th>Client</th><th>Requêtes</th></tr></thead>
            <tbody>
              <tr v-for="r in data.stats.remotes" :key="r.remote" class="clickable" @click="search = r.remote"><td class="mono">{{ r.remote }}</td><td class="num">{{ r.requests }}</td></tr>
            </tbody>
          </table>
        </section>
      </div>

      <h4>Dernières requêtes <span class="muted small">({{ data.entries.length }})</span></h4>
      <div class="scroll">
        <table class="table entries">
          <thead><tr><th>Heure</th><th>Domaine</th><th>Requête</th><th>Statut</th><th class="num">Durée</th><th class="num">Taille</th><th>Client</th></tr></thead>
          <tbody>
            <tr v-if="!data.entries.length"><td colspan="7" class="muted">Aucune requête</td></tr>
            <tr v-for="(e, i) in data.entries" :key="i">
              <td class="mono small">{{ timeOf(e.time) }}</td>
              <td class="mono small">{{ e.host ?? '—' }}</td>
              <td class="mono small req-cell" :title="[e.upstream ? `amont ${e.upstream}${e.upstreamTime !== null ? ` (${ms(e.upstreamTime)})` : ''}` : '', e.referer ? `depuis ${e.referer}` : ''].filter(Boolean).join('\n')"><strong>{{ e.method ?? '' }}</strong> {{ e.path }}</td>
              <td><UiBadge :tone="STATUS_TONE[toneOf(e.status)]">{{ e.status }}</UiBadge></td>
              <td class="num small">{{ ms(e.duration) }}</td>
              <td class="num small">{{ e.bytes !== null ? formatBytes(e.bytes) : '—' }}</td>
              <td class="mono small" :title="e.agent ?? ''">{{ e.remote ?? '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <template v-if="data.errors.length">
        <h4>Erreurs de nginx <span class="muted small">({{ data.errors.length }})</span></h4>
        <ul class="errors small">
          <li v-for="(e, i) in data.errors" :key="i"><span class="mono muted">{{ timeOf(e.time) }}</span> <UiBadge :tone="e.level === 'error' || e.level === 'crit' ? 'danger' : 'warning'">{{ e.level }}</UiBadge> <span class="mono">{{ e.message }}</span></li>
        </ul>
      </template>
    </template>
  </div>
</template>

<style scoped>
.alog { display: flex; flex-direction: column; gap: var(--space-2); min-width: 0; }
.bar { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center; }
.grow { flex: 1; min-width: 180px; }
.chips { display: inline-flex; gap: 2px; padding: 2px; background: var(--surface-3); border-radius: var(--radius); }
.chip { border: 0; background: transparent; padding: 3px 9px; border-radius: var(--radius); font-size: 12.5px; color: var(--text-muted); cursor: pointer; }
.chip.on { background: var(--surface); color: var(--text); box-shadow: var(--shadow); }
.auto { display: inline-flex; gap: 4px; align-items: center; }
.small { font-size: 12.5px; }
.alert { margin: 0; padding: var(--space-2) var(--space-3); border-radius: var(--radius); background: var(--danger-bg); color: var(--danger); }
.hint { margin: 0; padding: var(--space-2) var(--space-3); border-radius: var(--radius); background: var(--warning-bg); color: var(--warning); display: flex; gap: 6px; align-items: baseline; }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: var(--space-2); }
.kpi { display: flex; flex-direction: column; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-2); }
.kpi strong { font-size: 18px; font-variant-numeric: tabular-nums; }
.kpi span { font-size: 12px; color: var(--text-muted); }
.kpi .warn { color: var(--warning); }
.kpi .bad { color: var(--danger); }
.hist { display: flex; align-items: flex-end; gap: 1px; height: 64px; padding: 4px; border: 1px solid var(--border); border-radius: var(--radius); }
.col { flex: 1; height: 100%; display: flex; align-items: flex-end; min-width: 2px; }
.req { display: flex; flex-direction: column; justify-content: flex-start; width: 100%; background: color-mix(in srgb, var(--primary) 55%, transparent); border-radius: 2px 2px 0 0; min-height: 1px; }
.err { display: block; width: 100%; background: var(--danger); border-radius: 2px 2px 0 0; }
.tops { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: var(--space-3); }
h4 { margin: var(--space-2) 0 0; font-size: 13px; color: var(--text-muted); font-weight: 600; }
.table { width: 100%; border-collapse: collapse; font-size: 13px; }
.table th { text-align: left; font-size: 11px; text-transform: uppercase; color: var(--text-muted); padding: 4px 6px; border-bottom: 1px solid var(--border); position: sticky; top: 0; background: var(--surface); }
.table td { padding: 3px 6px; border-bottom: 1px solid var(--border); vertical-align: top; }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.path, .req-cell { max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.clickable { cursor: pointer; }
.clickable:hover { background: var(--surface-2); }
.scroll { max-height: 420px; overflow: auto; border: 1px solid var(--border); border-radius: var(--radius); }
.errors { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; max-height: 220px; overflow: auto; }
</style>
