<script setup lang="ts">
/** Vulnérabilités des images de la cible (dernière analyse Trivy) ; analyse de ses seules images à la demande. */
import type { Finding, ImageScanDto, SourceScanDto, TrivyRun } from '#shared/schemas/trivy'
import { RefreshCw } from 'lucide-vue-next'

const props = defineProps<{ targetId: string, canScan: boolean }>()
const toast = useToast()
type Scan = ImageScanDto & { findings: Finding[] }
const { data, refresh } = await useFetch<{ run: TrivyRun | null, images: Scan[], source: (SourceScanDto & { findings: Finding[] }) | null }>(() => `/api/targets/${props.targetId}/vulnerabilities`, { server: false })
const expanded = ref<string | null>(null)
const requested = ref(false)
let timer: ReturnType<typeof setInterval> | undefined
watch(() => requested.value || !!data.value?.run?.running || !!data.value?.images.some(i => i.scanState) || !!data.value?.source?.scanState, (on) => {
  clearInterval(timer)
  if (on) timer = setInterval(() => void refresh(), 4000)
}, { immediate: true })
watch(() => data.value?.run, (run) => {
  if (requested.value && run && !run.running && run.finishedAt && Date.parse(run.finishedAt) > Date.now() - 60_000) requested.value = false
})
onBeforeUnmount(() => clearInterval(timer))

async function scan() {
  try {
    await $fetch('/api/vulnerabilities/scan', { method: 'POST', body: { targetId: props.targetId } })
    requested.value = true
    toast.info('Analyse des images de la cible lancée')
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
}
</script>

<template>
  <div class="tv">
    <div class="bar">
      <p class="muted small">Analyse Trivy des images des conteneurs de la cible et des dépendances de son code source, à chaque déploiement, à chaque passage planifié (page Vulnérabilités) ou à la demande.</p>
      <UiButton v-if="canScan" size="sm" :loading="requested || !!data?.run?.running" @click="scan"><RefreshCw :size="14" /> Analyser maintenant</UiButton>
    </div>
    <p v-if="data?.run?.running" class="small">Analyse en cours : {{ data.run.done }} / {{ data.run.total }}<span v-if="data.run.current" class="muted"> · {{ data.run.current }}</span></p>
    <p v-if="data && !data.images.length && !data.source" class="muted">Aucune analyse pour cette cible.</p>
    <div v-if="data?.source" class="img">
      <button type="button" class="head" :aria-expanded="expanded === 'source'" @click="expanded = expanded === 'source' ? null : 'source'">
        <strong>Dépendances du code source</strong>
        <span class="muted small mono">{{ data.source.repository ?? 'archive' }} {{ data.source.ref?.replace(/^(branch|tag|commit):/, '') ?? '' }}</span>
        <UiBadge v-if="data.source.status === 'error'" tone="danger" :title="data.source.error ?? ''">échec</UiBadge>
        <SeverityCounts v-else :counts="data.source.counts" />
        <span class="muted small">{{ data.source.manifests.length }} fichier(s) de dépendances · {{ data.source.fixable }} corrigeable(s) · {{ fmtRelative(data.source.scannedAt) }}{{ data.source.trigger === 'deploy' ? ' au déploiement' : '' }}</span>
      </button>
      <p v-if="data.source.manifests.length" class="muted small mono">{{ data.source.manifests.join(', ') }}</p>
      <VulnerabilityFindings v-if="expanded === 'source'" :findings="data.source.findings" />
    </div>
    <div v-for="i in data?.images ?? []" :key="i.id" class="img">
      <button type="button" class="head" :aria-expanded="expanded === i.id" @click="expanded = expanded === i.id ? null : i.id">
        <span class="mono">{{ i.image }}</span>
        <span v-if="i.imageVersion || i.imageId.startsWith('sha256:')" class="muted small mono">{{ [i.imageVersion ? `version ${i.imageVersion}` : null, i.imageId.startsWith('sha256:') ? i.imageId.slice(7, 19) : null].filter(Boolean).join(' · ') }}</span>
        <span v-if="i.scanState" class="muted small" role="status">{{ i.scanState === 'running' ? 'analyse en cours…' : 'en file d\'attente…' }}</span>
        <span class="muted small">{{ i.targets.find(t => t.targetId === targetId)?.services.join(', ') }} · {{ i.os ?? '' }}</span>
        <UiBadge v-if="i.status === 'error'" tone="danger" :title="i.error ?? ''">échec</UiBadge>
        <SeverityCounts v-else :counts="i.counts" />
        <span class="muted small">{{ i.fixable }} corrigeable(s) · {{ fmtRelative(i.scannedAt) }}{{ i.trigger === 'deploy' ? ' au déploiement' : '' }}</span>
      </button>
      <p v-if="i.error" class="warn small">{{ i.error }}</p>
      <VulnerabilityFindings v-if="expanded === i.id" :findings="i.findings" />
    </div>
  </div>
</template>

<style scoped>
.tv { display: flex; flex-direction: column; gap: var(--space-2); }
.bar { display: flex; justify-content: space-between; gap: var(--space-3); align-items: flex-start; flex-wrap: wrap; }
.small { font-size: 12.5px; margin: 0; }
.warn { color: var(--warning); }
.img { border: 1px solid var(--border); border-radius: var(--radius); padding: 6px 10px; display: flex; flex-direction: column; gap: var(--space-2); }
.head { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: center; background: none; border: 0; padding: 0; cursor: pointer; text-align: left; color: inherit; }
</style>
