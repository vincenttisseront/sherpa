<script setup lang="ts">
withDefaults(defineProps<{ tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info', dot?: boolean }>(), { tone: 'neutral', dot: false })
</script>

<template>
  <span class="badge" :class="`badge--${tone}`"><span v-if="dot" class="dot" aria-hidden="true" /><slot /></span>
</template>

<style scoped>
.badge {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 2px 9px; border-radius: 999px;
  font-size: 12px; font-weight: 550; white-space: nowrap; line-height: 1.5;
  border: 1px solid transparent;
}
.dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.badge--neutral { background: var(--neutral-bg); color: var(--text-muted); }
.badge--success { background: var(--success-bg); color: var(--success); border-color: color-mix(in srgb, var(--success) 18%, transparent); }
.badge--warning { background: var(--warning-bg); color: var(--warning); border-color: color-mix(in srgb, var(--warning) 18%, transparent); }
.badge--danger { background: var(--danger-bg); color: var(--danger); border-color: color-mix(in srgb, var(--danger) 18%, transparent); }
.badge--info { background: var(--info-bg); color: var(--info); border-color: color-mix(in srgb, var(--info) 18%, transparent); }
</style>
