<script setup lang="ts">
/** Étape 7 : récapitulatif ; la suite se pilote depuis la page Mise en service. */
import { ONBOARDING_STEPS, type OnboardingFacts, type OnboardingState, STEP_LABEL } from '#shared/schemas/onboarding'

const props = defineProps<{ facts: OnboardingFacts, state: OnboardingState }>()
const rows = computed(() => ONBOARDING_STEPS.filter(s => s !== 'done').map((s) => {
  const f = props.facts
  const summary: Record<string, string> = {
    checks: `${f.checks.filter(c => c.status === 'ok').length} / ${f.checks.length} vérifications OK`,
    access: `${f.groups.length} groupe(s), ${f.admins.total} administrateur(s) dont ${f.admins.local} local(aux)`,
    sso: f.idps.length ? f.idps.map(i => `${i.name} (${i.mappings} groupe(s) mappé(s))`).join(', ') : 'Aucun fournisseur',
    notifications: f.channels.length ? f.channels.map(c => c.name).join(', ') : 'Aucun canal',
    servers: f.servers.length ? `${f.servers.length} serveur(s), ${f.servers.reduce((a, s) => a + s.endpointsEnabled, 0)} endpoint(s) activé(s)` : 'Aucun serveur',
    github: f.githubApis.join(', '),
  }
  return { step: s, label: STEP_LABEL[s], status: props.state.steps[s] ?? null, summary: summary[s] }
}))
</script>

<template>
  <div class="step">
    <table class="table">
      <thead class="sr-only"><tr><th>Étape</th><th>État</th><th>Résumé</th></tr></thead>
      <tbody>
        <tr v-for="r in rows" :key="r.step">
          <td><strong>{{ r.label }}</strong></td>
          <td><UiBadge :tone="r.status === 'done' ? 'success' : r.status === 'skipped' ? 'warning' : 'neutral'">{{ r.status === 'done' ? 'fait' : r.status === 'skipped' ? 'passé' : 'non vu' }}</UiBadge></td>
          <td class="small">{{ r.summary }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.step { display: flex; flex-direction: column; gap: var(--space-3); }
.small { font-size: 12.5px; margin: 0; }
.table { width: 100%; border-collapse: collapse; }
.table td { padding: 8px 6px; border-bottom: 1px solid var(--border); vertical-align: top; }
</style>
