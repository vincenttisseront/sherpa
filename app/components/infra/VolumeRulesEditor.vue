<script setup lang="ts">
/** Liste blanche des chemins bind (§10), enregistrée en bloc. */
import type { EnvironmentDto } from '#shared/schemas/environments'
import type { VolumeRuleInput } from '#shared/schemas/infra'

const props = defineProps<{ endpointId: string, environments: EnvironmentDto[], runtimeRoots: string[] }>()
const toast = useToast()
const { data: saved, refresh } = await useFetch<VolumeRuleInput[]>(() => `/api/endpoints/${props.endpointId}/volume-rules`, { default: () => [] })
const draft = ref<VolumeRuleInput[]>([])
const errors = ref<Record<string, string>>({})
const busy = ref(false)
watch(saved, v => { draft.value = structuredClone(toRaw(v)); errors.value = {} }, { immediate: true })
const dirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(saved.value))

function add() {
  draft.value = [...draft.value, { hostPath: '', mode: 'ro', environmentKey: null, description: null, enabled: true }]
}
function update(i: number, patch: Partial<VolumeRuleInput>) {
  draft.value = draft.value.map((r, j) => (j === i ? { ...r, ...patch } : r))
}

async function save() {
  busy.value = true
  errors.value = {}
  try {
    saved.value = await $fetch<VolumeRuleInput[]>(`/api/endpoints/${props.endpointId}/volume-rules`, { method: 'PUT', body: draft.value })
    toast.success('Liste blanche enregistrée')
  }
  catch (err) {
    const e = apiError(err)
    errors.value = e.errors
    toast.error(e.message)
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="stack">
    <p class="muted small">
      Un volume bind n'est accepté que si son chemin est couvert par une règle active. Le répertoire runtime du projet
      <template v-if="runtimeRoots.length">(<code>{{ runtimeRoots.map(r => `${r}/<projet>`).join(', ') }}</code>)</template>
      est toujours autorisé ; les répertoires système, les sockets et les répertoires de travail ne le sont jamais.
    </p>
    <div v-if="draft.length" class="scroll">
      <table>
        <thead><tr><th>Chemin de l'hôte</th><th>Accès</th><th>Environnement</th><th>Description</th><th>Active</th><th /></tr></thead>
        <tbody>
          <tr v-for="(r, i) in draft" :key="i" :class="{ invalid: errors[`${i}.hostPath`] }">
            <td>
              <input class="input mono" :value="r.hostPath" placeholder="/srv/shared/certs" aria-label="Chemin de l'hôte" @input="update(i, { hostPath: ($event.target as HTMLInputElement).value.trim() })">
              <span v-if="errors[`${i}.hostPath`]" class="error-text">{{ errors[`${i}.hostPath`] }}</span>
            </td>
            <td>
              <select class="input" :value="r.mode" aria-label="Accès" @change="update(i, { mode: ($event.target as HTMLSelectElement).value as 'ro' })">
                <option value="ro">Lecture seule</option><option value="rw">Lecture-écriture</option>
              </select>
            </td>
            <td>
              <select class="input" :value="r.environmentKey ?? ''" aria-label="Environnement" @change="update(i, { environmentKey: (($event.target as HTMLSelectElement).value || null) as VolumeRuleInput['environmentKey'] })">
                <option value="">Tous</option>
                <option v-for="e in environments" :key="e.key" :value="e.key">{{ e.name }}</option>
              </select>
            </td>
            <td><input class="input" :value="r.description ?? ''" maxlength="300" aria-label="Description" @input="update(i, { description: ($event.target as HTMLInputElement).value || null })"></td>
            <td><UiSwitch :model-value="r.enabled" :label="r.enabled ? 'oui' : 'non'" @update:model-value="v => update(i, { enabled: v })" /></td>
            <td><UiButton variant="ghost" size="sm" :aria-label="`Supprimer la règle ${i + 1}`" @click="draft = draft.filter((_, j) => j !== i)">✕</UiButton></td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-else class="muted">Aucun chemin bind autorisé en dehors des répertoires runtime des projets.</p>
    <div class="actions">
      <UiButton size="sm" @click="add">Ajouter un chemin</UiButton>
      <span class="spacer" />
      <UiButton :disabled="!dirty" @click="refresh">Annuler</UiButton>
      <UiButton variant="primary" :disabled="!dirty" :loading="busy" @click="save">Enregistrer</UiButton>
    </div>
  </div>
</template>

<style scoped>
.stack { display: flex; flex-direction: column; gap: var(--space-3); }
.small { font-size: 12.5px; margin: 0; }
.scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; }
th { text-align: left; font-size: 12px; color: var(--text-muted); font-weight: 600; padding: 4px; }
td { padding: 3px 4px; vertical-align: top; }
tr.invalid .input:first-child { border-color: var(--danger); }
.error-text { color: var(--danger); font-size: 12px; display: block; }
.actions { display: flex; gap: var(--space-2); align-items: center; }
.spacer { flex: 1; }
</style>
