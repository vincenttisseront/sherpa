<script setup lang="ts">
/**
 * Plan d'adressage d'un serveur : tous les réseaux Docker de l'hôte, leurs sous-réseaux et leurs
 * problèmes ; déplacement d'un réseau (ou de tous les réseaux à corriger) vers la plage.
 */
import type { AddressPlanDto, NetworkMovePlan, NetworkMoveResult, PlannedNetwork } from '#shared/schemas/address-plan'
import { ArrowRightLeft, TriangleAlert } from 'lucide-vue-next'

const props = defineProps<{ endpointId: string, canManage: boolean }>()
const toast = useToast()
const { data, error, refresh } = useFetch<AddressPlanDto>(() => `/api/endpoints/${props.endpointId}/address-plan`, { server: false, lazy: true })

// Relecture explicite (pas l'état de useFetch : différent entre rendu serveur et client).
const reloading = ref(false)
async function reload() {
  reloading.value = true
  await refresh()
  reloading.value = false
}
const showSystem = ref(false)
const onlyIssues = ref(false)
const rows = computed(() => (data.value?.networks ?? []).filter(n => (showSystem.value || n.owner.kind !== 'system') && (!onlyIssues.value || n.issues.length)))
const toFix = computed(() => (data.value?.networks ?? []).filter(n => n.movable && n.issues.length && !n.inPool))
const OWNER: Record<string, string> = { project: 'Projet', compose: 'Stack externe', platform: 'Plateforme', standalone: 'Réseau autonome', system: 'Système' }
const ISSUE_TONE = { avoid: 'danger', overlap: 'danger', oversized: 'warning' } as const

// --- Déplacement d'un réseau ---
const moving = ref<PlannedNetwork | null>(null)
const moveOpen = computed({ get: () => !!moving.value, set: (v) => { if (!v) moving.value = null } })
const target = ref<'pool' | 'custom'>('pool')
const custom = ref('')
const preview = ref<NetworkMovePlan | null>(null)
const busy = ref(false)
const result = ref<string[] | null>(null)

async function openMove(n: PlannedNetwork) {
  moving.value = n
  // Plage relue : elle a pu être définie ou modifiée depuis l'affichage du plan.
  await refresh()
  target.value = data.value?.pool ? 'pool' : 'custom'
  custom.value = ''
  preview.value = null
  result.value = null
  void previewMove()
}
async function call(dryRun: boolean): Promise<NetworkMoveResult> {
  return $fetch<NetworkMoveResult>(`/api/endpoints/${props.endpointId}/address-plan/move`, {
    method: 'POST',
    body: { network: moving.value!.name, subnet: target.value === 'custom' ? custom.value || null : null, dryRun },
  })
}
async function previewMove() {
  if (target.value === 'custom' && !custom.value) {
    preview.value = null
    return
  }
  busy.value = true
  try {
    preview.value = (await call(true)).plan
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    busy.value = false
  }
}
async function doMove() {
  busy.value = true
  try {
    const r = await call(false)
    if (r.deploymentId) {
      toast.success(`Sous-réseau ${r.plan.to} fixé : redéploiement du projet lancé`)
      moving.value = null
      await navigateTo(`/deployments/${r.deploymentId}`)
      return
    }
    result.value = r.log ?? []
    toast.success(`${r.plan.network} déplacé en ${r.plan.to}`)
    await refresh()
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    busy.value = false
  }
}

// --- Déplacement groupé ---
interface BulkMove { network: string, from: string[], to: string | null, mode: string | null, owner: string, error?: string }
const bulk = ref<{ moves: BulkMove[], deployments: string[], done: boolean } | null>(null)
const bulkOpen = computed({ get: () => !!bulk.value, set: (v) => { if (!v) bulk.value = null } })
async function bulkPlan() {
  busy.value = true
  try {
    bulk.value = { ...(await $fetch<{ moves: BulkMove[], deployments: string[] }>(`/api/endpoints/${props.endpointId}/address-plan/move-all`, { method: 'POST', body: { dryRun: true } })), done: false }
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    busy.value = false
  }
}
async function bulkRun() {
  busy.value = true
  try {
    bulk.value = { ...(await $fetch<{ moves: BulkMove[], deployments: string[] }>(`/api/endpoints/${props.endpointId}/address-plan/move-all`, { method: 'POST', body: { dryRun: false } })), done: true }
    const failed = bulk.value.moves.filter(m => m.error).length
    if (failed) toast.error(`${failed} réseau(x) non déplacé(s) : voir le détail`)
    else toast.success(`Réseaux déplacés ; ${bulk.value.deployments.length} projet(s) en cours de redéploiement`)
    await refresh()
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="ap">
    <div class="bar">
      <span v-if="data?.pool" class="small">Plage <code>{{ data.pool.base }}</code> en /{{ data.pool.prefix }}<template v-if="data.poolUsage"> · {{ data.poolUsage.used }} / {{ data.poolUsage.capacity }} utilisés</template></span>
      <span v-else class="muted small">Aucune plage : définir la plage ci-dessous pour déplacer les réseaux vers des sous-réseaux plus petits.</span>
      <span class="spacer" />
      <label class="check small"><input v-model="onlyIssues" type="checkbox"> À corriger</label>
      <label class="check small"><input v-model="showSystem" type="checkbox"> Réseaux système</label>
      <UiButton size="sm" variant="ghost" :loading="reloading" @click="reload">Relire</UiButton>
      <UiButton v-if="canManage && data?.pool && toFix.length" size="sm" variant="primary" :loading="busy && !moving" @click="bulkPlan"><ArrowRightLeft :size="13" /> Tout corriger ({{ toFix.length }})…</UiButton>
    </div>
    <p v-if="error" class="alert">{{ apiError(error).message }}</p>
    <p v-else-if="!data" class="muted small">Lecture des réseaux de l'hôte…</p>
    <div v-else class="scroll">
      <table class="table">
        <thead><tr><th>Réseau</th><th>Sous-réseau</th><th>Conteneurs</th><th>Propriétaire</th><th>Problèmes</th><th /></tr></thead>
        <tbody>
          <tr v-if="!rows.length"><td colspan="6" class="muted">Aucun réseau{{ onlyIssues ? ' à corriger' : '' }}</td></tr>
          <tr v-for="n in rows" :key="n.id">
            <td class="mono small">{{ n.name }}</td>
            <td class="mono small">
              <div v-for="s in n.subnets" :key="s">{{ s }}</div>
              <span v-if="!n.subnets.length" class="muted">—</span>
              <UiBadge v-if="n.inPool" tone="success">plage</UiBadge>
              <div v-if="n.addresses !== null" class="muted tiny">{{ n.addresses.toLocaleString('fr-FR') }} adresses</div>
            </td>
            <td class="small"><span :title="n.containers.join(', ')">{{ n.containers.length }}</span></td>
            <td class="small">
              {{ OWNER[n.owner.kind] }}
              <div v-if="n.owner.project" class="muted tiny">{{ n.owner.project }} · {{ n.owner.environment }} · {{ n.owner.network }}</div>
              <div v-else-if="n.owner.stack" class="muted tiny">{{ n.owner.stack }}</div>
            </td>
            <td class="small">
              <div v-for="(i, k) in n.issues" :key="k"><UiBadge :tone="ISSUE_TONE[i.kind]" :title="i.message">{{ i.kind === 'oversized' ? 'surdimensionné' : i.kind === 'avoid' ? 'plage à éviter' : 'recouvrement' }}</UiBadge> <span class="muted tiny">{{ i.message }}</span></div>
            </td>
            <td>
              <UiButton v-if="canManage && n.movable" size="sm" variant="ghost" :title="n.moveMode === 'redeploy' ? 'Sous-réseau fixé puis redéploiement du projet' : 'Recréation en direct, conteneurs reconnectés sans redémarrage'" @click="openMove(n)">Déplacer…</UiButton>
              <span v-else-if="n.notMovableReason && n.owner.kind !== 'system'" class="muted tiny">{{ n.notMovableReason }}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <UiModal v-model:open="moveOpen" :title="`Déplacer ${moving?.name ?? ''}`" width="680px">
      <div v-if="moving" class="mv">
        <p class="small">Actuellement <code>{{ moving.subnets.join(', ') || '—' }}</code> · {{ moving.containers.length }} conteneur(s) · {{ moving.moveMode === 'redeploy' ? 'réseau d\'un projet : sous-réseau fixé puis redéploiement' : 'déplacement en direct : réseau recréé, conteneurs reconnectés sans redémarrage' }}</p>
        <div class="choices">
          <label class="check"><input v-model="target" type="radio" value="pool" :disabled="!data?.pool" @change="previewMove"> <span>Prochain sous-réseau libre de la plage{{ data?.pool ? ` (${data.pool.base}, /${data.pool.prefix})` : ' (aucune plage définie)' }}</span></label>
          <label class="check"><input v-model="target" type="radio" value="custom"> <span>Sous-réseau précis</span></label>
          <input v-if="target === 'custom'" v-model.trim="custom" class="input input-sm mono" aria-label="Sous-réseau précis" placeholder="10.210.4.0/27" @change="previewMove">
        </div>
        <p v-if="busy && !preview" class="muted small">Calcul du plan…</p>
        <template v-if="preview">
          <p class="small"><strong>{{ preview.from.join(', ') || '—' }} → {{ preview.to ?? '?' }}</strong></p>
          <ul v-if="preview.blockers.length" class="alert list"><li v-for="b in preview.blockers" :key="b">{{ b }}</li></ul>
          <ol class="steps small"><li v-for="s in preview.steps" :key="s">{{ s }}</li></ol>
          <ul v-if="preview.warnings.length" class="warn list small"><li v-for="w in preview.warnings" :key="w"><TriangleAlert :size="12" /> {{ w }}</li></ul>
          <div v-if="preview.containers.length" class="muted tiny">Conteneurs : {{ preview.containers.map(c => `${c.name}${c.running ? '' : ' (arrêté)'}`).join(', ') }}</div>
        </template>
        <pre v-if="result" class="mono small out">{{ result.join('\n') }}</pre>
      </div>
      <template #footer>
        <UiButton variant="ghost" @click="moving = null">{{ result ? 'Fermer' : 'Annuler' }}</UiButton>
        <UiButton v-if="!result" variant="primary" :loading="busy && !!preview" :disabled="!preview || preview.blockers.length > 0" @click="doMove">{{ moving?.moveMode === 'redeploy' ? 'Fixer et redéployer' : 'Déplacer maintenant' }}</UiButton>
      </template>
    </UiModal>

    <UiModal v-model:open="bulkOpen" title="Corriger les sous-réseaux" width="820px">
      <div v-if="bulk" class="mv">
        <p class="small">Réseaux surdimensionnés ou en conflit, déplacés vers la plage. Réseaux autonomes et stacks externes : en direct, l'un après l'autre. Projets de la console : sous-réseaux fixés puis un seul redéploiement par projet.</p>
        <table class="table">
          <thead><tr><th>Réseau</th><th>Propriétaire</th><th>Actuel</th><th>Cible</th><th>Mode</th><th /></tr></thead>
          <tbody>
            <tr v-for="m in bulk.moves" :key="m.network">
              <td class="mono small">{{ m.network }}</td>
              <td class="small">{{ m.owner }}</td>
              <td class="mono small">{{ m.from.join(', ') }}</td>
              <td class="mono small">{{ m.to ?? '—' }}</td>
              <td class="small">{{ m.mode === 'redeploy' ? 'redéploiement' : 'en direct' }}</td>
              <td class="small"><span v-if="m.error" class="err">{{ m.error }}</span><span v-else-if="bulk.done" class="ok">fait</span></td>
            </tr>
          </tbody>
        </table>
        <p v-if="bulk.done && bulk.deployments.length" class="small">Redéploiements lancés : <NuxtLink v-for="d in bulk.deployments" :key="d" :to="`/deployments/${d}`" class="dep">{{ d.slice(0, 8) }}</NuxtLink></p>
      </div>
      <template #footer>
        <UiButton variant="ghost" @click="bulk = null">{{ bulk?.done ? 'Fermer' : 'Annuler' }}</UiButton>
        <UiButton v-if="bulk && !bulk.done" variant="primary" :loading="busy" :disabled="!bulk.moves.some(m => m.to && !m.error)" @click="bulkRun">Déplacer {{ bulk.moves.filter(m => m.to && !m.error).length }} réseau(x)</UiButton>
      </template>
    </UiModal>
  </div>
</template>

<style scoped>
.ap { display: flex; flex-direction: column; gap: var(--space-3); }
.bar { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.spacer { flex: 1; }
.scroll { overflow-x: auto; }
.check { display: inline-flex; gap: 6px; align-items: center; }
.small { font-size: 12.5px; }
.tiny { font-size: 11.5px; }
.mv { display: flex; flex-direction: column; gap: var(--space-3); }
.choices { display: flex; flex-direction: column; gap: 6px; font-size: 13px; }
.steps { margin: 0; padding-left: 20px; }
.list { margin: 0; padding-left: 20px; }
.warn { color: var(--warning); }
.err { color: var(--danger); }
.ok { color: var(--success); }
.dep { margin-right: 8px; }
p { margin: 0; }
.alert { padding: var(--space-2) var(--space-3); border-radius: var(--radius); background: var(--danger-bg); color: var(--danger); }
.out { margin: 0; padding: var(--space-2); background: var(--surface-2); border-radius: var(--radius); white-space: pre-wrap; }
</style>
