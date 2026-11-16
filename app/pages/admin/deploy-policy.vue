<script setup lang="ts">
/** Politique de déploiement par environnement : validation par une autre personne et fenêtres de déploiement. */
import type { DeployPolicyDto } from '#shared/schemas/deploy-gate'
import { DAY_LABEL, type DeployWindow } from '#shared/utils/deploy-windows'

useHead({ title: 'Politique de déploiement' })
const toast = useToast()
const { data, refresh } = await useFetch<{ policies: DeployPolicyDto[] }>('/api/admin/deploy-policies')
const drafts = ref<DeployPolicyDto[]>([])
watch(data, (d) => { drafts.value = (d?.policies ?? []).map(p => ({ ...p, windows: p.windows.map(w => ({ ...w, days: [...w.days] })) })) }, { immediate: true })
const saving = ref<string | null>(null)
const errors = ref<Record<string, Record<string, string>>>({})
const dirty = (p: DeployPolicyDto) => JSON.stringify(p) !== JSON.stringify(data.value?.policies.find(x => x.environmentId === p.environmentId))

function addWindow(p: DeployPolicyDto) {
  p.windows.push({ days: [1, 2, 3, 4, 5], from: '09:00', to: '17:00' } satisfies DeployWindow)
}
function toggleDay(w: DeployWindow, d: number) {
  w.days = w.days.includes(d) ? w.days.filter(x => x !== d) : [...w.days, d].sort()
}
async function save(p: DeployPolicyDto) {
  saving.value = p.environmentId
  errors.value[p.environmentId] = {}
  try {
    await $fetch<unknown>('/api/admin/deploy-policies', { method: 'PUT', body: { environmentId: p.environmentId, requireApproval: p.requireApproval, timezone: p.timezone, windows: p.windows } })
    toast.success(`Politique de ${p.environment} enregistrée`)
    await refresh()
  }
  catch (err) {
    const e = apiError(err)
    errors.value[p.environmentId] = e.errors
    toast.error(Object.values(e.errors)[0] ?? e.message)
  }
  finally {
    saving.value = null
  }
}
</script>

<template>
  <div>
    <UiPageHeader title="Administration" icon="settings"><template #nav><AdminNav /></template></UiPageHeader>
    <section class="card pad intro">
      <h2>Politique de déploiement</h2>
      <p class="muted small">
        Par environnement : exiger la <strong>validation d'une autre personne</strong> (droit « Valider les déploiements d'autrui ») avant tout déploiement, et limiter les déploiements à des <strong>fenêtres</strong> (jours et heures).
        Hors fenêtre, on peut planifier le déploiement dans une fenêtre, ou le demander en urgence (validation par une autre personne). Les automatismes (webhook GitHub, reconstruction automatique) sont reportés à la prochaine ouverture.
        L'arrêt, le démarrage et le redémarrage restent possibles à toute heure.
      </p>
    </section>

    <section v-for="p in drafts" :key="p.environmentId" class="card pad env" :data-env="p.environment">
      <div class="head">
        <h3>{{ p.environment }} <UiBadge v-if="p.isProduction" tone="danger">production</UiBadge></h3>
        <UiButton size="sm" variant="primary" :disabled="!dirty(p)" :loading="saving === p.environmentId" @click="save(p)">Enregistrer</UiButton>
      </div>
      <label class="row"><UiSwitch v-model="p.requireApproval" :label="`Validation requise pour ${p.environment}`" /> Validation par une autre personne obligatoire</label>
      <div class="row">
        <label :for="`tz-${p.environmentId}`" class="small">Fuseau horaire</label>
        <input :id="`tz-${p.environmentId}`" v-model.trim="p.timezone" class="input mono tz" spellcheck="false" placeholder="Europe/Paris">
        <span v-if="errors[p.environmentId]?.timezone" class="err small">{{ errors[p.environmentId]!.timezone }}</span>
      </div>
      <p v-if="!p.windows.length" class="muted small">Aucune fenêtre : déploiement possible à toute heure.</p>
      <div v-for="(w, i) in p.windows" :key="i" class="win">
        <div class="days" role="group" :aria-label="`Jours de la fenêtre ${i + 1}`">
          <label v-for="d in 7" :key="d" class="day"><input type="checkbox" :checked="w.days.includes(d)" @change="toggleDay(w, d)"> {{ DAY_LABEL[d] }}</label>
        </div>
        <input v-model="w.from" type="time" class="input sm" :aria-label="`Début de la fenêtre ${i + 1}`">
        <span class="muted">à</span>
        <input v-model="w.to" type="time" class="input sm" :aria-label="`Fin de la fenêtre ${i + 1}`">
        <UiButton size="sm" variant="ghost" :aria-label="`Retirer la fenêtre ${i + 1}`" @click="p.windows.splice(i, 1)">Retirer</UiButton>
      </div>
      <p v-if="errors[p.environmentId] && Object.keys(errors[p.environmentId]!).some(k => k.startsWith('windows'))" class="err small" role="alert">{{ Object.entries(errors[p.environmentId]!).find(([k]) => k.startsWith('windows'))?.[1] }}</p>
      <div><UiButton size="sm" @click="addWindow(p)">Ajouter une fenêtre</UiButton></div>
    </section>
  </div>
</template>

<style scoped>
.pad { padding: var(--space-5); display: flex; flex-direction: column; gap: var(--space-3); margin-bottom: var(--space-4); }
.head { display: flex; justify-content: space-between; align-items: center; }
h2, h3 { margin: 0; }
h3 { font-size: 15px; display: flex; gap: 8px; align-items: center; }
.small { font-size: 12.5px; margin: 0; }
.row { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; font-size: 13px; }
.tz { max-width: 220px; }
.win { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; padding: var(--space-2) var(--space-3); border: 1px solid var(--border); border-radius: var(--radius); }
.days { display: flex; gap: 8px; flex-wrap: wrap; }
.day { display: inline-flex; gap: 4px; align-items: center; font-size: 12.5px; }
.sm { max-width: 110px; }
.err { color: var(--danger); }
</style>
