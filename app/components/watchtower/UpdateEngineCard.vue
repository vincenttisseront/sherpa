<script setup lang="ts">
/**
 * Moteur de mise à jour des images (sidecar Watchtower) : image en service,
 * version publiée, choix d'une image maintenue (figée par empreinte), bascule des
 * cibles et nettoyage des anciens Watchtower trouvés sur les hôtes.
 */
import { ExternalLink, RefreshCw, ShieldCheck, Trash2, TriangleAlert } from 'lucide-vue-next'
import { type LegacyWatchtowerItem, UPDATE_ENGINE_CATALOG, type UpdateEngineDto } from '#shared/schemas/update-engine'
/** Le composant porte l'en-tête de la page : moteur en service sur la ligne du titre. */
defineProps<{ title: string, icon?: string }>()

const { hasAny } = useAuth()
const toast = useToast()
const confirm = useConfirm()
const { data: engine, refresh, status } = await useFetch<UpdateEngineDto>('/api/update-engine', { server: false })
const canSet = computed(() => hasAny('policy:manage'))
const canApply = computed(() => hasAny('deployment:execute'))
const canClean = computed(() => hasAny('server:manage'))
// Lecture côté navigateur : états de chargement seulement après l'hydratation (rendu serveur identique).
const mounted = ref(false)
onMounted(() => { mounted.value = true })

const maintained = UPDATE_ENGINE_CATALOG.filter(c => c.status === 'maintained')
const editing = ref(false)
const form = reactive({ repository: maintained[0]!.repository, tag: '' })
const busy = ref<string | null>(null)
const formError = ref<string | null>(null)
function openEdit() {
  form.repository = maintained.some(m => m.repository === engine.value?.repository) ? engine.value!.repository : maintained[0]!.repository
  form.tag = engine.value?.latest ?? engine.value?.tag ?? ''
  formError.value = null
  editing.value = true
}

async function pin(repository: string, tag: string) {
  busy.value = 'pin'
  formError.value = null
  try {
    engine.value = await $fetch<UpdateEngineDto>('/api/update-engine', { method: 'PUT', body: { repository, tag } })
    editing.value = false
    toast.success(`Moteur de mise à jour : ${repository}:${tag}, figé par empreinte`)
  }
  catch (err) {
    formError.value = apiError(err).message
  }
  finally {
    busy.value = null
  }
}

async function applyAll() {
  const n = engine.value?.outdated.length ?? 0
  const np = engine.value?.outdatedProfiles.length ?? 0
  if (!await confirm({ title: 'Basculer sur la nouvelle image', message: `${np ? `${np} profil${np > 1 ? 's' : ''} Watchtower ${np > 1 ? 'sont réappliqués' : 'est réappliqué'} (un conteneur par profil, sans redéployer les projets). ` : ''}${n ? `${n} cible${n > 1 ? 's' : ''} encore sur l'ancien Watchtower par projet ${n > 1 ? 'sont redéployées' : 'est redéployée'} : ${n > 1 ? 'elles passent' : 'elle passe'} sur un profil du serveur.` : ''}`, confirmLabel: 'Appliquer' })) return
  busy.value = 'apply'
  try {
    const r = await $fetch<{ started: { deploymentId: string }[], skipped: { reason: string }[], profiles: { error: string | null }[] }>('/api/update-engine/apply', { method: 'POST' })
    const pf = r.profiles.filter(p => p.error)
    toast.success(`${r.profiles.length - pf.length} profil(s) réappliqué(s) · ${r.started.length} redéploiement${r.started.length > 1 ? 's' : ''} lancé${r.started.length > 1 ? 's' : ''}${r.skipped.length || pf.length ? ` · ${r.skipped.length + pf.length} ignoré(s) : ${(r.skipped[0]?.reason ?? pf[0]?.error)}` : ''}`)
    await refresh()
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    busy.value = null
  }
}

// Anciens Watchtower sur les hôtes.
const legacy = ref<LegacyWatchtowerItem[] | null>(null)
const picked = ref<string[]>([])
async function scan() {
  busy.value = 'scan'
  try {
    legacy.value = await $fetch<LegacyWatchtowerItem[]>('/api/update-engine/legacy')
    picked.value = legacy.value.filter(i => i.removable).map(i => i.id)
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    busy.value = null
  }
}
async function cleanup() {
  const items = legacy.value!.filter(i => picked.value.includes(i.id))
  if (!await confirm({ title: 'Supprimer les anciens Watchtower', message: `${items.length} élément(s) : ${items.map(i => `${i.kind === 'container' ? 'conteneur' : 'image'} ${i.name} (${i.server})`).join(', ')}. Chaque élément est revérifié sur l'hôte avant suppression.`, confirmLabel: 'Supprimer', danger: true })) return
  busy.value = 'clean'
  try {
    const r = await $fetch<{ removed: string[], refused: { reason: string }[] }>('/api/update-engine/legacy', { method: 'POST', body: { ids: items.map(i => i.id) } })
    toast.success(`${r.removed.length} supprimé(s)${r.refused.length ? ` · ${r.refused.length} refusé(s) : ${r.refused[0]!.reason}` : ''}`)
    await scan()
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    busy.value = null
  }
}
const newer = computed(() => !!engine.value?.latest && engine.value.latest.replace(/^v/, '') !== engine.value.tag.replace(/^v/, ''))
/** Passage de version : même dépôt s'il est maintenu, sinon le fork maintenu. */
const upgradeRepository = computed(() => (maintained.some(m => m.repository === engine.value?.repository) ? engine.value!.repository : maintained[0]!.repository))
</script>

<template>
  <!-- En-tête de la page : moteur en service sur la ligne du titre, actions à droite. -->
  <UiPageHeader :title="title" :icon="icon">
    <template #nav>
      <div class="summary">
        <span class="lbl" title="Moteur de mise à jour des images (Watchtower)"><ShieldCheck :size="14" /> Moteur</span>
        <template v-if="engine">
          <code>{{ engine.repository }}:{{ engine.tag }}</code>
          <UiBadge :tone="engine.catalog.status === 'maintained' ? 'success' : 'danger'" :title="engine.catalog.maintainer">{{ engine.catalog.status === 'maintained' ? 'maintenu' : 'archivé' }}</UiBadge>
          <a v-if="engine.catalog.source" :href="engine.catalog.source" target="_blank" rel="noopener noreferrer" class="src" :title="`Projet source : ${engine.catalog.maintainer}`" aria-label="Projet source"><ExternalLink :size="12" /></a>
          <span v-if="engine.digest" class="muted small" :title="`Figée par empreinte : ${engine.digest} — le ${fmtDateTime(engine.pinnedAt)} par ${engine.pinnedBy}`">figée</span>
          <span v-else class="warn-text small">non figée : choisir une version</span>
          <UiBadge v-if="engine.latest && newer" tone="info">{{ engine.latest }} disponible</UiBadge>
          <span v-else-if="!engine.latest" class="muted small" :title="engine.latestError ?? ''">versions indisponibles</span>
          <span v-if="!engine.outdated.length && !engine.outdatedProfiles.length" class="ok-text small" :title="engine.latest && !newer ? 'Dernière version publiée, en service sur toutes les cibles' : 'Toutes les cibles utilisent cette image'">cibles à jour</span>
        </template>
        <span v-else-if="mounted && status === 'pending'" class="muted small">lecture…</span>
      </div>
    </template>
    <UiButton v-if="canSet && newer && engine" size="sm" variant="primary" :loading="busy === 'pin'" @click="pin(upgradeRepository, engine.latest!)">Passer en {{ engine.latest }}</UiButton>
    <UiButton size="sm" variant="ghost" :loading="busy === 'scan'" title="Conteneurs et images Watchtower d'une autre image que celle en service" @click="scan"><RefreshCw :size="13" /> Anciens Watchtower</UiButton>
    <UiButton v-if="canSet && !editing" size="sm" @click="openEdit">Changer</UiButton>
  </UiPageHeader>

  <!-- Panneaux seulement s'il y a quelque chose à faire ou à voir. -->
  <section v-if="engine && (engine.envRetired || editing || engine.outdated.length || engine.outdatedProfiles.length || legacy)" class="card pad engine">
    <template v-if="engine">
      <p v-if="engine.envRetired" class="alert alert--warning small"><TriangleAlert :size="13" /> WATCHTOWER_IMAGE pointe vers <code>{{ engine.envRetired }}</code>, projet archivé : ignorée au profit de l'image ci-dessus.</p>

      <form v-if="editing" class="edit" @submit.prevent="pin(form.repository, form.tag)">
        <UiField label="Dépôt (projets maintenus)" for="ue-repo">
          <select id="ue-repo" v-model="form.repository" class="input input-sm">
            <option v-for="m in maintained" :key="m.repository" :value="m.repository">{{ m.repository }} — {{ m.maintainer }}</option>
          </select>
        </UiField>
        <UiField label="Version" for="ue-tag" :error="formError" hint="Vérifiée dans le registre puis figée par empreinte">
          <input id="ue-tag" v-model.trim="form.tag" class="input input-sm mono" placeholder="1.23.0">
        </UiField>
        <div class="row">
          <UiButton size="sm" @click="editing = false">Annuler</UiButton>
          <UiButton type="submit" size="sm" variant="primary" :loading="busy === 'pin'" :disabled="!form.tag">Vérifier et figer</UiButton>
        </div>
        <p class="muted small">Refusés : {{ UPDATE_ENGINE_CATALOG.filter(c => c.status === 'archived').map(c => c.repository).join(', ') }} (projet archivé le 17/12/2025, incompatible avec Docker 29).</p>
      </form>

      <div v-if="engine.outdated.length || engine.outdatedProfiles.length" class="block">
        <div class="head">
          <h3>Bascule sur la nouvelle image</h3>
          <UiButton v-if="canApply" size="sm" variant="primary" :loading="busy === 'apply'" @click="applyAll">Appliquer</UiButton>
        </div>
        <ul v-if="engine.outdatedProfiles.length" class="list small">
          <li v-for="o in engine.outdatedProfiles" :key="o.profileId">
            Profil « {{ o.name }} » · {{ o.server }} / {{ o.endpoint }}
            <span class="muted"> · en place : <code>{{ o.appliedImage ?? 'inconnue' }}</code></span>
          </li>
        </ul>
        <ul class="list small">
          <li v-for="o in engine.outdated" :key="o.targetId">
            <NuxtLink :to="`/projects/${o.projectId}?tab=watchtower`">{{ o.project }} ({{ o.environment }})</NuxtLink>
            <span class="muted"> · en place : <code>{{ o.appliedImage ?? 'inconnue' }}</code></span>
          </li>
        </ul>
      </div>

      <div v-if="legacy" class="block">
        <div class="head">
          <h3>Anciens Watchtower sur les hôtes</h3>
          <span v-if="!legacy.length" class="muted small">aucun : seule l'image en service tourne sur les hôtes</span>
          <span class="spacer" />
          <UiButton size="sm" variant="ghost" @click="legacy = null">Masquer</UiButton>
        </div>
        <template v-if="legacy.length">
          <table class="tbl small">
            <thead><tr><th /><th>Hôte</th><th>Élément</th><th>Image</th><th>État</th></tr></thead>
            <tbody>
              <tr v-for="i in legacy" :key="i.id + i.endpointId">
                <td><input v-if="i.removable && canClean" v-model="picked" type="checkbox" :value="i.id" :aria-label="`Sélectionner ${i.name}`"></td>
                <td>{{ i.server }}</td>
                <td>{{ i.kind === 'container' ? 'conteneur' : 'image' }} <span class="mono">{{ i.name }}</span></td>
                <td class="mono">{{ i.image }}</td>
                <td :class="i.removable ? '' : 'muted'">{{ i.reason }}</td>
              </tr>
            </tbody>
          </table>
          <UiButton v-if="canClean && picked.length" size="sm" variant="danger" class="self-start" :loading="busy === 'clean'" @click="cleanup"><Trash2 :size="13" /> Supprimer {{ picked.length }} élément{{ picked.length > 1 ? 's' : '' }}</UiButton>
        </template>
      </div>
    </template>
  </section>
</template>

<style scoped>
.engine { display: flex; flex-direction: column; gap: var(--space-2); margin-bottom: var(--space-3); padding: var(--space-3) var(--space-4); }
.head { display: flex; align-items: center; gap: 6px var(--space-2); flex-wrap: wrap; }
.spacer { flex: 1; }
.summary { display: flex; align-items: center; gap: 4px var(--space-2); flex-wrap: wrap; min-width: 0; padding: 3px 10px; border: 1px solid var(--border); border-radius: 999px; background: var(--surface); font-size: 13px; }
.summary code { font-size: 12px; }
.lbl { display: inline-flex; gap: 4px; align-items: center; font-weight: 600; }
.ok-text { color: var(--success); }
h2 { margin: 0; font-size: 16px; display: flex; gap: 6px; align-items: center; }
h3 { margin: 0; font-size: 14px; }
.small { font-size: 12.5px; }
.src { display: inline-flex; vertical-align: middle; }
/* Choix du moteur sur une ligne : dépôt, version, actions. */
.edit { display: grid; grid-template-columns: minmax(0, 1fr) 160px auto; gap: var(--space-2) var(--space-3); align-items: start; }
.edit .row { display: flex; gap: var(--space-2); align-self: center; padding-top: 18px; }
.edit p { grid-column: 1 / -1; margin: 0; }
.block { display: flex; flex-direction: column; gap: 6px; padding-top: var(--space-2); border-top: 1px solid var(--border); }
.engine > .block:first-child { border-top: 0; padding-top: 0; }
.list { margin: 0; padding-left: 18px; }
.tbl { width: 100%; border-collapse: collapse; }
.tbl th { text-align: left; font-weight: 500; color: var(--text-muted); padding: 4px 8px 4px 0; border-bottom: 1px solid var(--border); }
.tbl td { padding: 5px 8px 5px 0; border-bottom: 1px solid var(--border); vertical-align: top; }
.warn-text { color: var(--warning); }
.self-start { align-self: flex-start; }
@media (max-width: 640px) {
  .edit { grid-template-columns: 1fr; }
  .edit .row { padding-top: 0; }
  .summary { border-radius: var(--radius); }
}
</style>
