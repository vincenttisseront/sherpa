<script setup lang="ts">
/** Barre de filtre d'un tableau local (voir useListFilter). */
defineProps<{ count: number, total: number, statuses?: Record<string, string>, placeholder?: string, active?: boolean }>()
const q = defineModel<string>('q', { required: true })
const status = defineModel<string>('status', { default: '' })
const emit = defineEmits<{ reset: [] }>()
</script>

<template>
  <div class="list-filter">
    <input v-model="q" class="input input-sm search" type="search" :placeholder="placeholder ?? 'Filtrer…'" :aria-label="placeholder ?? 'Filtrer'">
    <select v-if="statuses" v-model="status" class="input input-sm auto" aria-label="Statut">
      <option value="">Tous les statuts</option>
      <option v-for="(label, k) in statuses" :key="k" :value="k">{{ label }}</option>
    </select>
    <UiButton v-if="active" size="sm" variant="ghost" @click="emit('reset')">Réinitialiser</UiButton>
    <span class="muted count">{{ count === total ? `${total}` : `${count} / ${total}` }}</span>
  </div>
</template>

<style scoped>
.list-filter { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; margin-bottom: var(--space-2); }
.search { max-width: 220px; }
.auto { width: auto; }
.count { font-size: 12.5px; margin-left: auto; }
</style>
