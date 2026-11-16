<script setup lang="ts">
/** Dialogue modal custom : focus piégé, Échap pour fermer, retour du focus à l'ouverture. */
const props = withDefaults(defineProps<{ title: string, width?: string, dismissible?: boolean }>(), { width: '520px', dismissible: true })
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ close: [] }>()

const panel = ref<HTMLElement>()
const titleId = useId()
let previouslyFocused: HTMLElement | null = null

function close() {
  if (!props.dismissible) return
  open.value = false
  emit('close')
}

function focusables(): HTMLElement[] {
  return [...(panel.value?.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') ?? [])]
    .filter(el => !el.hasAttribute('disabled'))
}

function onKeydown(e: KeyboardEvent) {
  // Échap déjà traité par un composant (champ en cours d'édition, panneau de recherche de l'éditeur) : la fenêtre reste ouverte.
  if (e.key === 'Escape' && !e.defaultPrevented) {
    e.stopPropagation()
    close()
  }
  else if (e.key === 'Tab') {
    const els = focusables()
    if (!els.length) return
    const first = els[0]!
    const last = els[els.length - 1]!
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    }
    else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }
}

watch(open, async (v) => {
  if (v) {
    previouslyFocused = document.activeElement as HTMLElement | null
    await nextTick()
    ;(focusables()[0] ?? panel.value)?.focus()
  }
  else {
    previouslyFocused?.focus()
  }
})
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="open" class="backdrop" @mousedown.self="close">
        <div
          ref="panel"
          class="panel card"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="titleId"
          tabindex="-1"
          :style="{ width }"
          @keydown="onKeydown"
        >
          <header class="head">
            <h2 :id="titleId">{{ title }}</h2>
            <UiButton v-if="dismissible" variant="ghost" size="sm" aria-label="Fermer" @click="close">✕</UiButton>
          </header>
          <div class="body"><slot /></div>
          <footer v-if="$slots.footer" class="foot"><slot name="footer" /></footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.backdrop {
  position: fixed; inset: 0; z-index: 100;
  display: grid; grid-template-columns: minmax(0, 1fr); place-items: center; padding: var(--space-4);
  background: rgb(8 12 25 / 50%); backdrop-filter: blur(3px);
}
.panel { max-width: 100%; max-height: calc(100vh - 32px); display: flex; flex-direction: column; box-shadow: var(--shadow-lg); border-radius: var(--radius-xl); }
.panel:focus { outline: none; }
.head { display: flex; align-items: center; justify-content: space-between; padding: var(--space-4) var(--space-5); border-bottom: 1px solid var(--border); }
.head h2 { font-size: 16px; }
.body { padding: var(--space-5); overflow: auto; }
.foot { display: flex; justify-content: flex-end; gap: var(--space-2); padding: var(--space-4) var(--space-5); border-top: 1px solid var(--border); }
.modal-enter-active, .modal-leave-active { transition: opacity .16s; }
.modal-enter-active .panel, .modal-leave-active .panel { transition: transform .16s; }
.modal-enter-from, .modal-leave-to { opacity: 0; }
.modal-enter-from .panel, .modal-leave-to .panel { transform: translateY(8px) scale(.98); }
</style>
