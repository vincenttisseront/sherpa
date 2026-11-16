<script setup lang="ts">
/** Étapes d'un assistant : on peut revenir sur une étape déjà franchie, pas sauter en avant. */
defineProps<{ steps: { key: string, label: string }[], current: number, reached: number }>()
const emit = defineEmits<{ go: [index: number] }>()
</script>

<template>
  <nav aria-label="Étapes">
    <ol class="stepper">
      <li v-for="(s, i) in steps" :key="s.key" :class="{ done: i < current, active: i === current }">
        <button type="button" :disabled="i > reached" :aria-current="i === current ? 'step' : undefined" @click="emit('go', i)">
          <span class="num">{{ i < current ? '✓' : i + 1 }}</span>
          <span class="label">{{ s.label }}</span>
        </button>
      </li>
    </ol>
  </nav>
</template>

<style scoped>
.stepper { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
button { all: unset; display: flex; align-items: center; gap: var(--space-2); width: 100%; padding: 6px var(--space-2); border-radius: var(--radius); cursor: pointer; color: var(--text-muted); box-sizing: border-box; }
button:disabled { cursor: default; opacity: .55; }
button:not(:disabled):hover { background: var(--surface-2); }
button:focus-visible { outline: 2px solid var(--focus); }
.num { display: grid; place-items: center; width: 22px; height: 22px; border-radius: 50%; border: 1px solid var(--border); font-size: 11.5px; flex-shrink: 0; background: var(--surface); }
.done .num { background: var(--success-bg); color: var(--success); border-color: transparent; }
.active button { color: var(--text); font-weight: 600; background: var(--info-bg); }
.active .num { background: var(--primary); color: var(--primary-contrast); border-color: transparent; }
@media (max-width: 860px) {
  .stepper { flex-direction: row; overflow-x: auto; }
  .label { display: none; }
  .active .label { display: inline; }
}
</style>
