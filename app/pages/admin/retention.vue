<script setup lang="ts">
/** Rétention (§14) : volumes conservés, éléments expirés, dernière purge, purge manuelle. */
interface Status {
  retentionDays: number
  tables: { key: string, label: string, rows: number, expired: number, oldest: string | null }[]
  lastPurge: { at: string, by: string, details: Record<string, unknown> } | null
}
useHead({ title: 'Rétention' })
const { can } = useAuth()
const toast = useToast()
const confirm = useConfirm()
const { data, refresh } = await useFetch<Status>('/api/admin/retention')
const expired = computed(() => data.value?.tables.reduce((a, t) => a + t.expired, 0) ?? 0)
const fmt = (n: number) => n.toLocaleString('fr-FR')

async function purge() {
  if (!await confirm({ title: 'Purger maintenant', message: `${fmt(expired.value)} élément(s) de plus de ${data.value!.retentionDays} jours seront supprimés définitivement. La purge automatique a lieu chaque nuit à 03:15.`, confirmLabel: 'Purger', danger: true })) return
  try {
    await $fetch<unknown>('/api/admin/retention/purge', { method: 'POST' })
    toast.info('Purge lancée')
    setTimeout(() => void refresh(), 3000)
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
}
</script>

<template>
  <div>
    <UiPageHeader title="Administration" icon="settings"><template #nav><AdminNav /></template></UiPageHeader>
    <section v-if="data" class="card pad">
      <div class="bar">
        <div>
          <h2>Rétention des données</h2>
          <p class="muted small">Conservation : {{ data.retentionDays }} jours (RETENTION_DAYS). Purge automatique chaque nuit à 03:15, par lots.</p>
        </div>
        <UiButton v-if="can('policy:manage')" variant="primary" size="sm" :disabled="!expired" @click="purge">Purger maintenant{{ expired ? ` (${fmt(expired)})` : '' }}</UiButton>
      </div>
      <table class="table">
        <thead><tr><th>Données</th><th class="num">Conservées</th><th class="num">Expirées</th><th>Plus ancienne</th></tr></thead>
        <tbody>
          <tr v-for="t in data.tables" :key="t.key">
            <td>{{ t.label }}</td>
            <td class="num">{{ fmt(t.rows) }}</td>
            <td class="num"><UiBadge v-if="t.expired" tone="warning">{{ fmt(t.expired) }}</UiBadge><span v-else class="muted">0</span></td>
            <td>{{ fmtDateTime(t.oldest) }}</td>
          </tr>
        </tbody>
      </table>
      <p class="small">
        Dernière purge :
        <template v-if="data.lastPurge">{{ fmtDateTime(data.lastPurge.at) }} par {{ data.lastPurge.by }}
          <span class="muted">({{ Object.entries(data.lastPurge.details).filter(([k]) => k !== 'retentionDays').map(([k, v]) => `${k} : ${v}`).join(', ') }})</span>
        </template>
        <span v-else class="muted">jamais</span>
      </p>
    </section>
  </div>
</template>

<style scoped>
.pad { padding: var(--space-3) var(--space-4); display: flex; flex-direction: column; gap: var(--space-2); max-width: 900px; }
.bar { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--space-3); flex-wrap: wrap; }
.bar h2 { margin: 0; font-size: 16px; }
.small { font-size: 13px; margin: 0; }
.table { width: 100%; border-collapse: collapse; }
.table th { text-align: left; font-size: 12px; color: var(--text-muted); padding: 6px; border-bottom: 1px solid var(--border); }
.table td { padding: 8px 6px; border-bottom: 1px solid var(--border); }
.num { text-align: right; font-variant-numeric: tabular-nums; }
</style>
