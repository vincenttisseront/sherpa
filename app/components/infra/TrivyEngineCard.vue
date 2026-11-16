<script setup lang="ts">
/** Trivy (analyse de vulnérabilités) : version en service, dernière publiée, mise à jour en un clic. */
import type { TrivyEngineDto } from '#shared/schemas/trivy'
import { ExternalLink, RefreshCw, ShieldAlert } from 'lucide-vue-next'

const { hasAny } = useAuth()
const toast = useToast()
const confirm = useConfirm()
const { data: engine, refresh, status } = await useFetch<TrivyEngineDto>('/api/trivy/engine', { server: false })
const canSet = computed(() => hasAny('policy:manage'))
const busy = ref(false)
// Lecture côté navigateur : indicateur de chargement seulement après l'hydratation (rendu serveur identique).
const mounted = ref(false)
onMounted(() => { mounted.value = true })

async function update() {
  if (!engine.value?.latest) return
  if (!await confirm({ title: 'Mettre à jour Trivy', message: `${engine.value.image} → ${engine.value.repository}:${engine.value.latest}. La nouvelle version est récupérée sur chaque serveur à sa prochaine analyse (planifiée, au déploiement ou à la demande) ; la base de vulnérabilités, elle, se met à jour à chaque analyse.`, confirmLabel: 'Mettre à jour' })) return
  busy.value = true
  try {
    engine.value = await $fetch<TrivyEngineDto>('/api/trivy/engine', { method: 'POST', body: { tag: engine.value.latest } })
    toast.success(`Trivy : ${engine.value.image}`)
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="card pad">
    <div class="head">
      <span class="ico"><ShieldAlert :size="17" /></span>
      <div class="grow">
        <h3>Trivy <span class="muted small">analyse de vulnérabilités</span></h3>
        <p v-if="engine" class="small">
          En service : <span class="mono">{{ engine.image }}</span>
          <template v-if="engine.latest"> · dernière publiée : <span class="mono">{{ engine.latest }}</span></template>
          <span v-if="engine.latestError" class="warn"> · versions illisibles : {{ engine.latestError }}</span>
        </p>
        <p v-else class="muted small">Lecture de la version…</p>
      </div>
      <UiBadge v-if="engine?.updateAvailable" tone="warning">mise à jour disponible</UiBadge>
      <UiBadge v-else-if="engine?.latest" tone="success">à jour</UiBadge>
      <UiButton size="sm" variant="ghost" :loading="mounted && status === 'pending'" aria-label="Relire la version de Trivy" @click="refresh()"><RefreshCw :size="13" /></UiButton>
      <UiButton v-if="canSet && engine?.updateAvailable" size="sm" variant="primary" :loading="busy" @click="update">Mettre à jour vers {{ engine.latest }}</UiButton>
      <NuxtLink to="/vulnerabilities" class="small link">Vulnérabilités <ExternalLink :size="11" /></NuxtLink>
    </div>
  </section>
</template>

<style scoped>
.pad { padding: var(--space-3) var(--space-4); margin-bottom: var(--space-3); }
.head { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
.grow { flex: 1; min-width: 240px; }
.ico { width: 34px; height: 34px; border-radius: 9px; display: grid; place-items: center; background: var(--primary-soft); color: var(--primary); }
h3 { margin: 0; font-size: 15px; }
.small { font-size: 12.5px; margin: 2px 0 0; }
.warn { color: var(--warning); }
.link { white-space: nowrap; }
</style>
