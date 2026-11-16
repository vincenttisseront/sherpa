<script setup lang="ts">
/** Compteurs de vulnérabilités par sévérité (critique, haute, moyenne, basse). */
import type { SeverityCounts } from '#shared/schemas/trivy'

defineProps<{ counts: SeverityCounts }>()
</script>

<template>
  <span class="sc" :aria-label="`${counts.CRITICAL} critique(s), ${counts.HIGH} haute(s), ${counts.MEDIUM} moyenne(s), ${counts.LOW} basse(s)`">
    <UiBadge :tone="counts.CRITICAL ? 'danger' : 'neutral'" title="Critiques">C {{ counts.CRITICAL }}</UiBadge>
    <UiBadge :tone="counts.HIGH ? 'danger' : 'neutral'" title="Hautes">H {{ counts.HIGH }}</UiBadge>
    <UiBadge :tone="counts.MEDIUM ? 'warning' : 'neutral'" title="Moyennes">M {{ counts.MEDIUM }}</UiBadge>
    <UiBadge :tone="counts.LOW ? 'info' : 'neutral'" title="Basses">L {{ counts.LOW }}</UiBadge>
  </span>
</template>

<style scoped>
.sc { display: inline-flex; gap: 3px; flex-wrap: wrap; }
</style>
