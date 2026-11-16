<script setup lang="ts">
/** Journal d'audit (§19) : six mois, filtres combinables, export CSV. */
import type { Paginated } from '#shared/schemas/common'
import type { AuditRow } from '#shared/schemas/lists'
import { type Column, type TableState, stateFromRoute } from '~/types/table'

useHead({ title: 'Audit' })
const route = useRoute()
const query = ref<TableState>(stateFromRoute({ page: 1, pageSize: 50, sort: 'ts:desc', period: '7d' }, route.query, ['outcome', 'action', 'actor', 'projectId', 'environmentId', 'serverId']))
const { data, status } = await useFetch<Paginated<AuditRow>>('/api/audit', { query, watch: [query] })
const { data: environments } = useEnvironments()

const DOMAINS: Record<string, string> = {
  'deployment': 'Déploiements', 'target': 'Cibles et actions', 'project': 'Projets', 'source': 'Sources', 'upload': 'Archives',
  'server': 'Serveurs', 'endpoint': 'Endpoints et politiques', 'runner': 'Runners',
  'auth': 'Connexions', 'user': 'Comptes', 'permissions': 'Droits', 'group': 'Groupes', 'idp': 'Fournisseurs SSO',
  'watchtower': 'Watchtower', 'image': 'Images', 'notification': 'Notifications', 'export': 'Exports', 'retention': 'Rétention',
}
const OUTCOME: Record<string, { label: string, tone: 'success' | 'danger' | 'warning' }> = {
  success: { label: 'Réussi', tone: 'success' },
  failure: { label: 'Échec', tone: 'danger' },
  denied: { label: 'Refusé', tone: 'warning' },
}
const columns: Column<AuditRow>[] = [
  { key: 'ts', label: 'Date', sortable: true },
  { key: 'actor', label: 'Acteur', sortable: true },
  { key: 'action', label: 'Action', sortable: true },
  { key: 'outcome', label: 'Résultat', sortable: true },
  { key: 'targetType', label: 'Objet' },
  { key: 'details', label: 'Détails' },
  { key: 'ip', label: 'Adresse IP', defaultHidden: true },
]
const open = ref<AuditRow | null>(null)
const brief = (d: Record<string, unknown>) => Object.entries(d).slice(0, 3).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(' · ')
</script>

<template>
  <div>
    <UiPageHeader title="Audit" icon="scroll" />
    <UiDataTable v-model:query="query" table-key="audit" :defaults="{ period: '7d' }" export-url="/api/audit" period :columns="columns" :rows="data?.items ?? []" :total="data?.total ?? 0" :loading="status === 'pending'" empty-text="Aucun évènement">
      <template #filters>
        <select v-model="query.action" class="input auto" aria-label="Domaine">
          <option :value="undefined">Tous les domaines</option>
          <option v-for="(l, k) in DOMAINS" :key="k" :value="`${k}.`">{{ l }}</option>
        </select>
        <select v-model="query.outcome" class="input auto" aria-label="Résultat">
          <option :value="undefined">Tous les résultats</option>
          <option value="failure,denied">Échecs et refus</option>
          <option v-for="(o, k) in OUTCOME" :key="k" :value="k">{{ o.label }}</option>
        </select>
        <select v-model="query.environmentId" class="input auto" aria-label="Environnement">
          <option :value="undefined">Tous les environnements</option>
          <option v-for="e in environments" :key="e.id" :value="e.id">{{ e.name }}</option>
        </select>
      </template>
      <template #cell-ts="{ row }"><span class="nowrap">{{ fmtDateTime(row.ts) }}</span></template>
      <template #cell-action="{ row }"><code>{{ row.action }}</code></template>
      <template #cell-outcome="{ row }"><UiBadge :tone="OUTCOME[row.outcome]?.tone ?? 'neutral'">{{ OUTCOME[row.outcome]?.label ?? row.outcome }}</UiBadge></template>
      <template #cell-targetType="{ row }"><span class="small">{{ row.targetType ?? '—' }}</span></template>
      <template #cell-details="{ row }">
        <button v-if="Object.keys(row.details).length" type="button" class="details" @click="open = row">{{ brief(row.details) }}</button>
        <span v-else class="muted">—</span>
      </template>
    </UiDataTable>

    <UiModal :open="!!open" :title="open ? `${open.action} — ${fmtDateTime(open.ts)}` : ''" width="640px" @update:open="v => { if (!v) open = null }">
      <dl v-if="open" class="dl">
        <dt>Acteur</dt><dd>{{ open.actor }}</dd>
        <dt>Résultat</dt><dd>{{ OUTCOME[open.outcome]?.label ?? open.outcome }}</dd>
        <dt>Objet</dt><dd class="mono">{{ open.targetType ?? '—' }} {{ open.targetId ?? '' }}</dd>
        <dt>Adresse IP</dt><dd>{{ open.ip ?? '—' }}</dd>
      </dl>
      <pre v-if="open" class="json">{{ JSON.stringify(open.details, null, 2) }}</pre>
    </UiModal>
  </div>
</template>

<style scoped>
.auto { width: auto; max-width: 220px; }
.nowrap { white-space: nowrap; }
.small { font-size: 12.5px; }
.details { all: unset; cursor: pointer; font-size: 12.5px; color: var(--text-muted); max-width: 340px; display: inline-block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.details:hover { color: var(--primary); }
.details:focus-visible { outline: 2px solid var(--focus); }
.dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px var(--space-4); margin: 0 0 var(--space-3); font-size: 13px; }
.dl dt { color: var(--text-muted); }
.dl dd { margin: 0; overflow-wrap: anywhere; }
.json { background: var(--surface-2); padding: var(--space-3); border-radius: var(--radius); font-size: 12px; max-height: 50vh; overflow: auto; margin: 0; }
</style>
