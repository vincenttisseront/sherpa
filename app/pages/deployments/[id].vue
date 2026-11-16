<script setup lang="ts">
import { type DeploymentDetailDto, RELAUNCHABLE } from '#shared/schemas/deployments'

const route = useRoute()
const id = computed(() => String(route.params.id))
const { data: d, refresh } = await useFetch<DeploymentDetailDto>(() => `/api/deployments/${id.value}`)
const { can } = useAuth()
const toast = useToast()

// Échec acquitté : retiré du tableau de bord, conservé ici et dans l'historique.
const FAILED = ['FAILED', 'ROLLED_BACK', 'VALIDATION_FAILED']
const canAck = computed(() => !!d.value && FAILED.includes(d.value.status) && can('deployment:execute', { projectId: d.value.project.id }))
const acking = ref(false)
async function setAcknowledged(value: boolean) {
  acking.value = true
  try {
    await $fetch(`/api/deployments/${id.value}/acknowledge`, { method: 'POST', body: { acknowledged: value } })
    toast.success(value ? 'Échec acquitté : retiré du tableau de bord' : 'Acquittement annulé')
    await refresh()
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    acking.value = false
  }
}
// Relance avec les mêmes paramètres (même release, revalidée) : reconstruction des images au choix.
const canRelaunch = computed(() => !!d.value?.release?.slug && RELAUNCHABLE.includes(d.value.action) && !ACTIVE_STATUS.includes(d.value.status) && can('deployment:execute', { projectId: d.value.project.id }))
const relaunchOpen = ref(false)
const relaunching = ref(false)
const relaunch = reactive({ rebuild: false, cleanBuild: false, pull: true })
function openRelaunch() {
  Object.assign(relaunch, { rebuild: false, cleanBuild: false, pull: true })
  relaunchOpen.value = true
}
async function submitRelaunch() {
  relaunching.value = true
  try {
    const r = await $fetch<{ deploymentId: string }>(`/api/deployments/${id.value}/relaunch`, { method: 'POST', body: { ...relaunch, cleanBuild: relaunch.rebuild && relaunch.cleanBuild }, headers: { 'idempotency-key': crypto.randomUUID() } })
    relaunchOpen.value = false
    toast.success('Déploiement relancé')
    await navigateTo(`/deployments/${r.deploymentId}`)
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    relaunching.value = false
  }
}
// Validation par une autre personne / exécution planifiée.
const { me } = useAuth()
const waiting = computed(() => !!d.value && d.value.status === 'QUEUED' && (d.value.gate.approval?.state === 'pending' || !!d.value.gate.scheduledFor))
const pendingApproval = computed(() => d.value?.gate.approval?.state === 'pending' && d.value.status === 'QUEUED')
const scope = computed(() => (d.value ? { projectId: d.value.project.id } : {}))
const isRequester = computed(() => !!d.value?.gate.requestedBy && d.value.gate.requestedBy === me.value?.user?.email)
const canDecide = computed(() => pendingApproval.value && !isRequester.value && can('deployment:approve', scope.value))
const canCancelWaiting = computed(() => waiting.value && can('deployment:execute', scope.value))
const comment = ref('')
const deciding = ref<string | null>(null)
async function decide(decision: 'approve' | 'reject' | 'cancel') {
  deciding.value = decision
  try {
    await $fetch<unknown>(`/api/deployments/${id.value}/decision`, { method: 'POST', body: { decision, comment: comment.value.trim() || undefined } })
    toast.success({ approve: 'Déploiement validé', reject: 'Déploiement refusé', cancel: 'Déploiement annulé' }[decision])
    comment.value = ''
    await refresh()
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    deciding.value = null
  }
}
const OPTION_LABELS = computed(() => d.value ? [
  ...(d.value.options.skipBuild ? ['images reprises sans reconstruction'] : []),
  ...(d.value.options.cleanBuild ? ['build propre'] : []),
  ...(d.value.options.noPull ? ['images des registres non récupérées'] : []),
  ...(d.value.options.upgrade ? ['mise à niveau d\'images'] : []),
] : [])
useHead({ title: () => (d.value ? `Déploiement ${d.value.project.name}` : 'Déploiement') })

const steps = computed(() => d.value ? deploymentSteps({ ...d.value, sourceKind: d.value.release?.sourceKind ?? null }) : null)

const SOURCE_LABEL: Record<string, string> = { zip: 'Archive ZIP', github: 'Dépôt GitHub', compose: 'Compose saisi' }
const fmt = (iso: string | null) => fmtDateTime(iso)
const duration = computed(() => {
  if (!d.value?.startedAt) return null
  const end = d.value.finishedAt ? new Date(d.value.finishedAt) : new Date()
  const s = Math.round((end.getTime() - new Date(d.value.startedAt).getTime()) / 1000)
  return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`
})

// Rafraîchit le statut tant que le déploiement est en cours ; les logs arrivent par SSE.
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  timer = setInterval(() => {
    if (d.value && (ACTIVE_STATUS.includes(d.value.status) || waiting.value)) void refresh()
  }, 2000)
})
onBeforeUnmount(() => clearInterval(timer))

interface ReleaseView { number: number, slug: string | null, composePath: string | null, composeSource: string | null, composeFinal: string | null, composeDiff: string | null, analysis: { changes?: { service?: string, message: string }[], ports?: { service: string, published: number | null, protocol: string, policy: string }[], approvals?: { service: string, published: number, justification: string }[] }, images: Record<string, string> }
const { data: release } = await useFetch<ReleaseView | null>(() => `/api/deployments/${id.value}/release`)
const tab = ref('logs')
const tabs = computed(() => [
  { key: 'logs', label: 'Logs' },
  ...(release.value?.composeFinal ? [{ key: 'final', label: 'Compose final' }, { key: 'diff', label: 'Diff' }, { key: 'analysis', label: 'Analyse validée' }] : []),
])
</script>

<template>
  <div v-if="d">
    <UiPageHeader :title="d.project.name" icon="rocket" :back="{ to: `/projects/${d.project.id}`, label: 'Projet' }">
      <template #nav>
        <span class="h-meta">
          <UiBadge :tone="statusTone(d.status)" dot>{{ STATUS_LABEL[d.status] ?? d.status }}</UiBadge>
          <UiBadge :tone="d.environment.isProduction ? 'danger' : 'neutral'">{{ d.environment.name }}</UiBadge>
          <span class="muted small">{{ ACTION_LABEL[d.action] ?? d.action }} · {{ d.server.name }} / {{ d.endpoint.name }}</span>
          <span v-if="d.acknowledged" class="ack-note small">acquitté{{ d.acknowledged.by ? ` par ${d.acknowledged.by}` : '' }} le {{ fmt(d.acknowledged.at) }}</span>
        </span>
      </template>
      <UiButton v-if="canRelaunch" size="sm" title="Relance avec la même release (Compose, source, ports approuvés)" @click="openRelaunch">Relancer…</UiButton>
      <template v-if="canAck">
        <UiButton v-if="!d.acknowledged" size="sm" :loading="acking" title="Retire cet échec du tableau de bord ; il reste dans l'historique" @click="setAcknowledged(true)">Acquitter l'échec</UiButton>
        <UiButton v-else size="sm" variant="ghost" :loading="acking" @click="setAcknowledged(false)">Annuler l'acquittement</UiButton>
      </template>
    </UiPageHeader>

    <section v-if="d.gate.approval || (waiting && d.gate.scheduledFor)" class="gate card" data-testid="gate" :class="{ pending: pendingApproval }">
      <template v-if="pendingApproval">
        <strong>Validation requise</strong>
        <span class="small">{{ d.gate.approval!.reason === 'urgent' ? 'Demande urgente hors fenêtre de déploiement' : 'Politique de l\'environnement' }} : une autre personne que {{ d.gate.requestedBy ?? 'le demandeur' }} doit valider ce déploiement avant son exécution.<template v-if="d.gate.scheduledFor"> Exécution prévue le {{ fmt(d.gate.scheduledFor) }} après validation.</template></span>
        <div v-if="canDecide || canCancelWaiting" class="decide">
          <input v-model="comment" class="input" maxlength="500" placeholder="Commentaire (facultatif)" aria-label="Commentaire de la décision">
          <UiButton v-if="canDecide" size="sm" variant="primary" :loading="deciding === 'approve'" data-testid="approve" @click="decide('approve')">Valider</UiButton>
          <UiButton v-if="canDecide" size="sm" variant="danger" :loading="deciding === 'reject'" data-testid="reject" @click="decide('reject')">Refuser</UiButton>
          <UiButton v-if="canCancelWaiting" size="sm" variant="ghost" :loading="deciding === 'cancel'" @click="decide('cancel')">Annuler la demande</UiButton>
        </div>
        <span v-else-if="isRequester" class="muted small">Vous êtes le demandeur : vous ne pouvez pas valider votre propre demande.</span>
      </template>
      <template v-else>
        <strong v-if="d.gate.scheduledFor && waiting">Exécution planifiée le {{ fmt(d.gate.scheduledFor) }}</strong>
        <span v-if="d.gate.approval?.state === 'approved'" class="small">Validé par {{ d.gate.approval.decidedBy }} le {{ fmt(d.gate.approval.decidedAt) }}{{ d.gate.approval.comment ? ` : ${d.gate.approval.comment}` : '' }}.</span>
        <span v-else-if="d.gate.approval?.state === 'rejected'" class="small">Refusé par {{ d.gate.approval.decidedBy }} le {{ fmt(d.gate.approval.decidedAt) }}{{ d.gate.approval.comment ? ` : ${d.gate.approval.comment}` : '' }}.</span>
        <UiButton v-if="canCancelWaiting && waiting" size="sm" variant="ghost" :loading="deciding === 'cancel'" @click="decide('cancel')">Annuler la planification</UiButton>
      </template>
    </section>

    <div class="facts card">
      <div><span class="muted">Release</span>{{ d.release ? `#${d.release.number} (${d.release.slug ?? '—'})` : '—' }}</div>
      <div><span class="muted">Source</span>{{ SOURCE_LABEL[d.release?.sourceKind ?? ''] ?? d.release?.sourceKind ?? '—' }}</div>
      <div v-if="d.release?.commitSha"><span class="muted">Commit</span><code :title="d.release.commitSha">{{ d.release.sourceRef?.replace(/^\w+:/, '') ?? '' }} @ {{ d.release.commitSha.slice(0, 7) }}</code></div>
      <div v-if="OPTION_LABELS.length"><span class="muted">Options</span>{{ OPTION_LABELS.join(', ') }}</div>
      <div><span class="muted">Démarré</span>{{ fmt(d.startedAt) }}</div>
      <div><span class="muted">Durée</span>{{ duration ?? '—' }}</div>
      <div v-if="d.release?.sourceTreeSha256"><span class="muted">Empreinte des sources</span><code class="trunc" :title="d.release.sourceTreeSha256">{{ d.release.sourceTreeSha256.slice(0, 16) }}…</code></div>
      <div v-if="d.release?.remotePath" class="path"><span class="muted">Répertoire de la release</span><code class="trunc" :title="d.release.remotePath">{{ d.release.remotePath }}</code></div>
    </div>

    <UiProgressSteps v-if="steps" class="timeline" title="Étapes" :steps="steps" :horizontal="!ACTIVE_STATUS.includes(d.status)" />
    <p v-else-if="d.error" class="alert" role="alert">{{ d.error }}</p>

    <UiTabs v-model="tab" :tabs="tabs" />
    <LogViewer v-show="tab === 'logs'" :key="d.id" :deployment-id="d.id" :live="ACTIVE_STATUS.includes(d.status)" />
    <pre v-if="tab === 'final'" class="yaml mono card">{{ release?.composeFinal }}</pre>
    <DiffView v-if="tab === 'diff' && release?.composeDiff" :diff="release.composeDiff" />
    <section v-if="tab === 'analysis' && release" class="card pad">
      <h3>Modifications apportées</h3>
      <ul><li v-for="(c, k) in release.analysis.changes ?? []" :key="k"><strong v-if="c.service">{{ c.service }} : </strong>{{ c.message }}</li></ul>
      <h3>Ports publiés</h3>
      <p v-if="!(release.analysis.ports ?? []).length" class="muted">Aucun.</p>
      <ul><li v-for="(p, k) in release.analysis.ports ?? []" :key="k">{{ p.service }} — {{ p.published }}/{{ p.protocol }} ({{ p.policy }})</li></ul>
      <template v-if="(release.analysis.approvals ?? []).length">
        <h3>Ports validés manuellement</h3>
        <ul><li v-for="(a, k) in release.analysis.approvals" :key="k">{{ a.service }}:{{ a.published }} — « {{ a.justification }} »</li></ul>
      </template>
      <h3>Images</h3>
      <ul><li v-for="(img, svc) in release.images" :key="svc"><strong>{{ svc }}</strong> : <code>{{ img }}</code></li></ul>
    </section>

    <UiModal v-if="d?.release" v-model:open="relaunchOpen" :title="`Relancer le déploiement — release #${d.release.number}`" width="580px">
      <p class="small">
        Même release{{ d.release.commitSha ? ` (commit ${d.release.commitSha.slice(0, 7)})` : '' }} : Compose, source et ports approuvés repris, revalidés avec les politiques et variables en vigueur.
        <template v-if="!d.release.current"><br><strong>Cette release n'est pas la release active :</strong> elle la remplacera si le déploiement réussit.</template>
      </p>
      <div class="opts">
        <label v-if="d.release.builds" class="check"><input v-model="relaunch.rebuild" type="checkbox" aria-label="Reconstruire les images"> <span><strong>Reconstruire les images</strong> ({{ d.release.builds }} service(s) construit(s)) <span class="muted">— sinon les images déjà construites sont reprises ; une image absente de l'hôte est reconstruite</span></span></label>
        <label v-if="d.release.builds && relaunch.rebuild" class="check sub"><input v-model="relaunch.cleanBuild" type="checkbox" aria-label="Build propre"> <span><strong>Build propre</strong> : images de base (FROM) récupérées à nouveau, sans cache</span></label>
        <p v-if="!d.release.builds" class="muted small">Aucune image construite par la console dans cette release.</p>
        <label class="check"><input v-model="relaunch.pull" type="checkbox" aria-label="Récupérer à nouveau les images des registres"> <span><strong>Récupérer à nouveau les images des registres</strong> <span class="muted">(tags flottants mis à jour)</span></span></label>
      </div>
      <p v-if="d.environment.isProduction" class="warn-note small">Environnement de production.</p>
      <template #footer>
        <UiButton variant="ghost" @click="relaunchOpen = false">Annuler</UiButton>
        <UiButton variant="primary" :loading="relaunching" @click="submitRelaunch">Relancer</UiButton>
      </template>
    </UiModal>
  </div>
</template>

<style scoped>
.title { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.small { font-size: 12.5px; }
.gate { display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-3) var(--space-4); margin-bottom: var(--space-3); font-size: 13px; }
.gate.pending { border-color: color-mix(in srgb, var(--warning) 55%, var(--border)); }
.decide { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.decide .input { max-width: 320px; }
.facts { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: var(--space-2) var(--space-4); padding: var(--space-3) var(--space-4); margin-bottom: var(--space-3); font-size: 13px; }
.facts .path { grid-column: span 2; min-width: 0; }
.trunc { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.facts div { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.facts .wide { grid-column: 1 / -1; }
.facts code { word-break: break-all; }
.muted { font-size: 12px; }
.yaml { margin: 0; padding: var(--space-4); max-height: 600px; overflow: auto; font-size: 12.5px; white-space: pre; }
.pad { padding: var(--space-5); }
.pad h3 { margin: var(--space-3) 0 var(--space-2); font-size: 14px; }
.pad ul { margin: 0; padding-left: var(--space-5); }
.timeline { margin-bottom: var(--space-3); }
.alert { background: var(--danger-bg); color: var(--danger); padding: var(--space-3) var(--space-4); border-radius: var(--radius); margin: 0 0 var(--space-4); }
.ack-note { font-size: 12.5px; color: var(--success); }
.opts { display: flex; flex-direction: column; gap: var(--space-2); margin: var(--space-3) 0; }
.check { display: flex; gap: var(--space-2); align-items: flex-start; font-size: 13px; }
.check.sub { margin-left: var(--space-5); }
.warn-note { color: var(--warning, var(--danger)); }
.h-meta { display: inline-flex; flex-wrap: wrap; gap: 6px 8px; align-items: center; }
</style>
