<script setup lang="ts">
/**
 * Recherche en langage naturel d'un tableau : une phrase devient des filtres, appliqués au tableau et
 * affichés comme les autres (modifiables, effaçables). Le serveur ne renvoie que des filtres validés
 * par le schéma de la liste ; ce qu'il n'a pas pu appliquer est listé. Masqué si la fonction est inactive.
 */
import type { NlSearchDto, SearchTable } from '#shared/schemas/ollama'
import { Sparkles } from 'lucide-vue-next'
import type { TableState } from '~/types/table'

const props = defineProps<{ table: SearchTable, placeholder?: string }>()
const query = defineModel<TableState>('query', { required: true })
const { available, status } = useOllamaFeature('nl-search')
const toast = useToast()

const text = ref('')
const loading = ref(false)
const result = ref<NlSearchDto | null>(null)

async function run() {
  const phrase = text.value.trim()
  if (phrase.length < 3 || loading.value) return
  loading.value = true
  try {
    const r = await $fetch<NlSearchDto>(`/api/ollama/search/${props.table}`, { method: 'POST', body: { text: phrase } })
    // La phrase décrit tout le filtre : les paramètres qu'elle ne mentionne pas sont effacés.
    const kept = Object.fromEntries(Object.entries(query.value).filter(([k]) => !r.filterKeys.includes(k)))
    query.value = { ...kept, ...r.query, page: 1, pageSize: query.value.pageSize }
    result.value = r
  }
  catch (err) {
    result.value = null
    toast.error(apiError(err).message)
  }
  finally {
    loading.value = false
  }
}
</script>

<template>
  <form v-if="available" class="nl" role="search" @submit.prevent="run">
    <label class="nl-field">
      <Sparkles :size="14" aria-hidden="true" />
      <input v-model="text" class="input sm" :placeholder="placeholder ?? 'Décrire la recherche : échecs de production cette semaine…'" maxlength="300" :aria-label="`Recherche en langage naturel (${status?.model ?? 'Ollama'})`">
    </label>
    <UiButton size="sm" type="submit" :loading="loading" :disabled="text.trim().length < 3" title="Le modèle local traduit la phrase en filtres du tableau ; aucune donnée du tableau ne lui est envoyée">Filtrer</UiButton>
    <p v-if="result" class="nl-out small" role="status">
      <span v-for="a in result.applied" :key="a.label" class="chip">{{ a.label }} : {{ a.value }}</span>
      <span v-for="i in result.ignored" :key="i" class="ignored">Non appliqué — {{ i }}</span>
    </p>
  </form>
</template>

<style scoped>
.nl { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); margin-bottom: var(--space-3); }
.nl-field { display: flex; align-items: center; gap: var(--space-2); flex: 1 1 320px; max-width: 560px; color: var(--text-muted); }
.nl-field .input { flex: 1; }
.nl-out { flex-basis: 100%; display: flex; flex-wrap: wrap; gap: var(--space-2); margin: 0; }
.chip { padding: 1px 8px; border-radius: 999px; background: var(--primary-soft); color: var(--primary); }
.ignored { color: var(--warning); }
</style>
