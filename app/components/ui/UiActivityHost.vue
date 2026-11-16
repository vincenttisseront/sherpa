<script setup lang="ts">
/** Opérations en cours : ce que fait la plateforme, l'étape et l'avancement. */
import { Check, LoaderCircle, X } from 'lucide-vue-next'

const { items } = useActivity()
const shown = computed(() => items.value.filter(a => a.visible && !a.inline))
const now = ref(Date.now())
let t: ReturnType<typeof setInterval> | undefined
onMounted(() => { t = setInterval(() => { now.value = Date.now() }, 500) })
onBeforeUnmount(() => clearInterval(t))
const elapsed = (a: { startedAt: number }) => {
  const s = Math.floor((now.value - a.startedAt) / 1000)
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')}`
}
const pct = (a: { current: number | null, total: number | null, status: string }) => (a.status === 'success' ? 100 : a.current && a.total ? Math.round((a.current - 0.5) / a.total * 100) : null)
</script>

<template>
  <div class="host" role="status" aria-live="polite">
    <TransitionGroup name="act">
      <div v-for="a in shown" :key="a.id" class="act card" :class="a.status">
        <span class="ico" aria-hidden="true">
          <Check v-if="a.status === 'success'" :size="16" />
          <X v-else-if="a.status === 'error'" :size="16" />
          <LoaderCircle v-else :size="16" class="spin" />
        </span>
        <div class="body">
          <div class="top">
            <strong>{{ a.label }}</strong>
            <span class="time">{{ a.status === 'running' ? elapsed(a) : a.status === 'success' ? 'terminé' : 'échec' }}</span>
          </div>
          <div v-if="a.status === 'running'" class="step">
            <template v-if="a.step">{{ a.step }}<span v-if="a.total" class="n"> · étape {{ a.current }}/{{ a.total }}</span></template>
            <template v-else>En cours…</template>
          </div>
          <div class="bar" :class="{ indeterminate: pct(a) === null && a.status === 'running' }">
            <span :style="pct(a) !== null ? { width: `${pct(a)}%` } : undefined" />
          </div>
        </div>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.host { position: fixed; left: calc(var(--sidebar-w) + var(--space-4)); bottom: var(--space-4); z-index: 150; display: flex; flex-direction: column; gap: var(--space-2); width: min(380px, calc(100vw - 32px)); pointer-events: none; }
@media (max-width: 900px) { .host { left: var(--space-4); } }
.act { pointer-events: auto; display: flex; gap: var(--space-3); padding: var(--space-3) var(--space-4); box-shadow: var(--shadow-lg); border-radius: var(--radius-lg); }
.ico { width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center; flex-shrink: 0; background: var(--primary-soft); color: var(--primary); }
.success .ico { background: var(--success-bg); color: var(--success); }
.error .ico { background: var(--danger-bg); color: var(--danger); }
.spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.top { display: flex; justify-content: space-between; gap: var(--space-2); align-items: baseline; }
.top strong { font-size: 13.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.time { font-size: 12px; color: var(--text-muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.step { font-size: 12.5px; color: var(--text-muted); overflow-wrap: anywhere; }
.n { color: var(--text-faint); }
.bar { height: 4px; border-radius: 999px; background: var(--surface-3); overflow: hidden; position: relative; }
.bar span { display: block; height: 100%; width: 0; background: var(--primary); border-radius: 999px; transition: width .4s ease; }
.success .bar span { background: var(--success); }
.error .bar span { background: var(--danger); width: 100%; }
.bar.indeterminate span { position: absolute; width: 35%; animation: slide 1.2s ease-in-out infinite; }
@keyframes slide { 0% { left: -35%; } 100% { left: 100%; } }
@media (prefers-reduced-motion: reduce) { .spin, .bar.indeterminate span { animation: none; } }
.act-enter-active, .act-leave-active { transition: all .2s; }
.act-enter-from, .act-leave-to { opacity: 0; transform: translateY(8px); }
</style>
