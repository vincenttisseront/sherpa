<script setup lang="ts">
/** Historique des images (§12, §17) : mises à jour Watchtower, signalements, échecs, changements hors plateforme. */
import type { Paginated } from '#shared/schemas/common'
import type { ImageUpdateRow } from '#shared/schemas/lists'
import { UPDATE_KIND_LABEL } from '#shared/schemas/watchtower'
import { type Column, type TableState, stateFromRoute } from '~/types/table'

useHead({ title: 'Mises à jour d\'images' })
const route = useRoute()
const query = ref<TableState>(stateFromRoute({ page: 1, pageSize: 25, sort: 'detectedAt:desc' }, route.query, ['kind', 'projectId', 'environmentId']))
const { data, status } = await useFetch<Paginated<ImageUpdateRow>>('/api/image-updates', { query, watch: [query] })
const { data: environments } = useEnvironments()
const KIND_TONE = { updated: 'info', available: 'neutral', failed: 'danger', external: 'warning' } as const

const columns: Column<ImageUpdateRow>[] = [
  { key: 'detectedAt', label: 'Date', sortable: true },
  { key: 'project', label: 'Projet', sortable: true },
  { key: 'environment', label: 'Environnement', mobileHidden: true },
  { key: 'service', label: 'Service', sortable: true },
  { key: 'kind', label: 'Évènement', sortable: true },
  { key: 'image', label: 'Image', mobileHidden: true },
  { key: 'change', label: 'Avant → après', exportable: false, mobileHidden: true },
  { key: 'digest', label: 'Empreinte', defaultHidden: true },
  { key: 'releaseNumber', label: 'Release', align: 'right', defaultHidden: true },
]
const short = (id: string | null) => (id ? id.replace(/^sha256:/, '').slice(0, 12) : '—')
</script>

<template>
  <div>
    <UpdateEngineCard title="Mises à jour d'images" icon="refresh" />
    <TrivyEngineCard />
    <UiDataTable v-model:query="query" table-key="images" export-url="/api/image-updates" period :columns="columns" :rows="data?.items ?? []" :total="data?.total ?? 0" :loading="status === 'pending'" empty-text="Aucun changement d'image">
      <template #filters>
        <select v-model="query.kind" class="input auto" aria-label="Évènement">
          <option :value="undefined">Tous les évènements</option>
          <option v-for="(l, k) in UPDATE_KIND_LABEL" :key="k" :value="k">{{ l }}</option>
        </select>
        <select v-model="query.environmentId" class="input auto" aria-label="Environnement">
          <option :value="undefined">Tous les environnements</option>
          <option v-for="e in environments" :key="e.id" :value="e.id">{{ e.name }}</option>
        </select>
      </template>
      <template #cell-detectedAt="{ row }"><span class="nowrap">{{ fmtDateTime(row.detectedAt) }}</span></template>
      <template #cell-project="{ row }"><NuxtLink :to="`/projects/${row.projectId}`">{{ row.project }}</NuxtLink></template>
      <template #cell-kind="{ row }">
        <UiBadge :tone="KIND_TONE[row.kind as keyof typeof KIND_TONE] ?? 'neutral'">{{ UPDATE_KIND_LABEL[row.kind as keyof typeof UPDATE_KIND_LABEL] ?? row.kind }}</UiBadge>
        <div v-if="row.kind === 'failed' && row.detail" class="err" :title="row.detail">{{ row.detail }}</div>
      </template>
      <template #cell-image="{ row }"><span class="mono small">{{ row.image }}</span></template>
      <template #cell-change="{ row }"><span class="mono small">{{ short(row.fromImageId) }} → {{ short(row.toImageId) }}</span></template>
      <template #cell-digest="{ row }"><span class="mono small">{{ row.digest?.split('@')[1]?.slice(0, 19) ?? '—' }}</span></template>
      <template #cell-releaseNumber="{ row }">{{ row.releaseNumber ? `#${row.releaseNumber}` : '—' }}</template>
    </UiDataTable>
  </div>
</template>

<style scoped>
.auto { width: auto; max-width: 175px; }
.nowrap { white-space: nowrap; }
.small { font-size: 12.5px; }
.err { color: var(--danger); font-size: 12px; max-width: 320px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
