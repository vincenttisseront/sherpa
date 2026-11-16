<script setup lang="ts">
/** Mise en service : liste de contrôle vérifiée en direct, avec lien vers l'écran où agir. */
interface Item { key: string, label: string, status: 'ok' | 'warning' | 'error' | 'todo' | 'info', detail: string, link?: string }
interface Report { checkedAt: string, summary: Record<Item['status'], number>, sections: { key: string, title: string, items: Item[] }[] }

useHead({ title: 'Mise en service' })
const { data, refresh, status } = await useFetch<Report>('/api/admin/readiness')
const { refresh: refreshMe, hasAny } = useAuth()
async function reopenWizard() {
  await $fetch<unknown>('/api/onboarding/reopen', { method: 'POST' })
  await refreshMe()
  await navigateTo('/onboarding')
}
const STATUS = {
  ok: { label: 'OK', tone: 'success' },
  warning: { label: 'À revoir', tone: 'warning' },
  error: { label: 'Bloquant', tone: 'danger' },
  todo: { label: 'À faire', tone: 'info' },
  info: { label: 'Info', tone: 'neutral' },
} as const
const only = ref<'all' | 'pending'>('all')
const visible = (items: Item[]) => (only.value === 'all' ? items : items.filter(i => i.status !== 'ok' && i.status !== 'info'))
</script>

<template>
  <div>
    <UiPageHeader title="Administration" icon="settings"><template #nav><AdminNav /></template></UiPageHeader>
    <div v-if="data" class="head card">
      <h2>Mise en service <span class="muted small when">vérifié le {{ fmtDateTime(data.checkedAt) }}</span></h2>
      <div class="sum">
        <UiBadge v-for="(s, k) in STATUS" :key="k" :tone="s.tone">{{ s.label }} : {{ data.summary[k] }}</UiBadge>
      </div>
      <div class="actions">
        <UiSwitch :model-value="only === 'pending'" label="À faire seulement" @update:model-value="v => only = v ? 'pending' : 'all'" />
        <UiButton size="sm" :loading="status === 'pending'" @click="refresh()">Revérifier</UiButton>
        <UiButton size="sm" variant="ghost" title="Assistant d'initialisation" @click="reopenWizard">Assistant</UiButton>
        <UiTechSupportButton v-if="hasAny('audit:read')" href="/api/tech-support" title="Rapport texte de la plateforme : console, santé, base, files de tâches, configuration, réglages, serveurs, projets, échecs récents (ni secret ni donnée personnelle)" />
      </div>
    </div>
    <template v-if="data">
      <section v-for="s in data.sections" :key="s.key" class="card pad">
        <h3>{{ s.title }}</h3>
        <p v-if="!visible(s.items).length" class="muted small">Rien à faire.</p>
        <ul class="items">
          <li v-for="i in visible(s.items)" :key="i.key" :class="i.status">
            <UiBadge :tone="STATUS[i.status].tone">{{ STATUS[i.status].label }}</UiBadge>
            <div class="txt">
              <strong>{{ i.label }}</strong>
              <span class="muted small">{{ i.detail }}</span>
            </div>
            <NuxtLink v-if="i.link" :to="i.link" class="small go">Ouvrir</NuxtLink>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>

<style scoped>
.head { padding: var(--space-3) var(--space-4); display: flex; flex-wrap: wrap; gap: var(--space-3); align-items: center; justify-content: space-between; margin-bottom: var(--space-3); }
.head h2 { margin: 0; font-size: 16px; display: flex; align-items: baseline; gap: var(--space-2); }
.when { font-weight: 400; }
.sum { display: flex; gap: 6px; flex-wrap: wrap; }
.actions { display: flex; gap: var(--space-2); align-items: center; }
.auto { width: auto; }
.small { font-size: 12.5px; margin: 0; }
.pad { padding: var(--space-3) var(--space-4); margin-bottom: var(--space-3); }
.pad h3 { margin: 0 0 var(--space-2); font-size: 15px; }
.items { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.items li { display: grid; grid-template-columns: 90px 1fr auto; gap: var(--space-3); align-items: center; padding: 5px 0; border-bottom: 1px solid var(--border); }
.items li:last-child { border-bottom: 0; }
.items li > :first-child { justify-self: start; }
.txt { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px var(--space-2); min-width: 0; overflow-wrap: anywhere; font-size: 13px; }
.go { white-space: nowrap; }
@media (max-width: 600px) { .items li { grid-template-columns: 1fr; } }
</style>
