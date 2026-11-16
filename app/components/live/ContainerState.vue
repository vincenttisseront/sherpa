<script setup lang="ts">
/** Pastille + libellé d'état d'un conteneur (santé prise en compte). */
import type { LiveHealth, LiveState } from '#shared/schemas/live'

const props = defineProps<{ state: LiveState, health: LiveHealth, status?: string, compact?: boolean }>()
const view = computed(() => {
  const exitedKo = props.state === 'exited' && /Exited \((?!0\))/.test(props.status ?? '')
  if (props.state === 'running' && props.health === 'unhealthy') return { tone: 'danger', label: 'En erreur', live: true }
  if (props.state === 'running' && props.health === 'starting') return { tone: 'warning', label: 'Démarrage', live: true }
  if (props.state === 'running') return { tone: 'success', label: props.health === 'healthy' ? 'Sain' : 'En marche', live: true }
  if (props.state === 'restarting') return { tone: 'warning', label: 'Redémarre', live: true }
  if (props.state === 'paused') return { tone: 'info', label: 'En pause', live: false }
  if (props.state === 'dead' || exitedKo) return { tone: 'danger', label: exitedKo ? 'Arrêté (erreur)' : 'Mort', live: false }
  if (props.state === 'created') return { tone: 'neutral', label: 'Créé', live: false }
  return { tone: 'neutral', label: 'Arrêté', live: false }
})
</script>

<template>
  <span class="state" :class="view.tone">
    <span :class="view.live ? 'pulse' : 'dot'" aria-hidden="true" />
    <span v-if="!compact">{{ view.label }}</span>
    <span v-else class="sr-only">{{ view.label }}</span>
  </span>
</template>

<style scoped>
.state { display: inline-flex; align-items: center; gap: 8px; font-weight: 550; font-size: 13px; white-space: nowrap; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; display: inline-block; }
.success { color: var(--success); }
.warning { color: var(--warning); }
.danger { color: var(--danger); }
.info { color: var(--info); }
.neutral { color: var(--text-faint); }
</style>
