<script setup lang="ts">
/**
 * Déploiement au push GitHub : adresse et secret du webhook du projet, environnements qui déploient
 * (et sur quelle branche), dernières livraisons reçues. Le secret n'est affiché qu'une fois, à sa génération.
 */
import type { ProjectWebhookDto, TargetWebhookInput, WebhookDeliveryDto } from '#shared/schemas/webhook'
import { Copy, RefreshCw } from 'lucide-vue-next'

const props = defineProps<{ projectId: string }>()
const toast = useToast()
const confirm = useConfirm()

const { data, refresh } = useFetch<ProjectWebhookDto>(() => `/api/projects/${props.projectId}/webhook`, { server: false, lazy: true })
const secret = ref<string | null>(null)
const busy = ref(false)
const saving = ref<string | null>(null)
// Saisie de branche par environnement (enregistrée à la sortie du champ).
const branches = reactive<Record<string, string>>({})
watch(() => data.value?.targets, (ts) => {
  for (const t of ts ?? []) branches[t.targetId] ??= t.webhook?.branch ?? ''
}, { immediate: true })

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(`${what} copié`)
  }
  catch {
    toast.error('Copie impossible : sélectionner le texte')
  }
}

async function generate() {
  if (data.value?.configured && !(await confirm({ title: 'Remplacer le secret du webhook', message: 'L\'ancien secret cesse de fonctionner aussitôt : le nouveau doit être saisi dans GitHub (Settings › Webhooks) pour que les livraisons soient acceptées.', confirmLabel: 'Remplacer', danger: true }))) return
  busy.value = true
  try {
    secret.value = (await $fetch<{ secret: string }>(`/api/projects/${props.projectId}/webhook`, { method: 'POST' })).secret
    await refresh()
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    busy.value = false
  }
}

async function remove() {
  if (!(await confirm({ title: 'Supprimer le webhook', message: 'Les livraisons de GitHub seront refusées. Le webhook côté GitHub n\'est pas supprimé : le retirer de Settings › Webhooks.', confirmLabel: 'Supprimer', danger: true }))) return
  busy.value = true
  try {
    await $fetch(`/api/projects/${props.projectId}/webhook`, { method: 'DELETE' })
    secret.value = null
    await refresh()
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    busy.value = false
  }
}

async function save(targetId: string, patch: Partial<TargetWebhookInput>) {
  const t = data.value?.targets.find(x => x.targetId === targetId)
  if (!t) return
  saving.value = targetId
  try {
    const body: TargetWebhookInput = { enabled: t.webhook?.enabled ?? false, branch: (branches[targetId] ?? '').trim() || null, cleanBuild: t.webhook?.cleanBuild ?? false, ...patch }
    await $fetch(`/api/targets/${targetId}/webhook`, { method: 'PUT', body })
    await refresh()
  }
  catch (err) {
    const e = apiError(err)
    toast.error(Object.values(e.errors)[0] ?? e.message)
    await refresh()
  }
  finally {
    saving.value = null
  }
}

const OUTCOME = { accepted: { label: 'en cours', tone: 'info' }, done: { label: 'traitée', tone: 'success' }, ignored: { label: 'ignorée', tone: 'neutral' }, error: { label: 'échec', tone: 'danger' } } as const
const RESULT = { started: 'déploiement lancé', 'up-to-date': 'déjà à jour', waiting: 'en attente', skipped: 'ignoré', error: 'échec' } as const
const short = (d: WebhookDeliveryDto) => (d.sha ? `${d.ref ?? ''} @ ${d.sha.slice(0, 7)}` : d.ref ?? '')
const needsTagEvent = computed(() => data.value?.github?.refType === 'tag')
</script>

<template>
  <section class="webhook">
    <div class="head">
      <h3>Déploiement au push GitHub</h3>
      <UiButton size="sm" variant="ghost" aria-label="Actualiser" @click="refresh()"><RefreshCw :size="13" /> Actualiser</UiButton>
    </div>
    <p class="muted small">
      À chaque push sur une branche suivie, GitHub appelle Sherpa : l'environnement concerné est reconstruit sur le dernier commit et déployé, puis le résultat est publié sur le commit (statut « Deployments » de GitHub).
      Mettre <code>[skip deploy]</code> dans le message d'un commit pour ne pas déployer.
    </p>

    <p v-if="data && !data.github" class="muted">Ce projet ne suit pas de dépôt GitHub (onglet Source) : rien à déclencher.</p>

    <template v-else-if="data">
      <div class="box">
        <div class="row">
          <span class="lbl">Payload URL</span>
          <code class="val" data-testid="webhook-url">{{ data.url }}</code>
          <UiButton size="sm" variant="ghost" aria-label="Copier l'adresse du webhook" @click="copy(data.url, 'Adresse')"><Copy :size="13" /></UiButton>
        </div>
        <p v-if="secret" class="secret" role="status">
          <strong>Secret (affiché une seule fois)</strong>
          <code class="val" data-testid="webhook-secret">{{ secret }}</code>
          <UiButton size="sm" aria-label="Copier le secret" @click="copy(secret, 'Secret')"><Copy :size="13" /> Copier</UiButton>
        </p>
        <p class="muted small">
          Dans GitHub (<em>{{ data.github?.repository }}</em> › Settings › Webhooks › Add webhook) : <strong>Payload URL</strong> ci-dessus, <strong>Content type</strong> <code>application/json</code>, <strong>Secret</strong> ci-dessus,
          évènements : <strong>{{ needsTagEvent ? 'Releases (et Pushes pour les environnements qui suivent une branche)' : 'Just the push event' }}</strong>.
        </p>
        <div class="actions">
          <UiButton size="sm" :variant="data.configured ? 'secondary' : 'primary'" :loading="busy" @click="generate">{{ data.configured ? 'Remplacer le secret…' : 'Générer le secret' }}</UiButton>
          <UiButton v-if="data.configured" size="sm" variant="ghost" :loading="busy" @click="remove">Supprimer le webhook…</UiButton>
          <span v-if="data.configured" class="muted small">{{ data.lastDeliveryAt ? `Dernière livraison ${fmtRelative(data.lastDeliveryAt)}` : 'Aucune livraison reçue' }}</span>
        </div>
        <p v-if="data.statusReporting === 'no-token'" class="warn small">La source du projet n'a pas de jeton : les déploiements fonctionnent (dépôt public) mais le statut ne sera pas publié sur GitHub. Un jeton avec <em>Deployments : Read and write</em> est nécessaire.</p>
      </div>

      <table class="table">
        <thead><tr><th>Environnement</th><th>Déployer au push</th><th>Branche suivie</th><th>Build propre</th></tr></thead>
        <tbody>
          <tr v-for="t in data.targets" :key="t.targetId">
            <td>{{ t.environmentName }}<UiBadge v-if="t.isProduction" tone="danger"> prod</UiBadge></td>
            <td><UiSwitch :model-value="t.webhook?.enabled ?? false" :label="`Déploiement au push pour ${t.environmentName}`" :disabled="saving === t.targetId" @update:model-value="save(t.targetId, { enabled: $event })" /></td>
            <td>
              <input v-model.trim="branches[t.targetId]" class="input mono sm" :placeholder="t.effectiveBranch && !t.webhook?.branch ? `${t.effectiveBranch} (source du projet)` : 'ex. main'" :aria-label="`Branche suivie par ${t.environmentName}`" spellcheck="false" @change="save(t.targetId, {})">
            </td>
            <td><label class="small"><input type="checkbox" :checked="t.webhook?.cleanBuild ?? false" :aria-label="`Build propre pour ${t.environmentName}`" @change="save(t.targetId, { cleanBuild: ($event.target as HTMLInputElement).checked })"> images de base récupérées à nouveau</label></td>
          </tr>
        </tbody>
      </table>

      <h4>Dernières livraisons</h4>
      <p v-if="!data.deliveries.length" class="muted small">Aucune livraison. Après avoir créé le webhook dans GitHub, l'évènement « ping » de test apparaît ici.</p>
      <table v-else class="table deliveries">
        <thead><tr><th>Reçue</th><th>Évènement</th><th>Référence</th><th>Résultat</th></tr></thead>
        <tbody>
          <tr v-for="d in data.deliveries" :key="d.id">
            <td class="small">{{ fmtRelative(d.createdAt) }}</td>
            <td class="small">{{ d.event }}</td>
            <td class="small mono">{{ short(d) }}</td>
            <td>
              <UiBadge :tone="OUTCOME[d.outcome].tone">{{ OUTCOME[d.outcome].label }}</UiBadge>
              <span v-if="d.detail" class="muted small"> {{ d.detail }}</span>
              <div v-for="r in d.results" :key="r.targetId" class="small">
                {{ r.environment }} : {{ RESULT[r.outcome] }}<template v-if="r.message"> — {{ r.message }}</template>
                <NuxtLink v-if="r.deploymentId" :to="`/deployments/${r.deploymentId}`"> voir</NuxtLink>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </template>
  </section>
</template>

<style scoped>
.webhook { display: flex; flex-direction: column; gap: var(--space-3); margin-top: var(--space-5); padding-top: var(--space-4); border-top: 1px solid var(--border); }
.head { display: flex; justify-content: space-between; align-items: center; }
h3 { margin: 0; font-size: 15px; }
h4 { margin: var(--space-2) 0 0; font-size: 13.5px; }
.small { font-size: 12.5px; margin: 0; }
.box { border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-2); padding: var(--space-3); display: flex; flex-direction: column; gap: var(--space-2); }
.row { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.lbl { font-size: 12.5px; color: var(--text-muted); min-width: 80px; }
.val { word-break: break-all; font-size: 12.5px; }
.secret { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; margin: 0; padding: var(--space-2) var(--space-3); border: 1px solid color-mix(in srgb, var(--warning) 45%, var(--border)); border-radius: var(--radius); background: var(--surface); }
.actions { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.warn { color: var(--warning); margin: 0; }
.table { width: 100%; border-collapse: collapse; font-size: 13px; }
.table th { text-align: left; font-size: 11px; text-transform: uppercase; color: var(--text-muted); padding: 4px 6px; border-bottom: 1px solid var(--border); }
.table td { padding: 6px; border-bottom: 1px solid var(--border); vertical-align: top; }
.sm { max-width: 240px; }
</style>
