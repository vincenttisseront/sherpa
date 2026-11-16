<script setup lang="ts">
import type { Paginated } from '#shared/schemas/common'
import type { ProjectListItem } from '#shared/schemas/projects'
import { type Column, type TableState, stateFromRoute } from '~/types/table'

useHead({ title: 'Projets' })
const { hasAny } = useAuth()
const route = useRoute()
const adoptOpen = ref(false)
const query = ref<TableState>(stateFromRoute({ page: 1, pageSize: 25, sort: 'name:asc' }, route.query, ['environmentId', 'lastStatus', 'archived']))
const { data: environments } = useEnvironments()
const { data, status } = await useFetch<Paginated<ProjectListItem>>('/api/projects', { query, watch: [query] })
const columns: Column<ProjectListItem>[] = [
  { key: 'name', label: 'Projet', sortable: true },
  { key: 'targetCount', label: 'Environnements', align: 'right' },
  { key: 'lastStatus', label: 'Dernière opération' },
  { key: 'lastDeployedAt', label: 'Le' },
  { key: 'createdAt', label: 'Créé le', sortable: true },
]
</script>

<template>
  <div>
    <UiPageHeader title="Projets" icon="folder">
      <UiButton v-if="hasAny('project:create')" title="Reprendre en projet une stack déjà lancée sur un serveur" @click="adoptOpen = true">Reprendre une stack</UiButton>
      <UiButton v-if="hasAny('project:create')" variant="primary" @click="navigateTo('/projects/new')">Nouveau projet</UiButton>
    </UiPageHeader>
    <LazyAdoptStackPicker v-if="adoptOpen" v-model:open="adoptOpen" />
    <UiDataTable v-model:query="query" table-key="projects" export-url="/api/projects" period :columns="columns" :rows="data?.items ?? []" :total="data?.total ?? 0" :loading="status === 'pending'" empty-text="Aucun projet">
      <template #filters>
        <select v-model="query.environmentId" class="input auto" aria-label="Environnement">
          <option :value="undefined">Tous les environnements</option>
          <option v-for="e in environments" :key="e.id" :value="e.id">{{ e.name }}</option>
        </select>
        <select v-model="query.lastStatus" class="input auto" aria-label="Dernière opération">
          <option :value="undefined">Tous les états</option>
          <option v-for="s in ['HEALTHY', 'DEGRADED', 'FAILED', 'ROLLED_BACK', 'STOPPED']" :key="s" :value="s">{{ STATUS_LABEL[s] }}</option>
        </select>
        <select v-model="query.archived" class="input auto" aria-label="Archivage">
          <option :value="undefined">Projets actifs</option>
          <option value="only">Archivés</option>
          <option value="all">Actifs et archivés</option>
        </select>
      </template>
      <template v-if="!query.q && !query.environmentId && !query.lastStatus && !query.period && !query.archived" #empty>
        <UiEmpty title="Aucun projet pour l'instant">
          <UiButton v-if="hasAny('project:create')" variant="primary" @click="navigateTo('/projects/new')">Créer un projet</UiButton>
        </UiEmpty>
      </template>
      <template #cell-name="{ row }">
        <NuxtLink :to="`/projects/${row.id}`"><strong>{{ row.name }}</strong></NuxtLink> <span class="muted mono small">{{ row.slug }}</span> <UiBadge v-if="row.archivedAt" tone="neutral">archivé</UiBadge>
      </template>
      <template #cell-lastStatus="{ row }">
        <UiBadge v-if="row.lastStatus" :tone="statusTone(row.lastStatus)">{{ STATUS_LABEL[row.lastStatus] ?? row.lastStatus }}</UiBadge>
        <span v-else class="muted">—</span>
      </template>
      <template #cell-lastDeployedAt="{ row }">{{ fmtDateTime(row.lastDeployedAt) }}</template>
      <template #cell-createdAt="{ row }">{{ fmtDateTime(row.createdAt) }}</template>
    </UiDataTable>
  </div>
</template>

<style scoped>
.small { font-size: 12px; }
.auto { width: auto; }
</style>
