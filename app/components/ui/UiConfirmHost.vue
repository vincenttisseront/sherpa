<script setup lang="ts">
const state = useConfirmState()
const typed = ref('')
const open = computed({
  get: () => state.value !== null,
  set: (v) => { if (!v) answer(false) },
})
const canConfirm = computed(() => !state.value?.requireText || typed.value === state.value.requireText)

function answer(ok: boolean) {
  state.value?.resolve(ok)
  state.value = null
  typed.value = ''
}
</script>

<template>
  <UiModal v-if="state" v-model:open="open" :title="state.title" width="460px">
    <p class="msg">{{ state.message }}</p>
    <div v-if="state.requireText" class="field">
      <label for="confirm-text">Saisir <code>{{ state.requireText }}</code> pour confirmer</label>
      <input id="confirm-text" v-model="typed" class="input" autocomplete="off" @keydown.enter="canConfirm && answer(true)">
    </div>
    <template #footer>
      <UiButton @click="answer(false)">{{ state.cancelLabel ?? 'Annuler' }}</UiButton>
      <UiButton :variant="state.danger ? 'danger' : 'primary'" :disabled="!canConfirm" @click="answer(true)">
        {{ state.confirmLabel ?? 'Confirmer' }}
      </UiButton>
    </template>
  </UiModal>
</template>

<style scoped>
.msg { margin: 0 0 var(--space-4); white-space: pre-line; }
</style>
