<script setup lang="ts">
/** Étape 6 : joignabilité des API GitHub autorisées ; dépôts publics et privés. */
import type { GithubCheck, OnboardingFacts } from '#shared/schemas/onboarding'

defineProps<{ facts: OnboardingFacts }>()
const toast = useToast()
const results = ref<GithubCheck[] | null>(null)
const busy = ref(false)
async function check() {
  busy.value = true
  try {
    results.value = await $fetch<GithubCheck[]>('/api/onboarding/github-check', { method: 'POST' })
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
  <div class="step">
    <table class="table">
      <thead><tr><th /><th>Dépôt public</th><th>Dépôt privé</th></tr></thead>
      <tbody>
        <tr><td>Token</td><td>Facultatif</td><td>Obligatoire</td></tr>
        <tr><td>Sans token</td><td>60 appels/heure par adresse de la plateforme</td><td>« Introuvable » (GitHub ne révèle pas un dépôt privé)</td></tr>
        <tr><td>Token conseillé</td><td>Fine-grained, dépôts publics en lecture</td><td>Fine-grained limité au dépôt : Contents et Metadata en lecture seule</td></tr>
      </tbody>
    </table>
    <p class="muted small">Organisation en SAML SSO : autoriser le token pour l'organisation dans GitHub. GitHub Enterprise : ajouter son API (https://…/api/v3) à GITHUB_ALLOWED_API_URLS.</p>

    <div class="apis">
      <strong class="small">API GitHub autorisées sur cette plateforme</strong>
      <ul>
        <li v-for="a in facts.githubApis" :key="a" class="small">
          <code>{{ a }}</code>
          <template v-if="results">
            <UiBadge :tone="results.find(r => r.api === a)?.ok ? 'success' : 'danger'">{{ results.find(r => r.api === a)?.ok ? 'joignable' : 'injoignable' }}</UiBadge>
            <span class="muted">{{ results.find(r => r.api === a)?.detail }}</span>
          </template>
        </li>
      </ul>
      <UiButton size="sm" :loading="busy" @click="check">Tester la connexion depuis la plateforme</UiButton>
    </div>
  </div>
</template>

<style scoped>
.step { display: flex; flex-direction: column; gap: var(--space-3); }
.lead { margin: 0; }
.small { font-size: 12.5px; margin: 0; }
.table { width: 100%; border-collapse: collapse; font-size: 13px; }
.table th { text-align: left; font-size: 12px; color: var(--text-muted); padding: 4px 6px; border-bottom: 1px solid var(--border); }
.table td { padding: 6px; border-bottom: 1px solid var(--border); vertical-align: top; }
.table td:first-child { color: var(--text-muted); white-space: nowrap; }
.apis { display: flex; flex-direction: column; gap: var(--space-2); align-items: flex-start; }
.apis ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.apis li { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
</style>
