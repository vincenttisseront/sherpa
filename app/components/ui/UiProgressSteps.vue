<script setup lang="ts">
/** Avancement d'une opération en étapes : terminées, en cours (détail, barre), à venir, en erreur. */
import { Check, CircleAlert } from 'lucide-vue-next'
import type { ProgressStep } from '~/types/progress'

defineProps<{ steps: ProgressStep[], title?: string, horizontal?: boolean }>()
</script>

<template>
  <div class="steps" :class="{ horizontal }" role="status" aria-live="polite">
    <strong v-if="title && !horizontal" class="title">{{ title }}</strong>
    <ol :aria-label="title">
      <li v-for="(s, i) in steps" :key="i" :class="s.state">
        <span class="mark" aria-hidden="true">
          <Check v-if="s.state === 'done'" :size="13" />
          <CircleAlert v-else-if="s.state === 'error'" :size="13" />
          <span v-else-if="s.state === 'active'" class="spin" />
          <span v-else class="dot" />
        </span>
        <div class="body" :title="horizontal && s.detail ? s.detail : undefined">
          <span class="label">{{ s.label }}<span v-if="s.duration && s.state !== 'pending'" class="dur"> · {{ s.duration }}</span></span>
          <span v-if="s.detail && (!horizontal || s.state === 'error' || s.state === 'active')" class="detail" :title="horizontal ? s.detail : undefined">{{ s.detail }}</span>
          <div v-if="s.state === 'active'" class="bar" :class="{ indeterminate: s.percent === null || s.percent === undefined }">
            <div :style="s.percent !== null && s.percent !== undefined ? { width: `${s.percent}%` } : {}" />
          </div>
        </div>
      </li>
    </ol>
  </div>
</template>

<style scoped>
.steps { display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-3) var(--space-4); border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); }
.title { font-size: 13.5px; }
ol { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
li { display: flex; gap: 10px; align-items: flex-start; font-size: 13px; }
.mark { flex: none; width: 20px; height: 20px; border-radius: 50%; display: grid; place-items: center; margin-top: 1px; border: 1px solid var(--border); color: var(--text-muted); background: var(--surface-2); }
li.done .mark { background: var(--success-bg); border-color: transparent; color: var(--success); }
li.error .mark { background: var(--danger-bg); border-color: transparent; color: var(--danger); }
li.active .mark { border-color: var(--primary); background: var(--primary-soft); }
li.pending .label { color: var(--text-muted); }
li.active .label { font-weight: 600; }
li.error .label { color: var(--danger); }
.body { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1; }
.dur { color: var(--text-muted); font-variant-numeric: tabular-nums; font-weight: 400; }
.detail { color: var(--text-muted); font-size: 12.5px; overflow-wrap: anywhere; }
li.error .detail { color: var(--danger); }
.dot { width: 6px; height: 6px; border-radius: 50%; background: var(--border); }
.spin { width: 11px; height: 11px; border-radius: 50%; border: 2px solid var(--primary); border-right-color: transparent; animation: spin .8s linear infinite; }
.bar { height: 5px; border-radius: 3px; background: var(--surface-2); overflow: hidden; max-width: 420px; margin-top: 2px; }
.bar div { height: 100%; background: var(--primary); transition: width .2s; }
.bar.indeterminate div { width: 35%; animation: slide 1.2s ease-in-out infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes slide { from { transform: translateX(-100%); } to { transform: translateX(300%); } }
/* Horizontal : fil d'étapes en colonnes égales, pastilles reliées par une ligne de progression,
   libellé dessous ; détail au survol (affiché pour une étape en erreur ou en cours). */
.horizontal { padding: var(--space-3) var(--space-2) var(--space-2); }
.horizontal ol { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); gap: 0; }
.horizontal li { position: relative; flex-direction: column; align-items: center; gap: 6px; text-align: center; font-size: 12.5px; padding: 0 6px; }
.horizontal li + li::before { content: ''; position: absolute; top: 10px; right: calc(50% + 14px); left: calc(-50% + 14px); height: 2px; border-radius: 1px; background: var(--border); }
.horizontal li.done + li::before, .horizontal li.done + li.done::before { background: var(--success); }
.horizontal li.done + li.error::before { background: var(--danger); }
.horizontal .mark { position: relative; z-index: 1; width: 22px; height: 22px; margin-top: 0; }
.horizontal .body { align-items: center; flex: none; width: 100%; }
.horizontal .label { line-height: 1.3; }
.horizontal .detail { font-size: 11.5px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.horizontal .bar { width: 80%; }
@media (max-width: 640px) {
  .horizontal ol { display: flex; flex-direction: column; gap: 8px; }
  .horizontal li { flex-direction: row; align-items: flex-start; text-align: left; padding: 0; }
  .horizontal li + li::before { display: none; }
  .horizontal .body { align-items: flex-start; flex: 1; }
}
@media (prefers-reduced-motion: reduce) { .spin, .bar.indeterminate div { animation: none; } }
</style>
