<script setup lang="ts">
/** Règles d'alerte de ressources (CPU, mémoire, redémarrages) des conteneurs déployés par la plateforme, alertes en cours et récentes. */
import { METRIC_KINDS, METRIC_LABEL, type MetricAlertsDto, type MetricRule } from '#shared/schemas/metrics'

const toast = useToast()
const { data, refresh } = useFetch<MetricAlertsDto>('/api/admin/metric-alerts', { server: false, lazy: true })
const rules = ref<MetricRule[]>([])
const saving = ref(false)
const errors = ref<Record<string, string>>({})
watch(() => data.value?.rules, (r) => { if (r) rules.value = r.map(x => ({ ...x })) }, { immediate: true })
const dirty = computed(() => JSON.stringify(rules.value) !== JSON.stringify(data.value?.rules ?? []))

function add() {
  const n = rules.value.length + 1
  rules.value.push({ id: `regle-${Date.now().toString(36)}`, name: `Règle ${n}`, metric: 'cpu', threshold: 80, minutes: 10, enabled: true })
}
async function save() {
  saving.value = true
  errors.value = {}
  try {
    await $fetch<unknown>('/api/admin/metric-alerts', { method: 'PUT', body: { rules: rules.value } })
    toast.success('Règles enregistrées')
    await refresh()
  }
  catch (err) {
    const e = apiError(err)
    errors.value = e.errors
    toast.error(Object.values(e.errors)[0] ?? e.message)
  }
  finally {
    saving.value = false
  }
}
</script>

<template>
  <section v-if="data" class="card pad" data-testid="metric-alerts">
    <div class="bar">
      <h2>Alertes de ressources</h2>
      <div class="actions"><UiButton size="sm" @click="add">Ajouter une règle</UiButton><UiButton size="sm" variant="primary" :disabled="!dirty" :loading="saving" @click="save">Enregistrer</UiButton></div>
    </div>
    <p class="muted small">
      Un relevé par minute des conteneurs déployés par Sherpa{{ data.samples.lastAt ? ` (dernier ${fmtRelative(data.samples.lastAt)}, ${data.samples.containers} conteneur${data.samples.containers > 1 ? 's' : ''})` : '' }}. Une alerte exige un dépassement continu sur toute la durée.
      Pour être prévenu, ajouter l'évènement « Alerte de ressources » à un canal ci-dessus.
    </p>

    <table class="table">
      <thead><tr><th>Règle</th><th>Mesure</th><th>Seuil</th><th>Durée (min)</th><th>Active</th><th /></tr></thead>
      <tbody>
        <tr v-for="(r, i) in rules" :key="r.id">
          <td><input v-model.trim="r.name" class="input" maxlength="80" :aria-label="`Nom de la règle ${i + 1}`"></td>
          <td>
            <select v-model="r.metric" class="input" :aria-label="`Mesure de ${r.name}`" :title="METRIC_LABEL[r.metric].hint"><option v-for="k in METRIC_KINDS" :key="k" :value="k">{{ METRIC_LABEL[k].name }}</option></select>
          </td>
          <td class="num"><input v-model.number="r.threshold" class="input sm" type="number" min="0.01" step="any" :aria-label="`Seuil de ${r.name}`"> <span class="muted small">{{ METRIC_LABEL[r.metric].unit }}</span></td>
          <td class="num"><input v-model.number="r.minutes" class="input sm" type="number" min="2" max="60" :aria-label="`Durée de ${r.name}`"></td>
          <td><UiSwitch v-model="r.enabled" :label="`Règle ${r.name} active`" /></td>
          <td><UiButton size="sm" variant="ghost" :aria-label="`Supprimer ${r.name}`" @click="rules.splice(i, 1)">Retirer</UiButton></td>
        </tr>
        <tr v-if="!rules.length"><td colspan="6" class="muted small">Aucune règle : aucune alerte de ressources.</td></tr>
      </tbody>
    </table>
    <p v-if="Object.keys(errors).length" class="err small" role="alert">{{ Object.values(errors)[0] }}</p>

    <h3>En cours</h3>
    <p v-if="!data.active.length" class="muted small">Aucune alerte en cours.</p>
    <ul v-else class="alerts" data-testid="active-alerts">
      <li v-for="a in data.active" :key="a.id"><UiBadge tone="warning">{{ a.rule }}</UiBadge> <strong>{{ a.container }}</strong> <span class="muted small">{{ a.project ? `${a.project} (${a.environment}) · ` : '' }}depuis {{ fmtRelative(a.since) }}</span></li>
    </ul>
    <template v-if="data.recent.length">
      <h3>Récentes</h3>
      <ul class="alerts">
        <li v-for="a in data.recent" :key="a.id"><UiBadge tone="success">{{ a.rule }}</UiBadge> <strong>{{ a.container }}</strong> <span class="muted small">du {{ fmtDateTime(a.since) }} au {{ fmtDateTime(a.resolvedAt!) }}</span></li>
      </ul>
    </template>
  </section>
</template>

<style scoped>
.pad { padding: var(--space-5); display: flex; flex-direction: column; gap: var(--space-3); margin-top: var(--space-4); }
.bar { display: flex; justify-content: space-between; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
.actions { display: flex; gap: var(--space-2); }
h3 { margin: var(--space-2) 0 0; font-size: 13.5px; }
.small { font-size: 12.5px; margin: 0; }
.table { width: 100%; border-collapse: collapse; font-size: 13px; }
.table th { text-align: left; font-size: 11px; text-transform: uppercase; color: var(--text-muted); padding: 4px 6px; border-bottom: 1px solid var(--border); }
.table td { padding: 6px; border-bottom: 1px solid var(--border); vertical-align: middle; }
.sm { max-width: 90px; }
.num { white-space: nowrap; }
.alerts { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.err { color: var(--danger); margin: 0; }
</style>
