<script setup lang="ts">
const { toasts, dismiss } = useToast()
</script>

<template>
  <div class="toasts" role="status" aria-live="polite">
    <TransitionGroup name="toast">
      <div v-for="t in toasts" :key="t.id" class="toast card" :class="`toast--${t.tone}`">
        <span>{{ t.message }}</span>
        <UiButton variant="ghost" size="sm" aria-label="Fermer la notification" @click="dismiss(t.id)">✕</UiButton>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toasts { position: fixed; right: var(--space-4); bottom: var(--space-4); z-index: 200; display: flex; flex-direction: column; gap: var(--space-2); max-width: min(420px, calc(100vw - 32px)); }
.toast { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); padding: var(--space-3) var(--space-4); border-left: 4px solid; box-shadow: var(--shadow-lg); border-radius: var(--radius); }
.toast--success { border-left-color: var(--success); }
.toast--danger { border-left-color: var(--danger); }
.toast--info { border-left-color: var(--info); }
.toast--warning { border-left-color: var(--warning); }
.toast-enter-active, .toast-leave-active { transition: all .18s; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateY(8px); }
</style>
