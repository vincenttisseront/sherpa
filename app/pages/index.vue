<script setup lang="ts">
import { RUNTIME_STATE } from '#shared/utils/target-state'
/** Tableau de bord (§17) : données des agents et internes, limitées aux droits de l'utilisateur. */
import { PERIOD_LABEL, type Period } from '#shared/schemas/common'
import type { DashboardDto, PendingItem, TargetFreshness } from '#shared/schemas/dashboard'
import { EVENT_LABEL, type NotificationEvent } from '#shared/schemas/notifications'
import { UPDATE_KIND_LABEL } from '#shared/schemas/watchtower'
import { Activity, AlertTriangle, Check, CheckCircle2, Clock, HardDriveDownload, HeartPulse, ListTodo, Network, PackageCheck, RefreshCcw, Rocket, ScanSearch, Server, Sparkles, Wrench, XCircle } from 'lucide-vue-next'
import type { Component } from 'vue'

useHead({ title: 'Tableau de bord' })
const { hasAny, me } = useAuth()
const period = ref<Period>('7d')
const { data, refresh, status } = await useFetch<DashboardDto>('/api/dashboard', { query: { period }, watch: [period] })

let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => { timer = setInterval(() => void refresh(), 30_000) })
onBeforeUnmount(() => clearInterval(timer))

// Installation d'un hôte (agent, Runner) : commande complète selon le type d'hôte.
const installOpen = ref(false)

const p = computed(() => `period=${period.value}`)
const tiles = computed(() => {
  const t = data.value?.tiles
  if (!t) return []
  return [
    { label: 'Serveurs en ligne', short: 'Serveurs', value: `${t.serversOnline} / ${t.serversTotal}`, tone: t.serversOnline < t.serversTotal ? 'warning' : 'ok', to: '/servers', icon: Server },
    { label: 'Endpoints joignables', short: 'Endpoints', value: `${t.endpointsReachable} / ${t.endpointsTotal}`, tone: t.endpointsReachable < t.endpointsTotal ? 'warning' : 'ok', to: '/containers', icon: Network },
    { label: 'Projets actifs', short: 'Projets', value: t.activeProjects, tone: 'info', to: '/projects', icon: PackageCheck },
    { label: 'Déploiements en cours', short: 'En cours', value: t.deploymentsRunning, tone: t.deploymentsRunning ? 'info' : 'neutral', to: `/deployments?status=${ACTIVE_STATUS.join(',')}`, icon: Clock },
    { label: 'Déploiements réussis', short: 'Réussis', value: t.deploymentsSucceeded, tone: 'ok', to: `/deployments?status=HEALTHY&${p.value}`, icon: CheckCircle2 },
    { label: 'Déploiements échoués', short: 'Échoués', value: t.deploymentsFailed, tone: t.deploymentsFailed ? 'danger' : 'neutral', to: `/deployments?unacknowledged=true&${p.value}`, icon: XCircle },
    { label: 'Builds échoués', short: 'Builds KO', value: t.buildsFailed, tone: t.buildsFailed ? 'danger' : 'neutral', to: `/deployments?buildFailed=true&${p.value}`, icon: Wrench },
    { label: 'Projets dégradés', short: 'Dégradés', value: t.degradedTargets, tone: t.degradedTargets ? 'warning' : 'neutral', to: '#degraded', icon: AlertTriangle },
    { label: 'Healthchecks en erreur', short: 'Santé KO', value: t.unhealthyServices, tone: t.unhealthyServices ? 'danger' : 'neutral', to: '#degraded', icon: HeartPulse },
    { label: 'Mises à jour d\'images', short: 'MAJ images', value: t.imageUpdates, tone: 'neutral', to: `/images?kind=updated,external&${p.value}`, icon: RefreshCcw },
  ] as { label: string, short: string, value: number | string, tone: string, to: string, icon: Component }[]
})

// Accueil : prénom et résumé en une phrase.
const firstName = computed(() => (me.value?.user?.displayName ?? '').split(/\s+/)[0])
const hello = computed(() => (new Date().getHours() < 18 ? 'Bonjour' : 'Bonsoir'))
const today = computed(() => new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: DISPLAY_TZ }))
const attention = computed(() => {
  const t = data.value?.tiles
  if (!t) return null
  const n = t.degradedTargets + (t.serversTotal - t.serversOnline)
  if (!t.serversTotal) return { tone: 'info', text: 'Bienvenue ! Commencez par déclarer un serveur (SSH ou agent) pour déployer vos premiers projets.' }
  if (n) return { tone: 'warn', text: `${n} point${n > 1 ? 's demandent' : ' demande'} votre attention.` }
  if (t.deploymentsRunning) return { tone: 'info', text: `${t.deploymentsRunning} déploiement${t.deploymentsRunning > 1 ? 's' : ''} en cours, tout le reste fonctionne normalement.` }
  return { tone: 'ok', text: 'Tout fonctionne normalement.' }
})
const SEVERITY_TONE = { error: 'danger', warning: 'warning', info: 'info' } as const
const MAX = 3

// Acquittement d'un échec : retiré du tableau de bord (reste dans l'historique des déploiements).
const ACKABLE = ['deployment.failed', 'build.failed', 'deployment.rolled_back']
const deploymentOf = (link: string | null) => /^\/deployments\/([0-9a-f-]{36})$/.exec(link ?? '')?.[1] ?? null
const toast = useToast()
async function acknowledge(id: string) {
  try {
    await $fetch(`/api/deployments/${id}/acknowledge`, { method: 'POST', body: { acknowledged: true } })
    toast.success('Échec acquitté : retiré du tableau de bord')
    await refresh()
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
}
const STATE = RUNTIME_STATE

// Images comparées à leur registre (chargées à part : appels aux registres).
const freshness = ref<TargetFreshness[]>([])
const checking = ref(false)
async function checkImages(refresh = false) {
  checking.value = true
  try {
    freshness.value = await $fetch<TargetFreshness[]>('/api/dashboard/freshness', { query: refresh ? { refresh: '1' } : {} })
  }
  catch {
    freshness.value = []
  }
  finally {
    checking.value = false
  }
}
onMounted(() => void checkImages())
// En attente : éléments du serveur, plus les images à mettre à jour relevées auprès des registres.
const showPending = ref(false)
const pendingAll = computed<PendingItem[]>(() => {
  const base = data.value?.pending ?? []
  const images: PendingItem[] = freshness.value.flatMap((f) => {
    const t = data.value?.deployed.find(d => d.targetId === f.targetId)
    const outdated = f.services.filter(x => x.state === 'outdated')
    return t && outdated.length
      ? [{ kind: 'image' as const, severity: 'info' as const, title: `${t.project} (${t.environment}) : ${outdated.length} image(s) à mettre à jour`, detail: outdated.map(x => x.image).join(', '), link: `/projects/${t.projectId}`, at: f.checkedAt }]
      : []
  })
  const rank = { danger: 0, warning: 1, info: 2 }
  return [...base, ...images].sort((a, b) => rank[a.severity] - rank[b.severity])
})

function fresh(targetId: string) {
  const f = freshness.value.find(x => x.targetId === targetId)
  if (!f) return null
  if (f.error) return { tone: 'neutral' as const, label: 'non vérifié', title: f.error }
  const by = (s: string) => f.services.filter(x => x.state === s)
  const title = f.services.map(x => `${x.service} (${x.image}) : ${x.detail}`).join('\n') + `\nVérifié ${fmtDateTime(f.checkedAt)}`
  if (by('outdated').length) return { tone: 'warning' as const, label: `${by('outdated').length} à mettre à jour`, title }
  if (by('unknown').length) return { tone: 'neutral' as const, label: `à jour, ${by('unknown').length} non vérifiée(s)`, title }
  return { tone: 'success' as const, label: 'à jour', title }
}
const eventLabel = (e: string) => EVENT_LABEL[e as NotificationEvent] ?? e
const kindLabel = (k: string) => UPDATE_KIND_LABEL[k as keyof typeof UPDATE_KIND_LABEL] ?? k
const severityTone = (s: string) => SEVERITY_TONE[s as keyof typeof SEVERITY_TONE] ?? 'neutral'
</script>

<template>
  <div>
    <h1 class="sr-only">Tableau de bord</h1>
    <section class="hero">
      <div class="hero-text">
        <h2>{{ hello }}{{ firstName ? `, ${firstName}` : '' }} <span class="date">{{ today }}</span></h2>
        <p v-if="attention" class="summary" :class="attention.tone">
          <CheckCircle2 v-if="attention.tone === 'ok'" :size="15" aria-hidden="true" />
          <AlertTriangle v-else-if="attention.tone === 'warn'" :size="15" aria-hidden="true" />
          <Sparkles v-else :size="15" aria-hidden="true" />
          {{ attention.text }}
        </p>
      </div>
      <div class="hero-side">
        <label class="period"><span>Période</span>
          <select v-model="period" class="input auto" aria-label="Période des indicateurs">
            <option v-for="(label, key) in PERIOD_LABEL" :key="key" :value="key">{{ label }}</option>
          </select>
        </label>
        <button v-if="hasAny('server:manage')" type="button" class="live-link" title="Commande complète pour installer l'agent Portainer et le Target Runner sur un hôte" @click="installOpen = true"><HardDriveDownload :size="14" aria-hidden="true" /> Installer un hôte</button>
        <NuxtLink v-if="hasAny('server:read')" to="/containers" class="live-link"><Activity :size="14" aria-hidden="true" /> Conteneurs en direct</NuxtLink>
        <NuxtLink v-if="hasAny('project:create')" to="/projects/new" class="cta"><Rocket :size="14" aria-hidden="true" /> Nouveau projet</NuxtLink>
      </div>
    </section>
    <HostInstallDialog v-if="hasAny('server:manage')" v-model:open="installOpen" />

    <div class="tiles" :aria-busy="status === 'pending' || undefined">
      <NuxtLink v-for="t in tiles" :key="t.label" :to="t.to" class="tile card" :class="t.tone" :title="`${t.value} — ${t.label}`">
        <span class="tile-ico" aria-hidden="true"><component :is="t.icon" :size="13" :stroke-width="2" /></span>
        <span class="tile-text">
          <span class="value">{{ t.value }}</span>
          <span class="label full">{{ t.label }}</span>
          <span class="label short" aria-hidden="true">{{ t.short }}</span>
        </span>
      </NuxtLink>
    </div>

    <!-- Ce qui est déployé : l'essentiel, en premier -->
    <section v-if="data" class="card deployed">
      <div class="bar">
        <h2>Déployé <span class="muted count">{{ data.deployed.length }} cible{{ data.deployed.length > 1 ? 's' : '' }}</span></h2>
        <div class="bar-side small">
          <span class="muted" :title="'Watchtower met à jour ou signale les images ; la vérification ci-contre est faite par la plateforme, indépendamment'">Watchtower actif sur {{ data.watchtower.enabled }}/{{ data.watchtower.deployed }}</span>
          <span v-if="data.watchtower.toApply" class="warn-text" title="Activé dans la configuration ; le conteneur Watchtower est posé au prochain déploiement de la cible">{{ data.watchtower.toApply }} à appliquer</span>
          <UiButton size="sm" variant="ghost" :loading="checking" @click="checkImages(true)"><RefreshCcw :size="13" /> Vérifier les images</UiButton>
        </div>
      </div>
      <UiEmpty v-if="!data.deployed.length" compact :icon="Rocket" title="Rien n'est encore déployé" />
      <div v-else class="table-wrap">
        <table class="dep">
          <thead><tr><th>Projet</th><th>État</th><th class="opt">Release</th><th class="opt">Source</th><th class="opt">Images</th><th>Accès</th><th>Images à jour ?</th></tr></thead>
          <tbody>
            <tr v-for="t in data.deployed" :key="t.targetId">
              <td>
                <NuxtLink :to="`/projects/${t.projectId}`"><strong>{{ t.project }}</strong></NuxtLink>
                <span class="muted small env">{{ t.environment }} · {{ t.server }}</span> <UiBadge v-if="t.isProduction" tone="danger">prod</UiBadge>
              </td>
              <td>
                <!-- Cible en difficulté : l'état mène au diagnostic (cause probable et actions). -->
                <NuxtLink v-if="t.status !== 'healthy' && t.status !== 'deploying'" :to="`/diagnostic/${t.targetId}`" class="diag" title="Diagnostiquer : cause probable et actions">
                  <UiBadge :tone="STATE[t.status].tone" dot>{{ STATE[t.status].label }}</UiBadge>
                  <span class="diag-l">Diagnostic →</span>
                </NuxtLink>
                <UiBadge v-else :tone="STATE[t.status].tone" dot>{{ STATE[t.status].label }}</UiBadge>
                <div v-if="t.failing.length" class="small err ellipsis" :title="t.failing.join(', ')">{{ t.failing.join(', ') }}</div>
              </td>
              <td class="opt nowrap">
                <template v-if="t.release">#{{ t.release.number }} <span class="muted small">{{ fmtRelative(t.release.activatedAt) }}</span></template>
                <span v-else class="muted">—</span>
                <NuxtLink v-if="t.lastDeployment && t.lastDeployment.status !== 'HEALTHY' && t.lastDeployment.status !== 'DEGRADED'" :to="`/deployments/${t.lastDeployment.id}`" class="small warn-link">dernier : {{ STATUS_LABEL[t.lastDeployment.status] ?? t.lastDeployment.status }}</NuxtLink>
              </td>
              <td class="opt mono small ellipsis src" :title="t.release?.source">{{ t.release?.source ?? '—' }}</td>
              <td class="opt">
                <div class="chips">
                  <span v-for="i in t.images.slice(0, 1)" :key="i" class="chip mono" :title="i">{{ i }}</span>
                  <span v-if="t.images.length > 1" class="chip more" :title="t.images.slice(1).join('\n')">+{{ t.images.length - 1 }}</span>
                </div>
              </td>
              <td>
                <span v-if="t.links.length" class="acc">
                  <a :href="t.links[0]!.url" :title="t.links[0]!.url" target="_blank" rel="noopener" class="small host">{{ t.links[0]!.host }}</a>
                  <!-- Plusieurs URL (expositions et routes détectées sur les proxies) : liste dépliable. -->
                  <details v-if="t.links.length > 1" class="more-links">
                    <summary class="small" :aria-label="`${t.links.length} accès pour ${t.project}`">+{{ t.links.length - 1 }}</summary>
                    <ul class="links-menu" role="list">
                      <li v-for="l in t.links" :key="l.url">
                        <a :href="l.url" :title="l.url" target="_blank" rel="noopener">{{ l.host }}</a>
                        <span v-if="l.service" class="muted svc">{{ l.service }}</span>
                        <ScanSearch v-if="l.detected" :size="12" class="det" aria-label="détectée" title="Route lue sur un reverse proxy de l'hôte, hors exposition gérée par la plateforme" />
                      </li>
                    </ul>
                  </details>
                </span>
                <span v-if="!t.links.length" class="muted small">non exposé</span>
              </td>
              <td>
                <template v-if="fresh(t.targetId)">
                  <UiBadge :tone="fresh(t.targetId)!.tone" :title="fresh(t.targetId)!.title">{{ fresh(t.targetId)!.label }}</UiBadge>
                </template>
                <span v-else class="muted small">{{ checking ? 'vérification…' : '—' }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- Le reste en cartes compactes, côte à côte, 3 entrées au plus -->
    <div v-if="data" class="minis">
      <section class="card mini pending" :class="{ has: pendingAll.length }">
        <div class="bar"><h3><ListTodo :size="14" /> En attente <span v-if="pendingAll.length" class="pill">{{ pendingAll.length }}</span></h3><button v-if="pendingAll.length > MAX" type="button" class="link small" @click="showPending = true">Tout voir</button></div>
        <p v-if="!pendingAll.length" class="muted small"><CheckCircle2 :size="13" /> Rien en attente.</p>
        <ul v-else class="mlist">
          <li v-for="(i, k) in pendingAll.slice(0, MAX)" :key="k" :title="i.detail ?? i.title">
            <span class="sev" :class="i.severity" />
            <span class="ellipsis"><NuxtLink v-if="i.link" :to="i.link">{{ i.title }}</NuxtLink><span v-else>{{ i.title }}</span></span>
            <button v-if="i.kind === 'failed' && deploymentOf(i.link)" type="button" class="ack" title="Acquitter l'échec : retiré du tableau de bord" :aria-label="`Acquitter : ${i.title}`" @click="acknowledge(deploymentOf(i.link)!)"><Check :size="13" /></button>
            <span v-if="i.detail" class="muted small when ellipsis">{{ i.detail }}</span>
          </li>
        </ul>
      </section>
      <section class="card mini">
        <div class="bar"><h3>Dernières alertes</h3><span v-if="data.recentAlerts.length > MAX" class="muted small">+{{ data.recentAlerts.length - MAX }}</span></div>
        <p v-if="!data.recentAlerts.length" class="muted small">Aucune alerte.</p>
        <ul v-else class="mlist">
          <li v-for="a in data.recentAlerts.slice(0, MAX)" :key="a.id" :title="`${eventLabel(a.event)} — ${a.title}`">
            <span class="sev" :class="severityTone(a.severity)" />
            <span class="ellipsis"><NuxtLink v-if="a.link" :to="a.link">{{ a.title }}</NuxtLink><span v-else>{{ a.title }}</span></span>
            <button v-if="a.deploymentId && ACKABLE.includes(a.event)" type="button" class="ack" title="Acquitter l'échec : retiré du tableau de bord" :aria-label="`Acquitter : ${a.title}`" @click="acknowledge(a.deploymentId)"><Check :size="13" /></button>
            <span class="muted small when">{{ fmtRelative(a.at) }}</span>
          </li>
        </ul>
      </section>

      <section class="card mini">
        <div class="bar"><h3>Watchtower</h3><NuxtLink to="/images" class="small">Tout voir</NuxtLink></div>
        <p v-if="data.watchtower.toApply" class="small warn-text">Activé sur {{ data.watchtower.toApply }} cible(s) mais pas encore en place : Watchtower est installé au prochain déploiement de chacune (voir « En attente »).</p>
        <p v-else-if="!data.watchtower.enabled" class="small warn-text">Inactif sur les {{ data.watchtower.deployed }} cible(s) : rien n'est surveillé par Watchtower. La colonne « Images à jour ? » ci-dessus est vérifiée par la plateforme.</p>
        <p v-else-if="!data.imageUpdates.length" class="muted small">Aucun changement signalé sur la période ({{ data.watchtower.enabled }}/{{ data.watchtower.deployed }} cible(s) surveillée(s)).</p>
        <ul v-if="data.imageUpdates.length" class="mlist">
          <li v-for="u in data.imageUpdates.slice(0, MAX)" :key="u.id">
            <span class="ellipsis"><NuxtLink :to="`/projects/${u.projectId}`">{{ u.project }}</NuxtLink> · <strong>{{ u.service }}</strong> <span class="muted">{{ kindLabel(u.kind) }}</span></span>
            <span class="muted small when">{{ fmtRelative(u.at) }}</span>
          </li>
        </ul>
      </section>

      <section v-if="hasAny('audit:read') || data.recentActions.length" class="card mini">
        <div class="bar"><h3>Dernières actions</h3><NuxtLink v-if="hasAny('audit:read')" to="/audit" class="small">Journal</NuxtLink></div>
        <p v-if="!data.recentActions.length" class="muted small">Aucune action.</p>
        <ul v-else class="mlist">
          <li v-for="a in data.recentActions.slice(0, MAX)" :key="a.id" :title="`${a.action} — ${a.actor}`">
            <span class="ellipsis mono">{{ a.action }}</span>
            <span class="muted small when">{{ fmtRelative(a.at) }}</span>
          </li>
        </ul>
      </section>
    </div>

    <UiDrawer v-model:open="showPending" title="En attente" :subtitle="`${pendingAll.length} élément(s)`" width="560px">
      <ul class="plist">
        <li v-for="(i, k) in pendingAll" :key="k">
          <span class="sev" :class="i.severity" />
          <div>
            <NuxtLink v-if="i.link" :to="i.link" @click="showPending = false">{{ i.title }}</NuxtLink><strong v-else>{{ i.title }}</strong>
            <div v-if="i.detail" class="muted small">{{ i.detail }}</div>
            <div v-if="i.at" class="muted small">{{ fmtRelative(i.at) }}</div>
          </div>
        </li>
      </ul>
    </UiDrawer>
  </div>
</template>

<style scoped>
.hero {
  position: relative; overflow: hidden; display: flex; justify-content: space-between; align-items: center; gap: var(--space-3) var(--space-5); flex-wrap: wrap;
  padding: 10px var(--space-4); margin-bottom: var(--space-3); border-radius: var(--radius-xl); color: #fff;
  background: radial-gradient(circle at 90% 0%, rgb(163 92 240 / 55%), transparent 45%), radial-gradient(circle at 0% 100%, rgb(79 91 213 / 70%), transparent 55%), #121a3a;
  box-shadow: var(--shadow);
}
.hero::after { content: ''; position: absolute; inset: 0; background-image: radial-gradient(rgb(255 255 255 / 6%) 1px, transparent 1px); background-size: 20px 20px; pointer-events: none; }
.hero > * { position: relative; z-index: 1; }
.hero-text { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; min-width: 0; }
.date { text-transform: capitalize; color: rgb(255 255 255 / 65%); font-size: 13px; font-weight: 450; letter-spacing: 0; margin-left: 6px; }
.hero h2 { font-size: 17px; font-weight: 650; letter-spacing: -0.02em; margin: 0; }
.summary { display: inline-flex; align-items: center; gap: 6px; margin: 0; padding: 3px 10px; border-radius: 999px; font-weight: 550; font-size: 13px; background: rgb(255 255 255 / 12%); }
.summary.ok { color: #9ff0c9; }
.summary.warn { color: #ffd88a; }
.summary.info { color: #c7cdff; }
.hero-side { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
.period { display: flex; align-items: center; gap: var(--space-2); color: rgb(255 255 255 / 70%); font-size: 13px; }
.period .input { background: rgb(255 255 255 / 10%); color: #fff; border-color: rgb(255 255 255 / 20%); }
.period .input option { color: var(--text); background: var(--surface); }
.live-link, .cta { display: inline-flex; align-items: center; gap: 6px; padding: 5px 12px; border-radius: var(--radius); font-weight: 550; font-size: 13px; color: #fff; }
.period .input { min-height: 30px; padding-top: 3px; padding-bottom: 3px; font-size: 13px; }
.live-link { background: rgb(255 255 255 / 12%); border: 1px solid rgb(255 255 255 / 18%); cursor: pointer; font-family: inherit; }
.cta { background: #fff; color: #2b2f7a; }
.live-link:hover, .cta:hover { text-decoration: none; filter: brightness(1.05); }
.auto { width: auto; }

.tiles { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: var(--space-2); margin-bottom: var(--space-3); }
.label.short { display: none; }
/* Grand écran : les 10 indicateurs sur une ligne, libellé court sous le chiffre (libellé complet en info-bulle). */
@media (min-width: 1280px) {
  .tiles { grid-template-columns: repeat(10, minmax(0, 1fr)); gap: 6px; }
  .tile { padding: 5px 8px; gap: 6px; overflow: hidden; }
  .tile-text { min-width: 0; max-width: 100%; }
  .label.short { max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
  /* Sans icône à cette largeur : la couleur passe par le liseré gauche. */
  .tile .tile-ico { display: none; }
  .tile { border-left: 3px solid var(--border-strong); }
  .tile.ok { border-left-color: var(--success); }
  .tile.info { border-left-color: var(--info); }
  .tile.warning { border-left-color: var(--warning); }
  .tile.danger { border-left-color: var(--danger); }
  .tile-text { flex-direction: column; align-items: flex-start; gap: 0; }
  .label.full { display: none; }
  .label.short { display: block; font-size: 11.5px; }
}
@media (max-width: 1100px) { .tiles { grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); } }
/* Petit écran : chiffre au-dessus du libellé, libellé sur deux lignes au plus. */
@media (max-width: 640px) {
  .tile-text { flex-direction: column; align-items: flex-start; gap: 0; }
  .label { white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; }
}
.tile { padding: 6px 10px; color: inherit; display: flex; align-items: center; gap: 8px; min-width: 0; transition: box-shadow .15s, transform .15s; }
.tile:hover { text-decoration: none; box-shadow: var(--shadow-hover); transform: translateY(-1px); }
.tile-ico { flex: none; width: 24px; height: 24px; border-radius: 7px; display: grid; place-items: center; background: var(--neutral-bg); color: var(--text-muted); }
.tile-text { display: flex; align-items: baseline; gap: 6px; min-width: 0; line-height: 1.2; }
.tile.ok .tile-ico { background: var(--success-bg); color: var(--success); }
.tile.info .tile-ico { background: var(--info-bg); color: var(--info); }
.tile.warning .tile-ico { background: var(--warning-bg); color: var(--warning); }
.tile.danger .tile-ico { background: var(--danger-bg); color: var(--danger); }
.value { flex: none; font-size: 16px; font-weight: 650; font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }
.tile.danger .value { color: var(--danger); }
.label { color: var(--text-muted); font-size: 12px; line-height: 1.25; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.bar { display: flex; justify-content: space-between; align-items: center; gap: var(--space-2); }
.bar-side { display: flex; align-items: center; gap: var(--space-3); }
.small { font-size: 12.5px; margin: 0; }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }

/* Déployé */
.deployed { padding: var(--space-3) var(--space-4); margin-bottom: var(--space-3); }
.deployed h2 { margin: 0; font-size: 15px; display: flex; gap: var(--space-2); align-items: baseline; }
.count { font-size: 12.5px; font-weight: 400; }
.table-wrap { overflow-x: auto; margin-top: var(--space-2); }
.dep { width: 100%; border-collapse: collapse; font-size: 13px; }
.dep th { text-align: left; font-weight: 500; font-size: 11px; text-transform: uppercase; color: var(--text-muted); padding: 4px 10px 4px 0; border-bottom: 1px solid var(--border); white-space: nowrap; }
.dep td { padding: 5px 10px 5px 0; border-bottom: 1px solid var(--border); vertical-align: middle; }
.nowrap { white-space: nowrap; }
.diag { display: inline-flex; gap: 6px; align-items: center; text-decoration: none; }
.diag-l { font-size: 12px; font-weight: 550; white-space: nowrap; }
.diag:hover .diag-l { text-decoration: underline; }
.env { margin-left: 6px; }
@media (max-width: 720px) { .dep .opt { display: none; } .bar { flex-wrap: wrap; } }
.dep tr:last-child td { border-bottom: 0; }
.dep .src { max-width: 220px; }
.chips { display: flex; flex-wrap: wrap; gap: 4px; max-width: 300px; }
.chip { font-size: 11.5px; padding: 1px 7px; border-radius: 999px; background: var(--surface-2); border: 1px solid var(--border); max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chip.more { color: var(--text-muted); }
.host { white-space: nowrap; }
.acc { display: inline-flex; flex-wrap: wrap; gap: 2px 6px; align-items: baseline; }
.acc:has(details[open]) { width: 240px; }
.more-links summary { list-style: none; cursor: pointer; color: var(--primary); font-weight: 600; padding: 0 6px; border-radius: 999px; background: var(--primary-soft); }
.more-links summary::-webkit-details-marker { display: none; }
.more-links[open] summary { box-shadow: 0 0 0 2px color-mix(in srgb, var(--primary) 30%, transparent); }
/* Liste ouverte dans la cellule (le tableau défile horizontalement : pas de menu flottant). */
.more-links { display: contents; }
.links-menu { flex-basis: 100%; margin: 4px 0 0; padding: 4px; list-style: none; background: var(--surface-2); border-radius: var(--radius); display: flex; flex-direction: column; gap: 1px; }
.links-menu li { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 6px; align-items: center; font-size: 12px; padding: 1px 4px; border-radius: var(--radius-sm); white-space: nowrap; }
.links-menu .svc { font-size: 11.5px; max-width: 90px; overflow: hidden; text-overflow: ellipsis; }
.det { color: var(--text-muted); }
.links-menu li:hover { background: var(--surface); }
.links-menu a { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.err { color: var(--danger); max-width: 200px; }
.warn-link { display: block; color: var(--warning); }
.warn-text { color: var(--warning); }

/* Cartes compactes : taille fixe, 3 entrées */
.minis { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: var(--space-2); }
@media (max-width: 720px) { .mini { height: auto; max-height: 190px; } }
.sev { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--text-faint); }
.pending { grid-column: span 2; }
@media (max-width: 720px) { .pending { grid-column: auto; } }
.pending.has { border-color: color-mix(in srgb, var(--warning) 55%, var(--border)); box-shadow: 0 0 0 1px color-mix(in srgb, var(--warning) 25%, transparent); }
.mini h3 { display: flex; align-items: center; gap: 6px; }
.pill { font-size: 11px; font-weight: 600; padding: 0 7px; border-radius: 999px; background: var(--warning-bg); color: var(--warning); }
.link { all: unset; cursor: pointer; color: var(--primary); }
.link:focus-visible { outline: 2px solid var(--focus); }
.plist { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-3); }
.plist li { display: flex; gap: var(--space-3); align-items: flex-start; padding-bottom: var(--space-3); border-bottom: 1px solid var(--border); font-size: 13.5px; }
.plist .sev { margin-top: 6px; }
.sev.danger { background: var(--danger); }
.sev.warning { background: var(--warning); }
.sev.info { background: var(--info); }
.mono { font-family: var(--font-mono); font-size: 12px; }
.mini { height: 180px; padding: var(--space-3) var(--space-4); display: flex; flex-direction: column; gap: var(--space-2); overflow: hidden; min-width: 0; }
.mini h3 { margin: 0; font-size: 13.5px; }
.mini p { margin: 0; display: flex; gap: 6px; align-items: flex-start; }
.mlist { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.sev { grid-row: 1; }
.sev + .ellipsis { grid-column: 2; }
.mlist li { display: grid; grid-template-columns: auto 1fr auto; column-gap: var(--space-2); align-items: center; font-size: 12.5px; min-width: 0; padding-bottom: 5px; border-bottom: 1px solid var(--border); }
.mlist li > .ellipsis:first-child { grid-column: 1 / -1; }
.mlist li:last-child { border-bottom: 0; padding-bottom: 0; }
.mlist .ellipsis { flex: 1; }
.when { grid-column: 2 / -1; white-space: nowrap; font-size: 11.5px; }
.ack { all: unset; cursor: pointer; display: grid; place-items: center; width: 22px; height: 22px; border-radius: 6px; color: var(--text-muted); border: 1px solid var(--border); }
.ack:hover { color: var(--success); border-color: var(--success); background: var(--success-bg); }
.ack:focus-visible { outline: 2px solid var(--focus); }
.mlist li > .ellipsis:first-child + .when { grid-column: 1 / -1; }
</style>
