<script setup lang="ts">
defineProps<{ label?: string, disabled?: boolean }>()
const model = defineModel<boolean>({ required: true })
</script>

<template>
  <label class="switch" :class="{ disabled }">
    <button
      type="button"
      role="switch"
      class="track"
      :aria-checked="model"
      :disabled="disabled"
      @click="model = !model"
    ><span class="thumb" /></button>
    <span v-if="label">{{ label }}</span>
  </label>
</template>

<style scoped>
.switch { display: inline-flex; align-items: center; gap: var(--space-2); cursor: pointer; }
.switch.disabled { opacity: .55; cursor: not-allowed; }
.track { position: relative; width: 34px; height: 20px; border-radius: 999px; border: none; padding: 0; background: var(--border); cursor: inherit; transition: background .15s; flex-shrink: 0; }
.track[aria-checked='true'] { background: var(--primary); }
.thumb { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform .15s; box-shadow: var(--shadow); }
.track[aria-checked='true'] .thumb { transform: translateX(14px); }
</style>
