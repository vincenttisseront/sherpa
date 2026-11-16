<script setup lang="ts">
/** Saisie d'une liste de valeurs : Entrée ou virgule pour ajouter, validation optionnelle. */
const props = defineProps<{ id?: string, placeholder?: string, validate?: (v: string) => string | null, max?: number }>()
const model = defineModel<string[]>({ required: true })
const draft = ref('')
const error = ref<string | null>(null)

function add() {
  const v = draft.value.trim()
  if (!v) return
  const err = props.validate?.(v) ?? null
  if (err) {
    error.value = err
    return
  }
  if (props.max && model.value.length >= props.max) {
    error.value = `${props.max} valeurs maximum`
    return
  }
  if (!model.value.includes(v)) model.value = [...model.value, v]
  draft.value = ''
  error.value = null
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault()
    add()
  }
  else if (e.key === 'Backspace' && !draft.value && model.value.length) {
    model.value = model.value.slice(0, -1)
  }
}
</script>

<template>
  <div>
    <div class="tag-input input">
      <span v-for="t in model" :key="t" class="chip">
        {{ t }}
        <button type="button" :aria-label="`Retirer ${t}`" @click="model = model.filter(x => x !== t)">✕</button>
      </span>
      <input :id="id" v-model="draft" :placeholder="model.length ? '' : placeholder" @keydown="onKey" @blur="add">
    </div>
    <span v-if="error" class="error-text" role="alert">{{ error }}</span>
  </div>
</template>

<style scoped>
.tag-input { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; min-height: 36px; padding: 4px 6px; }
.tag-input input { flex: 1; min-width: 120px; border: none; outline: none; background: transparent; color: var(--text); font: inherit; padding: 2px; }
.chip { display: inline-flex; align-items: center; gap: 4px; padding: 1px 4px 1px 8px; border-radius: 999px; background: var(--info-bg); color: var(--info); font-size: 12.5px; }
.chip button { all: unset; cursor: pointer; padding: 0 4px; font-size: 10px; }
.error-text { color: var(--danger); font-size: 12px; }
</style>
