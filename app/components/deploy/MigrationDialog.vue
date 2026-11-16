<script setup lang="ts">
/**
 * Migration de la stack vers un autre serveur géré : choix du serveur, plan (données copiées et
 * leur taille, empêchements et ce qu'il faut faire pour les lever, alertes de l'analyse sur la
 * cible), confirmation par le nom de la stack, puis suivi dans le déploiement.
 */
import type { MigrationDestination, MigrationPlan } from '#shared/schemas/migration'
import { formatBytes } from '#shared/utils/format'
import { ServerCog } from 'lucide-vue-next'

const props = defineProps<{ targetId: string, stackName: string, serverName: string }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ started: [deploymentId: string] }>()
const toast = useToast()

const { data: destinations, error: destError } = useFetch<MigrationDestination[]>(() => `/api/targets/${props.targetId}/migration/destinations`, { server: false, lazy: true })
const to = ref('')
watch(destinations, (d) => {
  if (!to.value) to.value = d?.find(x => !x.unavailable)?.endpointId ?? ''
}, { immediate: true })

const plan = ref<MigrationPlan | null>(null)
const planError = ref<string | null>(null)
const loading = ref(false)
const selected = ref<string[]>([])
async function loadPlan() {
  plan.value = null
  planError.value = null
  if (!to.value) return
  loading.value = true
  try {
    plan.value = await $fetch<MigrationPlan>(`/api/targets/${props.targetId}/migration`, { query: { to: to.value } })
    selected.value = plan.value.items.filter(i => i.selected).map(i => i.id)
  }
  catch (err) {
    planError.value = apiError(err).message
  }
  finally {
    loading.value = false
  }
}
watch(to, () => void loadPlan())

const total = computed(() => plan.value?.items.filter(i => i.required || selected.value.includes(i.id)).reduce((n, i) => n + (i.sizeBytes ?? 0), 0) ?? 0)
const tooBig = computed(() => plan.value?.freeBytes != null && total.value + 512 * 1024 * 1024 > plan.value.freeBytes)
const confirmText = ref('')
const busy = ref(false)
const KIND = { release: 'release', data: 'données', volume: 'volume', bind: 'dossier' } as const

async function run() {
  busy.value = true
  try {
    const r = await $fetch<{ deploymentId: string }>(`/api/targets/${props.targetId}/migration`, {
      method: 'POST',
      body: { endpointId: to.value, items: selected.value, confirm: confirmText.value },
      headers: { 'Idempotency-Key': crypto.randomUUID() },
    })
    toast.success(`Migration lancée vers ${plan.value?.to.serverName}`)
    open.value = false
    emit('started', r.deploymentId)
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
  <UiModal v-model:open="open" :title="`Migrer ${stackName} vers un autre serveur`" width="820px">
    <div class="mig">
      <p class="lead small"><ServerCog :size="16" class="ico" /> La stack est préparée sur le serveur choisi (fichiers, images) pendant qu'elle tourne encore sur {{ serverName }}. Elle n'y est arrêtée que le temps de copier ses données, puis démarre sur la cible. En cas d'échec, elle redémarre sur {{ serverName }} avec ses données intactes.</p>
      <p v-if="destError" class="alert">{{ apiError(destError).message }}</p>
      <UiField label="Serveur de destination" for="mig-to">
        <select id="mig-to" v-model="to" class="input">
          <option value="" disabled>Choisir un serveur…</option>
          <option v-for="d in destinations ?? []" :key="d.endpointId" :value="d.endpointId" :disabled="!!d.unavailable">
            {{ d.serverName }} / {{ d.endpointName }}{{ d.unavailable ? ` — ${d.unavailable}` : '' }}
          </option>
        </select>
      </UiField>
      <p v-if="destinations && !destinations.some(d => !d.unavailable)" class="muted small">Aucun autre serveur ne peut accueillir cette stack : les raisons sont indiquées dans la liste.</p>

      <p v-if="loading" class="muted small">Analyse sur la cible et mesure des données…</p>
      <p v-if="planError" class="alert">{{ planError }}</p>
      <template v-if="plan">
        <ul v-if="plan.blockers.length" class="alert list" aria-label="Empêchements">
          <li v-for="b in plan.blockers" :key="b">{{ b }}</li>
        </ul>
        <section v-if="plan.items.length">
          <h3>Données copiées</h3>
          <table class="items">
            <thead><tr><th /><th>Élément</th><th>Services</th><th class="num">Taille</th></tr></thead>
            <tbody>
              <tr v-for="i in plan.items" :key="i.id">
                <td><input v-model="selected" type="checkbox" :value="i.id" :disabled="i.required || i.isFile" :aria-label="`Copier ${i.label}`"></td>
                <td>
                  <UiBadge tone="neutral">{{ KIND[i.kind] }}</UiBadge> {{ i.label }}
                  <div class="mono muted tiny">{{ i.source }}<template v-if="i.destination !== i.source"> → {{ i.destination }}</template></div>
                  <div v-if="i.note" class="muted tiny">{{ i.note }}</div>
                </td>
                <td class="small">{{ i.services.join(', ') || '—' }}</td>
                <td class="num small">{{ i.sizeBytes === null ? '?' : formatBytes(i.sizeBytes) }}</td>
              </tr>
            </tbody>
          </table>
          <p class="small" :class="{ danger: tooBig }">
            À copier : <strong>{{ formatBytes(total) }}</strong><template v-if="plan.freeBytes !== null"> · libre sur {{ plan.to.serverName }} : {{ formatBytes(plan.freeBytes) }}</template>
            <template v-if="tooBig"> — espace insuffisant : décocher des éléments ou libérer de la place</template>
          </p>
        </section>
        <section v-if="plan.warnings.length">
          <h3>Alertes de l'analyse sur {{ plan.to.serverName }}</h3>
          <ul class="small warn"><li v-for="w in plan.warnings" :key="w">{{ w }}</li></ul>
        </section>
        <ul v-if="plan.notes.length" class="muted small notes">
          <li v-for="n in plan.notes" :key="n">{{ n }}</li>
        </ul>
        <UiField :label="`Saisir le nom de la stack (${stackName}) pour confirmer`" for="mig-confirm">
          <input id="mig-confirm" v-model.trim="confirmText" class="input input-sm mono" autocomplete="off" :placeholder="stackName">
        </UiField>
      </template>
    </div>
    <template #footer>
      <UiButton variant="ghost" @click="open = false">Annuler</UiButton>
      <UiButton variant="primary" :loading="busy" :disabled="!plan || plan.blockers.length > 0 || tooBig || confirmText !== stackName" @click="run">Migrer vers {{ plan?.to.serverName ?? '…' }}</UiButton>
    </template>
  </UiModal>
</template>

<style scoped>
.mig { display: flex; flex-direction: column; gap: var(--space-3); }
.lead { display: flex; gap: 8px; align-items: flex-start; margin: 0; }
.ico { flex: none; color: var(--primary); margin-top: 1px; }
h3 { font-size: 13px; margin: 0 0 var(--space-2); }
.items { width: 100%; border-collapse: collapse; font-size: 13px; }
.items th { text-align: left; font-weight: 600; color: var(--text-muted); font-size: 12px; padding: 4px 6px; }
.items td { padding: 6px; border-top: 1px solid var(--border); vertical-align: top; }
.items .num { text-align: right; white-space: nowrap; }
.mono { overflow-wrap: anywhere; }
.tiny { font-size: 11.5px; }
.small { font-size: 12.5px; }
.danger { color: var(--danger); }
.warn { margin: 0; padding-left: 18px; color: var(--warning); }
.notes { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 3px; }
.alert { margin: 0; padding: var(--space-2) var(--space-3); border-radius: var(--radius); background: var(--danger-bg); color: var(--danger); }
.alert.list { padding-left: 28px; }
</style>
