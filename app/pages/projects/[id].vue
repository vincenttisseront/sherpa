<script setup lang="ts">
import { RUNTIME_STATE } from '#shared/utils/target-state'
import { ListTodo } from 'lucide-vue-next'
import type { PendingCheck, ProjectDto, TargetSummary } from '#shared/schemas/projects'
import type { TargetWatchtowerDto } from '#shared/schemas/watchtower'
import type { StoredUpload } from '~/types/infra'

const route = useRoute()
const toast = useToast()
const { can } = useAuth()
const confirm = useConfirm()
const id = computed(() => String(route.params.id))
const { data: project, refresh } = await useFetch<ProjectDto>(() => `/api/projects/${id.value}`)
useHead({ title: () => project.value?.name ?? 'Projet' })

const selectedId = ref<string>('')
watchEffect(() => {
  if (!selectedId.value && project.value?.targets[0]) selectedId.value = project.value.targets[0].id
})
const target = computed<TargetSummary | undefined>(() => project.value?.targets.find(t => t.id === selectedId.value))
const deploying = ref(route.query.deploy === '1')

const historyTable = ref<{ refresh: () => Promise<void> } | null>(null)
async function loadHistory() {
  await historyTable.value?.refresh()
}
const wt = ref<TargetWatchtowerDto | null>(null)
async function loadWatchtower() {
  if (!selectedId.value) return
  wt.value = await $fetch<TargetWatchtowerDto>(`/api/targets/${selectedId.value}/watchtower`).catch(() => null)
}
watch(selectedId, () => { void loadHistory(); void loadWatchtower() }, { immediate: true })

// Suivi tant qu'une opération est en cours.
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  timer = setInterval(async () => {
    if (target.value?.lastDeployment && ACTIVE_STATUS.includes(target.value.lastDeployment.status)) {
      await refresh()
      await loadHistory()
      if (!busy.value) await loadWatchtower()
    }
  }, 3000)
})
onBeforeUnmount(() => clearInterval(timer))

const scope = computed(() => (target.value && project.value ? { projectId: project.value.id, environmentId: target.value.environment.id, serverId: target.value.server.id } : {}))
// Projet archivé : plus de déploiement ni d'action sur les stacks.
const archived = computed(() => !!project.value?.archivedAt)
const canDeploy = computed(() => !archived.value && can('deployment:execute', scope.value))
const rebuildOpen = ref(false)
const canStop = computed(() => !archived.value && can('deployment:stop', scope.value))
const canArchive = computed(() => !!project.value && can('project:update', { projectId: project.value.id }))
// Archivage refusé tant qu'une stack est déployée.
const deployedTargets = computed(() => project.value?.targets.filter(t => t.currentRelease || t.lastDeployment?.status === 'STOPPED') ?? [])
const archiving = ref(false)
async function setArchived(value: boolean) {
  if (value && !await confirm({ title: `Archiver ${project.value!.name}`, message: 'Le projet est masqué des listes et du tableau de bord, et ne peut plus être déployé. Il reste consultable et peut être désarchivé.', confirmLabel: 'Archiver' })) return
  archiving.value = true
  try {
    await $fetch(`/api/projects/${project.value!.id}/archive`, { method: 'POST', body: { archived: value } })
    toast.success(value ? 'Projet archivé' : 'Projet désarchivé')
    await refresh()
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    archiving.value = false
  }
}
const removalOpen = ref(false)
const canDelete = computed(() => !archived.value && can('deployment:delete', scope.value))
const canEdit = computed(() => can('project:update', scope.value))
const migrationOpen = ref(false)
const cleanupOpen = ref(false)
const cleanupData = ref(false)
const cleanupConfirm = ref('')
const cleaning = ref(false)
async function cleanupSource() {
  cleaning.value = true
  try {
    const r = await $fetch<{ removed: string[] }>(`/api/targets/${target.value!.id}/migration/cleanup`, { method: 'POST', body: { removeData: cleanupData.value, confirm: cleanupConfirm.value } })
    toast.success(`Ancienne stack supprimée : ${r.removed.join(', ') || 'rien à supprimer'}`)
    cleanupOpen.value = false
    await refresh()
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    cleaning.value = false
  }
}
const busy = computed(() => !!target.value?.lastDeployment && ACTIVE_STATUS.includes(target.value.lastDeployment.status))
const hasStack = computed(() => !!target.value?.currentRelease || target.value?.lastDeployment?.status === 'STOPPED')

const ACTIONS = {
  restart: { label: 'Redémarrer', message: 'Les conteneurs existants sont redémarrés un par un, puis contrôlés (configuration inchangée : pour appliquer la configuration actuelle, redéployer).', danger: false },
  stop: { label: 'Arrêter', message: 'La stack est arrêtée : l\'application ne répond plus jusqu\'au prochain démarrage.', danger: true },
  start: { label: 'Démarrer', message: 'La stack est redémarrée puis contrôlée.', danger: false },
  redeploy: { label: 'Redéployer', message: 'La release active est redéployée avec la configuration actuelle (variables, alias, Watchtower, politiques de l\'endpoint) : les conteneurs dont la configuration a changé sont recréés, les images des registres récupérées à nouveau.', danger: false },
  delete: { label: 'Supprimer', message: 'La stack est supprimée de l\'hôte, ainsi que les releases et images de cette cible sur l\'hôte. Les données runtime (volumes du projet) sont conservées.', danger: true },
} as const

async function act(action: keyof typeof ACTIONS) {
  const t = target.value!
  const a = ACTIONS[action]
  const ok = await confirm({
    title: `${a.label} — ${project.value!.name} (${t.environment.name})`,
    message: a.message,
    confirmLabel: a.label,
    danger: a.danger || t.environment.isProduction,
    requireText: action === 'delete' || (t.environment.isProduction && a.danger) ? project.value!.slug : undefined,
  })
  if (!ok) return
  try {
    const r = await $fetch<{ deploymentId: string }>(`/api/targets/${t.id}/actions`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: { action } })
    await navigateTo(`/deployments/${r.deploymentId}`)
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
}

async function patchTarget(body: { autoRollback?: boolean, healthTimeoutSec?: number, proxyNetwork?: string | null, pendingAction?: { title: string, detail: string | null, check: PendingCheck } | null }) {
  try {
    await $fetch<unknown>(`/api/targets/${target.value!.id}`, { method: 'PATCH', body })
    await refresh()
    toast.success('Réglage enregistré')
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
}

// Vérification à la demande : la plateforme contrôle elle-même la condition.
const verifying = ref(false)
async function verifyPending() {
  verifying.value = true
  try {
    const r = await $fetch<{ done: boolean, missing: string | null }>(`/api/targets/${target.value!.id}/pending/verify`, { method: 'POST' })
    if (r.done) toast.success('Vérifié : c\'est fait, l\'action est levée')
    else toast.error(`Pas encore fait : ${r.missing}`)
    await refresh()
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    verifying.value = false
  }
}

const tab = ref((route.query.tab as string) || 'history')
// Liens directs (actions en attente) : onglet et champ ciblés, archive à reprendre.
const focus = computed(() => (route.query.focus as string) || null)
const initialMode = computed(() => (route.query.archive === 'release' ? 'release' as const : null))
const deepUpload = ref<StoredUpload | null>(null)
async function loadDeepUpload() {
  const id = route.query.upload as string | undefined
  deepUpload.value = id ? await $fetch<StoredUpload>(`/api/uploads/${id}`).catch(() => null) : null
}
onMounted(loadDeepUpload)
watch(() => route.query, async (q) => {
  if (q.tab) tab.value = q.tab as string
  if (q.deploy === '1') deploying.value = true
  await loadDeepUpload()
})
// Action en attente : formulaire des réglages, prérempli avec l'action en cours.
const pendingTitle = ref('')
const pendingDetail = ref('')
const pendingKind = ref<'variable' | 'variable-deployed' | 'deployed'>('variable-deployed')
const pendingVar = ref('')
watch(() => target.value?.pendingAction, (a) => {
  pendingTitle.value = a?.title ?? ''
  pendingDetail.value = a?.detail ?? ''
  pendingKind.value = a?.check.kind ?? 'variable-deployed'
  pendingVar.value = a && a.check.kind !== 'deployed' ? a.check.name : ''
}, { immediate: true })
const variableNames = ref<string[]>([])
watch(() => [tab.value, target.value?.id], async () => {
  if (tab.value !== 'settings' || !target.value) return
  variableNames.value = (await $fetch<{ name: string }[]>(`/api/targets/${target.value.id}/variables`).catch(() => [])).map(v => v.name)
}, { immediate: true })
async function savePending() {
  const prev = target.value?.pendingAction?.check
  // Formulaire d'origine (ex. générateur Harbor) conservé pour la même variable.
  const via = prev && prev.kind !== 'deployed' && prev.name === pendingVar.value ? prev.via : 'variables'
  const check: PendingCheck = pendingKind.value === 'deployed' ? { kind: 'deployed' } : { kind: pendingKind.value, name: pendingVar.value, via }
  await patchTarget({ pendingAction: { title: pendingTitle.value, detail: pendingDetail.value || null, check } })
}
async function removePending() {
  if (!await confirm({ title: 'Supprimer l\'action en attente ?', message: 'Elle ne sera plus suivie. Pour la clore parce qu\'elle est faite, utilisez plutôt « Vérifier » : la plateforme le constate elle-même.', confirmLabel: 'Supprimer' })) return
  await patchTarget({ pendingAction: null })
}

// Réseaux possibles pour le reverse proxy (chargés à l'ouverture des réglages).
const proxyNets = ref<{ default: string | null, networks: { name: string, role: string }[] } | null>(null)
watch([tab, selectedId], async () => {
  if (tab.value !== 'settings' || !selectedId.value) return
  proxyNets.value = await $fetch<typeof proxyNets.value>(`/api/targets/${selectedId.value}/proxy-networks`).catch(() => null)
}, { immediate: true })

// Stack reprise de l'existant, jamais déployée par la plateforme : première mise en gestion.
const adoptionUploads = useState<Record<string, StoredUpload>>('adoption-uploads', () => ({}))
const pendingAdoption = computed(() => !!target.value?.adoption && !target.value.currentRelease)
const preparing = ref(false)
async function manage() {
  const t = target.value!
  if (!adoptionUploads.value[t.id]) {
    preparing.value = true
    try {
      const u = await $fetch<StoredUpload>(`/api/targets/${t.id}/adoption`, { method: 'POST' })
      adoptionUploads.value = { ...adoptionUploads.value, [t.id]: u }
    }
    catch (err) {
      toast.error(apiError(err).message)
      return
    }
    finally {
      preparing.value = false
    }
  }
  deploying.value = true
}
</script>

<template>
  <div v-if="project">
    <UiPageHeader :title="project.name" icon="folder" :back="{ to: '/projects', label: 'Projets' }">
      <template #subtitle><span v-if="project.slug !== project.name.toLowerCase()" class="mono">{{ project.slug }}</span><template v-if="project.description">{{ project.slug !== project.name.toLowerCase() ? ' · ' : '' }}{{ project.description }}</template><UiBadge v-if="archived" tone="neutral">archivé</UiBadge></template>
      <template v-if="canArchive">
        <UiButton v-if="archived" size="sm" :loading="archiving" @click="setArchived(false)">Désarchiver</UiButton>
        <UiButton v-if="archived && can('deployment:delete', { projectId: project.id })" size="sm" variant="ghost" @click="removalOpen = true">Supprimer…</UiButton>
        <UiButton v-else size="sm" variant="ghost" :loading="archiving" :disabled="deployedTargets.length > 0" :title="deployedTargets.length ? `Supprimer d'abord la stack déployée (${deployedTargets.map(t => t.environment.name).join(', ')})` : 'Masquer le projet des listes et du tableau de bord'" @click="setArchived(true)">Archiver</UiButton>
      </template>
    </UiPageHeader>
    <p v-if="archived" class="archived-note">Projet archivé le {{ fmtDateTime(project.archivedAt) }} : masqué des listes et du tableau de bord, déploiements désactivés.</p>

    <UiEmpty v-if="!project.targets.length" class="card" title="Pas encore d'environnement" />

    <div v-else class="targets-row">
      <div class="targets">
        <button v-for="t in project.targets" :key="t.id" type="button" class="target card" :class="{ on: t.id === selectedId }" @click="selectedId = t.id; deploying = false">
          <strong>{{ t.environment.name }}</strong>
          <UiBadge v-if="t.environment.isProduction" tone="danger">prod</UiBadge>
          <!-- État réel (santé des conteneurs) ; la dernière opération seulement si elle n'a pas abouti. -->
          <UiBadge v-if="t.currentRelease || t.lastDeployment" :tone="RUNTIME_STATE[t.state].tone" dot :title="t.healthCheckedAt ? `Santé constatée le ${fmtDateTime(t.healthCheckedAt)}${t.failing.length ? ` : ${t.failing.join(', ')} en difficulté` : ''}` : 'D\'après la dernière opération'">{{ RUNTIME_STATE[t.state].label }}</UiBadge>
          <UiBadge v-if="t.lastDeployment && !['HEALTHY', 'STOPPED', 'DEGRADED'].includes(t.lastDeployment.status) && t.state !== 'deploying'" :tone="statusTone(t.lastDeployment.status)" :title="`Dernière opération : ${STATUS_LABEL[t.lastDeployment.status] ?? t.lastDeployment.status}`">dernier : {{ STATUS_LABEL[t.lastDeployment.status] ?? t.lastDeployment.status }}</UiBadge>
          <NuxtLink v-if="['degraded', 'down', 'failed'].includes(t.state)" :to="`/diagnostic/${t.id}`" class="diag-link small" @click.stop>Diagnostic →</NuxtLink>
          <span class="muted small">{{ t.server.name }} / {{ t.endpoint.name }} · {{ t.currentRelease ? `release #${t.currentRelease.number}` : 'jamais déployé' }}</span>
          <template v-if="t.id === selectedId && t.stackName">
            <code class="small">{{ t.stackName }}</code>
            <a v-if="hasStack || pendingAdoption" href="?tab=containers" class="live-link small" @click.stop.prevent="tab = 'containers'; deploying = false">conteneurs →</a>
          </template>
        </button>
      </div>
      <div v-if="target" class="actions">
        <UiButton v-if="canDeploy" size="sm" variant="primary" :disabled="busy" @click="deploying = !deploying">{{ deploying ? 'Fermer' : 'Nouveau déploiement' }}</UiButton>
        <UiButton v-if="canDeploy" size="sm" :disabled="busy || !hasStack" @click="act('restart')">Redémarrer</UiButton>
        <UiButton v-if="canDeploy && target.currentRelease" size="sm" :disabled="busy" title="Recrée les conteneurs de la release active avec la configuration actuelle (alias, variables, politiques) — « Redémarrer » ne fait que relancer les conteneurs existants" @click="act('redeploy')">Redéployer</UiButton>
        <UiButton v-if="canDeploy && target.currentRelease" size="sm" :disabled="busy" title="Reconstruit les images et déploie la dernière version de la source (dernier commit de la branche, dernière release GitHub)" @click="rebuildOpen = true">Reconstruire<UiBadge v-if="target.autoRebuild?.enabled" tone="info" class="auto-badge">auto</UiBadge></UiButton>
        <UiButton v-if="canStop && target.lastDeployment?.status !== 'STOPPED'" size="sm" :disabled="busy || !hasStack" @click="act('stop')">Arrêter</UiButton>
        <UiButton v-else-if="canDeploy && target.lastDeployment?.status === 'STOPPED'" size="sm" :disabled="busy" @click="act('start')">Démarrer</UiButton>
        <UiButton v-if="target.currentRelease" size="sm" variant="ghost" title="État réel des services, cause probable et actions" @click="navigateTo(`/diagnostic/${target.id}`)">Diagnostic</UiButton>
        <UiButton v-if="canDeploy && target.currentRelease" size="sm" variant="ghost" :disabled="busy" title="Déplacer la stack et ses données vers un autre serveur géré" @click="migrationOpen = true">Migrer…</UiButton>
        <UiButton v-if="canDelete" size="sm" variant="ghost" :disabled="busy" title="Supprimer définitivement, ou arrêter la gestion en laissant tout tourner" @click="removalOpen = true">Supprimer…</UiButton>
      </div>
    </div>

    <template v-if="target">
      <section v-if="target.pendingAction || busy" class="card pad notices">
        <div v-if="target.pendingAction" class="pending-banner">
          <ListTodo :size="16" />
          <div>
            <strong>En attente : {{ target.pendingAction.title }}</strong>
            <div v-if="target.pendingAction.detail" class="small">{{ target.pendingAction.detail }}</div>
            <div class="small missing">Pas encore fait : {{ target.pendingAction.status.missing }}</div>
            <div class="muted small">Déclarée par {{ target.pendingAction.by ?? 'la plateforme' }} {{ fmtRelative(target.pendingAction.at) }} · vérifiée par la plateforme, levée dès que c'est fait</div>
          </div>
          <div class="pending-actions">
            <NuxtLink :to="target.pendingAction.status.link" class="btn-link">Saisir maintenant →</NuxtLink>
            <UiButton size="sm" :loading="verifying" @click="verifyPending">Vérifier</UiButton>
          </div>
        </div>
        <p v-if="busy" class="alert info">
          Opération en cours :
          <NuxtLink :to="`/deployments/${target.lastDeployment!.id}`">{{ ACTION_LABEL[target.lastDeployment!.action] }} — {{ STATUS_LABEL[target.lastDeployment!.status] }}</NuxtLink>
        </p>
      </section>

      <section v-if="target.migratedFrom" class="card pad adoption">
        <div class="bar">
          <div>
            <strong>Migrée depuis {{ target.migratedFrom.serverName }} le {{ fmtDateTime(target.migratedFrom.at) }}</strong>
            <p class="muted small">L'ancienne stack <span class="mono">{{ target.migratedFrom.stackName }}</span> y est arrêtée, avec ses données ({{ [...target.migratedFrom.volumes, ...(target.migratedFrom.dataDir ? [target.migratedFrom.dataDir] : [])].join(', ') || 'aucune' }}). La supprimer une fois la migration validée.</p>
          </div>
          <UiButton v-if="canDelete" :disabled="busy" @click="cleanupOpen = true">Supprimer l'ancienne stack…</UiButton>
        </div>
      </section>

      <section v-if="pendingAdoption" class="card pad adoption">
        <div class="bar">
          <div>
            <strong>Stack <span class="mono">{{ target.adoption!.stack }}</span> reprise de l'existant</strong>
            <p class="muted small">Le {{ fmtDateTime(target.adoption!.at) }} · Compose reconstruit depuis les conteneurs · {{ target.adoption!.exposures }} exposition(s), {{ target.adoption!.variables }} variable(s) chiffrée(s). Elle tourne toujours telle quelle : le premier déploiement applique le Compose converti (mêmes volumes et réseaux).</p>
          </div>
          <UiButton v-if="canDeploy && !deploying" variant="primary" :loading="preparing" :disabled="busy" @click="manage">Mettre en gestion</UiButton>
        </div>
      </section>

      <section v-if="deploying && canDeploy" class="card pad">
        <h2>Nouveau déploiement — {{ target.environment.name }}</h2>
        <DeployPanel :key="`${target.id}-${adoptionUploads[target.id]?.id ?? ''}-${deepUpload?.id ?? ''}-${initialMode ?? ''}`" :target-id="target.id" :project-id="project.id" :project-slug="project.slug" :environment-name="target.environment.name" :is-production="target.environment.isProduction" :initial-upload="deepUpload ?? (pendingAdoption ? adoptionUploads[target.id] ?? null : null)" :initial-mode="initialMode" :focus="focus" :compose-overrides="target.composeOverrides" @cancel="deploying = false" @target-changed="refresh()" />
      </section>

      <UiTabs v-model="tab" :tabs="[{ key: 'history', label: 'Historique' }, { key: 'containers', label: 'Conteneurs', title: 'Conteneurs de la stack : état, actions, mises à jour' }, { key: 'source', label: 'Source' }, { key: 'exposure', label: 'Exposition web' }, { key: 'access', label: 'Logs d\'accès', title: 'Requêtes reçues par ses domaines (reverse proxy nginx)' }, { key: 'vulnerabilities', label: 'Vulnérabilités', title: 'Analyse Trivy des images de ses conteneurs' }, { key: 'variables', label: 'Variables' }, { key: 'watchtower', label: 'Watchtower' }, { key: 'settings', label: 'Réglages' }]" />

      <section v-if="tab === 'history' && wt?.provenance.config" class="card pad">
        <TargetProvenance :provenance="wt.provenance" />
      </section>
      <DeploymentsTable v-if="tab === 'history'" ref="historyTable" :key="target.id" :target-id="target.id" />

      <TargetContainers v-else-if="tab === 'containers'" :key="`containers-${target.id}`" :target-id="target.id" :project-id="project.id" :project-slug="project.slug" :is-production="target.environment.isProduction" :has-release="!!target.currentRelease" :can-deploy="canDeploy" :can-stop="canStop" :busy="busy" @act="a => act(a)" @started="id => navigateTo(`/deployments/${id}`)" />

      <section v-else-if="tab === 'source'" class="card pad">
        <SourceEditor v-if="canEdit" :project-id="project.id" />
        <p v-else class="muted">Modification réservée aux personnes pouvant modifier le projet.</p>
        <WebhookPanel v-if="canEdit" :project-id="project.id" />
      </section>

      <section v-else-if="tab === 'exposure'" class="card pad">
        <ExposuresEditor :target-id="target.id" />
      </section>

      <section v-else-if="tab === 'vulnerabilities'" class="card pad">
        <TargetVulnerabilities :key="`vuln-${target.id}`" :target-id="target.id" :can-scan="canDeploy" />
      </section>
      <section v-else-if="tab === 'access'" class="card pad">
        <AccessLogViewer :key="`access-${target.id}`" :url="`/api/targets/${target.id}/access-logs`" />
      </section>
      <section v-else-if="tab === 'variables'" class="card pad">
        <VariablesEditor :target-id="target.id" :focus="focus" @saved="refresh()" @redeploy="act('redeploy')" />
      </section>

      <section v-else-if="tab === 'watchtower'" class="card pad">
        <WatchtowerPanel v-if="wt" :target-id="target.id" :data="wt" :can-edit="canEdit" :can-deploy="canDeploy" :can-stop="canStop" :busy="busy" @changed="v => wt = v" @apply="act('redeploy')" />
      </section>

      <section v-else class="card pad settings">
        <div class="set-grid">
        <div class="set-col">
        <h3>Emplacement sur l'hôte</h3>
        <dl v-if="target.layout" class="placement">
          <dt>Dossier du projet</dt><dd class="mono">{{ target.layout.projectDir }}</dd>
          <dt>Releases</dt><dd class="mono">{{ target.layout.releasesDir }}</dd>
          <dt>Données</dt><dd class="mono">{{ target.layout.dataDir }}<span v-if="target.volumesAsFolders" class="muted"> (volumes en dossiers)</span></dd>
        </dl>
        <p class="muted small">{{ target.projectPath ? 'Chemin choisi à la création' : 'Racines de l\'environnement' }} ; fixé au premier déploiement.</p>
        <UiField label="Réseau du reverse proxy" for="t-net" hint="Appliqué au prochain déploiement">
          <select id="t-net" class="input net" :value="target.proxyNetwork ?? ''" :disabled="!canEdit" @change="patchTarget({ proxyNetwork: ($event.target as HTMLSelectElement).value || null })">
            <option value="">{{ proxyNets?.default ? `Réseau par défaut de l'endpoint (${proxyNets.default})` : 'Réseau par défaut de l\'endpoint' }}</option>
            <!-- Réseau choisi explicitement, même s'il est celui par défaut ou n'est plus proposé : toujours affiché. -->
            <option v-for="n in proxyNets?.networks.filter(x => x.name !== proxyNets?.default || x.name === target!.proxyNetwork) ?? []" :key="n.name" :value="n.name">{{ n.name }}{{ n.role === 'traefik' ? ' — rôle Traefik' : '' }}{{ n.name === proxyNets?.default ? ' (défaut de l\'endpoint)' : '' }}</option>
            <option v-if="target.proxyNetwork && !proxyNets?.networks.some(x => x.name === target!.proxyNetwork)" :value="target.proxyNetwork">{{ target.proxyNetwork }} (non proposé)</option>
          </select>
        </UiField>
        </div>
        <div class="set-col">
        <h3>Déploiement</h3>
        <UiSwitch :model-value="target.autoRollback" label="Rollback automatique si un service ne démarre pas" @update:model-value="v => patchTarget({ autoRollback: v })" />
        <UiField label="Délai maximal des healthchecks (secondes)" for="t-timeout" hint="Au-delà, un service toujours en démarrage est considéré en échec">
          <input id="t-timeout" class="input timeout" type="number" min="10" max="1800" :value="target.healthTimeoutSec" @change="patchTarget({ healthTimeoutSec: Number(($event.target as HTMLInputElement).value) })">
        </UiField>
        </div>
        </div>
        <h3>Action en attente</h3>
        <p class="muted small">Ce qui reste à faire pour terminer la mise en service. La plateforme vérifie elle-même la condition choisie et lève l'action quand elle est remplie : elle n'est jamais close sur simple déclaration.</p>
        <div class="pending-form">
          <input v-model.trim="pendingTitle" class="input" placeholder="Ex. Saisir le mot de passe administrateur" aria-label="Action en attente" :disabled="!canEdit">
          <select v-model="pendingKind" class="input kind" aria-label="Condition vérifiée" :disabled="!canEdit">
            <option value="variable-deployed">Variable renseignée, puis déploiement réussi</option>
            <option value="variable">Variable renseignée</option>
            <option value="deployed">Déploiement réussi</option>
          </select>
          <input v-if="pendingKind !== 'deployed'" v-model.trim="pendingVar" class="input mono" list="pending-vars" placeholder="NOM_VARIABLE" aria-label="Variable à renseigner" :disabled="!canEdit">
          <datalist id="pending-vars"><option v-for="n in variableNames" :key="n" :value="n" /></datalist>
          <input v-model.trim="pendingDetail" class="input" placeholder="Précision (facultatif)" aria-label="Précision" :disabled="!canEdit">
          <UiButton v-if="canEdit" size="sm" :disabled="pendingTitle.length < 3 || (pendingKind !== 'deployed' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(pendingVar))" @click="savePending">Enregistrer</UiButton>
          <UiButton v-if="canEdit && target.pendingAction" size="sm" variant="ghost" @click="removePending">Supprimer l'action</UiButton>
        </div>
        <h3>Healthchecks</h3>
        <HealthOverridesEditor :target-id="target.id" :value="target.composeOverrides" :can-edit="canEdit" @saved="refresh()" />
      </section>
    </template>
    <MigrationDialog v-if="migrationOpen && target?.stackName" v-model:open="migrationOpen" :target-id="target.id" :stack-name="target.stackName" :server-name="target.server.name" @started="id => navigateTo(`/deployments/${id}`)" />
    <UiModal v-if="target?.migratedFrom" v-model:open="cleanupOpen" :title="`Supprimer l'ancienne stack sur ${target.migratedFrom.serverName}`" width="620px">
      <p class="small">La stack arrêtée <span class="mono">{{ target.migratedFrom.stackName }}</span> est supprimée de {{ target.migratedFrom.serverName }} (conteneurs, réseaux, dossiers des releases). La stack migrée n'est pas touchée.</p>
      <label class="check small"><input v-model="cleanupData" type="checkbox"> Supprimer aussi les données d'origine (volumes et dossier des données) — irréversible</label>
      <UiField :label="`Saisir le nom de la stack (${target.migratedFrom.stackName}) pour confirmer`" for="cleanup-confirm">
        <input id="cleanup-confirm" v-model.trim="cleanupConfirm" class="input input-sm mono" autocomplete="off">
      </UiField>
      <template #footer>
        <UiButton variant="ghost" @click="cleanupOpen = false">Annuler</UiButton>
        <UiButton variant="danger" :loading="cleaning" :disabled="cleanupConfirm !== target.migratedFrom.stackName" @click="cleanupSource">Supprimer</UiButton>
      </template>
    </UiModal>
    <ProjectRemovalDialog v-if="removalOpen && project" v-model:open="removalOpen" :project-id="project.id" :project-name="project.name" />
    <RebuildDialog v-if="target && rebuildOpen" v-model:open="rebuildOpen" :target-id="target.id" :is-production="target.environment.isProduction" @started="id => navigateTo(`/deployments/${id}`)" @auto="refresh()" />
  </div>
</template>

<style scoped>
.back { font-size: 13px; }
.sub { margin: 4px 0 0; }
.small { font-size: 12.5px; }
.targets-row { display: flex; gap: var(--space-3); align-items: center; flex-wrap: wrap; margin-bottom: var(--space-3); }
.targets { display: flex; gap: var(--space-3); flex-wrap: wrap; flex: 1; min-width: 0; }
.targets-row > .actions { display: flex; gap: var(--space-2); flex-wrap: wrap; justify-content: flex-end; align-self: center; }
.notices { gap: var(--space-2); }
.notices .archived-note { margin: 0 0 var(--space-3); padding: var(--space-2) var(--space-3); border-radius: var(--radius); background: var(--neutral-bg); color: var(--text-muted); font-size: 13px; }
.pending-banner { margin-top: 0; }
.target { all: unset; box-sizing: border-box; display: flex; flex-wrap: wrap; align-items: center; gap: 4px var(--space-2); padding: 6px var(--space-3); cursor: pointer; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); }
.target.on { border-color: var(--primary); box-shadow: 0 0 0 1px var(--primary); }
.target:focus-visible { outline: 2px solid var(--focus); }
.pad { padding: var(--space-3) var(--space-4); display: flex; flex-direction: column; gap: var(--space-3); margin-bottom: var(--space-4); }
.bar { display: flex; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap; align-items: center; }
.actions { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.alert { margin: 0; padding: var(--space-3) var(--space-4); border-radius: var(--radius); }
.alert.info { background: var(--info-bg); color: var(--info); }
.pending-banner { display: flex; gap: var(--space-3); align-items: flex-start; margin-top: var(--space-3); padding: var(--space-3) var(--space-4); border-radius: var(--radius); background: var(--warning-bg); color: var(--text); }
.pending-banner > svg { color: var(--warning); flex: none; margin-top: 2px; }
.pending-banner > div { flex: 1; min-width: 0; }
.pending-form { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.pending-form .input { flex: 1; min-width: 200px; }
.pending-form .kind { flex: 0 1 300px; }
.missing { color: var(--warning); font-weight: 550; }
.pending-actions { display: flex; flex-direction: column; gap: var(--space-2); align-items: flex-end; flex: none; }
.btn-link { display: inline-flex; align-items: center; padding: 6px 12px; border-radius: var(--radius); background: var(--primary); color: #fff; font-size: 13px; font-weight: 550; white-space: nowrap; }
.btn-link:hover { text-decoration: none; filter: brightness(1.08); }
.settings { gap: var(--space-3); }
.set-grid { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap: var(--space-4); }
.set-col { display: flex; flex-direction: column; gap: var(--space-2); min-width: 0; }
@media (max-width: 900px) { .set-grid { grid-template-columns: 1fr; } }
.timeout { max-width: 140px; }
.net { max-width: 420px; }
.settings h3 { margin: 0; font-size: 14px; }
.placement { display: grid; grid-template-columns: 150px 1fr; gap: 4px var(--space-3); margin: 0; font-size: 13px; }
.placement dt { color: var(--text-muted); }
.placement dd { margin: 0; word-break: break-all; }
.live-link { display: inline-block; }
.adoption { border-color: color-mix(in srgb, var(--primary) 35%, var(--border)); }
.adoption p { margin: 4px 0 0; max-width: 820px; }
.diag-link { color: var(--danger); font-weight: 550; }
.auto-badge { margin-left: 6px; }
</style>
