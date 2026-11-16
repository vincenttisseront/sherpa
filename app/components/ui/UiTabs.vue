<script setup lang="ts">
defineProps<{ tabs: { key: string, label: string, title?: string, badge?: string | number }[] }>()
const model = defineModel<string>({ required: true })
</script>

<template>
  <div class="tabs" role="tablist">
    <button
      v-for="t in tabs"
      :key="t.key"
      type="button"
      role="tab"
      class="tab"
      :aria-selected="model === t.key"
      :title="t.title"
      @click="model = t.key"
    >
      {{ t.label }}
      <span v-if="t.badge" class="count">{{ t.badge }}</span>
    </button>
  </div>
</template>

<style scoped>
.tabs { display: flex; gap: 2px; padding: 3px; margin-bottom: var(--space-3); overflow-x: auto; background: var(--surface-3); border-radius: calc(var(--radius) + 2px); width: fit-content; max-width: 100%; }
.tab { all: unset; cursor: pointer; padding: 4px 11px; border-radius: var(--radius); color: var(--text-muted); font-weight: 550; font-size: 13px; white-space: nowrap; display: inline-flex; gap: 6px; align-items: center; transition: background-color .12s, color .12s; }
.tab:hover { color: var(--text); }
.tab:focus-visible { outline: 2px solid var(--focus); }
.tab[aria-selected='true'] { color: var(--text); background: var(--surface); box-shadow: var(--shadow); }
.count { background: var(--warning-bg); color: var(--warning); border-radius: 999px; padding: 0 6px; font-size: 11.5px; }
</style>
