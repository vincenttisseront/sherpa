<script setup lang="ts">
/** Déploiements et actions (§17) : filtres combinables, période, colonnes, vues, export CSV. */
import type { Paginated } from '#shared/schemas/common'
import type { BulkAcknowledgeResult, DeploymentRow } from '#shared/schemas/lists'
import { type Column, type TableState, stateFromRoute } from '~/types/table'

const props = defineProps<{ targetId?: string, syncRoute?: boolean, nlSearch?: boolean }>()
const route = useRoute()

const STATUS_GROUPS: Record<string, { label: string, value: string }> = {
  running: { label: 'En cours', value: ACTIVE_STATUS.join(',') },
  healthy: { label: 'Réussis', value: 'HEALTHY' },
  failed: { label: 'En échec (rollback compris)', value: 'FAILED,VALIDATION_FAILED,ROLLED_BACK' },
  rolledBack: { label: 'Rollback', value: 'ROLLED_BACK' },
  degraded: { label: 'Dégradés', value: 'DEGRADED' },
  stopped: { label: 'Arrêtés / supprimés', value: 'STOPPED,DELETED' },
}
const base: TableState = { page: 1, pageSize: 25, sort: 'createdAt:desc', ...(props.targetId ? { targetId: props.targetId } : {}) }
const query = ref<TableState>(props.syncRoute ? stateFromRoute(base, route.query, ['status', 'action', 'projectId', 'environmentId', 'serverId', 'buildFailed', 'unacknowledged']) : base)
watch(() => props.targetId, (id) => { if (id) query.value = { ...base, targetId: id } })

const refreshRef = { fn: async () => {} }
defineExpose({ refresh: () => refreshRef.fn() })
const { data, status, refresh } = await useFetch<Paginated<DeploymentRow>>('/api/deployments', { query, watch: [query] })
refreshRef.fn = refresh

const { data: environments } = useEnvironments()
const { data: projects } = props.targetId ? { data: ref(null) } : await useFetch<Paginated<{ id: string, name: string }>>('/api/projects', { query: { pageSize: 200, sort: 'name:asc' } })

const columns: Column<DeploymentRow>[] = [
  { key: 'createdAt', label: 'Demandé le', sortable: true },
  ...(props.targetId ? [] : [{ key: 'project', label: 'Projet', sortable: true }, { key: 'environment', label: 'Environnement', sortable: true, mobileHidden: true }] as Column<DeploymentRow>[]),
  { key: 'action', label: 'Opération', sortable: true },
  { key: 'status', label: 'Statut', sortable: true },
  { key: 'releaseNumber', label: 'Release', align: 'right', mobileHidden: true },
  { key: 'requestedBy', label: 'Par', mobileHidden: true },
  { key: 'durationSec', label: 'Durée', align: 'right', mobileHidden: true },
  { key: 'server', label: 'Serveur', defaultHidden: true },
  { key: 'finishedAt', label: 'Terminé le', sortable: true, defaultHidden: true },
]
// Statut : groupes de statuts, plus deux filtres d'échec (paramètres dédiés côté API).
const statusChoice = computed<string>({
  get: () => (query.value.unacknowledged === 'true' ? 'unack' : query.value.buildFailed === 'true' ? 'build' : String(query.value.status ?? '')),
  set: (v) => {
    const { status: _s, unacknowledged: _u, buildFailed: _b, ...rest } = query.value
    query.value = { ...rest, page: 1, ...(v === 'unack' ? { unacknowledged: 'true' } : v === 'build' ? { buildFailed: 'true' } : v ? { status: v } : {}) }
  },
})
const customStatus = computed(() => {
  const v = query.value.status
  if (typeof v !== 'string' || Object.values(STATUS_GROUPS).some(g => g.value === v)) return null
  return v.split(',').map(x => STATUS_LABEL[x] ?? x).join(' + ')
})
// Acquittement groupé des échecs : sélection, ou tous les échecs non acquittés des filtres.
const FAILED = ['FAILED', 'ROLLED_BACK', 'VALIDATION_FAILED']
const { can } = useAuth()
const toast = useToast()
const confirm = useConfirm()
const canAck = computed(() => can('deployment:execute'))
const ackable = (r: DeploymentRow) => FAILED.includes(r.status) && !r.acknowledgedAt
const selected = ref<string[]>([])
watch(query, () => { selected.value = [] }, { deep: true })
const acking = ref(false)
async function acknowledge(body: { ids?: string[], filter?: Record<string, unknown> }, label: string) {
  if (!await confirm({ title: 'Acquitter les échecs', message: `${label} : retirés du tableau de bord (alertes, compteur d'échecs, éléments en attente). Ils restent dans l'historique et l'acquittement est annulable depuis chaque déploiement.`, confirmLabel: 'Acquitter' })) return
  acking.value = true
  try {
    const r = await $fetch<BulkAcknowledgeResult>('/api/deployments/acknowledge', { method: 'POST', body: { ...body, acknowledged: true } })
    toast.success(`${r.updated} échec${r.updated > 1 ? 's' : ''} acquitté${r.updated > 1 ? 's' : ''}${r.skipped ? ` · ${r.skipped} ignoré${r.skipped > 1 ? 's' : ''} (déjà acquitté, pas un échec ou hors de vos droits)` : ''}`)
    selected.value = []
    await refresh()
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    acking.value = false
  }
}
const ackFilter = () => {
  const { page: _p, pageSize: _s, sort: _o, ...filter } = query.value
  return filter
}
const duration = (s: number | null) => (s === null ? '—' : s < 120 ? `${s} s` : `${Math.round(s / 60)} min`)
</script>

<template>
  <NlSearch v-if="nlSearch && !targetId" v-model:query="query" table="deployments" placeholder="Décrire la recherche : échecs de production cette semaine…" />
  <UiDataTable v-model:query="query" v-model:selected="selected" :selectable="canAck ? ackable : undefined" :fixed="targetId ? { targetId } : undefined" :table-key="targetId ? undefined : 'deployments'" export-url="/api/deployments" period :columns="columns" :rows="data?.items ?? []" :total="data?.total ?? 0" :loading="status === 'pending'" empty-text="Aucune opération">
    <template #filters>
      <select v-model="statusChoice" class="input auto" aria-label="Statut">
        <option value="">Tous les statuts</option>
        <option v-for="(g, k) in STATUS_GROUPS" :key="k" :value="g.value">{{ g.label }}</option>
        <option value="unack">Échecs non acquittés</option>
        <option value="build">Échecs de build</option>
        <option v-if="customStatus" :value="query.status">{{ customStatus }}</option>
      </select>
      <select v-model="query.action" class="input auto" aria-label="Opération">
        <option :value="undefined">Opérations</option>
        <option v-for="(l, k) in ACTION_LABEL" :key="k" :value="k">{{ l }}</option>
      </select>
      <template v-if="!targetId">
        <select v-model="query.projectId" class="input auto" aria-label="Projet">
          <option :value="undefined">Projets</option>
          <option v-for="p in projects?.items ?? []" :key="p.id" :value="p.id">{{ p.name }}</option>
        </select>
        <select v-model="query.environmentId" class="input auto" aria-label="Environnement">
          <option :value="undefined">Environnements</option>
          <option v-for="e in environments" :key="e.id" :value="e.id">{{ e.name }}</option>
        </select>
      </template>
      <UiButton v-if="canAck && query.unacknowledged === 'true' && (data?.total ?? 0) > 0" size="sm" :loading="acking" @click="acknowledge({ filter: ackFilter() }, `${data!.total} échec${data!.total > 1 ? 's' : ''} non acquitté${data!.total > 1 ? 's' : ''} (tous ceux des filtres)`)">Tout acquitter ({{ data!.total }})</UiButton>
    </template>
    <template #bulk="{ selected: ids }">
      <UiButton size="sm" variant="primary" :loading="acking" @click="acknowledge({ ids }, `${ids.length} échec${ids.length > 1 ? 's' : ''} sélectionné${ids.length > 1 ? 's' : ''}`)">Acquitter la sélection</UiButton>
    </template>
    <template #cell-createdAt="{ row }"><NuxtLink :to="`/deployments/${row.id}`">{{ fmtDateTime(row.createdAt) }}</NuxtLink></template>
    <template #cell-project="{ row }"><NuxtLink :to="`/projects/${row.projectId}`">{{ row.project }}</NuxtLink></template>
    <template #cell-action="{ row }">{{ ACTION_LABEL[row.action] ?? row.action }}</template>
    <template #cell-status="{ row }">
      <span class="st">
        <UiBadge :tone="statusTone(row.status)">{{ STATUS_LABEL[row.status] ?? row.status }}</UiBadge>
        <UiBadge v-if="row.gate === 'pending'" tone="warning" title="Une autre personne doit valider ce déploiement avant son exécution">à valider</UiBadge>
        <UiBadge v-else-if="row.gate === 'scheduled'" tone="info" :title="`Exécution planifiée le ${fmtDateTime(row.scheduledFor)}`">planifié</UiBadge>
        <UiBadge v-if="row.failedFrom === 'BUILDING'" tone="danger">build</UiBadge>
        <UiBadge v-if="row.acknowledgedAt" tone="neutral" :title="`Acquitté le ${fmtDateTime(row.acknowledgedAt)} : retiré du tableau de bord`">acquitté</UiBadge>
        <span v-if="row.error" class="err" :title="row.error">{{ row.error }}</span>
      </span>
    </template>
    <template #cell-releaseNumber="{ row }">{{ row.releaseNumber ? `#${row.releaseNumber}` : '—' }}</template>
    <template #cell-requestedBy="{ row }"><span class="small">{{ row.requestedBy ?? 'système' }}</span></template>
    <template #cell-durationSec="{ row }">{{ duration(row.durationSec) }}</template>
    <template #cell-finishedAt="{ row }">{{ fmtDateTime(row.finishedAt) }}</template>
  </UiDataTable>
</template>

<style scoped>
.auto { width: auto; max-width: 220px; }
.st { display: inline-flex; gap: 6px; align-items: center; max-width: 100%; }
.err { font-size: 12px; color: var(--danger); max-width: 190px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 720px) { .err { display: none; } }
.small { font-size: 12.5px; }
</style>
