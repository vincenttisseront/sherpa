<script setup lang="ts">
/**
 * Recherche globale (⌘K ou Ctrl+K, ou « / ») : pages, actions rapides, projets, serveurs et déploiements,
 * limités aux droits de l'utilisateur (les listes sont filtrées par le serveur). Navigation au clavier.
 */
import { Activity, CornerDownLeft, FolderKanban, Moon, Plus, Rocket, Search, Server, UserRound } from 'lucide-vue-next'
import type { Component } from 'vue'

export interface PalettePage { to: string, label: string, section: string }
const props = defineProps<{ pages: PalettePage[] }>()
const open = defineModel<boolean>('open', { default: false })

interface Item { id: string, group: string, label: string, hint?: string, icon: Component, run: () => unknown }

const { hasAny } = useAuth()
const { cycle } = useTheme()
const q = ref('')
const active = ref(0)
const loading = ref(false)
const remote = ref<Item[]>([])
const input = ref<HTMLInputElement | null>(null)
let previous: HTMLElement | null = null
let seq = 0
let timer: ReturnType<typeof setTimeout> | undefined
const listId = useId()

const go = (to: string) => navigateTo(to)
const ACTIONS = computed<Item[]>(() => [
  ...(hasAny('project:create') ? [{ id: 'a:new-project', group: 'Actions', label: 'Nouveau projet', icon: Plus, run: () => go('/projects/new') }] : []),
  { id: 'a:account', group: 'Actions', label: 'Mon compte et jetons d\'API', icon: UserRound, run: () => go('/account') },
  { id: 'a:theme', group: 'Actions', label: 'Changer de thème (clair, sombre, système)', icon: Moon, run: () => cycle() },
])
const norm = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
const matches = (item: { label: string, hint?: string }, query: string) => !query || norm(`${item.label} ${item.hint ?? ''}`).includes(norm(query))

const local = computed<Item[]>(() => [
  ...props.pages.map(p => ({ id: `p:${p.to}`, group: 'Pages', label: p.label, hint: p.section, icon: Activity, run: () => go(p.to) })),
  ...ACTIONS.value,
].filter(i => matches(i, q.value.trim())))
const items = computed(() => [...local.value, ...remote.value])
const groups = computed(() => {
  const m = new Map<string, { item: Item, index: number }[]>()
  items.value.forEach((item, index) => m.set(item.group, [...(m.get(item.group) ?? []), { item, index }]))
  return [...m.entries()]
})

interface Paged<T> { items: T[] }
async function search(query: string) {
  const my = ++seq
  if (query.length < 2) {
    remote.value = []
    loading.value = false
    return
  }
  loading.value = true
  function get<T>(path: string) {
    return $fetch<Paged<T>>(`${path}?q=${encodeURIComponent(query)}&pageSize=6`).catch(() => ({ items: [] as T[] }))
  }
  const [projects, servers, deployments] = await Promise.all([
    hasAny('project:read') ? get<{ id: string, name: string, slug: string, lastStatus: string | null }>('/api/projects') : { items: [] },
    hasAny('server:read') ? get<{ id: string, name: string, status: string }>('/api/servers') : { items: [] },
    hasAny('deployment:read') ? get<{ id: string, project: string, environment: string, action: string, status: string, createdAt: string }>('/api/deployments') : { items: [] },
  ])
  if (my !== seq) return
  remote.value = [
    ...projects.items.map(p => ({ id: `project:${p.id}`, group: 'Projets', label: p.name, hint: `${p.slug}${p.lastStatus ? ` · ${p.lastStatus}` : ''}`, icon: FolderKanban, run: () => go(`/projects/${p.id}`) })),
    ...servers.items.map(s => ({ id: `server:${s.id}`, group: 'Serveurs', label: s.name, hint: s.status, icon: Server, run: () => go(`/servers/${s.id}`) })),
    ...deployments.items.map(d => ({ id: `deployment:${d.id}`, group: 'Déploiements', label: `${d.project} (${d.environment})`, hint: `${d.action} · ${d.status} · ${fmtRelative(d.createdAt)}`, icon: Rocket, run: () => go(`/deployments/${d.id}`) })),
  ]
  loading.value = false
}

watch(q, (v) => {
  active.value = 0
  clearTimeout(timer)
  timer = setTimeout(() => void search(v.trim()), 160)
})
watch(items, () => { active.value = Math.min(active.value, Math.max(items.value.length - 1, 0)) })

watch(open, async (v) => {
  if (v) {
    previous = document.activeElement as HTMLElement | null
    q.value = ''
    active.value = 0
    remote.value = []
    await nextTick()
    input.value?.focus()
  }
  else {
    clearTimeout(timer)
    seq++
    previous?.focus?.()
  }
})

async function choose(item: Item | undefined) {
  if (!item) return
  open.value = false
  await item.run()
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    active.value = items.value.length ? (active.value + 1) % items.value.length : 0
  }
  else if (e.key === 'ArrowUp') {
    e.preventDefault()
    active.value = items.value.length ? (active.value - 1 + items.value.length) % items.value.length : 0
  }
  else if (e.key === 'Enter') {
    e.preventDefault()
    void choose(items.value[active.value])
  }
  else if (e.key === 'Escape') {
    e.preventDefault()
    open.value = false
  }
}

// Raccourcis globaux : ⌘K / Ctrl+K (partout), « / » (hors champ de saisie).
function onGlobal(e: KeyboardEvent) {
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement | null)?.tagName ?? '') || (e.target as HTMLElement | null)?.isContentEditable
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    open.value = !open.value
  }
  else if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey && !open.value) {
    e.preventDefault()
    open.value = true
  }
}
onMounted(() => window.addEventListener('keydown', onGlobal))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobal)
  clearTimeout(timer)
})
const activeId = computed(() => (items.value[active.value] ? `${listId}-${active.value}` : undefined))
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="overlay" @mousedown.self="open = false">
      <div class="palette" role="dialog" aria-modal="true" aria-label="Recherche globale">
        <div class="searchbar">
          <Search :size="16" class="ico" aria-hidden="true" />
          <input
            ref="input" v-model="q" class="q" type="text" role="combobox" autocomplete="off" spellcheck="false"
            placeholder="Rechercher un projet, un serveur, un déploiement, une page…" aria-label="Rechercher"
            aria-expanded="true" :aria-controls="listId" aria-autocomplete="list" :aria-activedescendant="activeId" @keydown="onKey"
          >
          <kbd class="esc">Échap</kbd>
        </div>
        <div :id="listId" class="results" role="listbox" aria-label="Résultats">
          <template v-for="[group, rows] in groups" :key="group">
            <div class="group" role="presentation">{{ group }}</div>
            <div
              v-for="r in rows" :id="`${listId}-${r.index}`" :key="r.item.id" class="row" :class="{ on: r.index === active }"
              role="option" :aria-selected="r.index === active" @mousemove="active = r.index" @click="choose(r.item)"
            >
              <component :is="r.item.icon" :size="15" class="ico" aria-hidden="true" />
              <span class="label">{{ r.item.label }}</span>
              <span v-if="r.item.hint" class="hint">{{ r.item.hint }}</span>
              <CornerDownLeft v-if="r.index === active" :size="13" class="enter" aria-hidden="true" />
            </div>
          </template>
          <p v-if="!items.length" class="empty" role="status">{{ loading ? 'Recherche…' : q.trim().length < 2 ? 'Aucune page ni action ne correspond.' : 'Aucun résultat.' }}</p>
        </div>
        <div class="foot" aria-hidden="true"><span><kbd>↑</kbd><kbd>↓</kbd> naviguer</span><span><kbd>↵</kbd> ouvrir</span><span v-if="loading" class="busy">recherche…</span></div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.overlay { position: fixed; inset: 0; z-index: 120; background: rgb(8 12 25 / 50%); backdrop-filter: blur(3px); display: flex; justify-content: center; align-items: flex-start; padding: 12vh var(--space-4) var(--space-4); }
.palette { width: 620px; max-width: 100%; max-height: 70vh; display: flex; flex-direction: column; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-xl); box-shadow: var(--shadow-lg); overflow: hidden; }
.searchbar { display: flex; align-items: center; gap: var(--space-2); padding: 0 var(--space-4); border-bottom: 1px solid var(--border); }
.searchbar .ico { color: var(--text-muted); flex: none; }
.q { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--text); font-size: 15px; padding: 14px 0; }
.esc, .foot kbd { font: inherit; font-size: 11px; color: var(--text-muted); border: 1px solid var(--border); border-radius: 4px; padding: 1px 5px; background: var(--surface-2); }
.results { overflow-y: auto; padding: var(--space-2); }
.group { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted); padding: 8px 10px 4px; }
.row { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: var(--radius); cursor: pointer; font-size: 13.5px; }
.row.on { background: var(--primary-soft, var(--surface-2)); }
.row .ico { color: var(--text-muted); flex: none; }
.label { flex: none; max-width: 55%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hint { flex: 1; min-width: 0; color: var(--text-muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.enter { color: var(--text-muted); margin-left: auto; flex: none; }
.empty { margin: 0; padding: var(--space-4); text-align: center; color: var(--text-muted); font-size: 13px; }
.foot { display: flex; gap: var(--space-4); padding: 8px var(--space-4); border-top: 1px solid var(--border); font-size: 11.5px; color: var(--text-muted); }
.foot kbd { margin-right: 3px; }
.busy { margin-left: auto; }
</style>
