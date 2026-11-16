<script setup lang="ts">
/**
 * Visualiseur de logs (§14). Deux modes :
 * - `deploymentId` : chargement des dernières lignes puis flux SSE temps réel
 *   (reprise automatique depuis le dernier id reçu après une coupure) ;
 * - `lines` : affichage de lignes fournies (diagnostic, prévisualisation).
 * Les messages arrivent déjà masqués par le serveur.
 */
import { Download } from 'lucide-vue-next'
import type { ViewerLine } from '~/types/logs'
import { byCode } from '#shared/utils/compare'

const props = withDefaults(defineProps<{ deploymentId?: string, lines?: ViewerLine[], live?: boolean, height?: string }>(), { deploymentId: undefined, lines: undefined, live: true, height: '520px' })
const toast = useToast()

const PHASES: Record<string, string> = { validation: 'Validation', extraction: 'Extraction', build: 'Build', portainer: 'Stack', service: 'Services', healthcheck: 'Healthchecks', system: 'Système' }
const LEVELS = ['debug', 'info', 'warn', 'error'] as const

const all = ref<ViewerLine[]>([])
const connected = ref(false)
const search = ref('')
const DEFAULT_LEVELS = ['info', 'warn', 'error']
const levels = ref<string[]>([...DEFAULT_LEVELS])
const phase = ref('')
const service = ref('')
const showRange = ref(false)
const from = ref('')
const to = ref('')
const hasOlder = ref(false)
const loadingOlder = ref(false)
const follow = ref(true)
const box = ref<HTMLElement>()
let source: EventSource | null = null

const MAX_LINES = 20_000

const visible = computed(() => {
  const q = search.value.trim().toLowerCase()
  const f = from.value ? new Date(from.value).getTime() : null
  const t = to.value ? new Date(to.value).getTime() : null
  return (props.lines ?? all.value).filter(l => levels.value.includes(l.level)
    && (!phase.value || l.phase === phase.value)
    && (!service.value || l.service === service.value)
    && (f === null || new Date(l.ts).getTime() >= f)
    && (t === null || new Date(l.ts).getTime() <= t)
    && (!q || l.message.toLowerCase().includes(q)))
})
const services = computed(() => [...new Set((props.lines ?? all.value).map(l => l.service).filter((s): s is string => !!s))].sort(byCode))
const filtered = computed(() => !!(service.value || from.value || to.value || phase.value || search.value.trim() || levels.value.length !== DEFAULT_LEVELS.length || DEFAULT_LEVELS.some(l => !levels.value.includes(l))))
const counts = computed(() => {
  const c: Record<string, number> = { debug: 0, info: 0, warn: 0, error: 0 }
  for (const l of props.lines ?? all.value) c[l.level] = (c[l.level] ?? 0) + 1
  return c
})

function append(lines: ViewerLine[]) {
  all.value.push(...lines)
  if (all.value.length > MAX_LINES) all.value.splice(0, all.value.length - MAX_LINES)
}

async function load() {
  if (!props.deploymentId) return
  const res = await $fetch<{ lines: ViewerLine[], hasMore: boolean }>(`/api/deployments/${props.deploymentId}/logs`, { query: { limit: 2000 } })
  all.value = res.lines
  hasOlder.value = res.hasMore
  if (props.live) connect()
}

/** Lignes plus anciennes que la première chargée (pagination serveur par curseur). */
async function loadOlder() {
  const first = all.value[0]
  if (!props.deploymentId || !first) return
  loadingOlder.value = true
  try {
    const res = await $fetch<{ lines: ViewerLine[], hasMore: boolean }>(`/api/deployments/${props.deploymentId}/logs`, { query: { limit: 2000, beforeId: first.id } })
    all.value = [...res.lines, ...all.value]
    hasOlder.value = res.hasMore
  }
  finally {
    loadingOlder.value = false
  }
}

function connect() {
  source?.close()
  const last = all.value.at(-1)?.id ?? '0'
  source = new EventSource(`/api/deployments/${props.deploymentId}/logs/stream?afterId=${last}`)
  source.onopen = () => { connected.value = true }
  source.addEventListener('log', (e) => {
    connected.value = true
    append([JSON.parse((e as MessageEvent).data)])
  })
  // EventSource se reconnecte seul et renvoie Last-Event-ID : aucune ligne perdue.
  source.onerror = () => { connected.value = false }
}

function stop() {
  source?.close()
  source = null
  connected.value = false
}

defineExpose({ stop })

watch(() => visible.value.length, async () => {
  if (!follow.value) return
  await nextTick()
  box.value?.scrollTo({ top: box.value.scrollHeight })
})

function onScroll() {
  const el = box.value
  if (!el) return
  follow.value = el.scrollHeight - el.scrollTop - el.clientHeight < 40
}

const fmtTs = (iso: string) => `${fmtTime(iso)}.${iso.slice(20, 23)}`
const lineText = (l: ViewerLine) => `${l.ts} ${l.level.toUpperCase()} [${l.phase}${l.service ? `/${l.service}` : ''}] ${l.message}`

async function copy(l: ViewerLine) {
  try {
    await navigator.clipboard.writeText(lineText(l))
    toast.info('Ligne copiée')
  }
  catch {
    toast.error('Copie impossible')
  }
}

function download() {
  if (props.deploymentId) {
    // Tout le journal côté serveur, avec les filtres affichés.
    const p = new URLSearchParams({ format: 'text' })
    if (levels.value.length < 4) p.set('levels', levels.value.join(','))
    if (phase.value) p.set('phases', phase.value)
    if (service.value) p.set('service', service.value)
    if (search.value.trim()) p.set('q', search.value.trim())
    if (from.value) p.set('from', new Date(from.value).toISOString())
    if (to.value) p.set('to', new Date(to.value).toISOString())
    window.open(`/api/deployments/${props.deploymentId}/logs?${p}`, '_blank', 'noopener')
    return
  }
  const blob = new Blob([visible.value.map(lineText).join('\n')], { type: 'text/plain' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = 'logs.txt'
  a.click()
  URL.revokeObjectURL(a.href)
}

// Filtres affichés repris pour l'analyse : le modèle lit les mêmes lignes que l'utilisateur.
const analysisBody = computed(() => ({
  levels: levels.value.length ? levels.value : undefined,
  phases: phase.value ? [phase.value] : undefined,
  service: service.value || undefined,
  limit: 1000,
}))

function resetFilters() {
  search.value = ''
  levels.value = [...DEFAULT_LEVELS]
  phase.value = ''
  service.value = ''
  from.value = ''
  to.value = ''
  showRange.value = false
}

function toggleLevel(l: string) {
  levels.value = levels.value.includes(l) ? levels.value.filter(x => x !== l) : [...levels.value, l]
}

onMounted(() => void load())
onBeforeUnmount(stop)
// Fin du déploiement : on laisse arriver les dernières lignes puis on ferme le flux.
let drainTimer: ReturnType<typeof setTimeout> | undefined
watch(() => props.live, (live) => {
  clearTimeout(drainTimer)
  if (live && props.deploymentId && !source) connect()
  else if (!live) drainTimer = setTimeout(stop, 3000)
})
watch(() => props.deploymentId, () => {
  stop()
  void load()
})
</script>

<template>
  <div class="viewer card">
    <div class="toolbar">
      <input v-model="search" class="input search" type="search" placeholder="Rechercher dans les logs…" aria-label="Rechercher dans les logs">
      <div class="levels" role="group" aria-label="Niveaux">
        <button v-for="l in LEVELS" :key="l" type="button" class="chip" :class="[`chip--${l}`, { on: levels.includes(l) }]" :aria-pressed="levels.includes(l)" @click="toggleLevel(l)">
          {{ l }} <span class="n">{{ counts[l] }}</span>
        </button>
      </div>
      <select v-model="phase" class="input phase" aria-label="Phase">
        <option value="">Toutes les phases</option>
        <option v-for="(label, k) in PHASES" :key="k" :value="k">{{ label }}</option>
      </select>
      <select v-if="services.length" v-model="service" class="input phase" aria-label="Service">
        <option value="">Tous les services</option>
        <option v-for="s in services" :key="s" :value="s">{{ s }}</option>
      </select>
      <!-- Période : affichée sur demande (ou si elle est renseignée), pour garder la barre sur une ligne. -->
      <UiButton v-if="!showRange && !from && !to" size="sm" variant="ghost" @click="showRange = true">Période…</UiButton>
      <template v-else>
        <label class="range">Du <input v-model="from" class="input dt" type="datetime-local" step="1" aria-label="Depuis"></label>
        <label class="range">au <input v-model="to" class="input dt" type="datetime-local" step="1" aria-label="Jusqu'à"></label>
      </template>
      <UiButton v-if="filtered" size="sm" variant="ghost" @click="resetFilters">Réinitialiser</UiButton>
      <span class="spacer" />
      <span v-if="deploymentId && live" class="live" :class="{ on: connected }">{{ connected ? '● en direct' : '○ connexion…' }}</span>
      <UiButton size="sm" variant="ghost" :aria-pressed="follow" @click="follow = !follow">{{ follow ? 'Suivi' : 'Suivre' }}</UiButton>
      <LogAnalysis v-if="deploymentId" :url="`/api/deployments/${deploymentId}/logs/analyze`" :body="analysisBody" />
      <UiButton size="sm" aria-label="Télécharger" title="Télécharger les logs" @click="download"><Download :size="14" /></UiButton>
    </div>
    <div ref="box" class="lines mono" :style="{ height }" role="log" aria-live="polite" @scroll="onScroll">
      <div v-if="hasOlder" class="older">
        <UiButton size="sm" variant="ghost" :loading="loadingOlder" @click="loadOlder">Charger les lignes précédentes</UiButton>
      </div>
      <p v-if="!visible.length" class="empty">Aucune ligne{{ (lines ?? all).length ? ' ne correspond aux filtres' : '' }}.</p>
      <div v-for="l in visible" :key="l.id" class="line" :class="`lv-${l.level}`">
        <span class="ts">{{ fmtTs(l.ts) }}</span>
        <span class="lvl">{{ l.level }}</span>
        <span class="ph">{{ PHASES[l.phase] ?? l.phase }}<template v-if="l.service">/{{ l.service }}</template></span>
        <span class="msg">{{ l.message }}</span>
        <button type="button" class="copy" aria-label="Copier la ligne" @click="copy(l)">⧉</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.viewer { overflow: hidden; display: flex; flex-direction: column; }
.toolbar { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center; padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--border); }
.toolbar .input { min-height: 30px; padding-top: 3px; padding-bottom: 3px; font-size: 12.5px; }
.search { max-width: 190px; }
.phase { width: auto; max-width: 200px; field-sizing: content; }
.spacer { flex: 1; }
.levels { display: flex; gap: 4px; }
.range { display: inline-flex; gap: 4px; align-items: center; font-size: 12.5px; color: var(--text-muted); }
.dt { width: auto; max-width: 175px; }
.older { text-align: center; padding: 4px; }
.chip { all: unset; cursor: pointer; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border); font-size: 12px; color: var(--text-muted); opacity: .6; }
.chip.on { opacity: 1; }
.chip:focus-visible { outline: 2px solid var(--focus); }
.chip--warn.on { background: var(--warning-bg); color: var(--warning); border-color: transparent; }
.chip--error.on { background: var(--danger-bg); color: var(--danger); border-color: transparent; }
.chip--info.on { background: var(--info-bg); color: var(--info); border-color: transparent; }
.n { opacity: .7; margin-left: 2px; }
.live { font-size: 12px; color: var(--text-muted); }
.live.on { color: var(--success); }
.lines { overflow: auto; background: var(--surface-2); padding: var(--space-2) 0; font-size: 12.5px; line-height: 1.55; }
.line { display: grid; grid-template-columns: 96px 44px 110px 1fr 24px; gap: var(--space-2); padding: 0 var(--space-3); align-items: baseline; }
.line:hover { background: color-mix(in srgb, var(--primary) 6%, transparent); }
.ts, .ph { color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lvl { text-transform: uppercase; font-size: 11px; color: var(--text-muted); }
.lv-warn .lvl, .lv-warn .msg { color: var(--warning); }
.lv-error .lvl, .lv-error .msg { color: var(--danger); }
.msg { white-space: pre-wrap; word-break: break-word; }
.copy { all: unset; cursor: pointer; opacity: 0; color: var(--text-muted); text-align: center; }
.line:hover .copy, .copy:focus-visible { opacity: 1; }
.empty { color: var(--text-muted); text-align: center; padding: var(--space-5); margin: 0; font-family: var(--font-sans); }
@media (max-width: 860px) { .line { grid-template-columns: 70px 1fr 24px; } .lvl, .ph { display: none; } }
</style>
