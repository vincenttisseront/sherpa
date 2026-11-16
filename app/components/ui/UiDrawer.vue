<script setup lang="ts">
/** Panneau latéral (détail) : Échap pour fermer, focus rendu à l'ouverture. */
import { X } from 'lucide-vue-next'

withDefaults(defineProps<{ title: string, subtitle?: string, width?: string }>(), { width: '600px', subtitle: undefined })
const open = defineModel<boolean>('open', { required: true })
const panel = ref<HTMLElement>()
let previous: HTMLElement | null = null
watch(open, async (v) => {
  if (v) {
    previous = document.activeElement as HTMLElement | null
    await nextTick()
    panel.value?.focus()
  }
  else {
    previous?.focus()
  }
})
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation()
    open.value = false
  }
}
// Échap ferme aussi quand le focus a quitté le panneau (élément re-rendu, notification).
function onDocKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && open.value && !panel.value?.contains(document.activeElement)) open.value = false
}
onMounted(() => document.addEventListener('keydown', onDocKeydown))
onBeforeUnmount(() => document.removeEventListener('keydown', onDocKeydown))
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="scrim" @mousedown.self="open = false">
      <aside ref="panel" class="drawer" role="dialog" aria-modal="true" :aria-label="title" tabindex="-1" :style="{ width }" @keydown="onKeydown">
        <header class="head">
          <div class="titles">
            <h2>{{ title }}</h2>
            <p v-if="subtitle || $slots.subtitle" class="sub"><slot name="subtitle">{{ subtitle }}</slot></p>
          </div>
          <button type="button" class="close" aria-label="Fermer" @click="open = false"><X :size="18" /></button>
        </header>
        <div class="body"><slot /></div>
      </aside>
    </div>
  </Teleport>
</template>

<style scoped>
.scrim { position: fixed; inset: 0; z-index: 90; background: rgb(8 12 25 / 35%); display: flex; justify-content: flex-end; }
.drawer { max-width: 100vw; height: 100vh; background: var(--surface); border-left: 1px solid var(--border); box-shadow: var(--shadow-lg); display: flex; flex-direction: column; animation: slide .18s ease-out; }
.drawer:focus { outline: none; }
@keyframes slide { from { transform: translateX(24px); opacity: .6; } to { transform: none; opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .drawer { animation: none; } }
.head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-3); padding: var(--space-4) var(--space-5); border-bottom: 1px solid var(--border); }
.titles { min-width: 0; }
.head h2 { font-size: 17px; overflow-wrap: anywhere; }
.sub { margin: 4px 0 0; color: var(--text-muted); font-size: 13px; display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.close { all: unset; cursor: pointer; width: 32px; height: 32px; display: grid; place-items: center; border-radius: var(--radius); color: var(--text-muted); flex-shrink: 0; }
.close:hover { background: var(--surface-3); color: var(--text); }
.close:focus-visible { outline: 2px solid var(--focus); }
.body { padding: var(--space-5); overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: var(--space-4); }
</style>
