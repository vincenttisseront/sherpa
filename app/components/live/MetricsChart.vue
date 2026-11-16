<script setup lang="ts">
/**
 * Courbe de ressources (SVG, sans bibliothèque) : aire sous la courbe, repère du seuil, valeur sous le curseur ou au clavier.
 * Un point nul (conteneur arrêté, relevé manquant) interrompt la courbe.
 */
const props = defineProps<{
  title: string
  points: { t: string, v: number | null }[]
  /** Maximum de l'axe vertical (défaut : maximum des valeurs, arrondi). */
  max?: number
  format: (v: number) => string
  /** Ligne de repère (seuil d'alerte, limite). */
  line?: { value: number, label: string } | null
}>()

const W = 640
const H = 140
const PAD = { l: 8, r: 8, t: 8, b: 18 }
const active = ref<number | null>(null)

const times = computed(() => props.points.map(p => new Date(p.t).getTime()))
const ymax = computed(() => {
  const m = props.max ?? Math.max(1, ...props.points.map(p => p.v ?? 0), props.line?.value ?? 0)
  return props.max ?? niceCeil(m)
})
function niceCeil(v: number) {
  const p = 10 ** Math.floor(Math.log10(v))
  return Math.ceil(v / p) * p
}
const x = (i: number) => {
  const t0 = times.value[0] ?? 0
  const span = (times.value.at(-1) ?? 1) - t0 || 1
  return PAD.l + ((times.value[i]! - t0) / span) * (W - PAD.l - PAD.r)
}
const y = (v: number) => PAD.t + (1 - Math.min(v, ymax.value) / ymax.value) * (H - PAD.t - PAD.b)

/** Segments continus (interrompus par les valeurs nulles). */
const segments = computed(() => {
  const out: { i: number, v: number }[][] = []
  let cur: { i: number, v: number }[] = []
  props.points.forEach((p, i) => {
    if (p.v === null) {
      if (cur.length) out.push(cur)
      cur = []
    }
    else cur.push({ i, v: p.v })
  })
  if (cur.length) out.push(cur)
  return out
})
const linePath = (s: { i: number, v: number }[]) => s.map((p, k) => `${k ? 'L' : 'M'}${x(p.i).toFixed(1)} ${y(p.v).toFixed(1)}`).join(' ')
const areaPath = (s: { i: number, v: number }[]) => `${linePath(s)} L${x(s.at(-1)!.i).toFixed(1)} ${H - PAD.b} L${x(s[0]!.i).toFixed(1)} ${H - PAD.b} Z`

const vals = computed(() => props.points.map(p => p.v).filter((v): v is number => v !== null))
const summary = computed(() => {
  if (!vals.value.length) return `${props.title} : aucun relevé`
  const avg = vals.value.reduce((a, b) => a + b, 0) / vals.value.length
  return `${props.title} : actuel ${props.format(vals.value.at(-1)!)}, moyenne ${props.format(avg)}, maximum ${props.format(Math.max(...vals.value))}`
})
const fmtT = (iso: string) => new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

function onMove(e: PointerEvent) {
  const el = e.currentTarget as SVGElement
  const r = el.getBoundingClientRect()
  const px = ((e.clientX - r.left) / r.width) * W
  let best = 0
  for (let i = 0; i < props.points.length; i++) if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i
  active.value = best
}
function onKey(e: KeyboardEvent) {
  if (!props.points.length) return
  const last = props.points.length - 1
  if (e.key === 'ArrowLeft') active.value = Math.max(0, (active.value ?? last) - 1)
  else if (e.key === 'ArrowRight') active.value = Math.min(last, (active.value ?? last) + 1)
  else if (e.key === 'Escape') active.value = null
  else return
  e.preventDefault()
}
const shown = computed(() => (active.value !== null ? props.points[active.value] : props.points.at(-1)) ?? null)
</script>

<template>
  <figure class="chart">
    <figcaption>
      <strong>{{ title }}</strong>
      <span v-if="shown && shown.v !== null" class="now mono">{{ format(shown.v) }} <small class="muted">{{ fmtT(shown.t) }}</small></span>
    </figcaption>
    <svg :viewBox="`0 0 ${W} ${H}`" class="svg" role="img" :aria-label="summary" tabindex="0" @pointermove="onMove" @pointerleave="active = null" @keydown="onKey" @blur="active = null">
      <line :x1="PAD.l" :x2="W - PAD.r" :y1="H - PAD.b" :y2="H - PAD.b" class="axis" />
      <line :x1="PAD.l" :x2="W - PAD.r" :y1="PAD.t" :y2="PAD.t" class="grid" />
      <text :x="PAD.l" :y="PAD.t + 10" class="lbl">{{ format(ymax) }}</text>
      <template v-if="line && line.value <= ymax">
        <line :x1="PAD.l" :x2="W - PAD.r" :y1="y(line.value)" :y2="y(line.value)" class="ref" />
        <text :x="W - PAD.r" :y="y(line.value) - 3" text-anchor="end" class="lbl ref-lbl">{{ line.label }}</text>
      </template>
      <g v-for="(s, k) in segments" :key="k">
        <path v-if="s.length > 1" :d="areaPath(s)" class="area" />
        <path v-if="s.length > 1" :d="linePath(s)" class="curve" />
        <circle v-else :cx="x(s[0]!.i)" :cy="y(s[0]!.v)" r="2.5" class="dot" />
      </g>
      <template v-if="points.length">
        <text :x="PAD.l" :y="H - 4" class="lbl">{{ fmtT(points[0]!.t) }}</text>
        <text :x="W - PAD.r" :y="H - 4" text-anchor="end" class="lbl">{{ fmtT(points.at(-1)!.t) }}</text>
      </template>
      <template v-if="active !== null && points[active]?.v !== null && points[active]">
        <line :x1="x(active)" :x2="x(active)" :y1="PAD.t" :y2="H - PAD.b" class="cursor" />
        <circle :cx="x(active)" :cy="y(points[active]!.v!)" r="3.5" class="dot" />
      </template>
    </svg>
    <p v-if="!vals.length" class="empty muted small">Aucun relevé sur cette période.</p>
  </figure>
</template>

<style scoped>
.chart { margin: 0; display: flex; flex-direction: column; gap: 4px; }
figcaption { display: flex; justify-content: space-between; align-items: baseline; font-size: 13px; }
.now { font-size: 13px; }
.svg { width: 100%; height: auto; display: block; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius); touch-action: none; }
.svg:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
.axis, .grid { stroke: var(--border); stroke-width: 1; }
.grid { stroke-dasharray: 3 4; }
.lbl { fill: var(--text-muted); font-size: 10.5px; }
.ref { stroke: var(--danger); stroke-width: 1; stroke-dasharray: 5 4; }
.ref-lbl { fill: var(--danger); }
.area { fill: var(--primary); opacity: .14; }
.curve { fill: none; stroke: var(--primary); stroke-width: 1.8; stroke-linejoin: round; stroke-linecap: round; }
.dot { fill: var(--primary); }
.cursor { stroke: var(--text-muted); stroke-width: 1; }
.empty { margin: 0; }
.small { font-size: 12.5px; }
</style>
