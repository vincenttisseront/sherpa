<script setup lang="ts">
/**
 * Mise à niveau des images d'une cible : version cible par service (compatible ou
 * majeure), services liés ensemble, build propre ; redéploiement avec retour
 * automatique aux images précédentes en cas d'échec. Compose source mis à niveau
 * à reporter dans le dépôt ou l'archive.
 */
import type { ImageUpgradePlan, ServiceUpgrade } from '#shared/schemas/image-upgrade'
import { Copy, Download, RefreshCw, TriangleAlert } from 'lucide-vue-next'

const props = defineProps<{ targetId: string, projectSlug: string, isProduction: boolean }>()
const open = defineModel<boolean>('open', { required: true })
const toast = useToast()
const confirm = useConfirm()

const refreshing = ref(false)
const { data: plan, error, status, refresh } = useFetch<ImageUpgradePlan>(() => `/api/targets/${props.targetId}/upgrade`, { server: false, lazy: true, query: computed(() => ({ refresh: refreshing.value ? '1' : undefined })) })
async function reload() {
  refreshing.value = true
  await refresh()
  refreshing.value = false
}

// Version choisie par service ('' : garder) ; un service lié suit le choix de son groupe.
const choice = reactive<Record<string, string>>({})
/** Valeur du choix « revenir à la version du Compose ». */
const RESET = '__reset__'
const cleanBuild = ref(false)
const confirmMajorData = ref(false)
// Sauvegarde à froid des volumes des services à données, proposée par défaut.
const backup = ref(true)
// Services à données, et versions figées (saut de version inconnu) : sauvegarde proposée.
const isPinned = (s: ServiceUpgrade) => !!s.pin && choice[s.service] === s.pin.tag
const statefulTouched = computed(() => [...selected.value, ...resets.value].filter(s => s.stateful || isPinned(s)))
// Migration PostgreSQL d'un service (fenêtre dédiée), suivie dans son déploiement.
const migrating = ref<string | null>(null)
// Ancien cluster PostgreSQL à supprimer après validation.
const cleaning = ref<ServiceUpgrade | null>(null)
const cleanOpen = computed({ get: () => !!cleaning.value, set: (v) => { if (!v) cleaning.value = null } })
const migrateOpen = computed({ get: () => !!migrating.value, set: (v) => { if (!v) migrating.value = null } })
async function migrationStarted(deploymentId: string) {
  open.value = false
  await navigateTo(`/deployments/${deploymentId}`)
}
watch(plan, (p) => {
  for (const s of p?.services ?? []) if (!(s.service in choice)) choice[s.service] = ''
}, { immediate: true })
function choose(s: ServiceUpgrade, tag: string) {
  choice[s.service] = tag
  for (const l of s.linked ?? []) choice[l] = tag
}
const KIND: Record<ServiceUpgrade['kind'], string> = { version: '', digest: 'figée par empreinte', floating: 'tag sans version', build: 'construite', local: 'image locale', unknown: '' }
const ORIGIN: Record<ServiceUpgrade['origin'], string> = { literal: 'Compose', variable: 'variable', anchor: 'ancre YAML', build: 'build', unknown: '—' }

const selected = computed(() => (plan.value?.services ?? []).filter(s => choice[s.service] && choice[s.service] !== RESET))
const resets = computed(() => (plan.value?.services ?? []).filter(s => choice[s.service] === RESET))
const majorData = computed(() => selected.value.filter(s => s.stateful && (s.major?.tag === choice[s.service] || isPinned(s))))
const majors = computed(() => selected.value.filter(s => s.major?.tag === choice[s.service] || isPinned(s)))
const republished = computed(() => (plan.value?.services ?? []).filter(s => s.sameTagUpdate && !choice[s.service]))
const canApply = computed(() => (selected.value.length > 0 || resets.value.length > 0 || republished.value.length > 0 || cleanBuild.value) && (!majorData.value.length || confirmMajorData.value))

const busy = ref(false)
async function apply() {
  const summary = [
    ...selected.value.filter(s => !(plan.value!.services.find(x => (x.linked ?? []).includes(s.service) && choice[x.service] === choice[s.service] && x.service < s.service))).map(s => `${s.service}${s.linked?.length ? ` (+ ${s.linked.join(', ')})` : ''} : ${s.tag} → ${choice[s.service]}`),
    ...resets.value.map(s => `${s.service} : retour à ${s.override!.from}`),
    ...(republished.value.length ? [`Nouvelles publications récupérées : ${republished.value.map(s => s.service).join(', ')}`] : []),
    ...(cleanBuild.value ? ['Build propre des services construits'] : []),
  ]
  if (!await confirm({
    title: 'Mettre à niveau et redéployer',
    message: `${summary.join('\n')}\n\nSi le déploiement ou les healthchecks échouent, les images précédentes sont rétablies automatiquement.`,
    confirmLabel: 'Mettre à niveau',
    danger: majors.value.length > 0 || props.isProduction,
    requireText: props.isProduction ? props.projectSlug : undefined,
  })) return
  busy.value = true
  try {
    const r = await $fetch<{ deploymentId: string }>(`/api/targets/${props.targetId}/upgrade`, {
      method: 'POST',
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      body: { services: selected.value.map(s => ({ service: s.service, tag: choice[s.service] })), reset: resets.value.map(s => s.service), refresh: true, cleanBuild: cleanBuild.value, confirmMajorData: confirmMajorData.value, backup: backup.value },
    })
    open.value = false
    await navigateTo(`/deployments/${r.deploymentId}`)
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    busy.value = false
  }
}

// Compose source mis à niveau (à reporter dans la source).
const patched = ref<{ composePath: string, composeText: string, changed: string[], manual: { service: string, reason: string }[] } | null>(null)
async function showPatched() {
  patched.value = await $fetch(`/api/targets/${props.targetId}/upgrade-compose`)
}
async function copyPatched() {
  await navigator.clipboard.writeText(patched.value!.composeText)
  toast.success('Compose copié')
}
function downloadPatched() {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([patched.value!.composeText], { type: 'text/yaml' }))
  a.download = patched.value!.composePath.split('/').pop() || 'compose.yml'
  a.click()
  URL.revokeObjectURL(a.href)
}
</script>

<template>
  <UiModal v-model:open="open" title="Mises à niveau des images" width="980px">
    <div class="up">
      <div class="bar">
        <span v-if="plan" class="muted small">Release #{{ plan.releaseNumber }} · versions lues à {{ fmtTime(plan.checkedAt) }}</span>
        <span class="spacer" />
        <UiButton size="sm" variant="ghost" :loading="status === 'pending'" title="Interroger de nouveau les registres" @click="reload"><RefreshCw :size="13" /> Relire</UiButton>
      </div>
      <p v-if="error" class="alert">{{ apiError(error).message }}</p>
      <p v-else-if="!plan" class="muted small">Lecture des versions publiées…</p>
      <template v-else>
        <div class="scroll">
          <table>
            <thead><tr><th>Service</th><th>En service</th><th>Origine</th><th>Version cible</th></tr></thead>
            <tbody>
              <tr v-for="s in plan.services" :key="s.service" :class="{ on: !!choice[s.service] }">
                <td class="mono"><strong>{{ s.service }}</strong><div v-if="s.linked?.length" class="muted tiny">avec {{ s.linked.join(', ') }}</div></td>
                <td>
                  <span class="mono small">{{ s.image }}</span>
                  <UiBadge v-if="s.sameTagUpdate" tone="warning" title="Le même tag a été republié : récupéré au redéploiement">republié</UiBadge>
                  <UiBadge v-if="s.migrated" tone="info" :title="`Données migrées le ${fmtDateTime(s.migrated.at)} dans ${s.migrated.path}`">migré vers PG {{ s.migrated.major }}</UiBadge>
                  <UiBadge v-if="s.override" tone="info" :title="`Mise à niveau par la plateforme le ${fmtDateTime(s.override.at)}${s.override.by ? ` par ${s.override.by}` : ''} ; Compose : ${s.override.from}`">mis à niveau</UiBadge>
                  <div v-if="KIND[s.kind]" class="muted tiny">{{ KIND[s.kind] }}</div>
                </td>
                <td class="small">{{ ORIGIN[s.origin] }} <code v-if="s.variable" class="small">{{ s.variable }}</code></td>
                <td>
                  <select v-if="s.compatible || s.major || s.override || s.pin" :value="choice[s.service]" class="input input-sm" :aria-label="`Version cible de ${s.service}`" @change="choose(s, ($event.target as HTMLSelectElement).value)">
                    <option value="">Garder {{ s.tag }}</option>
                    <option v-if="s.compatible" :value="s.compatible.tag">{{ s.compatible.tag }} ({{ s.compatible.level === 'minor' ? 'mineure' : 'correctif' }})</option>
                    <option v-if="s.major" :value="s.major.tag">{{ s.major.tag }} (majeure{{ s.stateful ? ', données' : '' }})</option>
                    <option v-if="s.pin" :value="s.pin.tag">Figer sur {{ s.pin.tag }} (dernière version publiée)</option>
                    <option v-if="s.override" value="__reset__">Revenir à la version du Compose ({{ s.override.from.split(':').pop() }})</option>
                  </select>
                  <span v-else-if="s.kind === 'version' || s.kind === 'digest'" class="ok small">dernière version</span>
                  <span v-else class="muted small" :title="s.note ?? ''">{{ s.note ? s.note.split(' : ')[0] : '—' }}</span>
                  <div v-if="isPinned(s)" class="warn tiny"><TriangleAlert :size="11" /> {{ s.pin!.reason === 'absent' ? 'Image absente du registre' : 'Tag sans version' }} : passage à une version fixe, écart de version inconnu — données sauvegardées{{ s.stateful ? ' (confirmation requise)' : '' }}, retour automatique à l'image actuelle si ça casse</div>
                  <div v-if="choice[s.service] && s.major?.tag === choice[s.service]" class="warn tiny"><TriangleAlert :size="11" /> Version majeure : lire les notes de version{{ s.stateful ? ' ; migration des données possible (sauvegarde recommandée)' : '' }}</div>
                  <UiButton v-if="s.migrated?.oldPgdata && !s.migrated.oldRemovedAt" size="sm" variant="ghost" class="mig-btn" :title="`Ancien cluster conservé dans ${s.migrated.oldPgdata}`" @click="cleaning = s">Supprimer l'ancien cluster…</UiButton>
                  <UiButton v-if="s.migration" size="sm" variant="ghost" class="mig-btn" :title="s.note ?? ''" @click="migrating = s.service">Migrer les données vers {{ s.migration.tag }}…</UiButton>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="opts">
          <label v-if="plan.hasBuilds" class="check"><input v-model="cleanBuild" type="checkbox"> <span><strong>Build propre</strong> des services construits : images de base (FROM) récupérées à nouveau, sans cache <span class="muted">(une image de base locale non publiée fait échouer le build)</span></span></label>
          <label v-if="statefulTouched.length" class="check"><input v-model="backup" type="checkbox"> <span><strong>Sauvegarder les données</strong> de {{ statefulTouched.map(s => s.service).join(', ') }} avant la mise à niveau <span class="muted">(copie de leurs volumes, stack arrêtée pendant la copie ; restaurée automatiquement si le retour aux images précédentes a lieu)</span></span></label>
          <label v-if="majorData.length" class="check danger"><input v-model="confirmMajorData" type="checkbox"> <span>Je confirme le changement de version (majeure ou figée) de {{ majorData.map(s => s.service).join(', ') }} : sauvegarde faite, migration des données vérifiée.</span></label>
          <p class="muted small">Le Compose de la release n'est pas modifié : les nouvelles images s'appliquent à cette cible (visibles dans le Compose final). Elles cessent de s'appliquer dès qu'une nouvelle source change elle-même la version. Retour automatique aux images précédentes si le déploiement ou les healthchecks échouent.</p>
        </div>

        <section v-if="plan.overridesPending" class="report">
          <div class="bar">
            <strong class="small">Compose source mis à niveau</strong>
            <span class="muted small">à reporter dans le dépôt ou l'archive</span>
            <span class="spacer" />
            <UiButton v-if="!patched" size="sm" variant="ghost" @click="showPatched">Afficher</UiButton>
            <template v-else>
              <UiButton size="sm" variant="ghost" @click="copyPatched"><Copy :size="13" /> Copier</UiButton>
              <UiButton size="sm" variant="ghost" @click="downloadPatched"><Download :size="13" /> Télécharger</UiButton>
            </template>
          </div>
          <template v-if="patched">
            <p v-if="patched.manual.length" class="warn small">À reporter à la main : {{ patched.manual.map(m => `${m.service} (${m.reason})`).join(' ; ') }}</p>
            <pre class="code">{{ patched.composeText }}</pre>
          </template>
        </section>
      </template>
    </div>
    <template #footer>
      <span class="muted small sum">{{ selected.length + resets.length }} service(s) changent de version{{ republished.length ? ` · ${republished.length} republié(s)` : '' }}</span>
      <UiButton variant="ghost" @click="open = false">Annuler</UiButton>
      <UiButton variant="primary" :loading="busy" :disabled="!canApply" @click="apply">Mettre à niveau et redéployer</UiButton>
    </template>
  </UiModal>
  <PgCleanupDialog v-if="cleaning" v-model:open="cleanOpen" :target-id="targetId" :service="cleaning" @done="refresh()" />
  <PgMigrationDialog v-if="migrating" v-model:open="migrateOpen" :target-id="targetId" :service="migrating" @started="migrationStarted" />
</template>

<style scoped>
.mig-btn { margin-top: 4px; }
.up { display: flex; flex-direction: column; gap: var(--space-2); }
.bar { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.spacer { flex: 1; }
.small { font-size: 12.5px; }
.tiny { font-size: 11.5px; }
.alert { margin: 0; padding: var(--space-2) var(--space-3); border-radius: var(--radius); background: var(--danger-bg); color: var(--danger); }
.scroll { overflow-x: auto; max-height: 50vh; overflow-y: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th { text-align: left; font-size: 11px; text-transform: uppercase; color: var(--text-muted); font-weight: 500; padding: 4px 8px 4px 0; border-bottom: 1px solid var(--border); position: sticky; top: 0; background: var(--surface); }
td { padding: 4px 8px 4px 0; border-bottom: 1px solid var(--border); vertical-align: middle; }
tr.on td { background: var(--primary-soft); }
.input-sm { width: auto; max-width: 260px; }
.ok { color: var(--success); }
.warn { color: var(--warning); display: flex; gap: 4px; align-items: center; margin: 2px 0 0; }
.opts { display: flex; flex-direction: column; gap: 6px; }
.opts p { margin: 0; }
.check { display: flex; gap: 8px; align-items: flex-start; font-size: 13px; }
.check input { margin-top: 3px; }
.check.danger { padding: 6px 8px; border-radius: var(--radius); background: var(--warning-bg); }
.report { border-top: 1px solid var(--border); padding-top: var(--space-2); display: flex; flex-direction: column; gap: 6px; }
.code { margin: 0; padding: var(--space-2) var(--space-3); border-radius: var(--radius); background: var(--surface-2); font-size: 12px; max-height: 260px; overflow: auto; white-space: pre; }
.sum { margin-right: auto; }
</style>
