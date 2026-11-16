<script setup lang="ts">
/**
 * Stacks présentes sur les serveurs mais pas encore projets de la plateforme
 * (Compose lancés à la main, autre outil…) ; « Reprendre » ouvre l'assistant
 * de reprise du serveur concerné.
 */
import type { AdoptableStack } from '#shared/schemas/adoption'
import type { LiveEndpoint } from '#shared/schemas/live'
import { MANAGED_PROXY_STACK } from '#shared/schemas/managed-proxy'

const open = defineModel<boolean>('open', { required: true })
const { can } = useAuth()

interface Row { stack: AdoptableStack, serverId: string, endpointId: string, where: string }
const rows = ref<Row[]>([])
const failed = ref<string[]>([])
const loading = ref(false)
const q = ref('')

async function load() {
  loading.value = true
  failed.value = []
  try {
    const endpoints = (await $fetch<LiveEndpoint[]>('/api/live')).filter(e => e.ok && can('server:manage', { serverId: e.serverId }))
    const lists = await Promise.all(endpoints.map(e => $fetch<AdoptableStack[]>(`/api/endpoints/${e.endpointId}/adoptable`)
      .then(stacks => stacks.filter(s => !s.managedBy && s.name !== MANAGED_PROXY_STACK).map(stack => ({ stack, serverId: e.serverId, endpointId: e.endpointId, where: `${e.serverName} / ${e.endpointName}` })))
      .catch(() => {
        failed.value.push(`${e.serverName} / ${e.endpointName}`)
        return [] as Row[]
      })))
    rows.value = lists.flat().sort((a, b) => a.stack.name.localeCompare(b.stack.name))
  }
  finally {
    loading.value = false
  }
}
watch(open, (o) => {
  if (o) void load()
}, { immediate: true })

const shown = computed(() => {
  const t = q.value.trim().toLowerCase()
  return t ? rows.value.filter(r => `${r.stack.name} ${r.stack.services.join(' ')} ${r.stack.hosts.join(' ')} ${r.where}`.toLowerCase().includes(t)) : rows.value
})
</script>

<template>
  <UiModal v-model:open="open" title="Reprendre une stack existante" width="760px">
    <div class="picker">
      <p class="muted small">Stacks Docker Compose présentes sur les serveurs mais pas encore gérées par la plateforme. La reprise analyse la stack, puis crée le projet sans interrompre les conteneurs.</p>
      <input v-model="q" class="input input-sm" type="search" placeholder="Stack, service, domaine, serveur…" aria-label="Filtrer les stacks">
      <p v-if="loading" class="muted small">Lecture des serveurs…</p>
      <p v-else-if="!rows.length" class="muted small">Aucune stack à reprendre sur les serveurs que vous gérez.</p>
      <ul v-else class="list">
        <li v-for="r in shown" :key="`${r.endpointId}/${r.stack.name}`">
          <span class="main">
            <strong class="mono">{{ r.stack.name }}</strong>
            <UiBadge v-if="r.stack.infrastructure" tone="warning">{{ r.stack.infrastructure }}</UiBadge>
            <span class="muted small one" :title="r.stack.services.join(', ')">{{ r.stack.services.join(', ') }}</span>
          </span>
          <span class="muted small where">{{ r.where }} · {{ r.stack.running }}/{{ r.stack.containers }} en marche</span>
          <UiButton size="sm" variant="primary" @click="open = false; navigateTo(adoptLink(r.serverId, r.endpointId, r.stack.name))">Reprendre</UiButton>
        </li>
        <li v-if="!shown.length" class="muted small">Aucune stack ne correspond.</li>
      </ul>
      <p v-if="!loading && rows.some(r => r.stack.infrastructure)" class="muted small">Les stacks marquées (reverse proxy, agent) servent l'infrastructure : les reprendre seulement en connaissance de cause.</p>
      <p v-if="failed.length" class="muted small">Non lus : {{ failed.join(', ') }}</p>
    </div>
  </UiModal>
</template>

<style scoped>
.picker { display: flex; flex-direction: column; gap: var(--space-2); }
.picker p { margin: 0; }
.list { list-style: none; margin: 0; padding: 0; max-height: 420px; overflow: auto; }
.list li { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: var(--space-3); align-items: center; padding: 5px 0; border-bottom: 1px solid var(--border); }
.main { display: flex; gap: var(--space-2); align-items: baseline; min-width: 0; }
.main strong { white-space: nowrap; }
.one { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.where { white-space: nowrap; }
.small { font-size: 12.5px; }
@media (max-width: 640px) { .list li { grid-template-columns: 1fr auto; } .where { display: none; } }
</style>
