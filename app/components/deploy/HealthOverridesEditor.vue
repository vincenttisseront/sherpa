<script setup lang="ts">
/**
 * Réglages de healthcheck propres à la cible : remplacent les valeurs du
 * Compose à chaque release (ex. délai de démarrage allongé pour un premier
 * démarrage avec migrations). Champ vide : valeur du Compose.
 */
import { Plus, Trash2 } from 'lucide-vue-next'
import type { ComposeOverrides, HealthcheckOverride } from '#shared/schemas/projects'

const props = defineProps<{ targetId: string, value: ComposeOverrides, canEdit: boolean }>()
const emit = defineEmits<{ saved: [] }>()
const toast = useToast()

type Field = keyof HealthcheckOverride
const FIELDS: { key: Field, label: string, hint: string }[] = [
  { key: 'startPeriodSec', label: 'start_period (s)', hint: 'Délai de démarrage : les échecs ne comptent pas, un succès rend le service sain' },
  { key: 'intervalSec', label: 'interval (s)', hint: 'Intervalle entre deux tests' },
  { key: 'timeoutSec', label: 'timeout (s)', hint: 'Durée maximale d\'un test' },
  { key: 'retries', label: 'retries', hint: 'Échecs consécutifs avant l\'état « en échec »' },
]

interface Row { service: string, values: Partial<Record<Field, number | ''>> }
const toRows = (v: ComposeOverrides): Row[] => Object.entries(v.healthchecks ?? {}).map(([service, o]) => ({ service, values: { ...o } }))
const rows = ref<Row[]>(toRows(props.value))
watch(() => props.value, v => (rows.value = toRows(v)))
const saving = ref(false)
const errors = ref<Record<string, string>>({})

async function save() {
  saving.value = true
  errors.value = {}
  try {
    const healthchecks: Record<string, HealthcheckOverride> = {}
    for (const r of rows.value.filter(x => x.service.trim())) {
      healthchecks[r.service.trim()] = Object.fromEntries(Object.entries(r.values).filter(([, v]) => v !== '' && v !== undefined && v !== null).map(([k, v]) => [k, Number(v)]))
    }
    await $fetch(`/api/targets/${props.targetId}`, { method: 'PATCH', body: { composeOverrides: { ...props.value, healthchecks } } })
    toast.success('Healthchecks enregistrés : appliqués au prochain déploiement')
    emit('saved')
  }
  catch (err) {
    const e = apiError(err)
    errors.value = e.errors
    toast.error(e.message)
  }
  finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="hc">
    <p class="muted small">Remplacent les valeurs du Compose pour cette cible, à chaque release. Utile quand le premier démarrage (migrations) dépasse le délai prévu : allonger le start_period ne ralentit pas les démarrages suivants.</p>
    <table v-if="rows.length" class="tbl">
      <thead><tr><th>Service</th><th v-for="f in FIELDS" :key="f.key" :title="f.hint">{{ f.label }}</th><th /></tr></thead>
      <tbody>
        <tr v-for="(r, i) in rows" :key="i">
          <td><input v-model.trim="r.service" class="input mono" aria-label="Service" :disabled="!canEdit" placeholder="service"></td>
          <td v-for="f in FIELDS" :key="f.key"><input v-model.number="r.values[f.key]" class="input num" type="number" min="0" :aria-label="`${f.label} — ${r.service}`" :disabled="!canEdit" placeholder="Compose"></td>
          <td><UiButton v-if="canEdit" size="sm" variant="ghost" :aria-label="`Retirer ${r.service}`" @click="rows.splice(i, 1)"><Trash2 :size="14" /></UiButton></td>
        </tr>
      </tbody>
    </table>
    <p v-for="(m, k) in errors" :key="k" class="err small">{{ m }}</p>
    <div v-if="canEdit" class="actions">
      <UiButton size="sm" @click="rows.push({ service: '', values: { startPeriodSec: 300 } })"><Plus :size="14" /> Ajouter un service</UiButton>
      <UiButton size="sm" variant="primary" :loading="saving" @click="save">Enregistrer</UiButton>
    </div>
  </div>
</template>

<style scoped>
.hc { display: flex; flex-direction: column; gap: var(--space-2); }
.small { font-size: 12.5px; }
.tbl { border-collapse: collapse; font-size: 13px; }
.tbl th { text-align: left; font-weight: 500; color: var(--text-muted); padding: 4px 6px; font-size: 12px; }
.tbl td { padding: 3px 6px 3px 0; }
.num { width: 100px; }
.err { color: var(--danger); margin: 0; }
.actions { display: flex; gap: var(--space-2); }
p { margin: 0; }
</style>
