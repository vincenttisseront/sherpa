<script setup lang="ts">
/**
 * Infrastructure › Vulnérabilités : dernière analyse Trivy de chaque image en service (par serveur),
 * projets qui l'utilisent, détail des vulnérabilités ; analyse à la demande et réglages (rythme,
 * sévérités, périmètre, image Trivy, miroir de la base).
 */
import { SEVERITIES, SEVERITY_LABEL, type Finding, type ImageScanDto, type ScanCleanupResult, type SeverityCounts, type SourceScanDto, type TrivySettings, type TrivyStatus } from '#shared/schemas/trivy'
import { ChevronDown, ChevronRight, Eraser, GitPullRequest, RefreshCw, Settings, ShieldAlert } from 'lucide-vue-next'
import { compareImageVersions, imageTechno } from '#shared/utils/image-techno'
import { REMEDIATION_STATE_LABEL, type RemediationRequestDto, type RemediationSubject, imageSubjectKey, sourceSubjectKey } from '#shared/schemas/remediation'
import { byCode } from '#shared/utils/compare'

useHead({ title: 'Vulnérabilités' })
const { hasAny } = useAuth()
const toast = useToast()
const canManage = computed(() => hasAny('policy:manage'))

interface Data { status: TrivyStatus, images: ImageScanDto[], sources: SourceScanDto[], requests: RemediationRequestDto[] }
const view = ref<'images' | 'sources'>('images')
const { data, refresh } = await useFetch<Data>('/api/vulnerabilities')
// Analyse en cours : relecture toutes les 5 s.
let timer: ReturnType<typeof setInterval> | undefined
// Analyse en cours ou demandée (ligne en file ou en cours) : relecture régulière.
const pending = computed(() => !!data.value?.status.run?.running || !!data.value?.status.queue?.waiting || !!data.value?.status.queue?.active || [...(data.value?.images ?? []), ...(data.value?.sources ?? [])].some(x => x.scanState))
watch(pending, (running) => {
  clearInterval(timer)
  if (running) timer = setInterval(() => void refresh(), 5000)
}, { immediate: true })
onBeforeUnmount(() => clearInterval(timer))

const server = ref('')
const minSeverity = ref<'' | 'CRITICAL' | 'HIGH'>('')
const q = ref('')
const servers = computed(() => [...new Set(data.value?.images.map(i => i.serverName) ?? [])].sort(byCode))
const images = computed(() => (data.value?.images ?? []).filter(i =>
  (!server.value || i.serverName === server.value)
  && (!minSeverity.value || i.counts.CRITICAL || (minSeverity.value === 'HIGH' && i.counts.HIGH))
  && (!q.value || `${i.image} ${i.targets.map(t => t.label).join(' ')}`.toLowerCase().includes(q.value.toLowerCase()))))
// Affichage des images : liste, ou une ligne par techno et ses versions en sous-lignes (préférence du navigateur).
const layout = ref<'list' | 'techno'>('list')
onMounted(() => {
  try {
    if (localStorage.getItem('vulnerabilities.layout') === 'techno') layout.value = 'techno'
  }
  catch {
    // Stockage du navigateur indisponible : liste par défaut.
  }
})
watch(layout, (v) => {
  try {
    localStorage.setItem('vulnerabilities.layout', v)
  }
  catch {
    // Préférence non mémorisée.
  }
})
interface TechnoGroup { key: string, versions: ImageScanDto[], tags: string[], servers: string[], projects: number, worst: ImageScanDto | null, fixable: number, failed: number, scanning: boolean, scannedAt: string }
// Pire version : le plus de critiques, puis de hautes, de moyennes, de basses.
const severityRank = (c: SeverityCounts) => [c.CRITICAL, c.HIGH, c.MEDIUM, c.LOW]
const worse = (a: ImageScanDto, b: ImageScanDto) => {
  const x = severityRank(a.counts)
  const y = severityRank(b.counts)
  const k = x.findIndex((n, j) => n !== y[j])
  return k >= 0 && x[k]! > y[k]!
}
const groups = computed<TechnoGroup[]>(() => {
  const m = new Map<string, ImageScanDto[]>()
  for (const i of images.value) {
    const key = imageTechno(i.image).techno
    m.set(key, [...(m.get(key) ?? []), i])
  }
  return [...m.entries()].map(([key, list]) => {
    const versions = [...list].sort((a, b) => compareImageVersions(imageTechno(a.image).version, imageTechno(b.image).version) || a.serverName.localeCompare(b.serverName))
    const ok = versions.filter(v => v.status === 'ok')
    return {
      key,
      versions,
      tags: [...new Set(versions.map(v => imageTechno(v.image).version))],
      servers: [...new Set(versions.map(v => v.serverName))].sort(byCode),
      projects: new Set(versions.flatMap(v => v.targets.map(t => t.targetId))).size,
      worst: ok.reduce<ImageScanDto | null>((w, v) => (!w || worse(v, w) ? v : w), null),
      fixable: Math.max(0, ...ok.map(v => v.fixable)),
      failed: versions.length - ok.length,
      scanning: versions.some(v => v.scanState),
      scannedAt: versions.map(v => v.scannedAt).sort(byCode).at(-1)!,
    }
  }).sort((a, b) => (a.worst && b.worst ? (worse(a.worst, b.worst) ? -1 : worse(b.worst, a.worst) ? 1 : 0) : a.worst ? -1 : b.worst ? 1 : 0) || a.key.localeCompare(b.key))
})
const expanded = ref(new Set<string>())
function toggleGroup(key: string) {
  const next = new Set(expanded.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  expanded.value = next
}
const allExpanded = computed(() => groups.value.length > 0 && groups.value.every(g => expanded.value.has(g.key)))
const toggleAll = () => {
  expanded.value = allExpanded.value ? new Set() : new Set(groups.value.map(g => g.key))
}
type ImageRow = { kind: 'group', g: TechnoGroup } | { kind: 'image', i: ImageScanDto, version: string | null }
const imageRows = computed<ImageRow[]>(() => layout.value === 'list'
  ? images.value.map(i => ({ kind: 'image' as const, i, version: null }))
  : groups.value.flatMap(g => [{ kind: 'group' as const, g }, ...(expanded.value.has(g.key) ? g.versions.map(i => ({ kind: 'image' as const, i, version: imageTechno(i.image).version })) : [])]))
const rowKey = (r: ImageRow) => (r.kind === 'group' ? `g:${r.g.key}` : r.i.id)

const totals = computed(() => (data.value?.images ?? []).reduce((a, i) => ({ critical: a.critical + i.counts.CRITICAL, high: a.high + i.counts.HIGH, affected: a.affected + (i.counts.CRITICAL || i.counts.HIGH ? 1 : 0) }), { critical: 0, high: 0, affected: 0 }))

const preDeployLabel = computed(() => {
  const st = data.value?.status.settings
  if (!st || (!st.buildScan && !st.registryScan && !st.sourceScan)) return 'non'
  const what = [st.buildScan ? 'images construites' : null, st.registryScan ? 'images des registres' : null, st.sourceScan ? `dépendances du code source${st.buildBlock !== 'off' && !st.sourceBlock ? ' (sans blocage)' : ''}` : null].filter(Boolean).join(', ')
  return `${what}, ${st.buildBlock === 'off' ? 'sans blocage' : `bloquant (${st.buildBlock === 'CRITICAL' ? 'critiques' : 'critiques et hautes'}${st.buildBlockFixableOnly ? ' corrigeables' : ''})`}`
})
// Analyse la plus récente, quelle qu'en soit l'origine (déploiement compris).
const TRIGGER = { deploy: 'au déploiement', planned: 'planifiée', manual: 'à la demande' } as const
const latestScan = computed(() => [...(data.value?.images ?? []), ...(data.value?.sources ?? [])].filter(x => x.status === 'ok').sort((a, b) => b.scannedAt.localeCompare(a.scannedAt))[0] ?? null)
const latestScanLabel = (x: { image?: string, label?: string }) => ('image' in x && x.image ? x.image : x.label ? `code source de ${x.label}` : '')
const severityList = computed(() => data.value?.status.settings.severities.map(x => SEVERITY_LABEL[x].toLowerCase()).join(', ') ?? '')

const scanning = ref(false)
async function scanAll() {
  scanning.value = true
  try {
    await $fetch('/api/vulnerabilities/scan', { method: 'POST', body: {} })
    toast.info('Analyse lancée : une image après l\'autre')
    setTimeout(() => void refresh(), 1500)
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    scanning.value = false
  }
}

// Nettoyage des analyses : aperçu à chaque changement de motif, puis suppression.
const cleanOpen = ref(false)
const clean = reactive({ stale: true, duplicates: true, failed: false, sources: false, all: false })
const cleanPreview = ref<ScanCleanupResult | null>(null)
const previewing = ref(false)
const cleaning = ref(false)
let previewSeq = 0
async function previewClean() {
  const seq = ++previewSeq
  previewing.value = true
  try {
    const r = await $fetch<ScanCleanupResult>('/api/vulnerabilities/cleanup', { query: { ...clean } })
    if (seq === previewSeq) cleanPreview.value = r
  }
  catch (err) {
    if (seq === previewSeq) toast.error(apiError(err).message)
  }
  finally {
    if (seq === previewSeq) previewing.value = false
  }
}
function openClean() {
  Object.assign(clean, { stale: true, duplicates: true, failed: false, sources: false, all: false })
  cleanPreview.value = null
  cleanOpen.value = true
  void previewClean()
}
watch(clean, () => {
  if (cleanOpen.value) void previewClean()
})
const cleanTotal = computed(() => (cleanPreview.value ? cleanPreview.value.images + cleanPreview.value.sources : 0))
async function runClean() {
  cleaning.value = true
  try {
    const r = await $fetch<ScanCleanupResult>('/api/vulnerabilities/cleanup', { method: 'POST', body: { ...clean, dryRun: false } })
    toast.success(`${r.images} analyse(s) d'images et ${r.sources} de code source supprimée(s)`)
    cleanOpen.value = false
    await refresh()
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    cleaning.value = false
  }
}

// Détail d'une image.
const selected = ref<(ImageScanDto & { findings: Finding[] }) | null>(null)
const drawer = computed({ get: () => !!selected.value, set: (v) => { if (!v) selected.value = null } })
async function open(i: ImageScanDto) {
  selected.value = await $fetch<ImageScanDto & { findings: Finding[] }>(`/api/vulnerabilities/${i.id}`).catch((err) => {
    toast.error(apiError(err).message)
    return null
  })
}

// Dépendances du code source : filtres communs (serveur, sévérité, recherche) et détail.
const sources = computed(() => (data.value?.sources ?? []).filter(x =>
  (!server.value || x.serverName === server.value)
  && (!minSeverity.value || x.counts.CRITICAL || (minSeverity.value === 'HIGH' && x.counts.HIGH))
  && (!q.value || `${x.label} ${x.repository ?? ''} ${x.manifests.join(' ')}`.toLowerCase().includes(q.value.toLowerCase()))))
const selectedSource = ref<(SourceScanDto & { findings: Finding[] }) | null>(null)
const sourceDrawer = computed({ get: () => !!selectedSource.value, set: (v) => { if (!v) selectedSource.value = null } })
async function openSource(x: SourceScanDto) {
  selectedSource.value = await $fetch<SourceScanDto & { findings: Finding[] }>(`/api/vulnerabilities/sources/${x.id}`).catch((err) => {
    toast.error(apiError(err).message)
    return null
  })
}
// Demandes de correction (issues, PR) : par sujet, la plus récente d'abord.
const remediation = ref<{ subject: RemediationSubject, label: string } | null>(null)
const remediationOpen = computed({ get: () => !!remediation.value, set: (v) => { if (!v) remediation.value = null } })
const requestsBy = computed(() => {
  const m = new Map<string, RemediationRequestDto[]>()
  for (const r of data.value?.requests ?? []) m.set(r.subjectKey, [...(m.get(r.subjectKey) ?? []), r])
  return m
})
const imageRequests = (i: ImageScanDto) => requestsBy.value.get(imageSubjectKey(i.endpointId, i.image)) ?? []
const sourceRequests = (x: SourceScanDto) => requestsBy.value.get(sourceSubjectKey(x.targetId)) ?? []
const openRequests = computed(() => (data.value?.requests ?? []).filter(r => r.state === 'open').length)
const resolvedRequests = computed(() => (data.value?.requests ?? []).filter(r => r.state === 'resolved' || r.state === 'merged').length)
const REQ_TONE = { open: 'info', closed: 'neutral', merged: 'success', resolved: 'success' } as const
const syncing = ref(false)
async function syncRequests() {
  syncing.value = true
  try {
    const r = await $fetch<{ checked: number, changed: number, resolved: number }>('/api/vulnerabilities/remediation/sync', { method: 'POST' })
    toast.success(`${r.checked} demande(s) vérifiée(s) sur GitHub : ${r.changed} changement(s), ${r.resolved} résolue(s)`)
    await refresh()
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    syncing.value = false
  }
}
// Analyse d'une seule ligne (image ou code source), suivie par l'état de l'analyse.
const scanningOne = ref<string | null>(null)
async function scanOne(body: { imageScanId: string } | { sourceScanId: string }, label: string) {
  scanningOne.value = 'imageScanId' in body ? body.imageScanId : body.sourceScanId
  try {
    await $fetch('/api/vulnerabilities/scan', { method: 'POST', body })
    toast.info(`Analyse de ${label} lancée`)
    await refresh()
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    scanningOne.value = null
  }
}
const askFix = (subject: RemediationSubject, label: string) => {
  remediation.value = { subject, label }
}

const refLabel = (x: SourceScanDto) => [x.ref?.replace(/^(branch|tag|commit):/, ''), x.commitSha?.slice(0, 7)].filter(Boolean).join(' @ ')

// Réglages.
const settingsOpen = ref(false)
const form = ref<TrivySettings | null>(null)
const freq = ref<'weekly' | 'daily' | 'custom'>('weekly')
const day = ref(1)
const hour = ref(3)
const errors = ref<Record<string, string>>({})
const saving = ref(false)
const DAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi']
function openSettings() {
  form.value = structuredClone(toRaw(data.value!.status.settings))
  const weekly = /^0 (\d{1,2}) \* \* ([0-6])$/.exec(form.value.cron)
  const daily = /^0 (\d{1,2}) \* \* \*$/.exec(form.value.cron)
  freq.value = weekly ? 'weekly' : daily ? 'daily' : 'custom'
  hour.value = Number((weekly ?? daily)?.[1] ?? 3)
  day.value = Number(weekly?.[2] ?? 1)
  errors.value = {}
  settingsOpen.value = true
}
watch([freq, day, hour], () => {
  if (!form.value) return
  if (freq.value === 'weekly') form.value.cron = `0 ${hour.value} * * ${day.value}`
  else if (freq.value === 'daily') form.value.cron = `0 ${hour.value} * * *`
})
function toggleSeverity(s: (typeof SEVERITIES)[number]) {
  const list = form.value!.severities
  form.value!.severities = list.includes(s) ? list.filter(x => x !== s) : SEVERITIES.filter(x => x === s || list.includes(x))
}
async function saveSettings() {
  saving.value = true
  errors.value = {}
  try {
    await $fetch('/api/admin/trivy', { method: 'PUT', body: form.value })
    toast.success('Réglages enregistrés et analyse replanifiée')
    settingsOpen.value = false
    await refresh()
  }
  catch (err) {
    const e = apiError(err)
    errors.value = e.errors
    toast.error(e.message)
  }
  finally {
    saving.value = false
  }
}
const scheduleLabel = (s: TrivySettings) => {
  if (!s.enabled) return 'désactivée'
  const w = /^0 (\d{1,2}) \* \* ([0-6])$/.exec(s.cron)
  const d = /^0 (\d{1,2}) \* \* \*$/.exec(s.cron)
  return w ? `chaque ${DAYS[Number(w[2])]} à ${w[1]}:00 (${s.timezone})` : d ? `chaque jour à ${d[1]}:00 (${s.timezone})` : `cron « ${s.cron} » (${s.timezone})`
}
</script>

<template>
  <div>
    <UiPageHeader title="Vulnérabilités" :icon="ShieldAlert">
      <UiButton v-if="canManage" size="sm" variant="ghost" title="Supprimer les analyses d'images arrêtées, en double, en échec…" @click="openClean"><Eraser :size="14" /> Nettoyer…</UiButton>
      <UiButton v-if="canManage" size="sm" variant="ghost" @click="openSettings"><Settings :size="14" /> Réglages</UiButton>
      <UiButton v-if="canManage" size="sm" variant="primary" :loading="scanning || !!data?.status.run?.running" @click="scanAll"><RefreshCw :size="14" /> Analyser maintenant</UiButton>
    </UiPageHeader>

    <template v-if="data">
      <section class="card pad">
        <div class="kpis">
          <div class="kpi"><strong>{{ data.images.length }}</strong><span>image(s) analysée(s)</span></div>
          <div class="kpi"><strong :class="{ bad: totals.critical }">{{ totals.critical }}</strong><span>critiques</span></div>
          <div class="kpi"><strong :class="{ bad: totals.high }">{{ totals.high }}</strong><span>hautes</span></div>
          <div class="kpi"><strong>{{ totals.affected }}</strong><span>image(s) concernée(s)</span></div>
        </div>
        <p class="muted small">
          Trivy ({{ data.status.settings.image }}) · analyse {{ scheduleLabel(data.status.settings) }} · avant déploiement : {{ preDeployLabel }} · {{ data.status.settings.scope === 'managed' ? 'conteneurs gérés par la console' : 'tous les conteneurs en marche' }} · sévérités {{ severityList }}
        </p>
        <p v-if="data.requests.length" class="small reqline">
          Demandes de correction : <strong>{{ openRequests }}</strong> en cours, {{ resolvedRequests }} fusionnée(s) ou résolue(s)
          <UiButton size="sm" variant="ghost" :loading="syncing" @click="syncRequests"><RefreshCw :size="12" /> Vérifier sur GitHub</UiButton>
        </p>
        <p v-if="latestScan && (!data.status.run?.finishedAt || latestScan.scannedAt > data.status.run.finishedAt) && !data.status.run?.running" class="small">
          Dernière analyse {{ latestScan.trigger ? TRIGGER[latestScan.trigger] : '' }} {{ fmtRelative(latestScan.scannedAt) }} : <span class="mono">{{ latestScanLabel(latestScan) }}</span>
          <NuxtLink v-if="latestScan.deploymentId" :to="`/deployments/${latestScan.deploymentId}`">voir le déploiement</NuxtLink>
        </p>
        <p v-else-if="data.status.run" class="small">
          <template v-if="data.status.run.running">Analyse en cours ({{ data.status.run.trigger }}) : {{ data.status.run.done }} / {{ data.status.run.total }}<span v-if="data.status.run.current" class="muted"> · {{ data.status.run.current }}</span></template>
          <template v-else>Dernière analyse ({{ data.status.run.trigger }}) terminée {{ fmtRelative(data.status.run.finishedAt!) }} : {{ data.status.run.done }} image(s)<span v-if="data.status.run.failed" class="warn">, {{ data.status.run.failed }} en échec</span></template>
        </p>
        <p v-if="data.status.run?.note && !data.status.run.running" class="small muted">Dernière demande ({{ data.status.run.trigger }}) : {{ data.status.run.note }}.</p>
        <p v-if="data.status.run?.lastError && !data.status.run.running" class="small warn">Dernière analyse : {{ data.status.run.failed }} échec(s) — {{ data.status.run.lastError }}</p>
        <p v-if="data.status.queue && (data.status.queue.waiting || data.status.queue.active)" class="small">
          File des analyses : {{ data.status.queue.active ? `1 en cours${data.status.queue.activeSince ? ` depuis ${fmtRelative(data.status.queue.activeSince)}` : ''}` : 'aucune en cours' }}{{ data.status.queue.waiting ? `, ${data.status.queue.waiting} en attente` : '' }}
        </p>
        <p v-if="data.status.queue?.lastFailure && (!data.status.run?.finishedAt || data.status.queue.lastFailure.at >= data.status.run.finishedAt)" class="small warn">Analyse interrompue {{ fmtRelative(data.status.queue.lastFailure.at) }} : {{ data.status.queue.lastFailure.reason }}</p>
        <p v-if="!data.status.run && !latestScan" class="muted small">Aucune analyse encore : la première aura lieu au prochain créneau, ou maintenant avec « Analyser maintenant ».</p>
      </section>

      <section class="card pad">
        <UiTabs v-model="view" :tabs="[{ key: 'images', label: `Images (${data.images.length})` }, { key: 'sources', label: `Code source (${data.sources.length})`, title: 'Dépendances déclarées dans le code source des releases actives' }]" />
        <div class="bar">
          <select v-if="servers.length > 1" v-model="server" class="input sm" aria-label="Serveur"><option value="">Tous les serveurs</option><option v-for="s in servers" :key="s" :value="s">{{ s }}</option></select>
          <select v-model="minSeverity" class="input sm" aria-label="Filtrer par sévérité"><option value="">Toutes</option><option value="CRITICAL">Avec critiques</option><option value="HIGH">Avec critiques ou hautes</option></select>
          <input v-model="q" class="input sm grow" placeholder="Image, projet…" aria-label="Rechercher une image ou un projet">
          <div v-if="view === 'images'" class="seg" role="radiogroup" aria-label="Affichage des images">
            <button type="button" role="radio" :aria-checked="layout === 'list'" :class="{ on: layout === 'list' }" @click="layout = 'list'">Liste</button>
            <button type="button" role="radio" :aria-checked="layout === 'techno'" :class="{ on: layout === 'techno' }" @click="layout = 'techno'">Par techno</button>
          </div>
          <UiButton v-if="view === 'images' && layout === 'techno' && groups.length" size="sm" variant="ghost" @click="toggleAll">{{ allExpanded ? 'Tout replier' : 'Tout déplier' }}</UiButton>
        </div>
        <table v-if="view === 'images'" class="table">
          <thead><tr><th>Image</th><th>Serveur</th><th>Projets</th><th>Vulnérabilités</th><th class="num">Corrigeables</th><th>Analyse</th><th>Correction</th></tr></thead>
          <tbody>
            <tr v-if="!imageRows.length"><td colspan="7" class="muted">Aucune image</td></tr>
            <template v-for="r in imageRows" :key="rowKey(r)">
            <tr v-if="r.kind === 'group'" class="clickable group" @click="toggleGroup(r.g.key)">
              <td>
                <button type="button" class="chev" :aria-expanded="expanded.has(r.g.key)" :aria-label="`Versions de ${r.g.key}`" @click.stop="toggleGroup(r.g.key)"><ChevronDown v-if="expanded.has(r.g.key)" :size="14" /><ChevronRight v-else :size="14" /></button>
                <strong class="mono">{{ r.g.key }}</strong>
                <div class="muted small">{{ r.g.tags.length > 1 ? `${r.g.tags.length} versions` : 'version' }} {{ r.g.tags.slice(0, 4).join(', ') }}<template v-if="r.g.tags.length > 4">…</template><template v-if="r.g.versions.length > r.g.tags.length"> · {{ r.g.versions.length }} analyses</template></div>
              </td>
              <td class="small">{{ r.g.servers.join(', ') }}</td>
              <td class="small">{{ r.g.projects ? `${r.g.projects} cible(s)` : '' }}<span v-if="!r.g.projects" class="muted">hors console</span></td>
              <td>
                <span v-if="r.g.scanning" class="scan-state" role="status"><span class="spinner" aria-hidden="true" />analyse en cours</span>
                <SeverityCounts v-if="r.g.worst" :counts="r.g.worst.counts" />
                <div v-if="r.g.worst && r.g.tags.length > 1" class="muted small">pire version : {{ imageTechno(r.g.worst.image).version }}</div>
                <UiBadge v-if="r.g.failed" tone="danger">{{ r.g.failed }} échec(s)</UiBadge>
              </td>
              <td class="num">{{ r.g.fixable }}</td>
              <td class="small">{{ fmtRelative(r.g.scannedAt) }}</td>
              <td />
            </tr>
            <tr v-else :class="['clickable', { child: r.version !== null }]" @click="open(r.i)">
              <td class="mono"><template v-if="r.version !== null"><span class="sub" aria-hidden="true">↳</span> <strong>{{ r.version }}</strong></template><template v-else>{{ r.i.image }}</template><div class="muted small">{{ [r.i.imageVersion ? `version ${r.i.imageVersion}` : null, r.i.imageId.startsWith('sha256:') ? r.i.imageId.slice(7, 19) : null, r.i.os].filter(Boolean).join(' · ') }}</div></td>
              <td class="small">{{ r.i.serverName }}</td>
              <td class="small"><div v-for="t in r.i.targets" :key="t.targetId">{{ t.label }} <span class="muted">· {{ t.services.join(', ') }}</span></div><span v-if="!r.i.targets.length" class="muted">hors console</span></td>
              <td><span v-if="r.i.scanState" class="scan-state" role="status"><span class="spinner" aria-hidden="true" />{{ r.i.scanState === 'running' ? 'analyse en cours' : 'en file d\'attente' }}</span><UiBadge v-if="r.i.status === 'error'" tone="danger" :title="r.i.error ?? ''">échec</UiBadge><SeverityCounts v-else :counts="r.i.counts" /></td>
              <td class="num">{{ r.i.fixable }}</td>
              <td class="small">{{ fmtRelative(r.i.scannedAt) }}<div v-if="r.i.trigger" class="muted"><NuxtLink v-if="r.i.deploymentId" :to="`/deployments/${r.i.deploymentId}`" @click.stop>{{ TRIGGER[r.i.trigger] }}</NuxtLink><template v-else>{{ TRIGGER[r.i.trigger] }}</template></div><div v-if="r.i.error" class="warn small" :title="r.i.error">{{ r.i.error.slice(0, 80) }}</div></td>
              <td class="fix" @click.stop>
                <a v-for="req in imageRequests(r.i).slice(0, 2)" :key="req.id" :href="req.url" target="_blank" rel="noopener" class="req"><UiBadge :tone="REQ_TONE[req.state]">{{ req.kind === 'pr' ? 'PR' : 'Issue' }} #{{ req.number }} {{ REMEDIATION_STATE_LABEL[req.state] }}</UiBadge></a>
                <UiButton size="sm" variant="ghost" :loading="scanningOne === r.i.id || !!r.i.scanState" :disabled="!!data?.status.run?.running" :aria-label="`Analyser ${r.i.image}`" title="Relancer l'analyse Trivy de cette seule image" @click="scanOne({ imageScanId: r.i.id }, r.i.image)"><RefreshCw :size="13" /> Analyser</UiButton>
                <UiButton v-if="r.i.status === 'ok' && (r.i.counts.CRITICAL + r.i.counts.HIGH + r.i.counts.MEDIUM + r.i.counts.LOW) > 0" size="sm" variant="ghost" :aria-label="`Demande de correction pour ${r.i.image}`" @click="askFix({ type: 'image', id: r.i.id }, r.i.image)"><GitPullRequest :size="13" /> Corriger</UiButton>
              </td>
            </tr>
            </template>
          </tbody>
        </table>
        <table v-else class="table">
          <thead><tr><th>Projet</th><th>Source</th><th>Fichiers de dépendances</th><th>Vulnérabilités</th><th class="num">Corrigeables</th><th>Analyse</th><th>Correction</th></tr></thead>
          <tbody>
            <tr v-if="!sources.length"><td colspan="7" class="muted">Aucune analyse du code source</td></tr>
            <tr v-for="x in sources" :key="x.id" class="clickable" @click="openSource(x)">
              <td class="small"><NuxtLink :to="`/projects/${x.projectId}?tab=vulnerabilities`" @click.stop>{{ x.label }}</NuxtLink><div class="muted">{{ x.serverName }}</div></td>
              <td class="small"><span v-if="x.repository" class="mono">{{ x.repository }}</span><span v-else class="muted">archive</span><div class="muted mono">{{ refLabel(x) || x.release }}</div></td>
              <td class="small mono">{{ x.manifests.slice(0, 3).join(', ') || '—' }}<span v-if="x.manifests.length > 3" class="muted"> +{{ x.manifests.length - 3 }}</span></td>
              <td><span v-if="x.scanState" class="scan-state" role="status"><span class="spinner" aria-hidden="true" />{{ x.scanState === 'running' ? 'analyse en cours' : 'en file d\'attente' }}</span><UiBadge v-if="x.status === 'error'" tone="danger" :title="x.error ?? ''">échec</UiBadge><SeverityCounts v-else :counts="x.counts" /></td>
              <td class="num">{{ x.fixable }}</td>
              <td class="small">{{ fmtRelative(x.scannedAt) }}<div v-if="x.trigger" class="muted"><NuxtLink v-if="x.deploymentId" :to="`/deployments/${x.deploymentId}`" @click.stop>{{ TRIGGER[x.trigger] }}</NuxtLink><template v-else>{{ TRIGGER[x.trigger] }}</template></div></td>
              <td class="fix" @click.stop>
                <a v-for="r in sourceRequests(x).slice(0, 2)" :key="r.id" :href="r.url" target="_blank" rel="noopener" class="req"><UiBadge :tone="REQ_TONE[r.state]">{{ r.kind === 'pr' ? 'PR' : 'Issue' }} #{{ r.number }} {{ REMEDIATION_STATE_LABEL[r.state] }}</UiBadge></a>
                <UiButton size="sm" variant="ghost" :loading="scanningOne === x.id || !!x.scanState" :disabled="!!data?.status.run?.running" :aria-label="`Analyser le code source de ${x.label}`" title="Relancer l'analyse Trivy de ce seul code source" @click="scanOne({ sourceScanId: x.id }, `code source de ${x.label}`)"><RefreshCw :size="13" /> Analyser</UiButton>
                <UiButton v-if="x.status === 'ok' && (x.counts.CRITICAL + x.counts.HIGH + x.counts.MEDIUM + x.counts.LOW) > 0" size="sm" variant="ghost" :aria-label="`Demande de correction pour le code source de ${x.label}`" @click="askFix({ type: 'source', id: x.id }, `code source de ${x.label}`)"><GitPullRequest :size="13" /> Corriger</UiButton>
              </td>
            </tr>
          </tbody>
        </table>
      </section>
    </template>

    <UiDrawer v-model:open="sourceDrawer" :title="selectedSource ? `Code source — ${selectedSource.label}` : ''" width="860px">
      <div v-if="selectedSource" class="detail">
        <p class="small">{{ selectedSource.repository ?? 'archive' }} {{ refLabel(selectedSource) }} · analysé {{ fmtRelative(selectedSource.scannedAt) }} · <SeverityCounts :counts="selectedSource.counts" /></p>
        <p class="small">Fichiers de dépendances : <span class="mono">{{ selectedSource.manifests.join(', ') || 'aucun' }}</span></p>
        <p v-if="selectedSource.error" class="warn small">{{ selectedSource.error }}</p>
        <div><UiButton size="sm" variant="primary" @click="askFix({ type: 'source', id: selectedSource.id }, `code source de ${selectedSource.label}`)"><GitPullRequest :size="13" /> Demande de correction (issue ou PR)</UiButton></div>
        <VulnerabilityFindings :findings="selectedSource.findings" />
      </div>
    </UiDrawer>

    <UiDrawer v-model:open="drawer" :title="selected?.image ?? ''" width="860px">
      <div v-if="selected" class="detail">
        <p class="small">{{ selected.serverName }} · {{ selected.os ?? 'système inconnu' }} · analysée {{ fmtRelative(selected.scannedAt) }} · <SeverityCounts :counts="selected.counts" /></p>
        <p v-if="selected.targets.length" class="small">Utilisée par : <template v-for="(t, k) in selected.targets" :key="t.targetId"><NuxtLink :to="`/projects/${t.projectId}?tab=vulnerabilities`">{{ t.label }}</NuxtLink><template v-if="k < selected.targets.length - 1">, </template></template></p>
        <p v-if="selected.error" class="warn small">{{ selected.error }}</p>
        <div><UiButton size="sm" variant="primary" @click="askFix({ type: 'image', id: selected.id }, selected.image)"><GitPullRequest :size="13" /> Demande de correction (issue ou PR)</UiButton></div>
        <VulnerabilityFindings :findings="selected.findings" />
      </div>
    </UiDrawer>

    <RemediationDialog v-if="remediation" v-model:open="remediationOpen" :subject="remediation.subject" :label="remediation.label" @created="refresh()" />

    <UiModal v-model:open="cleanOpen" title="Nettoyer les analyses" width="600px">
      <div class="stack">
        <p class="small muted">Les analyses retirées sont refaites à la prochaine analyse (planifiée ou « Analyser maintenant »). Les demandes de correction sont conservées.</p>
        <div class="checks">
          <label class="small"><input v-model="clean.stale" type="checkbox" :disabled="clean.all"> <strong>Images qui ne tournent plus</strong> (ni l'empreinte ni la référence parmi les conteneurs en marche, ou serveur désactivé) <span v-if="cleanPreview && clean.stale && !clean.all" class="muted">· {{ cleanPreview.byReason.stale }}</span></label>
          <label class="small"><input v-model="clean.duplicates" type="checkbox" :disabled="clean.all"> <strong>Analyses plus anciennes d'une même image</strong> sur un même serveur : seule la plus récente reste <span v-if="cleanPreview && clean.duplicates && !clean.all" class="muted">· {{ cleanPreview.byReason.duplicates }}</span></label>
          <label class="small"><input v-model="clean.failed" type="checkbox" :disabled="clean.all"> <strong>Analyses en échec</strong> <span v-if="cleanPreview && clean.failed && !clean.all" class="muted">· {{ cleanPreview.byReason.failed }}</span></label>
          <label class="small"><input v-model="clean.sources" type="checkbox" :disabled="clean.all"> <strong>Code source</strong> des cibles sans release active ou des projets archivés <span v-if="cleanPreview && clean.sources && !clean.all" class="muted">· {{ cleanPreview.byReason.sources }}</span></label>
          <label class="small danger-text"><input v-model="clean.all" type="checkbox"> <strong>Tout effacer</strong> (images et code source)</label>
        </div>
        <p class="small" role="status">
          <template v-if="previewing && !cleanPreview">Calcul…</template>
          <template v-else-if="cleanPreview">À supprimer : <strong>{{ cleanPreview.images }}</strong> analyse(s) d'images, <strong>{{ cleanPreview.sources }}</strong> de code source<span v-if="previewing" class="muted"> (mise à jour…)</span></template>
        </p>
        <p v-if="cleanPreview?.unreachable.length" class="small warn">Injoignable(s), images non comptées comme arrêtées : {{ cleanPreview.unreachable.join(', ') }}</p>
      </div>
      <template #footer>
        <UiButton variant="ghost" @click="cleanOpen = false">Annuler</UiButton>
        <UiButton variant="danger" :loading="cleaning" :disabled="previewing || !cleanTotal" @click="runClean">Supprimer {{ cleanTotal || '' }} analyse(s)</UiButton>
      </template>
    </UiModal>

    <UiModal v-model:open="settingsOpen" title="Analyse de vulnérabilités (Trivy)" width="640px">
      <form v-if="form" class="stack" @submit.prevent="saveSettings">
        <UiSwitch v-model="form.enabled" label="Analyse planifiée" />
        <div class="row-3">
          <UiField label="Fréquence" for="tv-freq">
            <select id="tv-freq" v-model="freq" class="input"><option value="weekly">Chaque semaine</option><option value="daily">Chaque jour</option><option value="custom">Personnalisée (cron)</option></select>
          </UiField>
          <UiField v-if="freq === 'weekly'" label="Jour" for="tv-day"><select id="tv-day" v-model.number="day" class="input"><option v-for="(d, n) in DAYS" :key="n" :value="n">{{ d }}</option></select></UiField>
          <UiField v-if="freq !== 'custom'" label="Heure" for="tv-hour"><select id="tv-hour" v-model.number="hour" class="input"><option v-for="h in 24" :key="h" :value="h - 1">{{ h - 1 }}:00</option></select></UiField>
          <UiField v-if="freq === 'custom'" class="span2" label="Expression cron" for="tv-cron" :error="errors.cron" hint="minute heure jour mois jour-de-semaine"><input id="tv-cron" v-model.trim="form.cron" class="input mono"></UiField>
        </div>
        <UiField label="Fuseau horaire" for="tv-tz" :error="errors.timezone"><input id="tv-tz" v-model.trim="form.timezone" class="input mono"></UiField>
        <UiField label="Sévérités relevées" for="tv-sev" :error="errors.severities">
          <div id="tv-sev" class="sev">
            <label v-for="s in SEVERITIES" :key="s" class="small"><input type="checkbox" :checked="form.severities.includes(s)" @change="toggleSeverity(s)"> {{ SEVERITY_LABEL[s] }}</label>
          </div>
        </UiField>
        <label class="small"><input v-model="form.ignoreUnfixed" type="checkbox"> Ignorer les vulnérabilités sans correctif publié</label>
        <UiField label="Périmètre" for="tv-scope">
          <select id="tv-scope" v-model="form.scope" class="input"><option value="managed">Images des conteneurs gérés par la console</option><option value="all">Images de tous les conteneurs en marche</option></select>
        </UiField>
        <UiField label="Notifier les nouvelles vulnérabilités" for="tv-notify">
          <select id="tv-notify" v-model="form.notifyMin" class="input"><option value="CRITICAL">Critiques</option><option value="HIGH">Critiques et hautes</option><option value="off">Jamais</option></select>
        </UiField>
        <fieldset class="build">
          <legend class="small">Avant chaque déploiement</legend>
          <UiSwitch v-model="form.buildScan" label="Analyser les images construites par la console" />
          <UiSwitch v-model="form.registryScan" label="Analyser les images des registres (récupérées sur l'hôte avant le déploiement)" />
          <UiSwitch v-model="form.sourceScan" label="Analyser les dépendances du code source (aussi à chaque analyse planifiée)" />
          <div v-if="form.buildScan || form.registryScan || form.sourceScan" class="row-2b">
            <UiField label="Bloquer le déploiement" for="tv-block">
              <select id="tv-block" v-model="form.buildBlock" class="input"><option value="off">Jamais (résultat dans le journal)</option><option value="CRITICAL">Si vulnérabilité critique</option><option value="HIGH">Si vulnérabilité critique ou haute</option></select>
            </UiField>
            <div v-if="form.buildBlock !== 'off'" class="checks">
              <label class="small"><input v-model="form.buildBlockFixableOnly" type="checkbox"> Seulement si un correctif est publié</label>
              <label v-if="form.sourceScan" class="small"><input v-model="form.sourceBlock" type="checkbox"> Aussi pour les dépendances du code source</label>
            </div>
          </div>
        </fieldset>
        <div class="row-2">
          <UiField label="Image Trivy" for="tv-image" :error="errors.image"><input id="tv-image" v-model.trim="form.image" class="input mono"></UiField>
          <UiField label="Délai par image (min)" for="tv-timeout"><input id="tv-timeout" v-model.number="form.timeoutMin" type="number" min="1" max="60" class="input"></UiField>
        </div>
        <UiField label="Miroir de la base de vulnérabilités" for="tv-db" :error="errors.dbRepository" hint="Vide : mirror.gcr.io / ghcr.io. Sinon un registre interne (réseau sans accès Internet)">
          <input id="tv-db" :value="form.dbRepository ?? ''" class="input mono" placeholder="registre.interne/aquasec/trivy-db:2" @input="form.dbRepository = ($event.target as HTMLInputElement).value.trim() || null">
        </UiField>
        <div class="foot">
          <UiButton variant="ghost" @click="settingsOpen = false">Annuler</UiButton>
          <UiButton variant="primary" type="submit" :loading="saving">Enregistrer</UiButton>
        </div>
      </form>
    </UiModal>
  </div>
</template>

<style scoped>
.pad { padding: var(--space-3) var(--space-4); display: flex; flex-direction: column; gap: var(--space-2); margin-bottom: var(--space-3); }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: var(--space-2); }
.kpi { display: flex; flex-direction: column; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-2); }
.kpi strong { font-size: 20px; font-variant-numeric: tabular-nums; }
.kpi span { font-size: 12px; color: var(--text-muted); }
.bad { color: var(--danger); }
.warn { color: var(--warning); }
.small { font-size: 12.5px; margin: 0; }
.bar { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center; }
.grow { flex: 1; min-width: 180px; }
.table { width: 100%; border-collapse: collapse; font-size: 13px; }
.table th { text-align: left; font-size: 11px; text-transform: uppercase; color: var(--text-muted); padding: 4px 6px; border-bottom: 1px solid var(--border); }
.table td { padding: 6px; border-bottom: 1px solid var(--border); vertical-align: top; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.clickable { cursor: pointer; }
.clickable:hover { background: var(--surface-2); }
.detail { display: flex; flex-direction: column; gap: var(--space-2); }
.stack { display: flex; flex-direction: column; gap: var(--space-2); }
.row-2 { display: grid; grid-template-columns: 2fr 1fr; gap: var(--space-2); }
.row-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--space-2); }
.span2 { grid-column: span 2; }
.build { border: 1px solid var(--border); border-radius: var(--radius); padding: var(--space-2) var(--space-3); display: flex; flex-direction: column; gap: var(--space-2); margin: 0; }
.checks { display: flex; flex-direction: column; gap: 4px; }
.row-2b { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-2); align-items: end; }
.sev { display: flex; gap: var(--space-3); flex-wrap: wrap; }
.foot { display: flex; justify-content: flex-end; gap: var(--space-2); }
.fix { white-space: nowrap; }
.seg { display: inline-flex; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
.seg button { border: 0; background: transparent; padding: 4px 10px; font-size: 12.5px; color: var(--text-muted); cursor: pointer; }
.seg button.on { background: var(--primary); color: var(--primary-contrast, #fff); }
.group td { background: var(--surface-2); }
.child td:first-child { padding-left: 28px; }
.sub { color: var(--text-muted); }
.chev { border: 0; background: transparent; padding: 0 4px 0 0; cursor: pointer; color: var(--text-muted); vertical-align: middle; }
.danger-text { color: var(--danger); }
.fix .req { display: inline-block; margin-right: 4px; text-decoration: none; }
.reqline { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.scan-state { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--primary); margin-right: 6px; }
.spinner { width: 12px; height: 12px; border: 2px solid color-mix(in srgb, var(--primary) 25%, transparent); border-top-color: var(--primary); border-radius: 50%; animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 2.4s; } }
</style>
