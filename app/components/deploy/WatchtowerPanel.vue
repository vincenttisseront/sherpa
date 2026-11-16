<script setup lang="ts">
/** Watchtower d'une cible (§12) : profil du serveur, politique, services, pause, historique des images. */
import { MODE_LABEL, type TargetWatchtowerDto, UPDATE_KIND_LABEL, WATCHTOWER_MODES, type WatchtowerConfig } from '#shared/schemas/watchtower'

const props = defineProps<{ targetId: string, data: TargetWatchtowerDto, canEdit: boolean, canDeploy: boolean, canStop: boolean, busy: boolean }>()
const emit = defineEmits<{ changed: [TargetWatchtowerDto], apply: [] }>()
const toast = useToast()
const confirm = useConfirm()

// « Planifié » (ancien réglage par projet) : le rythme vient désormais du profil.
const normalized = (c: WatchtowerConfig): WatchtowerConfig => ({ ...structuredClone(toRaw(c)), mode: c.mode === 'scheduled' ? 'automatic' : c.mode })
const form = ref<WatchtowerConfig>(normalized(props.data.config))
watch(() => props.data.config, v => { form.value = normalized(v) })
const MODES = WATCHTOWER_MODES.filter(m => m !== 'scheduled')
const errors = ref<Record<string, string>>({})
const issues = ref<{ severity: string, message: string }[]>([])
const saving = ref(false)

const MODE_HELP: Record<WatchtowerConfig['mode'], string> = {
  manual: 'Watchtower vérifie les registres et signale les nouvelles images ; rien n\'est mis à jour sans redéploiement.',
  scheduled: 'Mises à jour aux heures définies par le planning (cron à 6 champs, secondes incluses).',
  automatic: 'Les services sélectionnés sont mis à jour au rythme du profil Watchtower du serveur.',
  labels: 'Les services suivis et leur politique viennent des labels com.centurylinklabs.watchtower.* du Compose.',
}

const isGit = computed(() => props.data.provenance.config?.kind === 'github')
const anyUpdate = computed(() => form.value.mode !== 'manual' && (form.value.mode === 'labels' || Object.values(form.value.services).includes('update')))
const reset = () => { form.value = normalized(props.data.config) }
const dirty = computed(() => JSON.stringify(form.value) !== JSON.stringify(normalized(props.data.config)))

function policyOf(service: string) {
  return form.value.services[service] ?? 'off'
}
function setPolicy(service: string, p: 'off' | 'monitor' | 'update') {
  form.value.services = { ...form.value.services, [service]: p }
}

async function save() {
  saving.value = true
  errors.value = {}
  issues.value = []
  try {
    const r = await $fetch<TargetWatchtowerDto>(`/api/targets/${props.targetId}/watchtower`, { method: 'PUT', body: form.value })
    emit('changed', r)
    toast.success(r.pending ? 'Configuration enregistrée : à appliquer par un redéploiement' : 'Configuration enregistrée')
  }
  catch (err) {
    const e = apiError(err)
    errors.value = e.errors
    issues.value = ((err as { data?: { data?: { issues?: { severity: string, message: string }[] } } }).data?.data?.issues ?? []).filter(i => i.severity === 'error')
    toast.error(e.message)
  }
  finally {
    saving.value = false
  }
}

async function toggle(action: 'pause' | 'resume') {
  if (action === 'pause') {
    const ok = await confirm({ title: 'Mettre Watchtower en pause', message: 'Le conteneur Watchtower de la stack est arrêté : plus aucune image n\'est vérifiée ni mise à jour jusqu\'à la reprise ou au prochain déploiement.', confirmLabel: 'Mettre en pause' })
    if (!ok) return
  }
  try {
    emit('changed', await $fetch<TargetWatchtowerDto>(`/api/targets/${props.targetId}/watchtower/${action}`, { method: 'POST' }))
    toast.success(action === 'pause' ? 'Watchtower en pause' : 'Watchtower relancé')
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
}

const shortId = (id: string | null) => (id ? id.replace(/^sha256:/, '').slice(0, 12) : '—')
const KIND_TONE = { updated: 'info', available: 'neutral', failed: 'danger', external: 'warning' } as const
</script>

<template>
  <div class="wt">

    <p v-if="data.profile" class="muted small">Profil du serveur : <strong>{{ data.profile.name }}</strong><template v-if="data.serverLink"> · <NuxtLink :to="data.serverLink">voir les profils du serveur</NuxtLink></template></p>
    <p v-if="data.runtime?.state === 'missing'" class="alert danger">
      <template v-if="data.profile">Le Watchtower du profil « {{ data.profile.name }} » n'existe plus sur l'hôte : aucune image de ses projets n'est surveillée. <NuxtLink v-if="data.serverLink" :to="data.serverLink">Réappliquer le profil</NuxtLink></template>
      <template v-else>
        Watchtower est appliqué mais son conteneur n'existe plus sur l'hôte : aucune image n'est surveillée ni mise à jour.
        <UiButton v-if="canDeploy" size="sm" variant="primary" :disabled="busy" @click="emit('apply')">Recréer (redéployer)</UiButton>
      </template>
    </p>
    <p v-else-if="data.runtime?.state === 'stopped' && !data.pausedAt" class="alert warn">
      Le conteneur Watchtower est arrêté ({{ data.runtime.detail }}) sans pause demandée dans la console.
      <UiButton v-if="canDeploy" size="sm" @click="toggle('resume')">Relancer</UiButton>
    </p>
    <p v-else-if="data.runtime?.state === 'unknown'" class="muted small">État du conteneur Watchtower inconnu : {{ data.runtime.detail }}</p>
    <p v-if="data.pausedAt" class="alert warn">
      Watchtower est en pause depuis le {{ fmtDateTime(data.pausedAt) }} (échec d'une mise à jour ou pause manuelle).
      <UiButton v-if="canDeploy" size="sm" @click="toggle('resume')">Reprendre</UiButton>
    </p>
    <p v-if="data.pending" class="alert info">
      La configuration enregistrée n'est pas encore appliquée à la stack. Elle le sera au prochain déploiement, ou maintenant en redéployant la release active.
      <UiButton v-if="canDeploy" size="sm" variant="primary" :disabled="busy || dirty" @click="emit('apply')">Appliquer (redéployer)</UiButton>
    </p>

    <fieldset class="block" :disabled="!canEdit">
      <legend>Politique</legend>
      <UiSwitch v-model="form.enabled" label="Activer Watchtower pour cette cible" />
      <template v-if="form.enabled">
        <div class="modes" role="radiogroup" aria-label="Mode de mise à jour">
          <label v-for="m in MODES" :key="m" class="mode" :class="{ on: form.mode === m }">
            <input v-model="form.mode" type="radio" name="wt-mode" :value="m">
            <span :title="MODE_HELP[m]"><strong>{{ m === 'automatic' ? 'Mises à jour au rythme du profil' : MODE_LABEL[m] }}</strong><span class="muted help">{{ MODE_HELP[m] }}</span></span>
          </label>
        </div>
        <UiField label="Profil Watchtower du serveur" for="wt-profile" :error="errors.profileId" hint="Rythme, nettoyage et délai d'arrêt : communs aux projets du profil (un seul Watchtower par profil sur le serveur)">
          <div class="row">
            <select id="wt-profile" v-model="form.profileId" class="input input-sm">
              <option :value="null">Profil du serveur (créé au besoin, au rythme habituel)</option>
              <option v-for="p in data.profiles" :key="p.id" :value="p.id">{{ p.name }} — {{ p.summary }}</option>
            </select>
            <NuxtLink v-if="data.serverLink" :to="data.serverLink" class="small">Gérer les profils</NuxtLink>
          </div>
        </UiField>
      </template>
    </fieldset>

    <fieldset v-if="form.enabled" class="block" :disabled="!canEdit">
      <legend>Services</legend>
      <p v-if="!data.services.length" class="muted small">Aucune release active : les services apparaîtront après le premier déploiement.</p>
      <div v-else class="scroll">
      <table>
        <thead><tr><th>Service</th><th>Image exécutée</th><th>Politique</th></tr></thead>
        <tbody>
          <tr v-for="s in data.services" :key="s.service">
            <td><strong>{{ s.service }}</strong> <UiBadge v-if="s.drifted" tone="warning">image changée</UiBadge></td>
            <td class="mono small">{{ s.image }}</td>
            <td>
              <span v-if="s.built" class="muted small">Construit par la plateforme : redéployer depuis la source</span>
              <span v-else-if="s.pinned" class="muted small">Figé par empreinte : aucune mise à jour</span>
              <span v-else-if="form.mode === 'labels'" class="muted small">Selon les labels du Compose</span>
              <div v-else class="seg" role="radiogroup" :aria-label="`Politique de ${s.service}`">
                <button v-for="p in (['off', 'monitor', 'update'] as const)" :key="p" type="button" role="radio" :aria-checked="policyOf(s.service) === p" :class="{ on: policyOf(s.service) === p }" :disabled="form.mode === 'manual' && p === 'update'" @click="setPolicy(s.service, p)">
                  {{ p === 'off' ? 'Exclu' : p === 'monitor' ? 'Signaler' : 'Mettre à jour' }}
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      </div>
    </fieldset>

    <fieldset v-if="form.enabled" class="block" :disabled="!canEdit">
      <legend>Comportement</legend>
      <div class="row fields">
      <UiField label="Si une mise à jour échoue" for="wt-fail">
        <select id="wt-fail" v-model="form.onFailure" class="input input-sm short">
          <option value="pause">Exclure ce projet du Watchtower du profil (pause) et le signaler</option>
          <option value="notify">Le signaler seulement</option>
        </select>
      </UiField>
      </div>
      <label v-if="isGit && anyUpdate" class="ack">
        <input v-model="form.acknowledgeGitDrift" type="checkbox">
        <span>Je comprends que les images exécutées pourront différer du dépôt Git : le commit déployé ne suffira plus à reproduire l'état en cours.</span>
      </label>
      <p class="muted small">Le Watchtower du profil (un conteneur partagé du serveur, avec accès au socket Docker) n'agit que sur les services sélectionnés de ce projet, rattachés par labels. Une pause n'exclut que ce projet ; les autres projets du profil continuent.</p>
    </fieldset>

    <ul v-if="issues.length" class="issues">
      <li v-for="(i, k) in issues" :key="k">{{ i.message }}</li>
    </ul>

    <div v-if="canEdit" class="actions">
      <UiButton v-if="data.deployed && !data.pausedAt && canStop" size="sm" variant="ghost" @click="toggle('pause')">Mettre en pause</UiButton>
      <span class="spacer" />
      <UiButton v-if="dirty" size="sm" variant="ghost" @click="reset">Annuler</UiButton>
      <UiButton size="sm" variant="primary" :loading="saving" :disabled="!dirty" @click="save">Enregistrer</UiButton>
    </div>

    <section class="block">
      <h3>Historique des images</h3>
      <div v-if="data.updates.length" class="scroll">
      <table>
        <thead><tr><th>Date</th><th>Service</th><th>Évènement</th><th>Image</th><th>Avant → après</th><th>Release</th></tr></thead>
        <tbody>
          <tr v-for="u in data.updates" :key="u.id">
            <td class="small">{{ fmtDateTime(u.detectedAt) }}</td>
            <td>{{ u.service }}</td>
            <td><UiBadge :tone="KIND_TONE[u.kind]">{{ UPDATE_KIND_LABEL[u.kind] }}</UiBadge><div v-if="u.kind === 'failed' && u.detail" class="small err">{{ u.detail }}</div></td>
            <td class="mono small">{{ u.image }}<div v-if="u.digest" class="muted">{{ u.digest.split('@')[1]?.slice(0, 19) }}</div></td>
            <td class="mono small">{{ shortId(u.fromImageId) }} → {{ shortId(u.toImageId) }}</td>
            <td class="small">{{ u.releaseNumber ? `#${u.releaseNumber}` : '—' }}</td>
          </tr>
        </tbody>
      </table>
      </div>
      <p v-else class="muted small">Aucun changement d'image en dehors des déploiements.</p>
    </section>
  </div>
</template>

<style scoped>
.wt { display: flex; flex-direction: column; gap: var(--space-3); }
.block { border: 1px solid var(--border); border-radius: var(--radius-lg); padding: var(--space-2) var(--space-3) var(--space-3); margin: 0; display: flex; flex-direction: column; gap: var(--space-2); min-width: 0; }
legend, h3 { font-weight: 600; font-size: 14px; padding: 0 4px; margin: 0; }
.modes { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: var(--space-2); }
.mode { display: flex; gap: var(--space-2); align-items: flex-start; padding: 6px var(--space-2); border: 1px solid var(--border); border-radius: var(--radius); cursor: pointer; }
.mode.on { border-color: var(--primary); box-shadow: 0 0 0 1px var(--primary); }
.mode > span { display: flex; flex-direction: column; gap: 2px; font-size: 13px; }
.mode .muted { font-size: 11.5px; }
/* Description sur deux lignes au plus (texte complet en info-bulle). */
.help { display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.fields { align-items: flex-start; gap: var(--space-3); }
.row { display: flex; gap: var(--space-2); flex-wrap: wrap; align-items: center; }
.cron { max-width: 200px; }
.short { max-width: 340px; }
.num { max-width: 120px; }
table { width: 100%; border-collapse: collapse; }
th { text-align: left; font-size: 11px; text-transform: uppercase; color: var(--text-muted); padding: 3px 6px; border-bottom: 1px solid var(--border); }
td { padding: 3px 6px; border-bottom: 1px solid var(--border); vertical-align: middle; overflow-wrap: anywhere; }
.small { font-size: 12.5px; margin: 0; }
.err { color: var(--danger); }
.scroll { overflow-x: auto; }
.seg { display: inline-flex; white-space: nowrap; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
.seg button { all: unset; padding: 2px 9px; font-size: 12px; cursor: pointer; }
.seg button + button { border-left: 1px solid var(--border); }
.seg button.on { background: var(--primary); color: var(--primary-contrast, #fff); }
.seg button:disabled { opacity: .4; cursor: not-allowed; }
.seg button:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
.ack { display: flex; gap: var(--space-2); align-items: flex-start; font-size: 13px; padding: var(--space-3); border-radius: var(--radius); background: var(--warning-bg); }
.alert { margin: 0; padding: var(--space-3) var(--space-4); border-radius: var(--radius); display: flex; gap: var(--space-3); align-items: center; flex-wrap: wrap; }
.alert.info { background: var(--info-bg); color: var(--info); }
.alert.warn { background: var(--warning-bg); color: var(--warning); }
.alert.danger { background: var(--danger-bg); color: var(--danger); }
.issues { margin: 0; padding: var(--space-3) var(--space-5); border-radius: var(--radius); background: var(--danger-bg); color: var(--danger); font-size: 13px; }
.actions { display: flex; gap: var(--space-2); align-items: center; }
.spacer { flex: 1; }
</style>
