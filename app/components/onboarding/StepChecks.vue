<script setup lang="ts">
/** Étape 1 : vérifications de l'installation (réglages lus dans l'environnement du serveur). */
import type { OnboardingFacts } from '#shared/schemas/onboarding'

defineProps<{ facts: OnboardingFacts }>()
const TONE = { ok: 'success', warning: 'warning', error: 'danger', todo: 'info', info: 'neutral' } as const
const FIX: Record<string, string> = {
  https: 'Publier la plateforme derrière le reverse proxy (Traefik) en HTTPS et définir APP_DOMAIN (APP_URL en https://).',
  cookie: 'Laisser COOKIE_SECURE à true (valeur par défaut) dès que l\'accès se fait en HTTPS.',
  mode: 'Démarrer avec docker-compose.yml (NODE_ENV=production).',
  worker: 'Vérifier le conteneur worker : docker compose ps, docker compose logs worker.',
  keys: 'Terminer la rotation : docker compose exec worker node dist/rekey.mjs.',
}
</script>

<template>
  <div class="step">
    <ul class="checks">
      <li v-for="c in facts.checks" :key="c.key">
        <UiBadge :tone="TONE[c.status]">{{ c.status === 'ok' ? 'OK' : c.status === 'error' ? 'Bloquant' : 'À revoir' }}</UiBadge>
        <div>
          <strong>{{ c.label }}</strong>
          <div class="muted small">{{ c.detail }}</div>
          <div v-if="c.status !== 'ok' && FIX[c.key]" class="small fix">{{ FIX[c.key] }}</div>
        </div>
      </li>
    </ul>
    <p class="muted small">URL de la plateforme : <code>{{ facts.appUrl }}</code>. Elle sert aux retours SSO et aux liens des notifications et des invitations.</p>
  </div>
</template>

<style scoped>
.step { display: flex; flex-direction: column; gap: var(--space-3); }
.lead { margin: 0; }
.checks { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-3); }
.checks li { display: grid; grid-template-columns: 90px 1fr; gap: var(--space-3); align-items: start; }
.small { font-size: 12.5px; }
.fix { color: var(--warning); margin-top: 2px; }
</style>
