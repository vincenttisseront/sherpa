<script setup lang="ts">
/**
 * Profils Watchtower d'un serveur : un conteneur Watchtower par profil, partagé par les projets
 * qui le choisissent (rythme, nettoyage, délai d'arrêt), avec son état réel sur l'hôte.
 */
import type { WatchtowerProfileDto, WatchtowerProfileInput } from '#shared/schemas/watchtower'

const props = defineProps<{ endpointId: string, canManage: boolean }>()
const toast = useToast()
const confirm = useConfirm()
const { data, error, refresh } = useFetch<WatchtowerProfileDto[]>(() => `/api/endpoints/${props.endpointId}/watchtower-profiles`, { server: false, lazy: true })

const INTERVALS = [{ v: 900, l: '15 minutes' }, { v: 3600, l: '1 heure' }, { v: 6 * 3600, l: '6 heures' }, { v: 86_400, l: '24 heures' }, { v: 7 * 86_400, l: '7 jours' }]
const SCHEDULES = [{ v: '0 0 4 * * *', l: 'Chaque nuit à 4 h' }, { v: '0 0 4 * * 1-5', l: 'Jours ouvrés à 4 h' }, { v: '0 0 3 * * 0', l: 'Dimanche à 3 h' }]
const STATE = { running: { tone: 'success', label: 'en service' }, stopped: { tone: 'warning', label: 'arrêté' }, missing: { tone: 'danger', label: 'absent' }, unknown: { tone: 'neutral', label: 'inconnu' } } as const
const rythm = (p: WatchtowerProfileInput) => p.timing === 'schedule' ? `Planifié (${p.schedule})` : INTERVALS.find(i => i.v === p.intervalSec)?.l ? `Toutes les ${INTERVALS.find(i => i.v === p.intervalSec)!.l}` : `Toutes les ${Math.round(p.intervalSec / 60)} min`

// --- Édition ---
const editing = ref<{ id: string | null, form: WatchtowerProfileInput } | null>(null)
const editOpen = computed({ get: () => !!editing.value, set: (v) => { if (!v) editing.value = null } })
const errors = ref<Record<string, string>>({})
const busy = ref<string | null>(null)
const blank = (): WatchtowerProfileInput => ({ name: '', timing: 'interval', intervalSec: 86_400, schedule: '0 0 4 * * *', cleanup: true, stopTimeoutSec: 30, registries: [] })
// Mots de passe : jamais renvoyés ; vide en modification = inchangé.
const savedRegistries = ref<string[]>([])
function edit(p?: WatchtowerProfileDto) {
  errors.value = {}
  savedRegistries.value = p?.registries.map(r => `${r.registry}|${r.username}`) ?? []
  editing.value = p
    ? { id: p.id, form: { name: p.name, timing: p.timing, intervalSec: p.intervalSec, schedule: p.schedule, cleanup: p.cleanup, stopTimeoutSec: p.stopTimeoutSec, registries: p.registries.map(r => ({ registry: r.registry, username: r.username, password: '' })) } }
    : { id: null, form: blank() }
}
async function save() {
  const e = editing.value!
  busy.value = 'save'
  errors.value = {}
  try {
    const body = { ...e.form, registries: e.form.registries.map(r => ({ registry: r.registry, username: r.username, ...(r.password ? { password: r.password } : {}) })) }
    const saved = e.id
      ? await $fetch<WatchtowerProfileDto>(`/api/watchtower-profiles/${e.id}`, { method: 'PUT', body })
      : await $fetch<WatchtowerProfileDto>(`/api/endpoints/${props.endpointId}/watchtower-profiles`, { method: 'POST', body })
    editing.value = null
    toast.success(saved.pending && saved.appliedAt ? 'Profil enregistré : à appliquer' : 'Profil enregistré')
    await refresh()
  }
  catch (err) {
    const x = apiError(err)
    errors.value = x.errors
    toast.error(x.message)
  }
  finally {
    busy.value = null
  }
}
async function apply(p: WatchtowerProfileDto) {
  busy.value = p.id
  try {
    await $fetch(`/api/watchtower-profiles/${p.id}/apply`, { method: 'POST' })
    toast.success(`Watchtower du profil « ${p.name} » appliqué`)
    await refresh()
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    busy.value = null
  }
}
async function remove(p: WatchtowerProfileDto) {
  if (!await confirm({ title: `Supprimer le profil « ${p.name} »`, message: 'Son conteneur Watchtower est retiré de l\'hôte.', confirmLabel: 'Supprimer', danger: true })) return
  busy.value = p.id
  try {
    await $fetch(`/api/watchtower-profiles/${p.id}`, { method: 'DELETE' })
    toast.success('Profil supprimé')
    await refresh()
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    busy.value = null
  }
}
</script>

<template>
  <div class="wp">
    <div class="bar">
      <p class="muted small">Un conteneur Watchtower par profil, partagé par les projets du serveur qui le choisissent (onglet Watchtower du projet). Les projets y sont rattachés par labels ; une pause n'exclut que le projet concerné.</p>
      <span class="spacer" />
      <UiButton v-if="canManage" size="sm" variant="primary" @click="edit()">Nouveau profil</UiButton>
    </div>
    <p v-if="error" class="alert">{{ apiError(error).message }}</p>
    <p v-else-if="!data" class="muted small">Lecture des profils…</p>
    <p v-else-if="!data.length" class="muted small">Aucun profil : le premier est créé automatiquement quand un projet de ce serveur active Watchtower.</p>
    <div v-else class="list">
      <article v-for="p in data" :key="p.id" class="card pad profile">
        <header>
          <strong>{{ p.name }}</strong>
          <UiBadge :tone="STATE[p.runtime.state].tone" :title="p.runtime.detail ?? ''">{{ STATE[p.runtime.state].label }}</UiBadge>
          <UiBadge v-if="p.pending && p.appliedAt" tone="warning">à appliquer</UiBadge>
          <span class="spacer" />
          <template v-if="canManage">
            <UiButton size="sm" :variant="p.pending || p.runtime.state !== 'running' ? 'primary' : 'ghost'" :loading="busy === p.id" @click="apply(p)">{{ p.appliedAt ? 'Appliquer' : 'Déployer' }}</UiButton>
            <UiButton size="sm" variant="ghost" @click="edit(p)">Modifier</UiButton>
            <UiButton size="sm" variant="ghost" :disabled="p.projects.length > 0" :title="p.projects.length ? 'Utilisé par des projets' : ''" @click="remove(p)">Supprimer</UiButton>
          </template>
        </header>
        <dl class="kv small">
          <dt>Rythme</dt><dd>{{ rythm(p) }}</dd>
          <dt>Réglages</dt><dd>{{ p.cleanup ? 'anciennes images supprimées' : 'anciennes images conservées' }} · arrêt en {{ p.stopTimeoutSec }} s</dd>
          <dt>Périmètre</dt><dd class="mono">{{ p.scope }}</dd>
          <dt>Image</dt><dd class="mono">{{ p.image ?? '—' }}</dd>
          <dt>Projets</dt>
          <dd>
            <span v-if="!p.projects.length" class="muted">aucun</span>
            <span v-for="x in p.projects" :key="x.targetId" class="proj">{{ x.project }} ({{ x.environment }})<UiBadge v-if="x.paused" tone="warning">en pause</UiBadge></span>
          </dd>
          <template v-if="p.excluded.length"><dt>Exclus</dt><dd class="mono">{{ p.excluded.join(', ') }}</dd></template>
          <dt>Registres</dt><dd><span v-if="!p.registries.length" class="muted">publics seulement</span><span v-for="r in p.registries" :key="r.registry" class="proj mono">{{ r.registry }} ({{ r.username }})</span></dd>
        </dl>
      </article>
    </div>

    <UiModal v-model:open="editOpen" :title="editing?.id ? 'Modifier le profil' : 'Nouveau profil Watchtower'" width="720px">
      <div v-if="editing" class="form">
        <UiField label="Nom" for="wp-name" :error="errors.name" required>
          <input id="wp-name" v-model.trim="editing.form.name" class="input" placeholder="Nuit (4 h)">
        </UiField>
        <div class="seg" role="radiogroup" aria-label="Rythme">
          <button type="button" role="radio" :aria-checked="editing.form.timing === 'interval'" :class="{ on: editing.form.timing === 'interval' }" @click="editing.form.timing = 'interval'">Intervalle</button>
          <button type="button" role="radio" :aria-checked="editing.form.timing === 'schedule'" :class="{ on: editing.form.timing === 'schedule' }" @click="editing.form.timing = 'schedule'">Planification</button>
        </div>
        <UiField v-if="editing.form.timing === 'interval'" label="Vérification toutes les" for="wp-int" :error="errors.intervalSec">
          <select id="wp-int" v-model.number="editing.form.intervalSec" class="input input-sm">
            <option v-for="i in INTERVALS" :key="i.v" :value="i.v">{{ i.l }}</option>
          </select>
        </UiField>
        <UiField v-else label="Planification (cron, 6 champs)" for="wp-cron" :error="errors.schedule" hint="secondes minutes heures jour mois jour-de-semaine">
          <input id="wp-cron" v-model.trim="editing.form.schedule" class="input input-sm mono">
          <div class="presets"><UiButton v-for="s in SCHEDULES" :key="s.v" size="sm" variant="ghost" @click="editing!.form.schedule = s.v">{{ s.l }}</UiButton></div>
        </UiField>
        <UiSwitch v-model="editing.form.cleanup" label="Supprimer l'ancienne image après une mise à jour" />
        <UiField label="Délai d'arrêt d'un conteneur (secondes)" for="wp-stop" :error="errors.stopTimeoutSec">
          <input id="wp-stop" v-model.number="editing.form.stopTimeoutSec" class="input input-sm" type="number" min="5" max="600">
        </UiField>
        <fieldset class="regs">
          <legend>Registres privés</legend>
          <p class="muted small">Identifiants utilisés par Watchtower pour vérifier et récupérer les images de ces registres seulement (config.json Docker, une entrée par registre). Mots de passe chiffrés, jamais réaffichés.</p>
          <div v-for="(r, i) in editing.form.registries" :key="i" class="reg">
            <UiField :label="i ? '' : 'Registre'" :for="`wp-reg-${i}`" :error="errors[`registries.${i}.registry`]">
              <input :id="`wp-reg-${i}`" v-model.trim="r.registry" class="input input-sm mono" placeholder="harbor.example.com">
            </UiField>
            <UiField :label="i ? '' : 'Utilisateur'" :for="`wp-user-${i}`">
              <input :id="`wp-user-${i}`" v-model.trim="r.username" class="input input-sm" autocomplete="off">
            </UiField>
            <UiField :label="i ? '' : 'Mot de passe ou jeton'" :for="`wp-pass-${i}`" :error="errors[`registries.${i}.password`]">
              <input :id="`wp-pass-${i}`" v-model="r.password" class="input input-sm" type="password" autocomplete="new-password" :placeholder="savedRegistries.includes(`${r.registry}|${r.username}`) ? 'inchangé' : ''">
            </UiField>
            <UiButton size="sm" variant="ghost" :aria-label="`Retirer ${r.registry || 'le registre'}`" @click="editing!.form.registries.splice(i, 1)">Retirer</UiButton>
          </div>
          <UiButton size="sm" variant="ghost" :disabled="editing.form.registries.length >= 20" @click="editing!.form.registries.push({ registry: '', username: '', password: '' })">Ajouter un registre</UiButton>
        </fieldset>
        <p v-if="editing.id" class="muted small">Les changements s'appliquent au conteneur du profil (bouton Appliquer), sans redéployer les projets.</p>
      </div>
      <template #footer>
        <UiButton variant="ghost" @click="editing = null">Annuler</UiButton>
        <UiButton variant="primary" :loading="busy === 'save'" :disabled="!editing?.form.name" @click="save">Enregistrer</UiButton>
      </template>
    </UiModal>
  </div>
</template>

<style scoped>
.wp { display: flex; flex-direction: column; gap: var(--space-3); }
.bar { display: flex; align-items: flex-start; gap: var(--space-2); }
.spacer { flex: 1; }
.list { display: flex; flex-direction: column; gap: var(--space-2); }
.profile header { display: flex; align-items: center; gap: var(--space-2); margin-bottom: var(--space-2); }
.kv { display: grid; grid-template-columns: 100px 1fr; gap: 4px 12px; margin: 0; }
.kv dt { color: var(--text-muted); }
.kv dd { margin: 0; overflow-wrap: anywhere; }
.proj { margin-right: 10px; display: inline-flex; gap: 4px; align-items: center; }
.form { display: flex; flex-direction: column; gap: var(--space-3); }
.regs { border: 1px solid var(--border); border-radius: var(--radius); padding: var(--space-2) var(--space-3); display: flex; flex-direction: column; gap: var(--space-2); }
.regs legend { font-size: 12.5px; font-weight: 600; padding: 0 4px; }
.reg { display: grid; grid-template-columns: 1.4fr 1fr 1fr auto; gap: var(--space-2); align-items: end; }
@media (max-width: 640px) { .reg { grid-template-columns: 1fr; } }
.presets { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 4px; }
.seg { display: inline-flex; padding: 3px; background: var(--surface-3); border-radius: calc(var(--radius) + 2px); gap: 2px; align-self: flex-start; }
.seg button { all: unset; cursor: pointer; padding: 4px 12px; border-radius: var(--radius); font-size: 12.5px; font-weight: 550; color: var(--text-muted); }
.seg button.on { background: var(--surface); color: var(--text); box-shadow: var(--shadow); }
.small { font-size: 12.5px; }
p { margin: 0; }
.alert { padding: var(--space-2) var(--space-3); border-radius: var(--radius); background: var(--danger-bg); color: var(--danger); }
</style>
