<script setup lang="ts">
/** Étape 5 : premier hôte (agent Portainer, assistant existant), puis Runner par endpoint. */
import type { OnboardingFacts } from '#shared/schemas/onboarding'

defineProps<{ facts: OnboardingFacts }>()
const TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = { online: 'success', degraded: 'warning', offline: 'danger', unknown: 'neutral' }
</script>

<template>
  <div class="step">
    <p class="lead">Chaque hôte est joint en SSH (rien à installer dessus) ou par son agent Portainer (port 9001, protégé par un AGENT_SECRET généré dans l'assistant).</p>
    <UiButton variant="primary" @click="navigateTo('/servers/new?returnTo=/onboarding?step=servers')">Ajouter un serveur</UiButton>

    <table v-if="facts.servers.length" class="table">
      <thead><tr><th>Serveur</th><th>Statut</th><th>Endpoints activés</th><th>Runners</th><th /></tr></thead>
      <tbody>
        <tr v-for="s in facts.servers" :key="s.id">
          <td><strong>{{ s.name }}</strong></td>
          <td><UiBadge :tone="TONE[s.status] ?? 'neutral'">{{ s.status }}</UiBadge></td>
          <td>{{ s.endpointsEnabled }}</td>
          <td>
            <span v-if="!s.endpointsEnabled" class="muted">—</span>
            <UiBadge v-else :tone="s.runners === s.endpointsEnabled && s.runnersOnline === s.runners ? 'success' : 'warning'">{{ s.runnersOnline }} / {{ s.endpointsEnabled }} en ligne</UiBadge>
          </td>
          <td><NuxtLink :to="`/servers/${s.id}`" class="small">Ouvrir</NuxtLink></td>
        </tr>
      </tbody>
    </table>

    <div class="note">
      <strong class="small">Target Runner</strong>
      <p class="small muted">
        Le dépôt des sources et le build des images se font sur chaque hôte par un Runner (service à liste blanche d'actions, authentifié en mTLS).
        L'installer sur l'hôte (documentation « runner »), le déclarer dans l'onglet Runner de l'endpoint, puis lancer le diagnostic complet.
        Il est ensuite contrôlé toutes les 5 minutes.
      </p>
    </div>
  </div>
</template>

<style scoped>
.step { display: flex; flex-direction: column; gap: var(--space-3); align-items: flex-start; }
.lead { margin: 0; }
.small { font-size: 12.5px; margin: 0; }
.table { width: 100%; border-collapse: collapse; }
.table th { text-align: left; font-size: 12px; color: var(--text-muted); padding: 4px 6px; border-bottom: 1px solid var(--border); }
.table td { padding: 6px; border-bottom: 1px solid var(--border); }
.note { padding: var(--space-3); border-radius: var(--radius); background: var(--surface-2); display: flex; flex-direction: column; gap: 4px; width: 100%; box-sizing: border-box; }
</style>
