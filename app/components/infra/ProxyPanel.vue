<script setup lang="ts">
/** Reverse proxies réellement en place sur un endpoint : configuration Traefik ou nginx effective, routes, TLS, réseaux. */
import type { DetectedProxy, ProxyRoute, ProxyTopology } from '#shared/schemas/proxy'
import { ArrowRight, FileCode, Lock, LockOpen, RefreshCw, Route, ShieldAlert, TriangleAlert, Wand2 } from 'lucide-vue-next'

const props = defineProps<{ endpointId: string, canConfigure: boolean }>()
const emit = defineEmits<{ 'use-suggestion': [] }>()

const { data: topo, error, status, refresh: reload } = await useFetch<ProxyTopology>(() => `/api/endpoints/${props.endpointId}/proxy`, { server: false })
const refreshing = ref(false)
async function refresh() {
  refreshing.value = true
  try {
    topo.value = await $fetch<ProxyTopology>(`/api/endpoints/${props.endpointId}/proxy`, { query: { refresh: '1' } })
  }
  catch {
    await reload()
  }
  finally {
    refreshing.value = false
  }
}

const KIND: Record<string, string> = {
  'traefik': 'Traefik', 'caddy': 'Caddy', 'caddy-docker-proxy': 'Caddy (labels)', 'nginx': 'nginx', 'nginx-proxy': 'nginx-proxy',
  'nginx-proxy-manager': 'Nginx Proxy Manager', 'haproxy': 'HAProxy', 'envoy': 'Envoy', 'swag': 'SWAG', 'httpd': 'Apache httpd',
}
const SOURCE = { file: 'fichier', cli: 'arguments de lancement', env: 'variables TRAEFIK_*', defaults: 'valeurs par défaut' } as const
const CHALLENGE = { http: 'HTTP-01', tls: 'TLS-ALPN-01', dns: 'DNS-01' } as const

const STATUSES = { ok: 'Sans alerte', warn: 'À revoir', other: 'Autres proxies' }
const filter = useListFilter(
  () => topo.value?.routes ?? [],
  r => `${r.hosts.join(' ')} ${r.pathPrefix ?? ''} ${r.router} ${r.container?.name ?? ''} ${r.container?.stack ?? ''} ${r.targetUrl ?? ''} ${r.network ?? ''}`,
  r => (r.provider === 'docker' || r.provider === 'file' || (r.provider === 'nginx' && managedIds.value.has(r.proxyId)) ? (r.warnings.length ? 'warn' : 'ok') : 'other'),
)
const managedIds = computed(() => new Set(topo.value?.proxies.filter(p => p.nginx?.managed).map(p => p.container.id) ?? []))
// Proxies pilotables (Traefik, nginx) : reprise de leur configuration dans la plateforme.
const hasPilotable = computed(() => topo.value?.proxies.some(p => p.kind === 'traefik' || p.nginx) ?? false)
const traefikProxies = computed(() => topo.value?.proxies.filter(p => p.traefik) ?? [])
const nginxProxies = computed(() => topo.value?.proxies.filter(p => !p.traefik && p.nginx) ?? [])
const otherProxies = computed(() => topo.value?.proxies.filter(p => !p.traefik && !p.nginx) ?? [])
const destination = (r: ProxyRoute) => r.container ? `${r.container.service ?? r.container.name}${r.targetPort ? `:${r.targetPort}` : ''}` : r.targetUrl ?? r.service ?? '—'
const isRedirectOnly = (r: ProxyRoute) => r.redirectsToHttps && !r.tls
const proxyWarnings = (p: DetectedProxy) => p.warnings
// Logs d'accès d'un nginx (fenêtre).
const logsOf = ref<DetectedProxy | null>(null)
const logsOpen = computed({ get: () => !!logsOf.value, set: (v) => { if (!v) logsOf.value = null } })
</script>

<template>
  <div class="proxy">
    <p v-if="error" class="alert">{{ apiError(error).message }}</p>
    <div v-else-if="!topo" class="muted">Lecture des reverse proxies…</div>
    <template v-else>
      <div class="toolbar">
        <span class="muted small">{{ topo.proxies.length }} proxy(s) · {{ topo.routes.length }} route(s) · lu à {{ fmtTime(topo.scannedAt) }}</span>
        <span class="spacer" />
        <UiButton variant="ghost" size="sm" :loading="refreshing || status === 'pending'" @click="refresh"><RefreshCw :size="14" /> Relire</UiButton>
        <UiButton v-if="canConfigure && hasPilotable" variant="primary" size="sm" @click="emit('use-suggestion')"><Wand2 :size="14" /> Reprendre dans la configuration du reverse proxy</UiButton>
      </div>

      <ul v-if="topo.warnings.length" class="warnings card">
        <li v-for="(w, i) in topo.warnings" :key="i"><TriangleAlert :size="14" /> {{ w }}</li>
      </ul>

      <section v-for="p in traefikProxies" :key="p.container.id" class="card pad">
        <div class="p-head">
          <span class="ico"><Route :size="17" /></span>
          <div>
            <h3>{{ KIND[p.kind] }} <span v-if="p.version" class="muted">v{{ p.version }}</span></h3>
            <div class="muted small"><span class="mono">{{ p.container.name }}</span> · {{ p.container.image }}<template v-if="p.container.stack"> · stack <span class="mono">{{ p.container.stack }}</span></template></div>
          </div>
          <UiBadge :tone="p.container.running ? 'success' : 'danger'" dot>{{ p.container.running ? 'en marche' : 'arrêté' }}</UiBadge>
        </div>
        <dl class="kv">
          <dt>Configuration</dt>
          <dd>{{ SOURCE[p.traefik!.source] }}<span v-if="p.traefik!.configFile" class="mono small"> {{ p.traefik!.configFile }}</span></dd>
          <dt>Réseaux</dt>
          <dd><span v-for="n in p.networks" :key="n" class="chip mono">{{ n }}</span><span v-if="!p.networks.length" class="muted">—</span></dd>
          <dt>Ports publiés</dt>
          <dd><span v-for="h in p.hostPorts" :key="h.host + h.container" class="chip mono">{{ h.host }} → {{ h.container }}</span><span v-if="!p.hostPorts.length" class="muted">aucun</span></dd>
          <dt>Fournisseurs</dt>
          <dd>
            <template v-if="p.traefik!.providers.docker">Docker (<template v-if="p.traefik!.providers.docker.exposedByDefault">tout conteneur exposé</template><template v-else>sur label traefik.enable</template><template v-if="p.traefik!.providers.docker.network">, réseau <span class="mono">{{ p.traefik!.providers.docker.network }}</span></template>)</template>
            <template v-if="p.traefik!.providers.file"> · fichier <span class="mono">{{ p.traefik!.providers.file.directory ?? p.traefik!.providers.file.filename }}</span></template>
            <template v-if="p.traefik!.providers.swarm"> · Swarm</template>
            <template v-for="o in p.traefik!.providers.other" :key="o"> · {{ o }}</template>
          </dd>
          <dt>API</dt>
          <dd>
            <template v-if="p.traefik!.api.dashboard">tableau de bord actif</template><template v-else>inactive</template>
            <UiBadge v-if="p.traefik!.api.insecure" tone="danger">sans authentification</UiBadge>
          </dd>
        </dl>

        <h4>Points d'entrée</h4>
        <table class="table">
          <thead><tr><th>Nom</th><th>Adresse</th><th>Publié</th><th>TLS</th><th>Redirection</th><th>Middlewares</th></tr></thead>
          <tbody>
            <tr v-for="e in p.traefik!.entrypoints" :key="e.name">
              <td class="mono">{{ e.name }}</td>
              <td class="mono">{{ e.address ?? '—' }}<span v-if="e.protocol === 'udp'" class="muted"> udp</span></td>
              <td class="mono small">{{ e.hostPorts.join(', ') || '—' }}</td>
              <td><UiBadge v-if="e.tls" tone="success">TLS<template v-if="e.certResolver"> · {{ e.certResolver }}</template></UiBadge><span v-else class="muted">—</span></td>
              <td><template v-if="e.redirectTo"><ArrowRight :size="13" /> <span class="mono">{{ e.redirectTo }}</span></template><span v-else class="muted">—</span></td>
              <td class="mono small">{{ e.middlewares.join(', ') || '—' }}</td>
            </tr>
          </tbody>
        </table>

        <div class="tls-grid">
          <div>
            <h4>Certificats</h4>
            <ul class="plain small">
              <li v-for="r in p.traefik!.certResolvers" :key="r.name">
                <strong class="mono">{{ r.name }}</strong> · ACME {{ r.challenge ? CHALLENGE[r.challenge] : 'challenge non défini' }}<template v-if="r.dnsProvider"> ({{ r.dnsProvider }})</template><template v-if="r.httpEntrypoint"> via {{ r.httpEntrypoint }}</template>
                <UiBadge v-if="r.staging" tone="warning">test</UiBadge>
                <span v-if="r.storage" class="muted mono"> · {{ r.storage }}</span>
              </li>
              <li v-if="p.certificates.files">{{ p.certificates.files }} certificat(s) fourni(s) par fichier</li>
              <li v-if="p.certificates.defaultCertificate">Certificat par défaut défini</li>
              <li v-if="!p.traefik!.certResolvers.length && !p.certificates.files" class="muted">Aucun résolveur ni certificat : certificat auto-signé de Traefik</li>
            </ul>
          </div>
          <div v-if="p.tlsOptions.length">
            <h4>Options TLS</h4>
            <ul class="plain small">
              <li v-for="o in p.tlsOptions" :key="o.name"><strong class="mono">{{ o.name }}</strong> · {{ o.minVersion ?? 'version min. par défaut' }}<template v-if="o.sniStrict"> · SNI strict</template><template v-if="o.cipherSuites"> · {{ o.cipherSuites }} suites</template><template v-if="o.clientAuth"> · client : {{ o.clientAuth }}</template></li>
            </ul>
          </div>
        </div>
        <p v-if="p.configFiles.length > 1" class="muted small">Fichiers lus : <span class="mono">{{ p.configFiles.join(', ') }}</span></p>
        <ul v-if="proxyWarnings(p).length" class="warnings inline">
          <li v-for="(w, i) in proxyWarnings(p)" :key="i"><TriangleAlert :size="14" /> {{ w }}</li>
        </ul>
      </section>

      <section v-for="p in nginxProxies" :key="p.container.id" class="card pad">
        <div class="p-head">
          <span class="ico"><FileCode :size="17" /></span>
          <div>
            <h3>{{ KIND[p.kind] }} <span v-if="p.version" class="muted">v{{ p.version }}</span></h3>
            <div class="muted small"><span class="mono">{{ p.container.name }}</span> · {{ p.container.image }}<template v-if="p.container.stack"> · stack <span class="mono">{{ p.container.stack }}</span></template></div>
          </div>
          <UiButton size="sm" variant="ghost" @click="logsOf = p">Logs d'accès</UiButton>
          <UiBadge v-if="p.nginx!.managed" tone="info">reverse proxy des projets</UiBadge>
          <UiBadge v-else tone="neutral">hors plateforme</UiBadge>
          <UiBadge :tone="p.container.running ? 'success' : 'danger'" dot>{{ p.container.running ? 'en marche' : 'arrêté' }}</UiBadge>
        </div>
        <dl class="kv">
          <dt>Configuration</dt>
          <dd>
            <template v-if="p.kind === 'nginx-proxy'">variables VIRTUAL_HOST des conteneurs</template>
            <template v-else>{{ p.configFiles.length }} fichier(s) lu(s)</template>
            <template v-if="p.nginx!.managed?.confDir"> · sites de la console dans <span class="mono">{{ p.nginx!.managed.confDir }}</span> ({{ p.nginx!.platformSites }})</template>
          </dd>
          <dt>Réseaux</dt>
          <dd><span v-for="n in p.networks" :key="n" class="chip mono">{{ n }}</span><span v-if="!p.networks.length" class="muted">—</span><span v-if="p.nginx!.managed" class="muted small">projets sur <span class="mono">{{ p.nginx!.managed.network }}</span></span></dd>
          <dt>Ports publiés</dt>
          <dd><span v-for="h in p.hostPorts" :key="h.host + h.container" class="chip mono">{{ h.host }} → {{ h.container }}</span><span v-if="!p.hostPorts.length" class="muted">aucun</span></dd>
          <dt>Sites</dt>
          <dd>{{ p.nginx!.sites }}</dd>
        </dl>

        <h4>Écoutes</h4>
        <table class="table">
          <thead><tr><th>Port</th><th>Publié</th><th>TLS</th><th>Redirection</th></tr></thead>
          <tbody>
            <tr v-for="l in p.nginx!.listens" :key="l.port">
              <td class="mono">:{{ l.port }}</td>
              <td class="mono small">{{ l.hostPorts.join(', ') || '—' }}</td>
              <td><UiBadge v-if="l.tls" tone="success">TLS</UiBadge><span v-else class="muted">—</span></td>
              <td><template v-if="l.redirectTo"><ArrowRight :size="13" /> <span class="mono">{{ l.redirectTo }}</span></template><span v-else class="muted">—</span></td>
            </tr>
            <tr v-if="!p.nginx!.listens.length"><td colspan="4" class="muted">Aucune écoute lue</td></tr>
          </tbody>
        </table>

        <div>
          <h4>Certificats</h4>
          <ul class="plain small">
            <li v-if="p.nginx!.certificateFiles">{{ p.nginx!.certificateFiles }} certificat(s) référencé(s) par la configuration (ssl_certificate)</li>
            <li v-if="p.nginx!.managed">Certificats de la console déposés dans <span class="mono">{{ p.nginx!.managed.certsDir }}</span><template v-if="p.nginx!.managed.acme"> · Let's Encrypt par la console (HTTP-01 ou DNS-01)</template></li>
            <li v-if="!p.nginx!.certificateFiles && !p.nginx!.managed" class="muted">Aucun certificat référencé</li>
          </ul>
        </div>
        <p v-if="p.configFiles.length" class="muted small">Fichiers lus : <span class="mono">{{ p.configFiles.join(', ') }}</span></p>
        <ul v-if="proxyWarnings(p).length" class="warnings inline">
          <li v-for="(w, i) in proxyWarnings(p)" :key="i"><TriangleAlert :size="14" /> {{ w }}</li>
        </ul>
      </section>

      <section v-if="otherProxies.length" class="card pad">
        <h3>Autres reverse proxies</h3>
        <ul class="plain others">
          <li v-for="p in otherProxies" :key="p.container.id">
            <ShieldAlert :size="15" class="warn-ico" />
            <strong>{{ KIND[p.kind] }}</strong> <span class="mono">{{ p.container.name }}</span> <span class="muted small">{{ p.container.image }}<template v-if="p.container.stack"> · stack {{ p.container.stack }}</template></span>
            <span v-for="h in p.hostPorts" :key="h.host + h.container" class="chip mono">{{ h.host }} → {{ h.container }}</span>
            <div class="muted small">Hors plateforme : routes lues à titre indicatif<template v-if="p.configFiles.length"> ({{ p.configFiles.length }} fichier(s))</template>. <template v-for="(w, i) in p.warnings" :key="i">{{ w }}. </template></div>
          </li>
        </ul>
      </section>

      <section class="card pad-s">
        <div class="routes-head">
          <h3>Expositions</h3>
        </div>
        <UiListFilter v-model:q="filter.q.value" v-model:status="filter.status.value" :statuses="STATUSES" :count="filter.filtered.value.length" :total="filter.total.value" :active="filter.active.value" placeholder="Domaine, conteneur, stack, réseau…" @reset="filter.reset" />
        <table class="table routes">
          <thead><tr><th>Domaine</th><th>Sécurité</th><th>Destination</th><th>Réseau</th><th>Via</th></tr></thead>
          <tbody>
            <tr v-if="!filter.filtered.value.length"><td colspan="5" class="muted">{{ topo.routes.length ? 'Aucune route ne correspond au filtre' : 'Aucune route' }}</td></tr>
            <tr v-for="r in filter.filtered.value" :key="r.router + r.hosts.join()" :class="{ dim: isRedirectOnly(r) }">
              <td>
                <span class="dom">
                  <span v-for="h in r.hosts" :key="h" class="mono">{{ h }}{{ r.pathPrefix ?? '' }}</span>
                  <span v-if="!r.hosts.length" class="mono small muted">{{ r.rule ?? '—' }}</span>
                  <span v-if="r.warnings.length" class="w" :title="r.warnings.join('\n')" :aria-label="r.warnings.join(' ; ')"><TriangleAlert :size="13" /></span>
                </span>
              </td>
              <td>
                <UiBadge v-if="r.tls" tone="success"><Lock :size="12" /> HTTPS<template v-if="r.certResolver"> · {{ r.certResolver }}</template></UiBadge>
                <UiBadge v-else-if="isRedirectOnly(r)" tone="neutral">redirection HTTPS</UiBadge>
                <UiBadge v-else tone="warning"><LockOpen :size="12" /> HTTP</UiBadge>
                <span v-if="r.tls && r.redirectsToHttps" class="muted small" title="HTTP redirigé vers HTTPS"> · HTTP redirigé</span>
                <span v-if="r.passthrough" class="muted small"> passthrough</span>
              </td>
              <td>
                <span class="mono">{{ destination(r) }}</span>
                <span v-if="r.container?.stack" class="muted small"> · {{ r.container.stack }}</span>
                <UiBadge v-if="r.container?.managed" tone="info">géré</UiBadge>
              </td>
              <td class="mono small">{{ r.network ?? '—' }}</td>
              <td class="small">
                <span class="mono via" :title="[r.router, r.middlewares.length ? `middlewares : ${r.middlewares.join(', ')}` : ''].filter(Boolean).join('\n')">{{ r.router }}</span>
                <span v-if="r.entrypoints.length" class="muted"> · {{ r.entrypoints.join(', ') }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </section>
      <UiModal v-model:open="logsOpen" :title="logsOf ? `Logs d'accès — ${logsOf.container.name}` : ''" width="1100px">
        <AccessLogViewer v-if="logsOf" :url="`/api/endpoints/${endpointId}/proxy/${logsOf.container.id}/access-logs`" />
      </UiModal>
    </template>
  </div>
</template>

<style scoped>
.proxy { display: flex; flex-direction: column; gap: var(--space-3); }
.alert { margin: 0; padding: var(--space-3) var(--space-4); border-radius: var(--radius); background: var(--danger-bg); color: var(--danger); }
.toolbar { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.spacer { flex: 1; }
.small { font-size: 12.5px; }
.dom { display: inline-flex; flex-wrap: wrap; gap: 2px 8px; align-items: center; }
.dom .w { display: inline-flex; color: var(--warning); cursor: help; margin-top: 0; }
.via { display: inline-block; max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; }
.pad { padding: var(--space-3) var(--space-4); display: flex; flex-direction: column; gap: var(--space-3); }
.pad-s { padding: var(--space-3) var(--space-4); display: flex; flex-direction: column; gap: var(--space-2); }
h3, h4 { margin: 0; }
h4 { font-size: 13px; color: var(--text-muted); font-weight: 600; margin-top: var(--space-2); }
.p-head { display: flex; align-items: center; gap: var(--space-3); }
.p-head > div { flex: 1; }
.ico { width: 34px; height: 34px; border-radius: 9px; display: grid; place-items: center; background: var(--primary-soft); color: var(--primary); }
.kv { display: grid; grid-template-columns: 140px 1fr; gap: 3px var(--space-4); margin: 0; font-size: 13.5px; }
.kv dt { color: var(--text-muted); }
.kv dd { margin: 0; display: flex; gap: 4px; align-items: center; flex-wrap: wrap; }
.chip { display: inline-block; padding: 1px 8px; border-radius: 999px; background: var(--surface-2); border: 1px solid var(--border); font-size: 12px; }
.table { width: 100%; border-collapse: collapse; font-size: 13px; }
.table th { text-align: left; font-size: 11px; text-transform: uppercase; color: var(--text-muted); padding: 4px 8px; border-bottom: 1px solid var(--border); }
.table td { padding: 4px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
.routes tr.dim { opacity: .65; }
.tls-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: var(--space-4); }
.plain { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.warnings { list-style: none; margin: 0; padding: var(--space-3) var(--space-4); display: flex; flex-direction: column; gap: 4px; color: var(--warning); font-size: 13px; background: var(--warning-bg); }
.warnings.inline { padding: var(--space-2) var(--space-3); border-radius: var(--radius); }
.warnings li, .w { display: flex; gap: 6px; align-items: baseline; }
.w { color: var(--warning); margin-top: 2px; }
.others li { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; padding: 6px 0; border-bottom: 1px solid var(--border); }
.others li > div { flex-basis: 100%; }
.warn-ico { color: var(--warning); }
.routes-head { display: flex; align-items: center; gap: var(--space-2); }
@media (max-width: 860px) { .kv { grid-template-columns: 110px minmax(0, 1fr); } }
</style>
