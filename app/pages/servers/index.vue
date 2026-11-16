<script setup lang="ts">
import type { Paginated } from '#shared/schemas/common'
import type { ServerDto, ServerStatus } from '#shared/schemas/servers'
import { type Column, type TableState, stateFromRoute } from '~/types/table'

useHead({ title: 'Serveurs' })
const { hasAny } = useAuth()

const route = useRoute()
const query = ref<TableState & { status?: ServerStatus }>(stateFromRoute({ page: 1, pageSize: 25, sort: 'name:asc' }, route.query, ['status']))
const { data, status } = await useFetch<Paginated<ServerDto>>('/api/servers', { query, watch: [query] })

const columns: Column<ServerDto>[] = [
  { key: 'name', label: 'Nom', sortable: true },
  { key: 'url', label: 'URL' },
  { key: 'status', label: 'Statut', sortable: true },
  { key: 'detectedVersion', label: 'Version' },
  { key: 'endpointCount', label: 'Endpoints', align: 'right' },
  { key: 'lastCheckedAt', label: 'Dernier contrôle', sortable: true },
]

const STATUS: Record<ServerStatus, { label: string, tone: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  online: { label: 'En ligne', tone: 'success' },
  degraded: { label: 'Dégradé', tone: 'warning' },
  offline: { label: 'Hors ligne', tone: 'danger' },
  unknown: { label: 'Inconnu', tone: 'neutral' },
}

const fmtDate = (iso: string | null) => fmtDateTime(iso)
</script>

<template>
  <div>
    <UiPageHeader title="Serveurs" icon="server">
      <UiButton v-if="hasAny('server:manage')" variant="primary" @click="navigateTo('/servers/new')">Ajouter un serveur</UiButton>
    </UiPageHeader>

    <UiDataTable
      v-model:query="query"
      table-key="servers"
      export-url="/api/servers"
      period
      :columns="columns"
      :rows="data?.items ?? []"
      :total="data?.total ?? 0"
      :loading="status === 'pending'"
      empty-text="Aucun serveur configuré"
    >
      <template #filters>
        <select v-model="query.status" class="input status-filter" aria-label="Filtrer par statut">
          <option :value="undefined">Tous les statuts</option>
          <option v-for="(s, key) in STATUS" :key="key" :value="key">{{ s.label }}</option>
        </select>
      </template>
      <template #cell-name="{ row }">
        <NuxtLink :to="`/servers/${row.id}`"><strong>{{ row.name }}</strong></NuxtLink>
        <UiBadge v-if="row.transport === 'ssh'" tone="info" class="tag" title="Joint en SSH, sans agent ni Runner">SSH</UiBadge>
        <UiBadge v-for="t in row.tags" :key="t" class="tag">{{ t }}</UiBadge>
      </template>
      <template #cell-url="{ row }"><span class="mono">{{ row.url }}</span></template>
      <template #cell-status="{ row }">
        <UiBadge :tone="STATUS[row.status].tone" :title="row.lastError ?? undefined">{{ STATUS[row.status].label }}</UiBadge>
      </template>
      <template #cell-lastCheckedAt="{ row }">{{ fmtDate(row.lastCheckedAt) }}</template>
    </UiDataTable>
  </div>
</template>

<style scoped>
.status-filter { width: auto; }
.tag { margin-left: 4px; }
</style>
