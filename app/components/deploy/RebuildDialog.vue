<script setup lang="ts">
/**
 * Reconstruction de la cible sur la dernière version de sa source : version active, dernière
 * version (commit de la branche, release GitHub), build propre facultatif, puis déploiement.
 */
import type { AutoRebuildState, RebuildPlan } from '#shared/schemas/rebuild'
import { ArrowRight, ExternalLink, Hammer } from 'lucide-vue-next'

const props = defineProps<{ targetId: string, isProduction?: boolean }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ started: [deploymentId: string], auto: [state: AutoRebuildState] }>()
const toast = useToast()

const plan = ref<RebuildPlan | null>(null)
const error = ref<string | null>(null)
const loading = ref(false)
const starting = ref(false)
const cleanBuild = ref(false)

async function load() {
  loading.value = true
  error.value = null
  plan.value = null
  try {
    plan.value = await $fetch<RebuildPlan>(`/api/targets/${props.targetId}/rebuild`)
  }
  catch (err) {
    error.value = apiError(err).message
  }
  finally {
    loading.value = false
  }
}
watch(open, (o) => {
  if (o) {
    cleanBuild.value = false
    void load()
  }
}, { immediate: true })

// Reconstruction automatique à chaque nouvelle version.
const autoOn = ref(false)
const autoClean = ref(false)
const savingAuto = ref(false)
watch(plan, (p) => {
  autoOn.value = !!p?.auto?.enabled
  autoClean.value = !!p?.auto?.cleanBuild
})
const autoDirty = computed(() => !!plan.value && (autoOn.value !== !!plan.value.auto?.enabled || autoClean.value !== !!plan.value.auto?.cleanBuild))
async function saveAuto() {
  savingAuto.value = true
  try {
    const state = await $fetch<AutoRebuildState>(`/api/targets/${props.targetId}/auto-rebuild`, { method: 'PUT', body: { enabled: autoOn.value, cleanBuild: autoClean.value } })
    plan.value = { ...plan.value!, auto: state }
    toast.success(state.enabled ? 'Reconstruction automatique activée' : 'Reconstruction automatique désactivée')
    emit('auto', state)
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    savingAuto.value = false
  }
}
const checking = ref(false)
async function checkNow() {
  checking.value = true
  try {
    const r = await $fetch<{ outcome: string, state: AutoRebuildState }>(`/api/targets/${props.targetId}/auto-rebuild/check`, { method: 'POST' })
    plan.value = { ...plan.value!, auto: r.state }
    if (r.outcome === 'started' && r.state.last?.deploymentId) {
      toast.success(`Nouvelle version ${r.state.last.label} : reconstruction lancée`)
      open.value = false
      emit('started', r.state.last.deploymentId)
    }
    else toast.info(r.outcome === 'up-to-date' ? 'Aucune nouvelle version' : r.outcome === 'busy' ? 'Opération déjà en cours sur la cible' : r.state.error ?? 'Vérification faite')
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    checking.value = false
  }
}
const OUTCOME = { started: 'reconstruite', refused: 'refusée (revue nécessaire)', error: 'en échec' } as const

const MODE: Record<RebuildPlan['mode'], string> = {
  'github-branch': 'Dernier commit de la branche',
  'github-release': 'Dernière release GitHub',
  'release-archive': 'Archive de la dernière release GitHub',
  'same': 'Même source, reconstruite',
}

async function start() {
  starting.value = true
  try {
    const r = await $fetch<{ deploymentId: string }>(`/api/targets/${props.targetId}/rebuild`, { method: 'POST', body: { cleanBuild: cleanBuild.value }, headers: { 'Idempotency-Key': crypto.randomUUID() } })
    toast.success('Reconstruction lancée')
    open.value = false
    emit('started', r.deploymentId)
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    starting.value = false
  }
}
</script>

<template>
  <UiModal v-model:open="open" title="Reconstruire" width="620px">
    <div class="stack">
      <p v-if="error" class="alert" role="alert">{{ error }}</p>
      <p v-else-if="loading || !plan" class="muted">Recherche de la dernière version…</p>
      <template v-else>
        <dl class="kv">
          <dt>Source</dt><dd>{{ plan.source }}</dd>
          <dt>Reconstruit</dt><dd>{{ MODE[plan.mode] }}</dd>
        </dl>
        <div class="versions">
          <div class="v">
            <span class="muted small">Version active</span>
            <strong class="mono">{{ plan.current?.label ?? '—' }}</strong>
            <span v-if="plan.current?.at" class="muted small">{{ fmtDateTime(plan.current.at) }}</span>
          </div>
          <ArrowRight :size="18" class="muted" aria-hidden="true" />
          <div class="v">
            <span class="muted small">{{ plan.mode === 'same' ? 'Reconstruite' : 'Dernière version' }}</span>
            <strong class="mono">{{ plan.latest?.label ?? plan.current?.label ?? '—' }}</strong>
            <span v-if="plan.latest?.at" class="muted small">{{ fmtDateTime(plan.latest.at) }}</span>
            <a v-if="plan.latest?.url" :href="plan.latest.url" target="_blank" rel="noopener" class="small">Voir sur GitHub <ExternalLink :size="11" /></a>
          </div>
        </div>
        <UiBadge v-if="plan.mode !== 'same'" :tone="plan.upToDate ? 'neutral' : 'success'">{{ plan.upToDate ? 'Déjà à jour : la même version est reconstruite' : 'Nouvelle version disponible' }}</UiBadge>
        <p v-for="(w, i) in plan.warnings" :key="i" class="warn small">{{ w }}</p>
        <p class="muted small">
          {{ plan.builds ? `${plan.builds} service(s) reconstruit(s) depuis leur Dockerfile` : 'Aucun service construit : images des registres récupérées à nouveau' }}.
          Les ports approuvés de la version active sont repris ; une version qui en demande d'autres passe par « Nouveau déploiement ».
        </p>
        <label v-if="plan.builds" class="check small"><input v-model="cleanBuild" type="checkbox"> <span><strong>Build propre</strong> : images de base (FROM) récupérées à nouveau, sans cache</span></label>

        <section v-if="plan.mode !== 'same'" class="auto">
          <UiSwitch v-model="autoOn" label="Reconstruire automatiquement à chaque nouvelle version" />
          <label v-if="autoOn && plan.builds" class="check small"><input v-model="autoClean" type="checkbox"> <span>avec un build propre</span></label>
          <p class="muted small">
            Vérifié toutes les quelques minutes par la console ; une version refusée (ports à approuver) ou en échec n'est pas retentée, la suivante le sera. Notification « Reconstruction automatique ».
            <template v-if="isProduction"><strong class="warn"> Environnement de production : chaque release publiée y sera déployée.</strong></template>
          </p>
          <p v-if="plan.auto?.enabled && plan.auto.lastCheckAt" class="small">
            Dernière vérification {{ fmtRelative(plan.auto.lastCheckAt) }}<template v-if="plan.auto.last"> · {{ plan.auto.last.label }} {{ OUTCOME[plan.auto.last.outcome] }} {{ fmtRelative(plan.auto.last.at) }}</template>
            <span v-if="plan.auto.error" class="warn"> · {{ plan.auto.error }}</span>
          </p>
          <div class="row">
            <UiButton v-if="autoDirty" size="sm" :loading="savingAuto" @click="saveAuto">Enregistrer</UiButton>
            <UiButton v-else-if="plan.auto?.enabled" size="sm" variant="ghost" :loading="checking" @click="checkNow">Vérifier maintenant</UiButton>
          </div>
        </section>
      </template>
      <div class="foot">
        <UiButton variant="ghost" @click="open = false">Annuler</UiButton>
        <UiButton variant="primary" :disabled="!plan || !!plan.warnings.find(w => w.startsWith('Aucun fichier'))" :loading="starting" @click="start"><Hammer :size="14" /> Reconstruire et déployer</UiButton>
      </div>
    </div>
  </UiModal>
</template>

<style scoped>
.stack { display: flex; flex-direction: column; gap: var(--space-3); }
.kv { display: grid; grid-template-columns: 110px 1fr; gap: 3px var(--space-3); margin: 0; font-size: 13.5px; }
.kv dt { color: var(--text-muted); }
.kv dd { margin: 0; }
.versions { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
.v { display: flex; flex-direction: column; gap: 2px; padding: 8px 12px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-2); min-width: 180px; flex: 1; }
.small { font-size: 12.5px; margin: 0; }
.warn { color: var(--warning); }
.alert { margin: 0; padding: var(--space-2) var(--space-3); border-radius: var(--radius); background: var(--danger-bg); color: var(--danger); }
.check { display: flex; gap: 6px; align-items: baseline; }
.foot { display: flex; justify-content: flex-end; gap: var(--space-2); }
.row { display: flex; gap: var(--space-2); }
.auto { display: flex; flex-direction: column; gap: var(--space-2); align-items: flex-start; padding-top: var(--space-3); border-top: 1px solid var(--border); }
</style>
