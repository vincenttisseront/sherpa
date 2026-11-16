<script setup lang="ts">
/**
 * Diagnostic d'une cible dégradée ou arrêtée : verdict, constats par service
 * (cause probable, healthchecks, logs notables) et actions proposées.
 */
import type { DiagnosticAction, DiagnosticFinding, ServiceDiagnostic, TargetDiagnostic } from '#shared/schemas/diagnostic'
import { Activity, CircleAlert, CircleCheck, Info, RefreshCw, Stethoscope, TriangleAlert } from 'lucide-vue-next'

const route = useRoute()
const targetId = computed(() => String(route.params.targetId))
useHead({ title: 'Diagnostic' })
const toast = useToast()
const confirm = useConfirm()
const { can } = useAuth()

const { data: d, error, status, refresh } = useFetch<TargetDiagnostic>(() => `/api/targets/${targetId.value}/diagnostic`, { server: false, lazy: true })
// Après le montage seulement : l'état de useFetch diffère entre rendu serveur et hydratation.
const mounted = ref(false)
onMounted(() => { mounted.value = true })
const loading = computed(() => mounted.value && status.value === 'pending')
const canExecute = computed(() => !!d.value && can('deployment:execute', { projectId: d.value.projectId }))

const SEV_ICON = { error: CircleAlert, warning: TriangleAlert, info: Info, ok: CircleCheck } as const
const STATE_LABEL: Record<ServiceDiagnostic['state'], string> = { running: 'en marche', restarting: 'redémarre', exited: 'arrêté', created: 'créé', paused: 'en pause', dead: 'mort', missing: 'absent' }
const worst = (s: ServiceDiagnostic): DiagnosticFinding['severity'] => (['error', 'warning', 'info', 'ok'] as const).find(v => s.findings.some(f => f.severity === v)) ?? 'ok'
const troubled = computed(() => d.value?.services.filter(s => worst(s) !== 'ok') ?? [])
const healthy = computed(() => d.value?.services.filter(s => worst(s) === 'ok') ?? [])

const LIFECYCLE = {
  start: { label: 'Démarrer la stack', message: 'La stack est démarrée puis contrôlée.' },
  restart: { label: 'Redémarrer la stack', message: 'Les conteneurs de la stack sont redémarrés un par un, puis contrôlés.' },
  redeploy: { label: 'Redéployer', message: 'La release active est redéployée avec la configuration actuelle ; les conteneurs manquants sont recréés.' },
} as const
const actionLabel = (a: DiagnosticAction) => (a.kind === 'link' ? a.label : a.kind === 'restart-service' ? `Redémarrer ${a.service}` : LIFECYCLE[a.kind].label)

const busy = ref<string | null>(null)
const openLogs = ref<string | null>(null)
async function run(a: DiagnosticAction) {
  if (!d.value) return
  if (a.kind === 'link') return navigateTo(a.to)
  const key = a.kind === 'restart-service' ? `svc:${a.service}` : a.kind
  if (a.kind === 'restart-service') {
    if (!await confirm({ title: `Redémarrer ${a.service}`, message: `Le conteneur du service ${a.service} est redémarré (sans redéploiement). Le diagnostic est relu ensuite.`, confirmLabel: 'Redémarrer' })) return
    busy.value = key
    try {
      await $fetch(`/api/targets/${d.value.targetId}/services/${encodeURIComponent(a.service)}/restart`, { method: 'POST' })
      toast.success(`${a.service} redémarré`)
      await new Promise(r => setTimeout(r, 3000))
      await refresh()
    }
    catch (err) {
      toast.error(apiError(err).message)
    }
    finally {
      busy.value = null
    }
    return
  }
  const l = LIFECYCLE[a.kind]
  if (!await confirm({ title: `${l.label} — ${d.value.project} (${d.value.environment})`, message: l.message, confirmLabel: l.label })) return
  busy.value = key
  try {
    const r = await $fetch<{ deploymentId: string }>(`/api/targets/${d.value.targetId}/actions`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: { action: a.kind } })
    await navigateTo(`/deployments/${r.deploymentId}`)
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    busy.value = null
  }
}
const allowed = (a: DiagnosticAction) => a.kind === 'link' || canExecute.value
</script>

<template>
  <div>
    <UiPageHeader title="Diagnostic" :icon="Stethoscope" :back="d ? { to: `/projects/${d.projectId}`, label: 'Projet' } : undefined">
      <template v-if="d" #nav>
        <span class="meta">
          <NuxtLink :to="`/projects/${d.projectId}`"><strong>{{ d.project }}</strong></NuxtLink>
          <UiBadge>{{ d.environment }}</UiBadge>
          <span class="muted small">stack <code>{{ d.stack }}</code> · {{ d.server }} · lu à {{ fmtTime(d.checkedAt) }}</span>
        </span>
      </template>
      <NuxtLink v-if="d" :to="`/containers?endpoint=${d.endpointId}&stack=${encodeURIComponent(d.stack)}`" class="small link"><Activity :size="13" /> Conteneurs</NuxtLink>
      <UiTechSupportButton :href="`/api/targets/${targetId}/tech-support`" title="Rapport texte : état, diagnostic, conteneurs, réseaux, configuration, déploiements et journaux (secrets masqués)" />
      <UiButton v-if="d && canExecute" size="sm" :loading="busy === 'redeploy'" title="Recrée les conteneurs de la release active avec la configuration actuelle" @click="run({ kind: 'redeploy' })">Redéployer</UiButton>
      <UiButton size="sm" :loading="loading" title="Relire l'état des conteneurs" @click="refresh()"><RefreshCw :size="14" /> Relire</UiButton>
    </UiPageHeader>

    <p v-if="error" class="alert">{{ apiError(error).message }}</p>
    <div v-else-if="!d" class="muted">Lecture des conteneurs de la stack…</div>
    <template v-else>
      <!-- Verdict -->
      <section class="card verdict" :class="d.summary.severity">
        <component :is="SEV_ICON[d.summary.severity]" :size="18" class="ico" />
        <div class="v-text">
          <strong>{{ d.summary.title }}</strong>
          <span v-if="d.summary.detail" class="muted small">{{ d.summary.detail }}</span>
        </div>
        <div class="v-actions">
          <UiButton v-for="(a, i) in d.summary.actions.filter(allowed)" :key="i" size="sm" variant="primary" :loading="busy === a.kind" @click="run(a)">{{ actionLabel(a) }}</UiButton>
        </div>
      </section>

      <!-- Stack arrêtée en bloc : une ligne par service (le verdict porte l'action). -->
      <section v-if="d.allStopped" class="card stopped">
        <table class="st-table">
          <thead><tr><th>Service</th><th>Arrêt</th><th>Depuis</th><th>Image</th><th /></tr></thead>
          <tbody>
            <template v-for="s in d.services" :key="s.service">
              <tr>
                <td class="mono"><strong>{{ s.service }}</strong></td>
                <td :class="{ 'err-text': s.exitCode !== null && ![0, 137, 143].includes(s.exitCode) }">{{ s.findings[0]?.title.replace(/^Arrêté \((.*)\)$/, '$1') ?? '—' }} <span v-if="s.exitCode !== null" class="muted small">code {{ s.exitCode }}</span></td>
                <td class="muted small nowrap">{{ s.finishedAt ? fmtRelative(s.finishedAt) : '—' }}</td>
                <td class="muted small mono img-c" :title="s.image ?? ''">{{ s.image }}</td>
                <td class="nowrap"><button v-if="s.notableLogs.length || s.tail.length" type="button" class="link small" @click="openLogs = openLogs === s.service ? null : s.service">{{ openLogs === s.service ? 'Masquer' : 'Logs' }}</button></td>
              </tr>
              <tr v-if="openLogs === s.service" class="log-row"><td colspan="5"><pre class="log">{{ (s.notableLogs.length ? s.notableLogs : s.tail).join('\n') }}</pre></td></tr>
            </template>
          </tbody>
        </table>
      </section>

      <!-- Services en difficulté -->
      <section v-for="s in (d.allStopped ? [] : troubled)" :key="s.service" class="card svc" :class="worst(s)">
        <header class="s-head">
          <component :is="SEV_ICON[worst(s)]" :size="15" class="ico" />
          <strong class="mono">{{ s.service }}</strong>
          <UiBadge :tone="s.state === 'running' ? 'success' : s.state === 'missing' ? 'danger' : 'neutral'">{{ STATE_LABEL[s.state] }}</UiBadge>
          <UiBadge v-if="s.health && s.state === 'running'" :tone="s.health === 'healthy' ? 'success' : s.health === 'unhealthy' ? 'danger' : 'warning'">{{ s.health }}</UiBadge>
          <span v-if="s.exitCode !== null" class="muted small">code {{ s.exitCode }}{{ s.oomKilled ? ' · OOM' : '' }}</span>
          <span v-if="s.restartCount" class="muted small">· {{ s.restartCount }} redémarrage(s)</span>
          <span v-if="s.finishedAt && s.state !== 'running'" class="muted small">· arrêté {{ fmtRelative(s.finishedAt) }}</span>
          <span class="muted small mono img" :title="s.image ?? ''">{{ s.image }}</span>
        </header>
        <div v-for="(f, i) in s.findings.filter(x => x.severity !== 'ok')" :key="i" class="finding">
          <div class="f-text">
            <strong>{{ f.title }}</strong>
            <span v-if="f.detail" class="small">{{ f.detail }}</span>
          </div>
          <div class="f-actions">
            <UiButton v-for="(a, j) in f.actions.filter(allowed)" :key="j" size="sm" :variant="a.kind === 'link' ? 'ghost' : 'secondary'" :loading="busy === (a.kind === 'restart-service' ? `svc:${a.service}` : a.kind)" @click="run(a)">{{ actionLabel(a) }}</UiButton>
          </div>
        </div>
        <details v-if="s.healthLog.length" class="more">
          <summary class="small">Dernières vérifications de santé ({{ s.healthLog.length }})</summary>
          <ul class="hlog">
            <li v-for="(h, i) in s.healthLog" :key="i">
              <UiBadge :tone="h.exitCode === 0 ? 'success' : 'danger'" dot>{{ h.exitCode === 0 ? 'OK' : `code ${h.exitCode}` }}</UiBadge>
              <span class="muted small">{{ fmtDateTime(h.at) }}</span>
              <code class="small out" :title="h.output">{{ h.output.trim() || '—' }}</code>
            </li>
          </ul>
        </details>
        <details v-if="s.notableLogs.length || s.tail.length" class="more" :open="s.notableLogs.length > 0">
          <summary class="small">{{ s.notableLogs.length ? `Lignes de log notables (${s.notableLogs.length})` : 'Dernières lignes de log' }}</summary>
          <pre class="log">{{ (s.notableLogs.length ? s.notableLogs : s.tail).join('\n') }}</pre>
          <p v-if="s.notableLogs.length" class="muted small">Secrets masqués. Logs complets : <NuxtLink :to="`/containers?endpoint=${d.endpointId}&stack=${encodeURIComponent(d.stack)}`">conteneurs en direct</NuxtLink>.</p>
        </details>
      </section>

      <p v-if="d.logsHidden && troubled.length" class="muted small">Logs non lus : droit « lecture des logs » requis sur ce serveur.</p>

      <!-- Services sains -->
      <section v-if="healthy.length" class="card ok-list">
        <CircleCheck :size="15" class="ico" />
        <span class="small"><strong>{{ healthy.length }} service(s) en marche</strong> : {{ healthy.map(s => s.service).join(', ') }}</span>
      </section>
    </template>
  </div>
</template>

<style scoped>
.meta { display: inline-flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.meta code { font-size: 12px; }
.link { display: inline-flex; gap: 4px; align-items: center; }
.small { font-size: 12.5px; }
.alert { padding: var(--space-3) var(--space-4); border-radius: var(--radius); background: var(--danger-bg); color: var(--danger); margin: 0; }
.verdict { display: flex; gap: var(--space-3); align-items: center; padding: var(--space-3) var(--space-4); margin-bottom: var(--space-3); border-left: 4px solid var(--border-strong); flex-wrap: wrap; }
.v-text { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 240px; }
.v-actions, .f-actions { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.error { border-left-color: var(--danger); }
.error > .ico, .error .s-head > .ico { color: var(--danger); }
.warning { border-left-color: var(--warning); }
.warning > .ico, .warning .s-head > .ico { color: var(--warning); }
.info { border-left-color: var(--info); }
.info > .ico, .info .s-head > .ico { color: var(--info); }
.ok { border-left-color: var(--success); }
.ok > .ico { color: var(--success); }
.svc { padding: var(--space-2) var(--space-4) var(--space-3); margin-bottom: var(--space-2); border-left: 4px solid var(--border-strong); display: flex; flex-direction: column; gap: var(--space-2); }
.s-head { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.img { margin-left: auto; max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.finding { display: flex; gap: var(--space-3); align-items: center; justify-content: space-between; flex-wrap: wrap; padding: 6px var(--space-3); border-radius: var(--radius); background: var(--surface-2); }
.f-text { display: flex; flex-direction: column; gap: 2px; min-width: 240px; flex: 1; font-size: 13px; overflow-wrap: anywhere; }
.more summary { cursor: pointer; color: var(--text-muted); }
.hlog { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.hlog li { display: flex; gap: 8px; align-items: baseline; min-width: 0; }
.out { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.log { margin: 6px 0 0; padding: var(--space-2) var(--space-3); border-radius: var(--radius); background: #0b1020; color: #d7dcf0; font-size: 12px; line-height: 1.5; max-height: 260px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
.stopped { padding: var(--space-2) var(--space-4); margin-bottom: var(--space-2); overflow-x: auto; }
.st-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.st-table th { text-align: left; font-size: 11px; text-transform: uppercase; color: var(--text-muted); font-weight: 500; padding: 4px 8px 4px 0; border-bottom: 1px solid var(--border); }
.st-table td { padding: 4px 8px 4px 0; border-bottom: 1px solid var(--border); vertical-align: middle; }
.img-c { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nowrap { white-space: nowrap; }
.err-text { color: var(--danger); }
.link { all: unset; cursor: pointer; color: var(--primary); }
.log-row td { border-bottom: 0; }
.ok-list { display: flex; gap: 8px; align-items: center; padding: var(--space-2) var(--space-4); border-left: 4px solid var(--success); }
.ok-list .ico { color: var(--success); flex: none; }
@media (max-width: 640px) { .img { margin-left: 0; max-width: 100%; } }
</style>
