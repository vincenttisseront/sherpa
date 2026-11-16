<script setup lang="ts">
/** Étape 4 : canaux Teams et email pour les alertes critiques, avec envoi de test. */
import type { OnboardingFacts } from '#shared/schemas/onboarding'

defineProps<{ facts: OnboardingFacts }>()
const emit = defineEmits<{ changed: [] }>()
const toast = useToast()

/** Abonnement de départ : ce qui demande une action. */
const CRITICAL = ['deployment.failed', 'build.failed', 'server.unavailable', 'healthcheck.degraded', 'deployment.rolled_back', 'watchtower.error', 'permissions.changed']
const teams = reactive({ name: 'Équipe plateforme (Teams)', url: '' })
const mail = reactive({ name: 'Équipe plateforme (email)', recipients: '' })
const errors = ref<Record<string, string>>({})
const busy = ref<string | null>(null)

async function create(kind: 'teams_webhook' | 'email') {
  busy.value = kind
  errors.value = {}
  try {
    const body = kind === 'teams_webhook'
      ? { kind, name: teams.name, config: { url: teams.url.trim() }, events: CRITICAL }
      : { kind, name: mail.name, config: { recipients: mail.recipients.split(/[\s,;]+/).filter(Boolean) }, events: CRITICAL }
    const { id } = await $fetch<{ id: string }>('/api/admin/notifications/channels', { method: 'POST', body })
    if (kind === 'teams_webhook') teams.url = ''
    else mail.recipients = ''
    emit('changed')
    await test(id, body.name)
  }
  catch (err) {
    const e = apiError(err)
    errors.value = Object.fromEntries(Object.entries(e.errors).map(([k, v]) => [`${kind}.${k}`, v]))
    toast.error(e.message)
  }
  finally {
    busy.value = null
  }
}
async function test(id: string, name: string) {
  try {
    await $fetch<unknown>(`/api/admin/notifications/channels/${id}/test`, { method: 'POST' })
    toast.success(`Message de test envoyé sur « ${name} »`)
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  emit('changed')
}
const STATUS = { sent: { label: 'test réussi', tone: 'success' }, failed: { label: 'échec', tone: 'danger' }, pending: { label: 'en cours', tone: 'info' } } as const
const statusOf = (s: string | null) => (s ? STATUS[s as keyof typeof STATUS] : null)
</script>

<template>
  <div class="step">

    <ul v-if="facts.channels.length" class="list">
      <li v-for="c in facts.channels" :key="c.id">
        <strong>{{ c.name }}</strong> <span class="muted small">{{ c.kind === 'email' ? 'Email' : 'Teams' }}</span>
        <UiBadge v-if="statusOf(c.lastStatus)" :tone="statusOf(c.lastStatus)!.tone">{{ statusOf(c.lastStatus)!.label }}</UiBadge>
        <UiButton size="sm" variant="ghost" @click="test(c.id, c.name)">Tester</UiButton>
      </li>
    </ul>

    <section>
      <h3>Microsoft Teams</h3>
      <p class="muted small">Dans le canal Teams : Workflows → « Publier dans un canal lorsqu'une requête webhook est reçue », puis copier l'URL. Hôtes autorisés : {{ facts.webhookHosts.join(', ') }}.</p>
      <form class="inline" @submit.prevent="create('teams_webhook')">
        <UiField label="Nom" for="t-name"><input id="t-name" v-model.trim="teams.name" class="input" required></UiField>
        <UiField class="grow" label="URL du webhook" for="t-url" :error="errors['teams_webhook.config.url']"><input id="t-url" v-model="teams.url" class="input mono" type="url" autocomplete="off" required></UiField>
        <UiButton type="submit" size="sm" variant="primary" :loading="busy === 'teams_webhook'">Ajouter et tester</UiButton>
      </form>
    </section>

    <section>
      <h3>Email</h3>
      <p v-if="!facts.smtp" class="muted small">SMTP n'est pas configuré sur le serveur (SMTP_HOST, voir la documentation d'installation) : l'email sera disponible une fois ce réglage fait.</p>
      <form v-else class="inline" @submit.prevent="create('email')">
        <UiField label="Nom" for="m-name"><input id="m-name" v-model.trim="mail.name" class="input" required></UiField>
        <UiField class="grow" label="Destinataires" for="m-to" :error="errors['email.config.recipients']" hint="Séparés par des virgules"><input id="m-to" v-model="mail.recipients" class="input" required></UiField>
        <UiButton type="submit" size="sm" variant="primary" :loading="busy === 'email'">Ajouter et tester</UiButton>
      </form>
    </section>
  </div>
</template>

<style scoped>
.step { display: flex; flex-direction: column; gap: var(--space-4); }
.lead { margin: 0; }
section { display: flex; flex-direction: column; gap: var(--space-2); }
h3 { margin: 0; font-size: 15px; }
.small { font-size: 12.5px; margin: 0; }
.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2); }
.list li { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.inline { display: flex; gap: var(--space-3); align-items: flex-end; flex-wrap: wrap; }
.grow { flex: 1; min-width: 260px; }
</style>
