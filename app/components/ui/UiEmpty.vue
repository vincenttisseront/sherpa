<script setup lang="ts">
/** État vide : icône, explication et action pour commencer. */
import type { Component } from 'vue'

defineProps<{ title: string, text?: string, icon?: Component, compact?: boolean }>()
</script>

<template>
  <div class="empty" :class="{ compact }">
    <span v-if="icon" class="ico" aria-hidden="true"><component :is="icon" :size="compact ? 20 : 26" :stroke-width="1.8" /></span>
    <strong>{{ title }}</strong>
    <p v-if="text || $slots.text"><slot name="text">{{ text }}</slot></p>
    <div v-if="$slots.default" class="actions"><slot /></div>
  </div>
</template>

<style scoped>
.empty { display: flex; flex-direction: column; align-items: center; text-align: center; gap: var(--space-2); padding: var(--space-7) var(--space-5); }
.empty.compact { padding: var(--space-4); gap: 4px; }
.ico { width: 56px; height: 56px; border-radius: 50%; display: grid; place-items: center; color: var(--primary); background: var(--primary-soft); margin-bottom: var(--space-2); }
.compact .ico { width: 40px; height: 40px; margin-bottom: 0; }
strong { font-size: 15px; }
.compact strong { font-size: 13.5px; }
p { margin: 0; color: var(--text-muted); max-width: 440px; font-size: 13.5px; }
.compact p { font-size: 12.5px; }
.actions { display: flex; gap: var(--space-2); margin-top: var(--space-3); flex-wrap: wrap; justify-content: center; }
</style>
