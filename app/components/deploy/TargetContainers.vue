<script setup lang="ts">
/**
 * Conteneurs de la stack d'une cible : état, ports, fraîcheur de l'image ;
 * actions sur la stack (démarrer, arrêter, redémarrer, mettre à jour les images)
 * et sur chaque service (détail et logs, redémarrer, arrêter, démarrer).
 */
import type { ServiceAction, TargetContainer, TargetContainers } from '#shared/schemas/diagnostic'
import { FolderOpen, Pause, Play, RefreshCw, RotateCw, Square, Stethoscope } from 'lucide-vue-next'

const props = defineProps<{ targetId: string, projectId: string, projectSlug: string, isProduction: boolean, hasRelease: boolean, canDeploy: boolean, canStop: boolean, busy?: boolean }>()
const upgradeOpen = ref(false)
const emit = defineEmits<{ act: ['start' | 'stop' | 'restart' | 'redeploy'], started: [deploymentId: string] }>()
const toast = useToast()
const confirm = useConfirm()

const { data, error, status, refresh } = useFetch<TargetContainers>(() => `/api/targets/${props.targetId}/containers`, { server: false, lazy: true })
// Rafraîchi toutes les 10 s tant que l'onglet est ouvert (et la page visible).
let timer: ReturnType<typeof setInterval> | undefined
// Lecture côté navigateur seulement : l'indicateur de chargement n'apparaît qu'après l'hydratation (rendu serveur identique).
const mounted = ref(false)
onMounted(() => {
  mounted.value = true
  timer = setInterval(() => {
    if (document.visibilityState === 'visible' && status.value !== 'pending') void refresh()
  }, 10_000)
})
onBeforeUnmount(() => clearInterval(timer))

const list = computed(() => data.value?.containers ?? [])
const running = computed(() => list.value.filter(c => c.state === 'running').length)
const present = computed(() => list.value.filter(c => c.state !== 'missing'))
const allStopped = computed(() => present.value.length > 0 && present.value.every(c => c.state !== 'running'))
const troubled = computed(() => list.value.some(c => c.state === 'missing' || (c.state !== 'running' && !/Exited \(0\)/.test(c.status)) || c.health === 'unhealthy'))

const FRESH: Record<string, { label: string, tone: 'success' | 'warning' | 'neutral' | 'info' }> = {
  current: { label: 'à jour', tone: 'success' },
  outdated: { label: 'nouvelle version', tone: 'warning' },
  unknown: { label: 'non vérifiée', tone: 'neutral' },
  local: { label: 'image locale', tone: 'neutral' },
  pinned: { label: 'figée', tone: 'info' },
}
const uptime = (s: string) => s.replace(/\s*\((healthy|unhealthy|health: starting)\)/, '').replace(/^Up /, 'depuis ').replace(/^Exited \((\d+)\) /, 'arrêté (code $1) il y a ').replace(/ ago$/, '').replace(/About an? /, '1 ').replace(/seconds?/, 's').replace(/minutes?/, 'min').replace(/hours?/, 'h').replace(/days?/, 'j').replace(/weeks?/, 'sem.')

const pending = ref<string | null>(null)
const filesOf = ref<string | null>(null)
const filesOpen = computed({ get: () => filesOf.value !== null, set: (v: boolean) => { if (!v) filesOf.value = null } })

// Suspension : le service sort de la stack (conteneur supprimé, données gardées) jusqu'à sa reprise.
async function setSuspended(service: string, suspended: boolean) {
  if (!await confirm({
    title: `${suspended ? 'Suspendre' : 'Reprendre'} ${service}`,
    message: suspended
      ? `${service} est retiré de la stack par un redéploiement (sans mise à jour des images) : son conteneur est supprimé, ses volumes et données sont conservés. Il n'est plus démarré ni contrôlé (santé, mises à jour, migrations) jusqu'à sa reprise ; les services qui en dépendent ne l'attendent plus.`
      : `${service} est remis dans la stack par un redéploiement (sans mise à jour des images), avec ses données.`,
    confirmLabel: suspended ? 'Suspendre' : 'Reprendre',
    danger: suspended,
  })) return
  pending.value = `${service}:suspend`
  try {
    const r = await $fetch<{ deploymentId: string | null }>(`/api/targets/${props.targetId}/suspended-services`, { method: 'PUT', body: { service, suspended } })
    toast.success(`${service} : ${suspended ? 'suspension' : 'reprise'} en cours`)
    if (r.deploymentId) emit('started', r.deploymentId)
    else await refresh()
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    pending.value = null
  }
}
const LABEL: Record<ServiceAction, string> = { start: 'Démarrer', stop: 'Arrêter', restart: 'Redémarrer' }
async function serviceAct(c: TargetContainer, action: ServiceAction) {
  if (action !== 'start' && !await confirm({
    title: `${LABEL[action]} ${c.service}`,
    message: action === 'stop'
      ? `Le conteneur ${c.name} est arrêté (sans redéploiement) : le service ne répond plus jusqu'à son redémarrage. Les autres services de la stack continuent.`
      : `Le conteneur ${c.name} est redémarré (sans redéploiement).`,
    confirmLabel: LABEL[action],
    danger: action === 'stop',
  })) return
  pending.value = `${c.service}:${action}`
  try {
    await $fetch(`/api/targets/${props.targetId}/services/${encodeURIComponent(c.service)}/${action}`, { method: 'POST' })
    toast.success(`${c.service} : ${LABEL[action].toLowerCase()} demandé`)
    await new Promise(r => setTimeout(r, 1500))
    await refresh()
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    pending.value = null
  }
}

// Détail et logs : même panneau que les conteneurs en direct.
const selected = ref<TargetContainer | null>(null)
const drawer = computed({ get: () => !!selected.value, set: (v) => { if (!v) selected.value = null } })
</script>

<template>
  <section class="card tc">
    <div class="bar">
      <strong>{{ running }} / {{ list.length }} en marche</strong>
      <span v-if="data" class="muted small">stack <code>{{ data.stack }}</code> · lu à {{ fmtTime(data.checkedAt) }}</span>
      <NuxtLink v-if="troubled" :to="`/diagnostic/${targetId}`" class="diag small"><Stethoscope :size="13" /> Diagnostic</NuxtLink>
      <span class="spacer" />
      <UiButton v-if="canDeploy && hasRelease" size="sm" :variant="data?.outdated.length ? 'primary' : 'secondary'" :disabled="busy" title="Versions plus récentes, nouvelles publications des tags, build propre" @click="upgradeOpen = true">Mises à niveau…<span v-if="data?.outdated.length" class="count">{{ data.outdated.length }}</span></UiButton>
      <UiButton v-if="canDeploy && allStopped" size="sm" variant="primary" :disabled="busy" @click="emit('act', 'start')"><Play :size="13" /> Démarrer la stack</UiButton>
      <UiButton v-if="canDeploy && !allStopped && present.length" size="sm" :disabled="busy" @click="emit('act', 'restart')"><RotateCw :size="13" /> Redémarrer la stack</UiButton>
      <UiButton v-if="canDeploy && hasRelease" size="sm" :disabled="busy" title="Recrée les conteneurs avec la configuration actuelle" @click="emit('act', 'redeploy')"><RefreshCw :size="13" /> Redéployer</UiButton>
      <UiButton v-if="canStop && !allStopped && present.length" size="sm" :disabled="busy" @click="emit('act', 'stop')"><Square :size="12" /> Arrêter la stack</UiButton>
      <UiButton size="sm" variant="ghost" :loading="mounted && status === 'pending'" title="Relire l'état des conteneurs" aria-label="Relire" @click="refresh()"><RefreshCw :size="14" /></UiButton>
    </div>

    <div v-if="data?.suspended.length" class="suspended">
      <strong class="small">Services suspendus</strong>
      <span v-for="sv in data.suspended" :key="sv.service" class="sus">
        <span class="mono">{{ sv.service }}</span>
        <span class="muted small">depuis le {{ fmtDateTime(sv.at) }}{{ sv.by ? ` (${sv.by})` : '' }}</span>
        <UiButton v-if="canDeploy" size="sm" :disabled="busy" :loading="pending === `${sv.service}:suspend`" @click="setSuspended(sv.service, false)"><Play :size="13" /> Reprendre</UiButton>
      </span>
    </div>
    <p v-if="error" class="alert">{{ apiError(error).message }}</p>
    <p v-else-if="!data" class="muted small">Lecture des conteneurs…</p>
    <p v-else-if="!list.length" class="muted small">Aucun conteneur : la cible n'a pas encore été déployée.</p>
    <div v-else class="scroll">
      <table>
        <thead><tr><th>Service</th><th>État</th><th>Image</th><th class="m-hide">Ports</th><th class="m-hide">Depuis</th><th /></tr></thead>
        <tbody>
          <tr v-for="c in list" :key="c.id ?? c.service" :class="{ missing: c.state === 'missing' }">
            <td>
              <button v-if="c.id" type="button" class="svc mono" title="Détail, logs, variables" @click="selected = c">{{ c.service }}</button>
              <span v-else class="mono">{{ c.service }}</span>
            </td>
            <td>
              <UiBadge v-if="c.state === 'missing'" tone="danger">absent</UiBadge>
              <ContainerState v-else :state="c.state" :health="c.health" :status="c.status" />
            </td>
            <td>
              <span class="img">
                <span class="mono small ellipsis" :title="c.image ?? ''">{{ c.image }}</span>
                <UiBadge v-if="c.freshness" :tone="FRESH[c.freshness.state]?.tone ?? 'neutral'" :title="c.freshness.detail">{{ FRESH[c.freshness.state]?.label ?? c.freshness.state }}</UiBadge>
              </span>
            </td>
            <td class="m-hide"><span v-for="p in c.ports" :key="p" class="port mono">{{ p }}</span><span v-if="!c.ports.length" class="muted small">—</span></td>
            <td class="m-hide muted small nowrap">{{ c.state === 'missing' ? 'redéployer pour le recréer' : uptime(c.status) }}</td>
            <td class="acts">
              <template v-if="c.id">
                <UiButton v-if="canDeploy && c.state !== 'running'" size="sm" variant="ghost" :loading="pending === `${c.service}:start`" :title="`Démarrer ${c.service}`" :aria-label="`Démarrer ${c.service}`" @click="serviceAct(c, 'start')"><Play :size="13" /></UiButton>
                <UiButton v-if="canDeploy && c.state === 'running'" size="sm" variant="ghost" :loading="pending === `${c.service}:restart`" :title="`Redémarrer ${c.service}`" :aria-label="`Redémarrer ${c.service}`" @click="serviceAct(c, 'restart')"><RotateCw :size="13" /></UiButton>
                <UiButton v-if="canStop && c.state === 'running'" size="sm" variant="ghost" :loading="pending === `${c.service}:stop`" :title="`Arrêter ${c.service}`" :aria-label="`Arrêter ${c.service}`" @click="serviceAct(c, 'stop')"><Square :size="12" /></UiButton>
                <UiButton v-if="canDeploy && hasRelease" size="sm" variant="ghost" :disabled="busy" :loading="pending === `${c.service}:suspend`" :title="`Suspendre ${c.service} : retiré de la stack (données gardées), ni démarré ni contrôlé jusqu'à sa reprise`" :aria-label="`Suspendre ${c.service}`" @click="setSuspended(c.service, true)"><Pause :size="13" /></UiButton>
                <UiButton v-if="canDeploy" size="sm" variant="ghost" :title="`Fichiers de ${c.service} (volumes et dossiers montés)`" :aria-label="`Fichiers de ${c.service}`" @click="filesOf = c.service"><FolderOpen :size="13" /></UiButton>
                <UiButton size="sm" variant="ghost" @click="selected = c">Logs</UiButton>
              </template>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-if="data?.outdated.length" class="muted small">Tag republié pour {{ data.outdated.join(', ') }} : à récupérer depuis « Mises à niveau… », qui propose aussi les versions plus récentes.</p>
    <ImageUpgradePanel v-if="upgradeOpen" v-model:open="upgradeOpen" :target-id="targetId" :project-slug="projectSlug" :is-production="isProduction" />

    <ServiceFilesDialog v-if="filesOf" :key="filesOf" v-model:open="filesOpen" :target-id="targetId" :service="filesOf" />
    <UiDrawer v-model:open="drawer" :title="selected?.name ?? ''" width="640px">
      <ContainerDetail v-if="selected?.id && data" :key="selected.id" :endpoint-id="data.endpointId" :container-id="selected.id" />
    </UiDrawer>
  </section>
</template>

<style scoped>
.tc { padding: var(--space-3) var(--space-4); display: flex; flex-direction: column; gap: var(--space-2); }
.bar { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.bar code { font-size: 12px; }
.spacer { flex: 1; }
.small { font-size: 12.5px; }
.count { margin-left: 6px; padding: 0 6px; border-radius: 999px; background: rgb(255 255 255 / 25%); font-size: 11.5px; }
.diag { display: inline-flex; gap: 4px; align-items: center; color: var(--danger); font-weight: 550; }
.alert { margin: 0; padding: var(--space-2) var(--space-3); border-radius: var(--radius); background: var(--danger-bg); color: var(--danger); }
.scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th { text-align: left; font-size: 11px; text-transform: uppercase; color: var(--text-muted); font-weight: 500; padding: 4px 8px 4px 0; border-bottom: 1px solid var(--border); }
td { padding: 3px 8px 3px 0; border-bottom: 1px solid var(--border); vertical-align: middle; }
tr.missing td { background: var(--danger-bg); }
.svc { all: unset; cursor: pointer; color: var(--primary); font-weight: 600; }
.svc:hover { text-decoration: underline; }
.svc:focus-visible { outline: 2px solid var(--focus); }
.img { display: flex; gap: 6px; align-items: center; min-width: 0; max-width: 380px; }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.port { display: inline-block; margin-right: 4px; padding: 0 6px; border-radius: var(--radius-sm); background: var(--surface-3); font-size: 11.5px; }
.nowrap { white-space: nowrap; }
.acts { white-space: nowrap; text-align: right; }
@media (max-width: 720px) { .m-hide { display: none; } }
.suspended { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2) var(--space-4); padding: var(--space-2) var(--space-3); border-radius: var(--radius); background: var(--warning-bg); margin-bottom: var(--space-3); }
.sus { display: inline-flex; align-items: center; gap: var(--space-2); }
</style>
