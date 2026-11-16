<script setup lang="ts">
/**
 * Détail d'un conteneur, lu en direct : état et santé, métriques (rafraîchies
 * toutes les 5 s), logs récents, réseau, volumes, variables (noms seulement).
 */
import type { LiveContainerDetail } from '#shared/schemas/live'
import { analyzeLogs } from '#shared/utils/log-insights'
import type { MetricRange, MetricsDto } from '#shared/schemas/metrics'
import { Copy, RefreshCw } from 'lucide-vue-next'

const props = defineProps<{ endpointId: string, containerId: string }>()
const { hasAny } = useAuth()
const toast = useToast()
const tab = ref('overview')
const detail = ref<LiveContainerDetail | null>(null)
const error = ref<string | null>(null)

async function load() {
  try {
    detail.value = await $fetch<LiveContainerDetail>(`/api/endpoints/${props.endpointId}/containers/${props.containerId}`)
    error.value = null
  }
  catch (err) {
    error.value = apiError(err).message
  }
}
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  void load()
  timer = setInterval(() => void load(), 5_000)
})
onBeforeUnmount(() => clearInterval(timer))

// Logs récents, rafraîchis à la demande ou en continu.
const logs = ref<string[] | null>(null)
const logsAt = ref<string | null>(null)
const follow = ref(true)
const logFilter = ref('')
const logBox = ref<HTMLElement>()
async function loadLogs() {
  try {
    const r = await $fetch<{ lines: string[], at: string }>(`/api/endpoints/${props.endpointId}/containers/${props.containerId}/logs`, { query: { tail: 300 } })
    logs.value = r.lines
    logsAt.value = r.at
    if (follow.value) {
      await nextTick()
      logBox.value?.scrollTo({ top: logBox.value.scrollHeight })
    }
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
}
let logTimer: ReturnType<typeof setInterval> | undefined
watch([tab, follow], ([t, f]) => {
  clearInterval(logTimer)
  if (t === 'logs') {
    void loadLogs()
    if (f) logTimer = setInterval(() => void loadLogs(), 3_000)
  }
})
onBeforeUnmount(() => clearInterval(logTimer))
// Analyse en direct : signatures d'erreurs connues dans les lignes lues (recalculée à chaque lecture).
const insights = computed(() => analyzeLogs(logs.value ?? []))
const openInsight = ref<string | null>(null)
const INSIGHT_TONE = { error: 'danger', warning: 'warning', info: 'info' } as const
const shownLogs = computed(() => {
  const q = logFilter.value.trim().toLowerCase()
  return (logs.value ?? []).filter(l => !q || l.toLowerCase().includes(q))
})

// Historique des ressources (relevés par minute des conteneurs déployés par la plateforme).
const RANGES: { key: MetricRange, label: string }[] = [{ key: '1h', label: '1 h' }, { key: '6h', label: '6 h' }, { key: '24h', label: '24 h' }, { key: '7d', label: '7 j' }]
const range = ref<MetricRange>('1h')
const history = ref<MetricsDto | null>(null)
async function loadHistory() {
  try {
    history.value = await $fetch<MetricsDto>(`/api/endpoints/${props.endpointId}/containers/${props.containerId}/metrics`, { query: { range: range.value } })
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
}
let historyTimer: ReturnType<typeof setInterval> | undefined
watch([tab, range], ([t]) => {
  clearInterval(historyTimer)
  if (t === 'history') {
    void loadHistory()
    historyTimer = setInterval(() => void loadHistory(), 30_000)
  }
})
onBeforeUnmount(() => clearInterval(historyTimer))
const cpuPoints = computed(() => (history.value?.points ?? []).map(p => ({ t: p.t, v: p.cpu })))
const memPoints = computed(() => (history.value?.points ?? []).map(p => ({ t: p.t, v: p.memory })))
const memLimit = computed(() => history.value?.points.findLast(p => p.memoryLimit)?.memoryLimit ?? null)
const restartsGained = computed(() => {
  const r = (history.value?.points ?? []).map(p => p.restarts).filter((n): n is number => n !== null)
  return r.length > 1 ? r.reduce((a, v, i) => a + (i ? Math.max(0, v - r[i - 1]!) : 0), 0) : 0
})

const c = computed(() => detail.value?.container)
const s = computed(() => detail.value?.stats)
const memPct = computed(() => (s.value?.memoryBytes && s.value.memoryLimitBytes ? Math.min(100, (s.value.memoryBytes / s.value.memoryLimitBytes) * 100) : null))
const tabs = computed(() => [
  { key: 'overview', label: 'Aperçu' },
  ...(hasAny('logs:read') ? [{ key: 'logs', label: 'Logs' }] : []),
  ...(hasAny('container:exec') && c.value?.state.running && detail.value?.execSupported ? [{ key: 'console', label: 'Console' }] : []),
  { key: 'history', label: 'Historique' },
  { key: 'network', label: 'Réseau et volumes' },
  { key: 'env', label: 'Variables', badge: c.value?.envKeys.length },
  { key: 'labels', label: 'Labels' },
])
const copy = (t: string) => navigator.clipboard.writeText(t).then(() => toast.info('Copié'), () => toast.error('Copie impossible'))
</script>

<template>
  <div class="detail">
    <p v-if="error" class="alert">{{ error }}</p>
    <template v-if="c">
      <div class="state-row">
        <ContainerState :state="(c.state.status as never)" :health="(c.health?.status as never) ?? null" />
        <span class="muted small">{{ c.state.running ? `démarré ${fmtRelative(c.state.startedAt)}` : c.state.finishedAt ? `arrêté ${fmtRelative(c.state.finishedAt)}` : 'jamais démarré' }}</span>
        <UiBadge v-if="c.restartCount" tone="warning">{{ c.restartCount }} redémarrage{{ c.restartCount > 1 ? 's' : '' }}</UiBadge>
        <UiBadge v-if="c.state.oomKilled" tone="danger">mémoire épuisée (OOM)</UiBadge>
        <NuxtLink v-if="detail?.project" :to="`/projects/${detail.project.id}`" class="small proj">{{ detail.project.name }} · {{ detail.project.environment }}</NuxtLink>
      </div>

      <UiTabs v-model="tab" :tabs="tabs" />

      <template v-if="tab === 'overview'">
        <div v-if="c.state.running" class="metrics">
          <div class="metric">
            <span class="k">CPU</span>
            <strong>{{ s?.cpuPercent ?? '—' }}<small v-if="s?.cpuPercent !== null && s?.cpuPercent !== undefined"> %</small></strong>
            <span class="meter"><span :style="{ width: `${Math.min(100, s?.cpuPercent ?? 0)}%` }" /></span>
          </div>
          <div class="metric">
            <span class="k">Mémoire</span>
            <strong>{{ fmtBytesShort(s?.memoryBytes) }}</strong>
            <span class="meter"><span :style="{ width: `${memPct ?? 0}%` }" :class="{ hot: (memPct ?? 0) > 85 }" /></span>
            <span class="muted tiny">sur {{ fmtBytesShort(s?.memoryLimitBytes) }}</span>
          </div>
          <div class="metric">
            <span class="k">Réseau</span>
            <strong class="sm">↓ {{ fmtBytesShort(s?.netRxBytes) }}</strong>
            <strong class="sm">↑ {{ fmtBytesShort(s?.netTxBytes) }}</strong>
          </div>
          <div class="metric">
            <span class="k">Processus</span>
            <strong>{{ s?.pids ?? '—' }}</strong>
            <span class="muted tiny">E/S disque {{ fmtBytesShort(s?.blockReadBytes) }} / {{ fmtBytesShort(s?.blockWriteBytes) }}</span>
          </div>
        </div>
        <p v-else-if="c.state.exitCode !== null" class="alert soft">Arrêté avec le code {{ c.state.exitCode }}{{ c.state.exitCode === 0 ? ' (arrêt normal)' : c.state.exitCode === 137 ? ' (tué : SIGKILL ou mémoire)' : c.state.exitCode === 143 ? ' (SIGTERM)' : '' }}{{ c.state.error ? ` : ${c.state.error}` : '' }}.</p>

        <dl class="dl">
          <dt>Image</dt><dd class="mono">{{ c.image }} <button class="ic" type="button" aria-label="Copier l'image" @click="copy(c.image)"><Copy :size="13" /></button></dd>
          <dt>Identifiant</dt><dd class="mono">{{ c.id.slice(0, 12) }} <span class="muted">· image {{ c.imageId.replace('sha256:', '').slice(0, 12) }}</span></dd>
          <dt>Commande</dt><dd class="mono">{{ [...c.entrypoint, ...c.command].join(' ') || '—' }}</dd>
          <dt>Créé</dt><dd>{{ fmtDateTime(c.createdAt) }}</dd>
          <dt>Redémarrage</dt><dd>{{ c.restartPolicy ?? 'aucun' }}</dd>
          <dt v-if="c.user">Utilisateur</dt><dd v-if="c.user" class="mono">{{ c.user }}</dd>
          <dt v-if="c.workingDir">Répertoire</dt><dd v-if="c.workingDir" class="mono">{{ c.workingDir }}</dd>
        </dl>

        <section v-if="c.health" class="health">
          <h3>Healthcheck <UiBadge :tone="c.health.status === 'healthy' ? 'success' : c.health.status === 'unhealthy' ? 'danger' : 'warning'">{{ c.health.status }}</UiBadge></h3>
          <p v-if="c.health.failingStreak" class="small muted">{{ c.health.failingStreak }} échec(s) consécutif(s)</p>
          <ul class="checks">
            <!-- Une ligne par vérification ; une sortie longue ou multiligne se déplie. -->
            <li v-for="(h, i) in [...c.health.log].reverse()" :key="i" :class="{ ko: h.exitCode !== 0 }">
              <UiBadge :tone="h.exitCode === 0 ? 'success' : 'danger'" dot>{{ h.exitCode === 0 ? 'OK' : `code ${h.exitCode}` }}</UiBadge>
              <span class="muted small when">{{ fmtDateTime(h.start) }}</span>
              <details v-if="h.output.trim().length > 90 || h.output.trim().includes('\n')" class="out-d">
                <summary class="mono small one" :title="h.output.trim()">{{ h.output.trim().split('\n')[0] }}</summary>
                <pre class="out">{{ h.output.trim() }}</pre>
              </details>
              <span v-else-if="h.output.trim()" class="mono small one">{{ h.output.trim() }}</span>
            </li>
          </ul>
        </section>
      </template>

 <section v-else-if="tab === 'history'" class="history" data-testid="history">
        <div class="range" role="group" aria-label="Période">
          <UiButton v-for="r in RANGES" :key="r.key" size="sm" :variant="range === r.key ? 'primary' : 'ghost'" @click="range = r.key">{{ r.label }}</UiButton>
        </div>
        <p v-for="a in history?.alerts ?? []" :key="a.id" class="alert" role="alert">{{ a.rule }} : seuil {{ a.threshold }} dépassé depuis {{ fmtRelative(a.since) }}.</p>
        <p v-if="history && !history.tracked" class="muted small">Pas encore de relevé : l'historique concerne les conteneurs déployés par Sherpa (un relevé par minute, conservé quelques jours).</p>
        <template v-else-if="history">
          <MetricsChart title="CPU" :points="cpuPoints" :format="v => `${Math.round(v * 10) / 10} %`" />
          <MetricsChart title="Mémoire" :points="memPoints" :format="v => fmtBytesShort(v)" :line="memLimit ? { value: memLimit, label: `limite ${fmtBytesShort(memLimit)}` } : null" />
          <p class="muted small">Redémarrages sur la période : <strong>{{ restartsGained }}</strong>. Moyenne du CPU, maximum de la mémoire par intervalle.</p>
        </template>
      </section>

      <ExecTerminal v-else-if="tab === 'console'" :endpoint-id="endpointId" :container-id="containerId" />

      <section v-else-if="tab === 'logs'" class="logs">
        <div class="log-bar">
          <input v-model="logFilter" class="input" type="search" placeholder="Filtrer les lignes…" aria-label="Filtrer les logs">
          <UiSwitch v-model="follow" label="En direct" />
          <UiButton size="sm" variant="ghost" aria-label="Actualiser" @click="loadLogs"><RefreshCw :size="14" /></UiButton>
          <LogAnalysis :url="`/api/endpoints/${endpointId}/containers/${containerId}/logs/analyze`" :body="{ tail: 300 }" />
        </div>
        <section v-if="insights.length" class="insights" aria-label="Analyse des logs">
          <h3 class="small">Analyse des logs <span class="muted tiny">({{ insights.length }} cause{{ insights.length > 1 ? 's' : '' }} reconnue{{ insights.length > 1 ? 's' : '' }})</span></h3>
          <article v-for="i in insights" :key="i.id" class="insight" :class="i.severity">
            <button type="button" class="ins-head" :aria-expanded="openInsight === i.id || insights.length === 1" @click="openInsight = openInsight === i.id ? null : i.id">
              <UiBadge :tone="INSIGHT_TONE[i.severity]">{{ i.severity === 'error' ? 'erreur' : i.severity === 'warning' ? 'attention' : 'info' }}</UiBadge>
              <strong>{{ i.title }}</strong>
              <span class="muted tiny">{{ i.count }} ligne{{ i.count > 1 ? 's' : '' }}</span>
            </button>
            <div v-if="openInsight === i.id || insights.length === 1" class="ins-body small">
              <p>{{ i.explain }}</p>
              <p><strong>À faire :</strong> {{ i.fix }}</p>
              <p class="mono tiny sample">{{ i.sample }}</p>
            </div>
          </article>
        </section>
        <p v-else-if="logs?.length" class="muted tiny">Analyse des logs : aucune cause connue repérée dans ces lignes.</p>
        <div ref="logBox" class="log-box mono" role="log">
          <p v-if="logs === null" class="muted">Chargement…</p>
          <p v-else-if="!shownLogs.length" class="muted">Aucune ligne{{ logs.length ? ' ne correspond au filtre' : '' }}.</p>
          <div v-for="(l, i) in shownLogs" :key="i" class="ln">{{ l }}</div>
        </div>
        <p class="muted tiny">300 dernières lignes · secrets masqués · lu {{ fmtRelative(logsAt) }}</p>
      </section>

      <template v-else-if="tab === 'network'">
        <section>
          <h3>Ports</h3>
          <p v-if="!c.ports.length" class="muted small">Aucun port exposé.</p>
          <div class="chips"><span v-for="(p, i) in c.ports" :key="i" class="chip mono">{{ p.host ? `${p.host} → ` : '' }}{{ p.container }}</span></div>
        </section>
        <section>
          <h3>Réseaux</h3>
          <ul class="rows"><li v-for="n in c.networks" :key="n.name"><strong>{{ n.name }}</strong> <span class="mono muted">{{ n.ip ?? '' }}</span> <span v-if="n.aliases.length" class="muted small">alias : {{ n.aliases.join(', ') }}</span></li></ul>
        </section>
        <section>
          <h3>Volumes</h3>
          <p v-if="!c.mounts.length" class="muted small">Aucun volume.</p>
          <ul class="rows">
            <li v-for="(m, i) in c.mounts" :key="i">
              <UiBadge>{{ m.type }}</UiBadge>
              <span class="mono">{{ m.name ?? m.source }}</span> → <span class="mono">{{ m.destination }}</span>
              <UiBadge v-if="!m.rw" tone="info">lecture seule</UiBadge>
            </li>
          </ul>
        </section>
      </template>

      <section v-else-if="tab === 'env'">
        <p class="muted small">Valeurs jamais lues.</p>
        <div class="chips"><span v-for="k in c.envKeys" :key="k" class="chip mono">{{ k }}</span></div>
      </section>

      <section v-else>
        <table class="kv">
          <thead class="sr-only"><tr><th>Étiquette</th><th>Valeur</th></tr></thead>
          <tbody><tr v-for="(v, k) in c.labels" :key="k"><td class="mono">{{ k }}</td><td class="mono">{{ v }}</td></tr></tbody>
        </table>
      </section>
    </template>
    <p v-else-if="!error" class="muted">Lecture du conteneur…</p>
  </div>
</template>

<style scoped>
.detail { display: flex; flex-direction: column; gap: var(--space-4); }
.state-row { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
.proj { margin-left: auto; }
.small { font-size: 12.5px; margin: 0; }
.tiny { font-size: 11.5px; margin: 0; }
.alert { margin: 0; padding: 6px var(--space-3); font-size: 13px; border-radius: var(--radius); background: var(--danger-bg); color: var(--danger); }
.alert.soft { background: var(--warning-bg); color: var(--warning); }
.metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: var(--space-3); }
.metric { padding: var(--space-3); border-radius: var(--radius); background: var(--surface-2); border: 1px solid var(--border); display: flex; flex-direction: column; gap: 4px; }
.metric .k { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--text-faint); font-weight: 600; }
.metric strong { font-size: 20px; font-variant-numeric: tabular-nums; }
.metric strong.sm { font-size: 14px; }
.metric small { font-size: 12px; color: var(--text-muted); }
.meter { height: 6px; border-radius: 999px; background: var(--surface-3); overflow: hidden; }
.meter span { display: block; height: 100%; background: var(--primary); border-radius: 999px; transition: width .4s; }
.meter span.hot { background: var(--danger); }
.dl { display: grid; grid-template-columns: max-content 1fr; gap: 3px var(--space-4); margin: 0; font-size: 13px; }
.dl dt { color: var(--text-muted); }
.dl dd { margin: 0; overflow-wrap: anywhere; }
.ic { all: unset; cursor: pointer; color: var(--text-faint); vertical-align: middle; }
.ic:hover { color: var(--primary); }
h3 { font-size: 14px; display: flex; gap: var(--space-2); align-items: center; margin-bottom: var(--space-2); }
.checks { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.checks li { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center; }
.checks li { flex-wrap: nowrap; align-items: baseline; min-width: 0; }
.when { white-space: nowrap; }
.one { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.out-d { min-width: 0; flex: 1; }
.out-d summary { cursor: pointer; display: block; }
.out-d[open] .out { margin-top: 4px; }
.out { flex-basis: 100%; margin: 0; padding: var(--space-2); background: var(--surface-2); border-radius: var(--radius-sm); font-size: 12px; max-height: 120px; overflow: auto; white-space: pre-wrap; }
.logs { display: flex; flex-direction: column; gap: var(--space-2); }
.history { display: flex; flex-direction: column; gap: var(--space-3); }
.range { display: flex; gap: 4px; }
.log-bar { display: flex; gap: var(--space-3); align-items: center; }
.log-box { height: 52vh; overflow: auto; padding: var(--space-3); border-radius: var(--radius); background: #0b1020; color: #d7dcf0; font-size: 12px; line-height: 1.55; }
.log-box .muted { color: #8a92a8; }
.ln { white-space: pre-wrap; overflow-wrap: anywhere; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { padding: 3px 8px; border-radius: var(--radius-sm); background: var(--surface-2); border: 1px solid var(--border); font-size: 12px; }
.rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2); font-size: 13px; }
.rows li { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; overflow-wrap: anywhere; }
.kv { width: 100%; border-collapse: collapse; font-size: 12px; }
.kv td { padding: 4px 6px; border-bottom: 1px solid var(--border); vertical-align: top; overflow-wrap: anywhere; }
.kv td:first-child { color: var(--text-muted); width: 45%; }
.insights { display: flex; flex-direction: column; gap: 6px; margin-bottom: var(--space-2); }
.insights h3 { margin: 0; }
.insight { border: 1px solid var(--border); border-left-width: 3px; border-radius: var(--radius); padding: 6px 8px; background: var(--surface); }
.insight.error { border-left-color: var(--danger); }
.insight.warning { border-left-color: var(--warning); }
.insight.info { border-left-color: var(--info, var(--primary)); }
.ins-head { display: flex; align-items: center; gap: 8px; width: 100%; background: none; border: 0; padding: 0; color: var(--text); cursor: pointer; text-align: left; font: inherit; }
.ins-body p { margin: 6px 0 0; }
.sample { padding: 4px 6px; background: var(--surface-2); border-radius: var(--radius); overflow-wrap: anywhere; }
</style>
