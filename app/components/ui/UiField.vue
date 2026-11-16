<script setup lang="ts">
defineProps<{ label: string, for?: string, hint?: string, error?: string | null, required?: boolean }>()
</script>

<template>
  <div class="field" :class="{ 'has-error': !!error }">
    <label :for="$props.for">{{ label }}<span v-if="required" class="req" aria-hidden="true"> *</span></label>
    <slot />
    <span v-if="error" class="error" role="alert">{{ error }}</span>
    <span v-else-if="hint" class="hint">{{ hint }}</span>
  </div>
</template>

<style scoped>
.req { color: var(--danger); }
.has-error :deep(.input) { border-color: var(--danger); }
</style>
