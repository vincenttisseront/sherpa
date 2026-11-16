<script setup lang="ts">
import { Activity, ChevronDown, FolderKanban, LayoutDashboard, LogOut, Menu, Monitor, Moon, Network, RefreshCcw, Rocket, ScrollText, Search, Server, Settings, ShieldAlert, Sun, X } from 'lucide-vue-next'

const { me, hasAny, logout } = useAuth()
const { choice, cycle } = useTheme()
const route = useRoute()

const sections = computed(() => [
  {
    title: 'Pilotage',
    items: [
      { to: '/', label: 'Tableau de bord', icon: LayoutDashboard, show: true },
      { to: '/containers', label: 'Conteneurs en direct', icon: Activity, show: hasAny('server:read') },
      { to: '/projects', label: 'Projets', icon: FolderKanban, show: hasAny('project:read') },
      { to: '/deployments', label: 'Déploiements', icon: Rocket, show: hasAny('deployment:read') },
      { to: '/images', label: 'Mises à jour d\'images', icon: RefreshCcw, show: hasAny('deployment:read') },
    ],
  },
  {
    title: 'Infrastructure',
    items: [
      { to: '/servers', label: 'Serveurs', icon: Server, show: hasAny('server:read') },
      { to: '/proxies', label: 'Reverse proxies', icon: Network, show: hasAny('server:read') },
      { to: '/vulnerabilities', label: 'Vulnérabilités', icon: ShieldAlert, show: hasAny('server:read') },
    ],
  },
  {
    title: 'Gouvernance',
    items: [
      { to: '/audit', label: 'Audit', icon: ScrollText, show: hasAny('audit:read') },
      { to: '/admin', label: 'Administration', icon: Settings, show: hasAny('user:manage') || hasAny('group:manage') || hasAny('role:manage') || hasAny('notification:manage') || hasAny('policy:manage') },
    ],
  },
].map(s => ({ ...s, items: s.items.filter(i => i.show) })).filter(s => s.items.length))

// Recherche globale : toutes les pages visibles du menu, et le raccourci affiché selon la plateforme.
const searchOpen = ref(false)
const palettePages = computed(() => sections.value.flatMap(s => s.items.map(i => ({ to: i.to, label: i.label, section: s.title }))))
const shortcut = ref('Ctrl K')
onMounted(() => { if (/Mac|iPhone|iPad/.test(navigator.platform)) shortcut.value = '⌘K' })

const isActive = (to: string) => (to === '/' ? route.path === '/' : route.path === to || route.path.startsWith(`${to}/`))
const menuOpen = ref(false)
watch(() => route.path, () => { menuOpen.value = false })

const initials = computed(() => (me.value?.user?.displayName ?? '?').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase())
const THEME = { system: { icon: Monitor, label: 'Thème : système' }, dark: { icon: Moon, label: 'Thème : sombre' }, light: { icon: Sun, label: 'Thème : clair' } } as const

// État de la plateforme, rafraîchi en continu (base, Redis, worker).
const { data: health, refresh: refreshHealth } = await useFetch('/api/health', { server: false })
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => { timer = setInterval(() => void refreshHealth(), 30_000) })
onBeforeUnmount(() => clearInterval(timer))
const status = computed(() => {
  const h = health.value as { status?: string, worker?: string } | null
  if (!h) return null
  if (h.status === 'ok') return { tone: 'ok', label: 'Plateforme opérationnelle' }
  if (h.worker === 'absent') return { tone: 'warn', label: 'Worker arrêté : déploiements en attente' }
  return { tone: 'ko', label: 'Plateforme dégradée' }
})
const userMenu = ref(false)
</script>

<template>
  <div class="shell">
    <div v-if="menuOpen" class="scrim" aria-hidden="true" @click="menuOpen = false" />
    <aside class="sidebar" :class="{ open: menuOpen }">
      <div class="brand">
        <AppLogo :size="34" />
        <span class="brand-text">
          <strong>Sherpa</strong>
          <small>Déploiements Docker par SSH</small>
        </span>
        <button type="button" class="close" aria-label="Fermer le menu" @click="menuOpen = false"><X :size="18" /></button>
      </div>

      <nav aria-label="Navigation principale">
        <div v-for="s in sections" :key="s.title" class="section">
          <span class="section-title">{{ s.title }}</span>
          <NuxtLink v-for="item in s.items" :key="item.to" :to="item.to" class="link" :class="{ active: isActive(item.to) }" :aria-current="isActive(item.to) ? 'page' : undefined">
            <component :is="item.icon" :size="17" :stroke-width="2" class="ico" aria-hidden="true" />
            <span>{{ item.label }}</span>
          </NuxtLink>
        </div>
      </nav>

      <div v-if="me?.user" class="me">
        <button type="button" class="me-btn" :aria-expanded="userMenu" @click="userMenu = !userMenu">
          <span class="avatar" aria-hidden="true">{{ initials }}</span>
          <span class="me-text"><strong>{{ me.user.displayName }}</strong><small>{{ me.user.email }}</small></span>
          <ChevronDown :size="16" class="chev" :class="{ up: userMenu }" aria-hidden="true" />
        </button>
        <div v-if="userMenu" class="me-menu">
          <NuxtLink to="/account" class="me-item">Mon compte</NuxtLink>
          <button type="button" class="me-item" @click="cycle"><component :is="THEME[choice].icon" :size="15" aria-hidden="true" /> {{ THEME[choice].label }}</button>
          <button type="button" class="me-item danger" @click="logout"><LogOut :size="15" aria-hidden="true" /> Se déconnecter</button>
        </div>
      </div>
    </aside>

    <div class="main">
      <header class="topbar">
        <button type="button" class="burger" aria-label="Ouvrir le menu" @click="menuOpen = true"><Menu :size="20" /></button>
        <span class="spacer" />
        <button type="button" class="search-btn" aria-label="Rechercher (raccourci : Ctrl ou ⌘ + K)" title="Rechercher" @click="searchOpen = true">
          <Search :size="15" aria-hidden="true" /><span class="search-label">Rechercher</span><kbd>{{ shortcut }}</kbd>
        </button>
        <NuxtLink v-if="status" to="/" class="status" :class="status.tone" :title="status.label">
          <span class="pulse" aria-hidden="true" />
          <span class="status-label">{{ status.label }}</span>
        </NuxtLink>
        <button type="button" class="icon-btn" :aria-label="THEME[choice].label" :title="THEME[choice].label" @click="cycle">
          <component :is="THEME[choice].icon" :size="17" />
        </button>
      </header>
      <main class="content"><slot /></main>
    </div>
    <CommandPalette v-model:open="searchOpen" :pages="palettePages" />
  </div>
</template>

<style scoped>
.shell { display: flex; min-height: 100vh; }

/* Barre latérale */
.sidebar {
  width: var(--sidebar-w); flex-shrink: 0; position: sticky; top: 0; height: 100vh;
  display: flex; flex-direction: column; gap: var(--space-4);
  padding: var(--space-4) var(--space-3);
  background: linear-gradient(180deg, var(--sidebar-bg) 0%, var(--sidebar-bg-2) 100%);
  color: var(--sidebar-text);
}
.brand { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-1) var(--space-2) var(--space-2); }
.brand-text { display: flex; flex-direction: column; line-height: 1.2; }
.brand-text strong { color: #fff; font-size: 15px; letter-spacing: -0.01em; }
.brand-text small { color: var(--sidebar-muted); font-size: 11.5px; }
.close { display: none; margin-left: auto; background: none; border: 0; color: var(--sidebar-muted); cursor: pointer; }

nav { display: flex; flex-direction: column; gap: var(--space-4); overflow-y: auto; flex: 1; }
.section { display: flex; flex-direction: column; gap: 2px; }
.section-title { font-size: 10.5px; text-transform: uppercase; letter-spacing: .08em; color: var(--sidebar-muted); padding: 0 var(--space-3) var(--space-1); font-weight: 600; }
.link {
  position: relative; display: flex; align-items: center; gap: var(--space-3);
  padding: 8px var(--space-3); border-radius: var(--radius); color: var(--sidebar-text); font-weight: 500;
  transition: background-color .12s, color .12s;
}
.link:hover { background: var(--sidebar-active); color: #fff; text-decoration: none; }
.link .ico { opacity: .8; flex-shrink: 0; }
.link.active { background: rgb(255 255 255 / 12%); color: #fff; }
.link.active .ico { opacity: 1; color: #a5b0ff; }
.link.active::before { content: ''; position: absolute; left: -12px; top: 8px; bottom: 8px; width: 3px; border-radius: 0 3px 3px 0; background: #a5b0ff; }

.me { position: relative; border-top: 1px solid rgb(255 255 255 / 8%); padding-top: var(--space-3); }
.me-btn { all: unset; box-sizing: border-box; width: 100%; display: flex; align-items: center; gap: var(--space-3); padding: 6px var(--space-2); border-radius: var(--radius); cursor: pointer; }
.me-btn:hover { background: var(--sidebar-active); }
.me-btn:focus-visible { outline: 2px solid var(--focus); }
.avatar { width: 32px; height: 32px; border-radius: 50%; display: grid; place-items: center; background: var(--gradient); color: #fff; font-size: 12px; font-weight: 700; flex-shrink: 0; }
.me-text { display: flex; flex-direction: column; min-width: 0; line-height: 1.25; }
.me-text strong { color: #fff; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.me-text small { color: var(--sidebar-muted); font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.chev { margin-left: auto; color: var(--sidebar-muted); transition: transform .15s; }
.chev.up { transform: rotate(180deg); }
.me-menu { position: absolute; bottom: calc(100% + 6px); left: 0; right: 0; background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow-lg); padding: 4px; display: flex; flex-direction: column; z-index: 10; }
.me-item { all: unset; box-sizing: border-box; display: flex; align-items: center; gap: var(--space-2); padding: 8px 10px; border-radius: var(--radius-sm); cursor: pointer; color: var(--text); font-size: 13px; }
.me-item:hover { background: var(--surface-2); text-decoration: none; }
.me-item.danger { color: var(--danger); }

/* Zone principale */
.main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.topbar {
  position: sticky; top: 0; z-index: 20; display: flex; align-items: center; gap: var(--space-3);
  height: 48px; padding: 0 var(--space-6);
  background: color-mix(in srgb, var(--bg) 82%, transparent); backdrop-filter: saturate(160%) blur(10px);
  border-bottom: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
}
.spacer { flex: 1; }
.burger, .icon-btn { all: unset; box-sizing: border-box; width: 36px; height: 36px; display: grid; place-items: center; border-radius: var(--radius); color: var(--text-muted); cursor: pointer; }
.burger:hover, .icon-btn:hover { background: var(--surface-3); color: var(--text); }
.burger:focus-visible, .icon-btn:focus-visible { outline: 2px solid var(--focus); }
.burger { display: none; }
.status { display: inline-flex; align-items: center; gap: var(--space-2); padding: 5px 12px 5px 10px; border-radius: 999px; font-size: 12.5px; font-weight: 550; border: 1px solid transparent; }
.status:hover { text-decoration: none; }
.status.ok { color: var(--success); background: var(--success-bg); }
.status.warn { color: var(--warning); background: var(--warning-bg); }
.status.ko { color: var(--danger); background: var(--danger-bg); }
.content { padding: var(--space-4) var(--space-6) var(--space-6); max-width: 1440px; width: 100%; margin: 0 auto; }

@media (max-width: 900px) {
  .sidebar { position: fixed; inset: 0 auto 0 0; z-index: 50; transform: translateX(-100%); transition: transform .2s; box-shadow: var(--shadow-lg); }
  .sidebar.open { transform: none; }
  .scrim { position: fixed; inset: 0; z-index: 40; background: rgb(8 12 25 / 45%); }
  .close { display: block; }
  .burger { display: grid; }
  .topbar { padding: 0 var(--space-4); }
  .content { padding: var(--space-4); }
  .status-label { display: none; }
}
.search-btn { display: inline-flex; align-items: center; gap: 8px; height: 32px; padding: 0 10px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); color: var(--text-muted); font: inherit; font-size: 13px; cursor: pointer; }
.search-btn:hover { color: var(--text); border-color: var(--border-strong, var(--border)); }
.search-btn kbd { font: inherit; font-size: 11px; border: 1px solid var(--border); border-radius: 4px; padding: 0 5px; background: var(--surface-2); }
@media (max-width: 720px) { .search-label, .search-btn kbd { display: none; } }
</style>
