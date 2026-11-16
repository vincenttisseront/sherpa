<script setup lang="ts" generic="T extends { id: string }">
/**
 * Tableau (§17) : recherche, filtres combinables (slot #filters), tri et
 * pagination côté serveur, période, export CSV des lignes filtrées,
 * colonnes configurables, vues sauvegardées, réinitialisation.
 * L'état (hors colonnes) est contrôlé par le parent via v-model:query.
 */
import { PERIOD_LABEL } from '#shared/schemas/common'
import type { SavedViewDto } from '#shared/schemas/saved-views'
import type { Column, TableState } from '~/types/table'
import { Bookmark, Columns3, Download, Inbox, RotateCcw, Search, SlidersHorizontal, Trash2 } from 'lucide-vue-next'

const props = defineProps<{
  columns: Column<T>[]
  rows: T[]
  total: number
  loading?: boolean
  emptyText?: string
  /** Active colonnes mémorisées et vues sauvegardées. */
  tableKey?: string
  /** URL de la liste (même route que l'écran) : active l'export CSV. */
  exportUrl?: string
  /** Affiche le filtre de période. */
  period?: boolean
  /** Sélection de lignes (actions groupées) : lignes éligibles. */
  selectable?: (row: T) => boolean
  /** Filtres imposés par l'écran (ex. la cible d'un projet) : ni comptés, ni effacés par Réinitialiser. */
  fixed?: Record<string, string | number | undefined>
  /** Valeurs par défaut de l'écran (ex. période 7 jours) : non comptées comme filtre, rétablies par Réinitialiser. */
  defaults?: Record<string, string | number | undefined>
}>()
const query = defineModel<TableState>('query', { required: true })
/** Identifiants des lignes sélectionnées (conservés d'une page à l'autre). */
const selected = defineModel<string[]>('selected', { default: () => [] })
const rowId = (row: T) => String((row as { id?: unknown }).id)
const selectableRows = computed(() => (props.selectable ? props.rows.filter(r => props.selectable!(r)) : []))
const pageAllSelected = computed(() => selectableRows.value.length > 0 && selectableRows.value.every(r => selected.value.includes(rowId(r))))
function toggleRow(row: T) {
  const id = rowId(row)
  selected.value = selected.value.includes(id) ? selected.value.filter(x => x !== id) : [...selected.value, id]
}
function togglePage() {
  const ids = selectableRows.value.map(rowId)
  selected.value = pageAllSelected.value ? selected.value.filter(x => !ids.includes(x)) : [...new Set([...selected.value, ...ids])]
}
const emit = defineEmits<{ reset: [] }>()
const toast = useToast()
const confirm = useConfirm()

// --- Recherche ---
const search = ref(String(query.value.q ?? ''))
const filtersOpen = ref(false)
let debounce: ReturnType<typeof setTimeout> | undefined
watch(search, (v) => {
  clearTimeout(debounce)
  debounce = setTimeout(() => { if ((query.value.q ?? '') !== v) query.value = { ...query.value, q: v || undefined, page: 1 } }, 300)
})
watch(() => query.value.q, (v) => { if ((v ?? '') !== search.value) search.value = String(v ?? '') })

// --- Pagination et tri ---
const pageCount = computed(() => Math.max(1, Math.ceil(props.total / query.value.pageSize)))
const sortKey = computed(() => query.value.sort?.split(':')[0])
const sortDir = computed(() => query.value.sort?.split(':')[1])
function toggleSort(col: Column<T>) {
  if (!col.sortable) return
  const dir = sortKey.value === col.key && sortDir.value === 'asc' ? 'desc' : 'asc'
  query.value = { ...query.value, sort: `${col.key}:${dir}`, page: 1 }
}
function goTo(page: number) {
  query.value = { ...query.value, page: Math.min(Math.max(1, page), pageCount.value) }
}
function ariaSort(col: Column<T>) {
  if (sortKey.value !== col.key) return 'none'
  return sortDir.value === 'asc' ? 'ascending' : 'descending'
}

// --- Période ---
const periodMode = computed<string>({
  get: () => (query.value.period ? String(query.value.period) : query.value.from || query.value.to ? 'custom' : ''),
  set: (v) => {
    const { period: _p, from: _f, to: _t, ...rest } = query.value
    if (v === 'custom') query.value = { ...rest, page: 1, from: new Date(Date.now() - 7 * 864e5).toISOString() } as TableState
    else query.value = { ...rest, page: 1, ...(v ? { period: v } : {}) } as TableState
  },
})
const dayOf = (iso: unknown) => (typeof iso === 'string' ? iso.slice(0, 10) : '')
function setBound(which: 'from' | 'to', day: string) {
  const iso = day ? new Date(`${day}T${which === 'from' ? '00:00:00' : '23:59:59'}`).toISOString() : undefined
  query.value = { ...query.value, [which]: iso, page: 1 }
}

// --- Colonnes ---
const storageKey = computed(() => (props.tableKey ? `pp:cols:${props.tableKey}` : null))
const hidden = ref<string[]>(props.columns.filter(c => c.defaultHidden).map(c => c.key))
onMounted(() => {
  if (!storageKey.value) return
  try {
    const raw = localStorage.getItem(storageKey.value)
    if (raw) hidden.value = (JSON.parse(raw) as string[]).filter(k => props.columns.some(c => c.key === k))
  }
  catch { /* stockage indisponible : colonnes par défaut */ }
})
watch(hidden, (v) => {
  if (!storageKey.value) return
  try {
    localStorage.setItem(storageKey.value, JSON.stringify(v))
  }
  catch { /* ignoré */ }
}, { deep: true })
const visibleColumns = computed(() => props.columns.filter(c => !hidden.value.includes(c.key)))
function toggleColumn(key: string) {
  const next = hidden.value.includes(key) ? hidden.value.filter(k => k !== key) : [...hidden.value, key]
  // Toujours au moins une colonne.
  if (props.columns.some(c => !next.includes(c.key))) hidden.value = next
}

// --- Filtres actifs et réinitialisation ---
const BASE_KEYS = ['page', 'pageSize', 'sort']
const activeFilters = computed(() => Object.entries(query.value).filter(([k, v]) => !BASE_KEYS.includes(k) && !(props.fixed && k in props.fixed) && v !== undefined && v !== '' && v !== null && props.defaults?.[k] !== v).length)
function reset() {
  search.value = ''
  query.value = { page: 1, pageSize: query.value.pageSize, ...(props.defaults ?? {}), ...(props.fixed ?? {}) }
  currentView.value = ''
  emit('reset')
}

// --- Export CSV ---
function params(extra: Record<string, string>) {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(query.value)) {
    if (v === undefined || v === null || v === '' || k === 'page' || k === 'pageSize') continue
    p.set(k, Array.isArray(v) ? v.join(',') : String(v))
  }
  for (const [k, v] of Object.entries(extra)) p.set(k, v)
  return p.toString()
}
const csvHref = computed(() => (props.exportUrl ? `${props.exportUrl}?${params({ format: 'csv', columns: visibleColumns.value.filter(c => c.exportable !== false).map(c => c.key).join(',') })}` : null))

// --- Vues sauvegardées ---
const views = ref<SavedViewDto[]>([])
const currentView = ref('')
async function loadViews() {
  if (!props.tableKey) return
  views.value = await $fetch<SavedViewDto[]>('/api/saved-views', { query: { table: props.tableKey } }).catch(() => [])
}
onMounted(loadViews)
function applyView(id: string) {
  currentView.value = id
  const v = views.value.find(x => x.id === id)
  if (!v) return
  const { _hidden, ...state } = v.state as { _hidden?: string[] } & Record<string, unknown>
  query.value = { pageSize: query.value.pageSize, ...state, page: 1 } as TableState
  if (Array.isArray(_hidden)) hidden.value = _hidden.filter(k => props.columns.some(c => c.key === k))
}
const saveOpen = ref(false)
const viewName = ref('')
const saving = ref(false)
function openSave() {
  viewName.value = views.value.find(v => v.id === currentView.value)?.name ?? ''
  saveOpen.value = true
}
async function saveView() {
  if (!viewName.value.trim()) return
  saving.value = true
  try {
    const { page: _page, ...state } = query.value
    const v = await $fetch<SavedViewDto>('/api/saved-views', { method: 'POST', body: { tableKey: props.tableKey, name: viewName.value.trim(), state: { ...state, _hidden: hidden.value } } })
    await loadViews()
    currentView.value = v.id
    saveOpen.value = false
    toast.success(`Vue « ${v.name} » enregistrée`)
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    saving.value = false
  }
}
async function deleteView() {
  const v = views.value.find(x => x.id === currentView.value)
  if (!v) return
  if (!await confirm({ title: 'Supprimer la vue', message: `La vue « ${v.name} » sera supprimée. Les données ne sont pas modifiées.`, confirmLabel: 'Supprimer', danger: true })) return
  try {
    await $fetch<unknown>(`/api/saved-views/${v.id}`, { method: 'DELETE' })
    currentView.value = ''
    await loadViews()
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
}

function cell(row: T, col: Column<T>): unknown {
  return col.value ? col.value(row) : (row as Record<string, unknown>)[col.key]
}
</script>

<template>
  <div class="table-wrap card">
    <div class="head">
    <div class="toolbar">
      <label class="search"><Search :size="15" aria-hidden="true" /><input v-model="search" type="search" placeholder="Rechercher…" aria-label="Rechercher"></label>
      <!-- Petit écran : filtres repliés derrière un bouton (la recherche reste visible). -->
      <button type="button" class="f-toggle btn-like" :aria-expanded="filtersOpen" @click="filtersOpen = !filtersOpen"><SlidersHorizontal :size="14" aria-hidden="true" /> Filtres<template v-if="activeFilters"> ({{ activeFilters }})</template></button>
      <div class="filters" :class="{ open: filtersOpen }">
      <slot name="filters" />
      <template v-if="period">
        <select v-model="periodMode" class="input auto" aria-label="Période">
          <option value="">Toutes les dates</option>
          <option v-for="(label, key) in PERIOD_LABEL" :key="key" :value="key">{{ label }}</option>
          <option value="custom">Période personnalisée…</option>
        </select>
        <template v-if="periodMode === 'custom'">
          <input class="input auto" type="date" aria-label="Du" :value="dayOf(query.from)" @change="setBound('from', ($event.target as HTMLInputElement).value)">
          <input class="input auto" type="date" aria-label="Au" :value="dayOf(query.to)" @change="setBound('to', ($event.target as HTMLInputElement).value)">
        </template>
      </template>
      <UiButton v-if="activeFilters" variant="ghost" size="sm" :aria-label="`Réinitialiser (${activeFilters})`" :title="`Réinitialiser les ${activeFilters} filtre(s)`" @click="reset"><RotateCcw :size="14" aria-hidden="true" /> {{ activeFilters }}</UiButton>
      </div>
    </div>
    <div v-if="tableKey || csvHref" class="tools">
      <div v-if="tableKey" class="views">
        <select v-if="views.length" :value="currentView" class="input auto" aria-label="Vues sauvegardées" @change="applyView(($event.target as HTMLSelectElement).value)">
          <option value="">Vues sauvegardées…</option>
          <option v-for="v in views" :key="v.id" :value="v.id">{{ v.name }}</option>
        </select>
        <UiButton size="sm" variant="ghost" title="Enregistrer la vue" aria-label="Enregistrer la vue" @click="openSave"><Bookmark :size="14" aria-hidden="true" /></UiButton>
        <UiButton v-if="currentView" size="sm" variant="ghost" aria-label="Supprimer la vue" @click="deleteView"><Trash2 :size="14" /></UiButton>
      </div>
      <details v-if="tableKey" class="cols">
        <summary class="btn-like" title="Colonnes affichées" aria-label="Colonnes"><Columns3 :size="14" aria-hidden="true" /></summary>
        <div class="menu" role="group" aria-label="Colonnes affichées">
          <label v-for="c in columns" :key="c.key"><input type="checkbox" :checked="!hidden.includes(c.key)" @change="toggleColumn(c.key)"> {{ c.label }}</label>
        </div>
      </details>
      <a v-if="csvHref" class="btn-like" :href="csvHref" download aria-label="Exporter CSV" title="Exporter en CSV (filtres et colonnes de l'écran)"><Download :size="14" aria-hidden="true" /> CSV</a>
    </div>

    </div>
    <div v-if="selectable && selected.length" class="bulk" role="region" aria-label="Actions groupées">
      <strong>{{ selected.length }} sélectionné{{ selected.length > 1 ? 's' : '' }}</strong>
      <slot name="bulk" :selected="selected" :clear="() => (selected = [])" />
      <span class="spacer-b" />
      <UiButton size="sm" variant="ghost" @click="selected = []">Désélectionner</UiButton>
    </div>
    <div class="scroll" :class="{ busy: loading }">
      <div v-if="loading" class="loading-bar" role="progressbar" aria-label="Chargement des résultats"><span /></div>
      <table :aria-busy="loading || undefined">
        <thead>
          <tr>
            <th v-if="selectable" class="sel"><input type="checkbox" :checked="pageAllSelected" :disabled="!selectableRows.length" aria-label="Sélectionner les lignes de la page" @change="togglePage"></th>
            <th
              v-for="col in visibleColumns"
              :key="col.key"
              :style="{ width: col.width, textAlign: col.align ?? 'left' }"
              :class="{ 'm-hide': col.mobileHidden }"
              :aria-sort="col.sortable ? ariaSort(col) : undefined"
            >
              <button v-if="col.sortable" class="sort" type="button" @click="toggleSort(col)">
                {{ col.label }}
                <span class="arrow" aria-hidden="true">{{ sortKey === col.key ? (sortDir === 'asc' ? '▲' : '▼') : '↕' }}</span>
              </button>
              <template v-else>{{ col.label }}</template>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="!loading && rows.length === 0">
            <td :colspan="visibleColumns.length + (selectable ? 1 : 0)" class="empty">
              <slot name="empty">
                <UiEmpty compact :icon="Inbox" :title="activeFilters ? 'Aucun résultat avec ces filtres' : (emptyText ?? 'Aucun élément')" />
              </slot>
            </td>
          </tr>
          <tr v-for="row in rows" :key="row.id" :class="{ picked: selectable && selected.includes(rowId(row)) }">
            <td v-if="selectable" class="sel"><input v-if="selectable(row)" type="checkbox" :checked="selected.includes(rowId(row))" :aria-label="`Sélectionner la ligne`" @change="toggleRow(row)"></td>
            <td v-for="col in visibleColumns" :key="col.key" :style="{ textAlign: col.align ?? 'left' }" :class="{ 'm-hide': col.mobileHidden }">
              <slot :name="`cell-${col.key}`" :row="row" :value="cell(row, col)">{{ cell(row, col) ?? '—' }}</slot>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="pager">
      <span class="muted">{{ total }} élément{{ total > 1 ? 's' : '' }}</span>
      <div class="pages">
        <select :value="query.pageSize" class="input auto page-size" aria-label="Lignes par page" @change="query = { ...query, pageSize: Number(($event.target as HTMLSelectElement).value), page: 1 }">
          <option v-for="n in [10, 25, 50, 100]" :key="n" :value="n">{{ n }} / page</option>
        </select>
        <UiButton size="sm" :disabled="query.page <= 1" @click="goTo(query.page - 1)">Précédent</UiButton>
        <span>Page {{ query.page }} / {{ pageCount }}</span>
        <UiButton size="sm" :disabled="query.page >= pageCount" @click="goTo(query.page + 1)">Suivant</UiButton>
      </div>
    </div>

    <UiModal v-model:open="saveOpen" title="Enregistrer la vue" width="420px">
      <form class="save" @submit.prevent="saveView">
        <UiField label="Nom de la vue" for="view-name" hint="Filtres, tri, période et colonnes. Une vue de même nom est remplacée.">
          <input id="view-name" v-model="viewName" class="input" maxlength="60" required>
        </UiField>
        <div class="save-actions">
          <UiButton variant="ghost" @click="saveOpen = false">Annuler</UiButton>
          <UiButton variant="primary" type="submit" :loading="saving" :disabled="!viewName.trim()">Enregistrer</UiButton>
        </div>
      </form>
    </UiModal>
  </div>
</template>

<style scoped>
.table-wrap { overflow: visible; }
.sel { width: 32px; padding-right: 0 !important; }
.sel input { cursor: pointer; }
tr.picked td { background: var(--primary-soft); }
.bulk { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; padding: 6px var(--space-3); background: var(--primary-soft); border-bottom: 1px solid var(--border); font-size: 13px; }
.spacer-b { flex: 1; }
.head { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center; padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--border); }
.toolbar { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center; flex: 1 1 0; min-width: 260px; }
.filters { display: contents; }
.toolbar .f-toggle { display: none; }
@media (max-width: 640px) {
  .toolbar .f-toggle { display: inline-flex; }
  .filters { display: none; }
  .filters.open { display: flex; flex-wrap: wrap; gap: var(--space-2); width: 100%; }
  .m-hide { display: none; }
  .page-size { display: none; }
}
@media (max-width: 720px) { .m-hide { display: none; } }
.toolbar :deep(select.input) { width: auto; max-width: 240px; field-sizing: content; }
.toolbar :deep(.input), .tools :deep(.input) { min-height: 32px; padding-top: 4px; padding-bottom: 4px; font-size: 13px; }
.tools { display: flex; gap: var(--space-2); align-items: center; margin-left: auto; flex: 0 0 auto; }
.search { display: flex; align-items: center; gap: var(--space-2); flex: 1; min-width: 180px; max-width: 170px; padding: 0 var(--space-3); border: 1px solid var(--border-strong); border-radius: var(--radius); color: var(--text-faint); background: var(--surface); min-height: 32px; }
.search:focus-within { border-color: var(--primary); box-shadow: 0 0 0 4px color-mix(in srgb, var(--primary) 18%, transparent); }
.search :deep(svg) { flex: none; }
.search input { all: unset; flex: 1; min-width: 0; color: var(--text); }
.auto { width: auto; max-width: 190px; }
.views .auto { max-width: 150px; }
.views { display: flex; gap: 4px; align-items: center; }
.cols { position: relative; }
.btn-like { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; min-height: 30px; font-size: 13px; font-weight: 550; border: 1px solid var(--border-strong); border-radius: var(--radius); background: var(--surface); color: var(--text); cursor: pointer; list-style: none; white-space: nowrap; }
.btn-like:hover { background: var(--surface-2); text-decoration: none; }
.btn-like::-webkit-details-marker { display: none; }
.menu { position: absolute; right: 0; top: calc(100% + 4px); z-index: 20; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: 0 8px 24px rgba(0, 0, 0, .12); padding: var(--space-2) var(--space-3); display: flex; flex-direction: column; gap: 4px; min-width: 200px; }
.menu label { display: flex; gap: 6px; align-items: center; font-size: 13px; white-space: nowrap; }
.scroll { overflow-x: auto; position: relative; }
.scroll.busy table { opacity: .55; transition: opacity .15s; }
.loading-bar { position: absolute; top: 0; left: 0; right: 0; height: 3px; overflow: hidden; z-index: 1; }
.loading-bar span { position: absolute; width: 30%; height: 100%; background: var(--primary); animation: tbl-load 1.1s ease-in-out infinite; }
@keyframes tbl-load { 0% { left: -30%; } 100% { left: 100%; } }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 4px var(--space-3); border-bottom: 1px solid var(--border); vertical-align: middle; }
/* Une ligne par entrée : défilement horizontal plutôt que cellules sur plusieurs lignes. */
td { white-space: nowrap; font-size: 13px; }
th { background: var(--surface-2); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--text-faint); white-space: nowrap; }
tbody tr:hover { background: var(--surface-2); }
.sort { all: unset; cursor: pointer; display: inline-flex; gap: 4px; align-items: center; }
.sort:focus-visible { outline: 2px solid var(--focus); }
.arrow { font-size: 10px; opacity: .7; }
.empty { text-align: center; color: var(--text-muted); padding: var(--space-3); }
tbody tr:hover .empty { background: var(--surface); }
.pager { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: var(--space-2); padding: var(--space-2) var(--space-3); }
.pages { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
.save { display: flex; flex-direction: column; gap: var(--space-4); }
.save-actions { display: flex; justify-content: flex-end; gap: var(--space-2); }
</style>
