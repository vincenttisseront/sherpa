<script setup lang="ts">
import { RefreshCw } from 'lucide-vue-next'
/** Canaux de notification (§18) et historique des envois. */
import type { Paginated } from '#shared/schemas/common'
import { type ChannelDto, type ChannelKind, type DeliveryDto, EVENT_LABEL, KIND_LABEL, NOTIFICATION_EVENTS, SELECTABLE_EVENTS, type NotificationEvent } from '#shared/schemas/notifications'
import type { Column, TableState } from '~/types/table'

useHead({ title: 'Notifications' })
const toast = useToast()
const confirm = useConfirm()
const { data, refresh } = await useFetch<{ channels: ChannelDto[], smtp: boolean, webhookHosts: string[] }>('/api/admin/notifications/channels')
const { data: environments } = useEnvironments()

// --- Formulaire (création / modification) ---
interface Form { id: string | null, kind: ChannelKind, name: string, recipients: string, url: string, server: string, topic: string, token: string, digest: 'off' | 'daily' | 'weekly', digestHour: number, events: NotificationEvent[], environmentIds: string[], enabled: boolean, replaceConfig: boolean }
const blank = (): Form => ({ id: null, kind: 'teams_webhook', name: '', recipients: '', url: '', server: 'https://ntfy.sh', topic: '', token: '', digest: 'off', digestHour: 8, events: ['deployment.failed', 'build.failed', 'server.unavailable', 'healthcheck.degraded', 'deployment.rolled_back', 'watchtower.error'], environmentIds: [], enabled: true, replaceConfig: true })
const form = ref<Form>(blank())
const formOpen = ref(false)
const errors = ref<Record<string, string>>({})
const saving = ref(false)

function create() {
  form.value = blank()
  errors.value = {}
  formOpen.value = true
}
function edit(c: ChannelDto) {
  form.value = { ...blank(), id: c.id, kind: c.kind, name: c.name, events: [...c.events], environmentIds: [...c.environmentIds], enabled: c.enabled, digest: c.digest, digestHour: c.digestHour, replaceConfig: false }
  errors.value = {}
  formOpen.value = true
}
function config() {
  const f = form.value
  if (f.kind === 'email') return { recipients: f.recipients.split(/[\s,;]+/).filter(Boolean) }
  if (f.kind === 'ntfy') return { server: f.server.trim(), topic: f.topic.trim(), ...(f.token.trim() ? { token: f.token.trim() } : {}) }
  if (f.kind === 'gotify') return { url: f.url.trim(), token: f.token.trim() }
  return { url: f.url.trim() }
}
const URL_LABEL: Partial<Record<ChannelKind, string>> = { teams_webhook: 'URL du webhook Teams', slack_webhook: 'URL du webhook Slack', discord_webhook: 'URL du webhook Discord', gotify: 'Adresse du serveur Gotify' }
const URL_HINT: Partial<Record<ChannelKind, string>> = {
  teams_webhook: 'Workflow Teams « Publier dans un canal lorsqu\'une requête webhook est reçue ».',
  slack_webhook: 'Webhook entrant d\'une application Slack (https://hooks.slack.com/services/…).',
  discord_webhook: 'Webhook du salon (Paramètres du salon › Intégrations › Webhooks).',
  gotify: 'Adresse du serveur, ex. https://gotify.exemple.fr ; le jeton est celui d\'une application Gotify.',
}
const replaceLabel = computed(() => ({ email: 'les destinataires', ntfy: 'le serveur, le sujet et le jeton', gotify: 'l\'adresse et le jeton' } as Record<string, string>)[form.value.kind] ?? 'l\'URL du webhook')
async function save() {
  saving.value = true
  errors.value = {}
  const f = form.value
  const body = { name: f.name, events: f.events, environmentIds: f.environmentIds, enabled: f.enabled, digest: f.digest, digestHour: f.digestHour }
  try {
    if (f.id) await $fetch<unknown>(`/api/admin/notifications/channels/${f.id}`, { method: 'PATCH', body: { ...body, ...(f.replaceConfig ? { config: config() } : {}) } })
    else await $fetch<unknown>('/api/admin/notifications/channels', { method: 'POST', body: { ...body, kind: f.kind, config: config() } })
    formOpen.value = false
    toast.success('Canal enregistré')
    await refresh()
  }
  catch (err) {
    const e = apiError(err)
    errors.value = e.errors
    toast.error(e.message)
  }
  finally {
    saving.value = false
  }
}
function toggleEvent(e: NotificationEvent) {
  const s = form.value.events
  form.value.events = s.includes(e) ? s.filter(x => x !== e) : [...s, e]
}
function toggleEnv(id: string) {
  const s = form.value.environmentIds
  form.value.environmentIds = s.includes(id) ? s.filter(x => x !== id) : [...s, id]
}

const testing = ref<string | null>(null)
async function test(c: ChannelDto) {
  testing.value = c.id
  try {
    await $fetch<unknown>(`/api/admin/notifications/channels/${c.id}/test`, { method: 'POST' })
    toast.success(`Message de test envoyé sur « ${c.name} »`)
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    testing.value = null
  }
}
async function digestNow(c: ChannelDto) {
  testing.value = c.id
  try {
    const r = await $fetch<{ events: number }>(`/api/admin/notifications/channels/${c.id}/digest`, { method: 'POST' })
    toast.success(r.events ? `Résumé de ${r.events} évènement${r.events > 1 ? 's' : ''} envoyé sur « ${c.name} »` : 'Aucun évènement à résumer depuis le dernier résumé')
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    testing.value = null
  }
}
async function toggle(c: ChannelDto) {
  await $fetch<unknown>(`/api/admin/notifications/channels/${c.id}`, { method: 'PATCH', body: { enabled: !c.enabled } }).catch(err => toast.error(apiError(err).message))
  await refresh()
}
async function remove(c: ChannelDto) {
  if (!await confirm({ title: 'Supprimer le canal', message: `« ${c.name} » ne recevra plus aucune notification. Sa configuration (adresse, URL) est supprimée ; l'historique des envois est conservé.`, confirmLabel: 'Supprimer', danger: true })) return
  await $fetch<unknown>(`/api/admin/notifications/channels/${c.id}`, { method: 'DELETE' }).catch(err => toast.error(apiError(err).message))
  await refresh()
}

const NOTE = "Le filtre d'environnement ne s'applique qu'aux évènements liés à un environnement ; un serveur indisponible, une invitation ou un changement de droits sont envoyés à tous les canaux abonnés."

// --- Historique des envois ---
const dq = ref<TableState>({ page: 1, pageSize: 25, sort: 'createdAt:desc', period: '7d' })
const { data: deliveries, status: dStatus, refresh: refreshDeliveries } = await useFetch<Paginated<DeliveryDto>>('/api/admin/notifications/deliveries', { query: dq, watch: [dq] })
const dColumns: Column<DeliveryDto>[] = [
  { key: 'createdAt', label: 'Date', sortable: true },
  { key: 'event', label: 'Évènement', sortable: true },
  { key: 'title', label: 'Message' },
  { key: 'channelName', label: 'Canal', sortable: true },
  { key: 'status', label: 'Statut', sortable: true },
  { key: 'attempts', label: 'Tentatives', align: 'right', defaultHidden: true },
]
const D_STATUS = { sent: { label: 'Envoyé', tone: 'success' }, failed: { label: 'Échec', tone: 'danger' }, pending: { label: 'En attente', tone: 'info' } } as const
const eventsLabel = (c: ChannelDto) => (c.events.length >= SELECTABLE_EVENTS.length ? 'Tous' : c.events.map(ev => EVENT_LABEL[ev]).join(', '))
const envName = (id: string) => environments.value?.find(e => e.id === id)?.name ?? id
</script>

<template>
  <div>
    <UiPageHeader title="Administration" icon="settings"><template #nav><AdminNav /></template></UiPageHeader>

    <section class="card pad">
      <div class="bar">
        <h2>Canaux de notification <span class="muted hint" :title="NOTE">ⓘ</span></h2>
        <UiButton variant="primary" size="sm" @click="create">Ajouter un canal</UiButton>
      </div>
      <p v-if="!data?.smtp" class="muted small">Email indisponible : SMTP n'est pas configuré sur cette instance (SMTP_HOST). Les invitations restent remises par lien.</p>
      <table class="table">
        <thead><tr><th>Canal</th><th>Destination</th><th>Évènements</th><th>Environnements</th><th>Dernier envoi</th><th /></tr></thead>
        <tbody>
          <tr v-if="!data?.channels.length"><td colspan="6" class="muted">Aucun canal : aucune notification n'est envoyée (les alertes restent visibles sur le tableau de bord).</td></tr>
          <tr v-for="c in data?.channels ?? []" :key="c.id" :class="{ off: !c.enabled }">
            <td><strong>{{ c.name }}</strong><div class="muted small">{{ KIND_LABEL[c.kind] }}<template v-if="c.digest !== 'off'"> · résumé {{ c.digest === 'daily' ? 'quotidien' : 'hebdomadaire' }} à {{ String(c.digestHour).padStart(2, '0') }}:00</template><template v-if="!c.enabled"> · désactivé</template></div></td>
            <td class="small mono">{{ c.target }}</td>
            <td class="small">{{ eventsLabel(c) }}</td>
            <td class="small">{{ c.environmentIds.length ? c.environmentIds.map(envName).join(', ') : 'Tous' }}</td>
            <td class="small">
              <template v-if="c.lastDelivery">
                <UiBadge :tone="D_STATUS[c.lastDelivery.status as keyof typeof D_STATUS]?.tone ?? 'neutral'">{{ D_STATUS[c.lastDelivery.status as keyof typeof D_STATUS]?.label ?? c.lastDelivery.status }}</UiBadge>
                {{ fmtDateTime(c.lastDelivery.at) }}
                <div v-if="c.lastDelivery.error" class="err">{{ c.lastDelivery.error }}</div>
              </template>
              <span v-else class="muted">—</span>
            </td>
            <td class="actions">
              <UiButton size="sm" :loading="testing === c.id" @click="test(c)">Tester</UiButton>
              <UiButton v-if="c.digest !== 'off'" size="sm" variant="ghost" :loading="testing === c.id" title="Envoie maintenant le résumé des évènements depuis le dernier résumé" @click="digestNow(c)">Résumé maintenant</UiButton>
              <UiButton size="sm" variant="ghost" @click="edit(c)">Modifier</UiButton>
              <UiButton size="sm" variant="ghost" @click="toggle(c)">{{ c.enabled ? 'Désactiver' : 'Activer' }}</UiButton>
              <UiButton size="sm" variant="ghost" @click="remove(c)">Supprimer</UiButton>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <h2 class="section">Historique des envois</h2>
    <UiDataTable v-model:query="dq" table-key="deliveries" :defaults="{ period: '7d' }" export-url="/api/admin/notifications/deliveries" period :columns="dColumns" :rows="deliveries?.items ?? []" :total="deliveries?.total ?? 0" :loading="dStatus === 'pending'" empty-text="Aucun envoi">
      <template #filters>
        <select v-model="dq.status" class="input auto" aria-label="Statut">
          <option :value="undefined">Tous les statuts</option>
          <option v-for="(s, k) in D_STATUS" :key="k" :value="k">{{ s.label }}</option>
        </select>
        <select v-model="dq.event" class="input auto" aria-label="Évènement">
          <option :value="undefined">Tous les évènements</option>
          <option v-for="e in NOTIFICATION_EVENTS" :key="e" :value="e">{{ EVENT_LABEL[e] }}</option>
        </select>
        <UiButton size="sm" variant="ghost" title="Actualiser" aria-label="Actualiser" @click="refreshDeliveries()"><RefreshCw :size="14" aria-hidden="true" /></UiButton>
      </template>
      <template #cell-createdAt="{ row }"><span class="nowrap">{{ fmtDateTime(row.createdAt) }}</span></template>
      <template #cell-event="{ row }">{{ EVENT_LABEL[row.event as NotificationEvent] ?? row.event }}</template>
      <template #cell-channelName="{ row }">{{ row.channelName }} <span class="muted small">{{ KIND_LABEL[row.kind] }}</span></template>
      <template #cell-status="{ row }">
        <UiBadge :tone="D_STATUS[row.status].tone">{{ D_STATUS[row.status].label }}</UiBadge>
        <div v-if="row.error" class="err" :title="row.error">{{ row.error }}</div>
      </template>
    </UiDataTable>

    <UiModal v-model:open="formOpen" :title="form.id ? `Modifier « ${form.name} »` : 'Nouveau canal'" width="620px">
      <form class="form" @submit.prevent="save">
        <UiField v-if="!form.id" label="Type" for="ch-kind" :error="errors.kind">
          <select id="ch-kind" v-model="form.kind" class="input">
            <option value="teams_webhook">{{ KIND_LABEL.teams_webhook }}</option>
            <option value="slack_webhook">{{ KIND_LABEL.slack_webhook }}</option>
            <option value="discord_webhook">{{ KIND_LABEL.discord_webhook }}</option>
            <option value="ntfy">{{ KIND_LABEL.ntfy }}</option>
            <option value="gotify">{{ KIND_LABEL.gotify }}</option>
            <option value="email" :disabled="!data?.smtp">{{ KIND_LABEL.email }}{{ data?.smtp ? '' : ' — SMTP non configuré' }}</option>
            <option value="teams_graph" disabled>{{ KIND_LABEL.teams_graph }} — prévu</option>
          </select>
        </UiField>
        <UiField label="Nom" for="ch-name" :error="errors.name" required>
          <input id="ch-name" v-model="form.name" class="input" maxlength="100" placeholder="Équipe plateforme" required>
        </UiField>
        <label v-if="form.id" class="check"><input v-model="form.replaceConfig" type="checkbox"> Remplacer {{ replaceLabel }}</label>
        <template v-if="form.replaceConfig">
          <UiField v-if="form.kind === 'email'" label="Destinataires" for="ch-to" :error="errors['config.recipients']" hint="Adresses séparées par des virgules ou des espaces">
            <textarea id="ch-to" v-model="form.recipients" class="input" rows="2" placeholder="ops@exemple.fr, astreinte@exemple.fr" />
          </UiField>
          <template v-else-if="form.kind === 'ntfy'">
            <UiField label="Serveur ntfy" for="ch-server" :error="errors['config.server']" :hint="`https://ntfy.sh ou votre serveur. Hôtes autorisés : ${data?.webhookHosts.join(', ')} (variable NOTIFY_WEBHOOK_ALLOWED_HOSTS).`">
              <input id="ch-server" v-model="form.server" class="input mono" type="url" autocomplete="off">
            </UiField>
            <UiField label="Sujet" for="ch-topic" :error="errors['config.topic']" hint="Un sujet difficile à deviner : quiconque le connaît peut le lire sur ntfy.sh.">
              <input id="ch-topic" v-model.trim="form.topic" class="input mono" autocomplete="off" maxlength="64">
            </UiField>
            <UiField label="Jeton d'accès (facultatif)" for="ch-token" :error="errors['config.token']"><input id="ch-token" v-model="form.token" class="input mono" type="password" autocomplete="off"></UiField>
          </template>
          <template v-else>
            <UiField :label="URL_LABEL[form.kind] ?? 'URL'" for="ch-url" :error="errors['config.url']" :hint="`${URL_HINT[form.kind] ?? ''} Hôtes autorisés : ${data?.webhookHosts.join(', ')}. Les secrets sont stockés chiffrés et ne sont plus affichés.`">
              <input id="ch-url" v-model="form.url" class="input mono" type="url" autocomplete="off" placeholder="https://…">
            </UiField>
            <UiField v-if="form.kind === 'gotify'" label="Jeton de l'application" for="ch-gtoken" :error="errors['config.token']"><input id="ch-gtoken" v-model="form.token" class="input mono" type="password" autocomplete="off"></UiField>
          </template>
        </template>
        <UiField label="Envoi" for="ch-digest" hint="En mode résumé, les évènements choisis ne partent pas un par un : un seul message récapitulatif est envoyé (à l'heure de Paris, le lundi pour l'hebdomadaire), seulement s'il y a eu des évènements.">
          <div class="inline">
            <select id="ch-digest" v-model="form.digest" class="input">
              <option value="off">Immédiat (un message par évènement)</option>
              <option value="daily">Résumé quotidien</option>
              <option value="weekly">Résumé hebdomadaire (lundi)</option>
            </select>
            <template v-if="form.digest !== 'off'">
              <label for="ch-hour" class="small">à</label>
              <select id="ch-hour" v-model.number="form.digestHour" class="input hour"><option v-for="h in 24" :key="h" :value="h - 1">{{ String(h - 1).padStart(2, '0') }}:00</option></select>
            </template>
          </div>
        </UiField>
        <fieldset class="group">
          <legend>Évènements</legend>
          <label v-for="e in SELECTABLE_EVENTS" :key="e" class="check"><input type="checkbox" :checked="form.events.includes(e)" @change="toggleEvent(e)"> {{ EVENT_LABEL[e] }}</label>
          <span v-if="errors.events" class="error-text">{{ errors.events }}</span>
        </fieldset>
        <fieldset class="group">
          <legend>Environnements <span class="muted small">(aucun coché : tous)</span></legend>
          <label v-for="e in environments" :key="e.id" class="check"><input type="checkbox" :checked="form.environmentIds.includes(e.id)" @change="toggleEnv(e.id)"> {{ e.name }}</label>
        </fieldset>
        <UiSwitch v-model="form.enabled" label="Canal actif" />
        <div class="form-actions">
          <UiButton variant="ghost" @click="formOpen = false">Annuler</UiButton>
          <UiButton type="submit" variant="primary" :loading="saving">Enregistrer</UiButton>
        </div>
      </form>
    </UiModal>

    <MetricAlertsPanel />
  </div>
</template>

<style scoped>
.inline { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.hour { max-width: 100px; }
.pad { padding: var(--space-3) var(--space-4); display: flex; flex-direction: column; gap: var(--space-2); }
.bar { display: flex; justify-content: space-between; align-items: center; gap: var(--space-3); }
.bar h2 { margin: 0; font-size: 15px; }
.section { margin: var(--space-3) 0 var(--space-2); font-size: 15px; }
.hint { cursor: help; font-size: 13px; font-weight: 400; }
.table { width: 100%; border-collapse: collapse; }
.table th { text-align: left; font-size: 11px; text-transform: uppercase; color: var(--text-muted); padding: 4px 6px; border-bottom: 1px solid var(--border); }
.table td { padding: 4px 6px; border-bottom: 1px solid var(--border); vertical-align: top; }
.table tr.off td { opacity: .6; }
.actions { white-space: nowrap; text-align: right; }
.small { font-size: 12.5px; }
.nowrap { white-space: nowrap; }
.auto { width: auto; max-width: 220px; }
.err { color: var(--danger); font-size: 12px; max-width: 320px; overflow-wrap: anywhere; }
.form { display: flex; flex-direction: column; gap: var(--space-3); }
.group { border: 1px solid var(--border); border-radius: var(--radius); padding: var(--space-3); display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 6px; margin: 0; }
.group legend { font-size: 13px; font-weight: 600; padding: 0 4px; }
.check { display: flex; gap: 6px; align-items: center; font-size: 13px; }
.error-text { color: var(--danger); font-size: 12px; grid-column: 1 / -1; }
.form-actions { display: flex; justify-content: flex-end; gap: var(--space-2); }
</style>
