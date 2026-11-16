<script setup lang="ts">
/**
 * Fin de vie d'un projet : suppression définitive (stacks supprimées des hôtes) ou
 * détachement (la plateforme cesse de gérer le projet, tout continue de tourner).
 */
import type { ProjectRemovalPlan } from '#shared/schemas/project-removal'
import { Trash2, Unplug } from 'lucide-vue-next'

const props = defineProps<{ projectId: string, projectName: string }>()
const open = defineModel<boolean>('open', { required: true })
const toast = useToast()

const { data: plan, error } = useFetch<ProjectRemovalPlan>(() => `/api/projects/${props.projectId}/removal`, { server: false, lazy: true })
const mode = ref<'detach' | 'delete'>('detach')
const confirmText = ref('')
const stopWatchtower = ref(false)
const busy = ref(false)
const deployed = computed(() => plan.value?.targets.filter(t => t.stack) ?? [])
const hasWatchtower = computed(() => deployed.value.some(t => t.watchtower))

async function run() {
  busy.value = true
  try {
    const r = await $fetch<{ mode: string, removed: boolean, deploymentIds?: string[] }>(`/api/projects/${props.projectId}/removal`, {
      method: 'POST',
      body: mode.value === 'detach' ? { mode: 'detach', confirm: confirmText.value, stopWatchtower: stopWatchtower.value } : { mode: 'delete', confirm: confirmText.value },
    })
    open.value = false
    if (r.mode === 'detach') {
      toast.success(`${props.projectName} détaché : les conteneurs continuent de tourner, la stack est désormais externe`)
      await navigateTo('/projects')
    }
    else if (r.removed) {
      toast.success(`${props.projectName} supprimé`)
      await navigateTo('/projects')
    }
    else {
      // L'historique part avec le projet : suivi depuis la liste des projets (et l'audit).
      toast.success(`Suppression de ${props.projectName} en cours : stacks supprimées puis projet retiré (quelques secondes)`)
      await navigateTo('/projects')
    }
  }
  catch (err) {
    const e = apiError(err)
    toast.error(Object.values(e.errors)[0] ?? e.message)
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <UiModal v-model:open="open" :title="`Supprimer ${projectName}`" width="680px">
    <p v-if="error" class="alert">{{ apiError(error).message }}</p>
    <p v-else-if="!plan" class="muted small">Lecture du projet…</p>
    <div v-else class="rm">
      <div class="choices" role="radiogroup" aria-label="Mode de suppression">
        <label class="choice" :class="{ on: mode === 'detach' }">
          <input v-model="mode" type="radio" value="detach">
          <Unplug :size="18" class="ico" />
          <span>
            <strong>Arrêter la gestion par la console</strong>
            <span class="muted small">Tout continue de tourner sur l'hôte : conteneurs, Compose en service, images, données. Le projet, son historique et ses variables sont retirés de la plateforme ; la stack redevient externe (reprenable plus tard).</span>
          </span>
        </label>
        <label class="choice danger" :class="{ on: mode === 'delete' }">
          <input v-model="mode" type="radio" value="delete">
          <Trash2 :size="18" class="ico" />
          <span>
            <strong>Supprimer définitivement</strong>
            <span class="muted small">Les stacks sont arrêtées et supprimées des hôtes, avec leurs releases et images construites, puis le projet est retiré de la plateforme. Les données (volumes) sont conservées sur l'hôte.</span>
          </span>
        </label>
      </div>

      <table v-if="plan.targets.length" class="tbl">
        <thead><tr><th>Environnement</th><th>Stack</th><th>{{ mode === 'detach' ? 'Compose en service' : 'Données conservées' }}</th></tr></thead>
        <tbody>
          <tr v-for="t in plan.targets" :key="t.targetId">
            <td>{{ t.environment }} <span class="muted small">{{ t.server }}</span></td>
            <td class="mono small">{{ t.stack ?? '— (non déployée)' }}</td>
            <td class="mono small path">{{ (mode === 'detach' ? t.composeFile : t.dataDir) ?? '—' }}</td>
          </tr>
        </tbody>
      </table>

      <template v-if="mode === 'detach' && deployed.length">
        <label v-if="hasWatchtower" class="check"><input v-model="stopWatchtower" type="checkbox"> <span>Arrêter les mises à jour Watchtower de ces stacks <span class="muted">(exclues du Watchtower du profil du serveur, ou ancien Watchtower retiré ; sinon les images continuent d'être mises à jour sans suivi)</span></span></label>
        <p class="muted small">Pour gérer la stack à la main ensuite : <code>docker compose -p &lt;stack&gt; -f &lt;Compose en service&gt; …</code>{{ deployed.some(t => t.secretVariables) ? ' ; les variables secrètes ne sont pas écrites dans ce fichier : les fournir dans l\'environnement.' : '' }}</p>
      </template>

      <UiField :label="`Saisir l'identifiant du projet (${plan.slug}) pour confirmer`" for="rm-confirm">
        <input id="rm-confirm" v-model.trim="confirmText" class="input input-sm mono" autocomplete="off" :placeholder="plan.slug">
      </UiField>
    </div>
    <template #footer>
      <UiButton variant="ghost" @click="open = false">Annuler</UiButton>
      <UiButton :variant="mode === 'delete' ? 'danger' : 'primary'" :loading="busy" :disabled="!plan || confirmText !== plan.slug" @click="run">{{ mode === 'delete' ? 'Supprimer définitivement' : 'Arrêter la gestion' }}</UiButton>
    </template>
  </UiModal>
</template>

<style scoped>
.rm { display: flex; flex-direction: column; gap: var(--space-3); }
.choices { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-2); }
@media (max-width: 640px) { .choices { grid-template-columns: 1fr; } }
.choice { display: flex; gap: var(--space-2); align-items: flex-start; padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius); cursor: pointer; }
.choice > span { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
.choice input { margin-top: 3px; }
.choice .ico { flex: none; color: var(--primary); margin-top: 1px; }
.choice.danger .ico { color: var(--danger); }
.choice.on { border-color: var(--primary); box-shadow: 0 0 0 1px var(--primary); }
.choice.danger.on { border-color: var(--danger); box-shadow: 0 0 0 1px var(--danger); }
.small { font-size: 12.5px; }
.tbl { width: 100%; border-collapse: collapse; font-size: 13px; }
.tbl th { text-align: left; font-size: 11px; text-transform: uppercase; color: var(--text-muted); font-weight: 500; padding: 4px 8px 4px 0; border-bottom: 1px solid var(--border); }
.tbl td { padding: 4px 8px 4px 0; border-bottom: 1px solid var(--border); }
.path { overflow-wrap: anywhere; }
.check { display: flex; gap: 8px; align-items: flex-start; font-size: 13px; }
.alert { margin: 0; padding: var(--space-2) var(--space-3); border-radius: var(--radius); background: var(--danger-bg); color: var(--danger); }
p { margin: 0; }
</style>
