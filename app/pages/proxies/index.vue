<script setup lang="ts">
/**
 * Infrastructure › Reverse proxies : carte des proxies d'un endpoint (ports de
 * l'hôte, points d'entrée, domaines, conteneurs), certificats ACME de chaque
 * Traefik, ports publiés hors proxy et alertes. Seule action : supprimer un
 * proxy qui ne sert aucune route (hors Traefik géré et reverse proxy déclaré des projets).
 */
import { ArrowRight, ExternalLink, Lock, LockOpen, Network, RefreshCw, Search, Trash2, TriangleAlert } from 'lucide-vue-next'
import type { EndpointListItem, MapHostCertificate, ProxyMapDto } from '#shared/schemas/proxy-map'
import { type MapSelection, buildProxyGraph } from '#shared/utils/proxy-graph'
import { MANAGED_PROXY_STACK } from '#shared/schemas/managed-proxy'

useHead({ title: 'Reverse proxies' })
const route = useRoute()
const requestFetch = useRequestFetch()
const { can, hasAny } = useAuth()
const toast = useToast()
const confirm = useConfirm()

const { data: endpoints } = await useAsyncData('proxy-endpoints', () => requestFetch<EndpointListItem[]>('/api/endpoints'))
const endpointId = ref<string | null>((route.query.endpoint as string) || null)
watchEffect(() => {
  if (!endpointId.value && endpoints.value?.length) endpointId.value = endpoints.value[0]!.id
})
watch(endpointId, id => navigateTo({ query: { ...route.query, endpoint: id ?? undefined } }, { replace: true }))
const endpoint = computed(() => endpoints.value?.find(e => e.id === endpointId.value) ?? null)

const map = ref<ProxyMapDto | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
async function load(refresh = false) {
  if (!endpointId.value) return
  loading.value = true
  error.value = null
  try {
    map.value = await $fetch<ProxyMapDto>(`/api/endpoints/${endpointId.value}/proxy-map`, { query: refresh ? { refresh: '1' } : {} })
  }
  catch (err) {
    error.value = apiError(err).message
  }
  finally {
    loading.value = false
  }
}
watch(endpointId, () => {
  map.value = null
  void load()
}, { immediate: true })

// --- Rebrancher derrière le proxy (conteneur absent du réseau du proxy) ---
const canReattach = computed(() => !!endpoint.value && can('network:manage', { serverId: endpoint.value.serverId }))
const toReattach = computed(() => {
  const seen = new Map<string, { containerId: string, name: string, network: string }>()
  for (const r of map.value?.topology.routes ?? []) {
    if (r.reattach && r.container && !seen.has(r.container.id)) seen.set(r.container.id, { containerId: r.container.id, name: r.container.name, network: r.reattach.network })
  }
  return [...seen.values()]
})
const reattaching = ref(false)
async function reattach(items: { containerId: string, name: string, network: string }[]) {
  if (!items.length || !await confirm({
    title: items.length > 1 ? `Rebrancher ${items.length} conteneurs derrière le proxy` : `Rebrancher ${items[0]!.name} derrière le proxy`,
    message: `${items.map(i => `${i.name} → ${i.network}`).join(', ')}. Chaque conteneur est connecté au réseau du proxy puis redémarré (Traefik ne relit une route qu'au démarrage du conteneur ; nginx la résout à la requête) : courte interruption de ce seul service.`,
    confirmLabel: 'Rebrancher',
  })) return
  reattaching.value = true
  const failed: string[] = []
  for (const i of items) {
    await $fetch(`/api/endpoints/${endpointId.value}/proxy/reattach`, { method: 'POST', body: { containerId: i.containerId, network: i.network } })
      .catch((err) => { failed.push(`${i.name} : ${apiError(err).message}`) })
  }
  reattaching.value = false
  if (failed.length) toast.error(failed.join(' ; '))
  else toast.success(items.length > 1 ? `${items.length} conteneurs rebranchés derrière le proxy` : `${items[0]!.name} rebranché derrière le proxy`)
  await load(true)
}

const proxyId = ref<string>('')
const query = ref('')
const showDirect = ref(true)
const showUnrouted = ref(true)
watch(endpointId, () => (proxyId.value = ''))
const graph = computed(() => (map.value ? buildProxyGraph(map.value, { proxyId: proxyId.value || null, query: query.value, showDirect: showDirect.value, showUnrouted: showUnrouted.value }) : null))

const KIND: Record<string, string> = {
  'traefik': 'Traefik', 'caddy': 'Caddy', 'caddy-docker-proxy': 'Caddy (labels)', 'nginx': 'nginx', 'nginx-proxy': 'nginx-proxy',
  'nginx-proxy-manager': 'Nginx Proxy Manager', 'haproxy': 'HAProxy', 'envoy': 'Envoy', 'swag': 'SWAG', 'httpd': 'Apache httpd',
}
const CHALLENGE = { http: 'HTTP-01', tls: 'TLS-ALPN-01', dns: 'DNS-01' } as const
const CERT_LABEL: Record<MapHostCertificate['state'], string> = { valid: 'Valide', expiring: 'Expire bientôt', expired: 'Expiré', error: 'En erreur', pending: 'En attente', static: 'Fourni (fichier/défaut)' }
const CERT_TONE: Record<MapHostCertificate['state'], 'success' | 'warning' | 'danger' | 'info' | 'neutral'> = { valid: 'success', expiring: 'warning', expired: 'danger', error: 'danger', pending: 'info', static: 'neutral' }
const proxyName = (id: string) => {
  const p = map.value?.topology.proxies.find(x => x.container.id === id)
  return p ? `${KIND[p.kind] ?? p.kind} (${p.container.name})` : id.slice(0, 12)
}
const daysLeft = (iso: string | null) => (iso ? Math.floor((new Date(iso).getTime() - Date.now()) / 864e5) : null)

const summary = computed(() => {
  const m = map.value
  if (!m) return null
  const certs = m.certificates.filter(c => c.state !== 'static')
  return {
    proxies: m.topology.proxies.length,
    routes: m.topology.routes.length,
    containers: new Set(m.topology.routes.map(r => r.container?.id).filter(Boolean)).size,
    valid: certs.filter(c => c.state === 'valid').length,
    attention: certs.filter(c => c.state !== 'valid').length,
    direct: m.containers.filter(c => c.hostPorts.length).length,
    warnings: m.topology.warnings.length + m.topology.proxies.reduce((a, p) => a + p.warnings.length, 0) + m.topology.routes.filter(r => r.warnings.length).length,
  }
})

const tab = ref((route.query.tab as string) || 'diagram')
watch(tab, t => navigateTo({ query: { ...route.query, tab: t } }, { replace: true }))
const tabs = computed(() => [
  { key: 'diagram', label: 'Diagramme' },
  { key: 'certs', label: 'Certificats ACME', badge: summary.value?.attention || undefined },
  { key: 'ports', label: 'Ports' },
  { key: 'alerts', label: 'Alertes', badge: summary.value?.warnings || undefined },
])

// Tous les ports publiés : proxies (vers leurs points d'entrée) et conteneurs (hors proxy).
const portRows = computed(() => {
  const m = map.value
  if (!m) return []
  const rows: { host: string, protocol: string, target: string, detail: string, direct: boolean, exposed: boolean, id: string, kind: 'proxy' | 'container' }[] = []
  for (const p of m.topology.proxies) {
    for (const h of p.hostPorts) {
      const ep = p.traefik?.entrypoints.find(e => e.port === h.container && e.protocol === h.protocol)
      const listen = p.nginx?.listens.find(l => l.port === h.container && h.protocol === 'tcp')
      rows.push({ host: h.host, protocol: h.protocol, target: proxyName(p.container.id), detail: ep ? `point d'entrée ${ep.name} (:${h.container})${ep.redirectTo ? ` → ${ep.redirectTo}` : ''}${ep.tls ? ', TLS' : ''}` : listen ? `écoute :${listen.port}${listen.redirectTo ? ` → ${listen.redirectTo}` : ''}${listen.tls ? ', TLS' : ''}` : `:${h.container}`, direct: false, exposed: !h.host.startsWith('127.'), id: p.container.id, kind: 'proxy' })
    }
  }
  for (const c of m.containers) {
    for (const h of c.hostPorts) rows.push({ host: h.host, protocol: h.protocol, target: `${c.stack ? `${c.stack}/` : ''}${c.service ?? c.name}`, detail: `:${h.container}, sans passer par un proxy`, direct: true, exposed: !h.host.startsWith('127.'), id: c.id, kind: 'container' })
  }
  return rows.sort((a, b) => Number(a.direct) - Number(b.direct) || a.host.localeCompare(b.host, undefined, { numeric: true }))
})

const alerts = computed(() => {
  const m = map.value
  if (!m) return []
  return [
    ...m.topology.warnings.map(w => ({ where: 'Endpoint', message: w, select: null })),
    ...m.topology.proxies.flatMap(p => p.warnings.map(w => ({ where: proxyName(p.container.id), message: w, select: { kind: 'proxy' as const, id: p.container.id } }))),
    ...m.topology.routes.flatMap((r, i) => r.warnings.map(w => ({ where: r.hosts[0] ?? r.router, message: w, select: { kind: 'routes' as const, indexes: [i] } }))),
  ]
})

// Détail (panneau latéral).
const sel = ref<MapSelection | null>(null)
const drawer = computed({ get: () => !!sel.value, set: (v) => { if (!v) sel.value = null } })
const selProxy = computed(() => (sel.value?.kind === 'proxy' ? map.value?.topology.proxies.find(p => p.container.id === (sel.value as { id: string }).id) ?? null : null))
const selRoutes = computed(() => (sel.value?.kind === 'routes' ? sel.value.indexes.map(i => map.value?.topology.routes[i]).filter((r): r is NonNullable<typeof r> => !!r) : []))
const selContainers = computed(() => (sel.value?.kind === 'containers' ? sel.value.ids.map(id => map.value?.containers.find(c => c.id === id)).filter((c): c is NonNullable<typeof c> => !!c) : []))
const drawerTitle = computed(() => {
  if (selProxy.value) return proxyName(selProxy.value.container.id)
  if (selRoutes.value.length) return selRoutes.value.length > 1 ? `${selRoutes.value.length} routes vers ${selRoutes.value[0]!.container?.service ?? selRoutes.value[0]!.container?.name ?? 'la même destination'}` : (selRoutes.value[0]!.hosts[0] ?? selRoutes.value[0]!.router)
  if (selContainers.value.length) return selContainers.value.length > 1 ? `${selContainers.value[0]!.stack ?? 'Conteneurs'} — ${selContainers.value.length} conteneurs` : (selContainers.value[0]!.service ?? selContainers.value[0]!.name)
  return ''
})
// Suppression d'un proxy inutile : aucune route, pas le Traefik géré ; revérifié côté serveur.
/** Stack externe (ni projet ni stack de la plateforme) reprenable depuis le détail. */
const adoptStack = computed(() => {
  const c = selContainers.value
  const stack = c[0]?.stack
  if (!stack || stack === MANAGED_PROXY_STACK || !endpoint.value || !endpointId.value || c.some(x => x.stack !== stack || x.managed || x.project)) return null
  return can('server:manage', { serverId: endpoint.value.serverId }) && hasAny('project:create') ? stack : null
})
const selProxyRoutes = computed(() => (selProxy.value ? map.value?.topology.routes.filter(r => r.proxyId === selProxy.value!.container.id).length ?? 0 : 0))
const canRemoveProxy = computed(() => !!selProxy.value && selProxy.value.container.stack !== MANAGED_PROXY_STACK && !selProxy.value.nginx?.managed && selProxyRoutes.value === 0 && !!endpoint.value && can('server:manage', { serverId: endpoint.value.serverId }))
const removing = ref(false)
// Logs d'accès d'un nginx (fenêtre ouverte depuis le détail du proxy).
const logsProxy = ref<string | null>(null)
const logsOpen = computed({ get: () => !!logsProxy.value, set: (v) => { if (!v) logsProxy.value = null } })
async function removeProxy() {
  const p = selProxy.value
  if (!p || !endpointId.value) return
  const ok = await confirm({
    title: 'Supprimer ce reverse proxy',
    message: `${p.container.name} ne sert aucune route. Le conteneur est arrêté puis supprimé ; ses volumes sont conservés.${p.container.stack ? ` Il appartient au Compose « ${p.container.stack} » : le retirer aussi de son fichier, sinon il sera recréé au prochain lancement.` : ''}`,
    confirmLabel: 'Supprimer',
    danger: true,
  })
  if (!ok) return
  removing.value = true
  try {
    const r = await $fetch<{ removed: string, stack: string | null }>(`/api/endpoints/${endpointId.value}/proxy/${p.container.id}/remove`, { method: 'POST' })
    toast.success(`${r.removed} supprimé${r.stack ? ` — à retirer aussi du Compose « ${r.stack} »` : ''}`)
    sel.value = null
    await load(true)
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    removing.value = false
  }
}
const routesOfContainer = (id: string) => map.value?.topology.routes.map((r, i) => ({ r, i })).filter(x => x.r.container?.id === id) ?? []
const certsOfRoute = (r: (typeof selRoutes.value)[number]) => map.value?.certificates.filter(c => c.proxyId === r.proxyId && r.hosts.includes(c.host)) ?? []
</script>

<template>
  <div>
    <UiPageHeader title="Reverse proxies" :icon="Network">
      <template v-if="endpoints?.length" #nav>
        <div class="filters">
          <select v-if="endpoints.length > 1" v-model="endpointId" class="input sm" aria-label="Endpoint">
            <option v-for="e in endpoints" :key="e.id" :value="e.id">{{ e.serverName }} / {{ e.name }}</option>
          </select>
          <select v-if="(map?.topology.proxies.length ?? 0) > 1" v-model="proxyId" class="input sm" aria-label="Proxy">
            <option value="">Tous les proxies</option>
            <option v-for="p in map?.topology.proxies ?? []" :key="p.container.id" :value="p.container.id">{{ proxyName(p.container.id) }}</option>
          </select>
          <span class="search"><Search :size="14" aria-hidden="true" /><input v-model="query" class="input sm" placeholder="Domaine, stack, service…" aria-label="Rechercher un domaine ou un conteneur"></span>
        </div>
      </template>
      <NuxtLink v-if="endpoint" :to="`/servers/${endpoint.serverId}?tab=proxy`" class="small link" title="Configuration du proxy sur la fiche du serveur">Serveur <ExternalLink :size="12" /></NuxtLink>
      <AiReport v-if="endpoint && map && hasAny('server:read')" feature="proxy" :body="{ endpointId: endpoint.id }" label="Expliquer avec Ollama" title="Explication des reverse proxies" causesLabel="Constats" actionsLabel="À vérifier" />
      <UiButton size="sm" :loading="loading" title="Relire les proxies" aria-label="Actualiser" @click="load(true)"><RefreshCw :size="14" /></UiButton>
    </UiPageHeader>

    <UiEmpty v-if="endpoints && !endpoints.length" title="Aucun endpoint" text="Ajoutez un serveur pour voir ses reverse proxies." :icon="Network" />
    <template v-else>
      <p v-if="error" class="alert" role="alert">{{ error }}</p>
      <p v-else-if="toReattach.length" class="alert warn-banner" role="status">
        {{ toReattach.length }} conteneur(s) routé(s) par un proxy mais absent(s) de son réseau : {{ toReattach.map(t => t.name).join(', ') }}.
        <UiButton v-if="canReattach" size="sm" variant="primary" :loading="reattaching" @click="reattach(toReattach)">Tout rebrancher</UiButton>
      </p>
      <div v-else-if="!map" class="muted pad">Lecture des reverse proxies…</div>
      <template v-else>
        <div class="tabline">
          <UiTabs v-model="tab" :tabs="tabs" />
          <div v-if="summary" class="kpis">
            <span class="kpi" title="Reverse proxies détectés"><strong>{{ summary.proxies }}</strong><span class="muted small">proxy(s)</span></span>
            <span class="kpi" :title="`${summary.routes} route(s) vers ${summary.containers} conteneur(s)`"><strong>{{ summary.routes }}</strong><span class="muted small">route(s)</span></span>
            <button type="button" class="kpi" title="Certificats ACME valides" @click="tab = 'certs'"><strong class="ok">{{ summary.valid }}</strong><span class="muted small">cert. valide(s)</span></button>
            <button v-if="summary.attention" type="button" class="kpi attn" title="Certificats à surveiller" @click="tab = 'certs'"><strong>{{ summary.attention }}</strong><span class="muted small">à surveiller</span></button>
            <button type="button" class="kpi" :class="{ attn: summary.direct }" title="Conteneurs publiés hors proxy" @click="tab = 'ports'"><strong>{{ summary.direct }}</strong><span class="muted small">hors proxy</span></button>
          </div>
        </div>

        <section v-if="tab === 'diagram'" class="card pad">
          <div class="opts small">
            <label><input v-model="showDirect" type="checkbox"> Ports publiés hors proxy</label>
            <label><input v-model="showUnrouted" type="checkbox"> Stacks sur le réseau d'un proxy, sans route</label>
            <span class="legend">
              <span><i class="sw route" /> URL → port</span>
              <span><i class="sw target" /> proxy → stack</span>
              <span><i class="sw network" /> réseau du proxy, sans route</span>
              <span><i class="sw direct" /> port publié hors proxy</span>
            </span>
          </div>
          <UiEmpty v-if="!map.topology.proxies.length && !graph?.stacks.length" title="Aucun reverse proxy détecté" text="Aucun Traefik, Caddy, nginx… sur cet endpoint. Un reverse proxy se déclare (ou un Traefik géré se déploie) depuis l'onglet Reverse proxy du serveur." compact />
          <ProxyMapDiagram v-else-if="graph" :graph="graph" @select="s => (sel = s)" />
          <p class="muted small foot">Lu à {{ fmtTime(map.topology.scannedAt) }} · de gauche à droite : URL, port de l'hôte, reverse proxy, stack servie · survol : flux, clic : détail.</p>
        </section>

        <section v-else-if="tab === 'certs'" class="stack">
          <div class="card pad">
            <h3>Résolveurs ACME <span v-if="!map.resolvers.length" class="muted small">· aucun résolveur configuré sur les proxies de cet endpoint (Traefik, Let's Encrypt de la console pour nginx)</span></h3>
            <div v-if="map.resolvers.length" class="resolvers">
              <div v-for="r in map.resolvers" :key="`${r.proxyId}-${r.name}`" class="resolver">
                <div class="r-title"><strong class="mono">{{ r.name }}</strong><span class="muted small">{{ proxyName(r.proxyId) }}</span></div>
                <div class="small">
                  {{ r.challenge ? CHALLENGE[r.challenge] : 'défi non précisé' }}{{ r.dnsProvider ? ` (${r.dnsProvider})` : '' }}
                  <UiBadge v-if="r.staging" tone="warning">autorité de test</UiBadge>
                </div>
                <div class="muted small mono">{{ r.storage }}</div>
                <div class="small">
                  <UiBadge v-if="r.error" tone="warning">{{ r.error }}</UiBadge>
                  <template v-else>
                    <UiBadge :tone="r.accountRegistered ? 'success' : 'warning'">{{ r.accountRegistered ? 'compte enregistré' : 'compte non enregistré' }}</UiBadge>
                    {{ r.certificates }} certificat(s) stocké(s)
                  </template>
                </div>
              </div>
            </div>
          </div>
          <div class="card pad">
            <h3>Certificats par domaine</h3>
            <table v-if="map.certificates.length" class="tbl">
              <thead><tr><th>Domaine</th><th>Proxy / résolveur</th><th>État</th><th>Émetteur</th><th>Expiration</th></tr></thead>
              <tbody>
                <tr v-for="c in map.certificates" :key="`${c.proxyId}-${c.host}-${c.resolver}`">
                  <td class="mono">{{ c.host }}</td>
                  <td class="small">{{ proxyName(c.proxyId) }}<span v-if="c.resolver" class="muted"> · {{ c.resolver }}</span></td>
                  <td>
                    <UiBadge :tone="CERT_TONE[c.state]" dot>{{ CERT_LABEL[c.state] }}</UiBadge>
                    <UiBadge v-if="c.staging" tone="warning">test</UiBadge>
                    <div v-if="c.error" class="err small">{{ c.error }}</div>
                  </td>
                  <td class="small">{{ c.issuer ?? '—' }}</td>
                  <td class="small">{{ c.notAfter ? `${fmtDate(c.notAfter)} (${daysLeft(c.notAfter)} j)` : '—' }}</td>
                </tr>
              </tbody>
            </table>
            <p v-else class="muted small">Aucune route en HTTPS.</p>
          </div>
          <div v-if="map.acmeErrors.length" class="card pad">
            <h3>Erreurs ACME récentes (logs)</h3>
            <ul class="errs">
              <li v-for="(e, i) in map.acmeErrors" :key="i" class="small">
                <span class="muted">{{ e.at ? fmtDateTime(e.at) : '' }} {{ proxyName(e.proxyId) }}</span>&nbsp;
                <span v-if="e.domains.length" class="mono"> {{ e.domains.join(', ') }}</span>
                <div class="err">{{ e.message }}</div>
              </li>
            </ul>
          </div>
        </section>

        <section v-else-if="tab === 'ports'" class="card pad">
          <table class="tbl">
            <thead><tr><th>Port de l'hôte</th><th /><th>Destination</th><th>Détail</th></tr></thead>
            <tbody>
              <tr v-for="(p, i) in portRows" :key="i" class="clickable" @click="sel = p.kind === 'proxy' ? { kind: 'proxy', id: p.id } : { kind: 'containers', ids: [p.id] }">
                <td class="mono">{{ p.host }}/{{ p.protocol }}</td>
                <td><ArrowRight :size="13" /></td>
                <td>{{ p.target }}</td>
                <td class="small">
                  {{ p.detail }}
                  <UiBadge v-if="p.direct && p.exposed" tone="warning">exposé sur toutes les interfaces</UiBadge>
                  <UiBadge v-else-if="p.direct" tone="neutral">local</UiBadge>
                </td>
              </tr>
              <tr v-if="!portRows.length"><td colspan="4" class="muted">Aucun port publié</td></tr>
            </tbody>
          </table>
        </section>

        <section v-else class="card pad">
          <ul v-if="alerts.length" class="alerts">
            <li v-for="(a, i) in alerts" :key="i" :class="{ clickable: a.select }" @click="a.select && (sel = a.select)">
              <TriangleAlert :size="14" /> <strong>{{ a.where }}</strong> — {{ a.message }}
            </li>
          </ul>
          <p v-else class="muted">Aucune alerte.</p>
        </section>
      </template>
    </template>

    <UiModal v-model:open="logsOpen" :title="logsProxy ? `Logs d'accès — ${proxyName(logsProxy)}` : ''" width="1100px">
      <AccessLogViewer v-if="logsProxy && endpointId" :url="`/api/endpoints/${endpointId}/proxy/${logsProxy}/access-logs`" />
    </UiModal>

    <UiDrawer v-model:open="drawer" :title="drawerTitle" width="640px">
      <div v-if="selProxy" class="detail">
        <dl>
          <dt>Image</dt><dd class="mono">{{ selProxy.container.image }}</dd>
          <dt>État</dt><dd>{{ selProxy.container.running ? 'en marche' : 'arrêté' }}{{ selProxy.container.stack ? ` · stack ${selProxy.container.stack}` : '' }}</dd>
          <dt>Réseaux</dt><dd>{{ selProxy.networks.join(', ') || '—' }}</dd>
          <dt>Ports publiés</dt><dd class="mono">{{ selProxy.hostPorts.map(h => `${h.host} → ${h.container}/${h.protocol}`).join(', ') || '—' }}</dd>
          <template v-if="selProxy.traefik">
            <dt>Configuration</dt><dd>{{ selProxy.traefik.source }}{{ selProxy.traefik.configFile ? ` (${selProxy.traefik.configFile})` : '' }}</dd>
            <dt>Fournisseur Docker</dt><dd>{{ selProxy.traefik.providers.docker ? `${selProxy.traefik.providers.docker.exposedByDefault ? 'exposé par défaut' : 'traefik.enable requis'}${selProxy.traefik.providers.docker.network ? `, réseau ${selProxy.traefik.providers.docker.network}` : ''}${selProxy.traefik.providers.docker.constraints ? `, contrainte ${selProxy.traefik.providers.docker.constraints}` : ''}` : 'désactivé' }}</dd>
          </template>
          <template v-if="selProxy.nginx">
            <dt>Gestion</dt><dd>{{ selProxy.nginx.managed ? `reverse proxy des projets (${selProxy.nginx.managed.provider === 'nginx' ? `sites écrits dans ${selProxy.nginx.managed.confDir}` : 'variables VIRTUAL_HOST'}, réseau ${selProxy.nginx.managed.network})` : 'hors plateforme (lecture seule)' }}</dd>
            <dt>Sites</dt><dd>{{ selProxy.nginx.sites }}{{ selProxy.nginx.platformSites ? ` dont ${selProxy.nginx.platformSites} fichier(s) de la console` : '' }}</dd>
            <dt>Certificats</dt><dd>{{ selProxy.nginx.certificateFiles }} référencé(s){{ selProxy.nginx.managed ? ` · console : ${selProxy.nginx.managed.certsDir}${selProxy.nginx.managed.acme ? ', Let\'s Encrypt' : ''}` : '' }}</dd>
            <dt v-if="selProxy.configFiles.length">Fichiers lus</dt><dd v-if="selProxy.configFiles.length" class="mono small">{{ selProxy.configFiles.join(', ') }}</dd>
          </template>
        </dl>
        <UiButton v-if="selProxy.nginx" size="sm" @click="logsProxy = selProxy.container.id">Logs d'accès</UiButton>
        <template v-if="selProxy.nginx?.listens.length">
          <h4>Écoutes</h4>
          <table class="tbl">
            <thead><tr><th>Port</th><th>Hôte</th><th>TLS / redirection</th></tr></thead>
            <tbody>
              <tr v-for="l in selProxy.nginx.listens" :key="l.port">
                <td class="mono">:{{ l.port }}</td><td class="mono small">{{ l.hostPorts.join(', ') || 'non publié' }}</td>
                <td class="small">{{ l.redirectTo ? `→ ${l.redirectTo}` : l.tls ? 'TLS' : '—' }}</td>
              </tr>
            </tbody>
          </table>
        </template>
        <template v-if="selProxy.traefik?.entrypoints.length">
          <h4>Points d'entrée</h4>
          <table class="tbl">
            <thead><tr><th>Nom</th><th>Port</th><th>Hôte</th><th>TLS / redirection</th></tr></thead>
            <tbody>
              <tr v-for="e in selProxy.traefik.entrypoints" :key="e.name">
                <td class="mono">{{ e.name }}</td><td>{{ e.port ?? '?' }}/{{ e.protocol }}</td><td class="mono small">{{ e.hostPorts.join(', ') || 'non publié' }}</td>
                <td class="small">{{ e.redirectTo ? `→ ${e.redirectTo}` : e.tls ? `TLS${e.certResolver ? ` (ACME ${e.certResolver})` : ''}` : '—' }}</td>
              </tr>
            </tbody>
          </table>
        </template>
        <template v-if="selProxy.warnings.length">
          <h4>Alertes</h4>
          <ul class="warn-list"><li v-for="(w, i) in selProxy.warnings" :key="i">{{ w }}</li></ul>
        </template>
        <div v-if="canRemoveProxy" class="remove">
          <p class="muted small">Aucune route ne passe par ce proxy.</p>
          <UiButton size="sm" variant="danger" :loading="removing" @click="removeProxy"><Trash2 :size="13" /> Supprimer ce reverse proxy</UiButton>
        </div>
      </div>

      <div v-else-if="selRoutes.length" class="detail">
        <section v-for="(selRoute, k) in selRoutes" :key="k" class="item">
        <h4 v-if="selRoutes.length > 1" class="mono">{{ selRoute.hosts[0] ?? selRoute.router }}{{ selRoute.pathPrefix ?? '' }}</h4>
        <dl>
          <dt>Proxy</dt><dd>{{ proxyName(selRoute.proxyId) }}</dd>
          <dt>Routeur</dt><dd class="mono">{{ selRoute.router }}</dd>
          <dt>Règle</dt><dd class="mono">{{ selRoute.rule ?? '—' }}</dd>
          <dt>Domaines</dt><dd class="mono">{{ selRoute.hosts.join(', ') || '—' }}{{ selRoute.pathPrefix ?? '' }}</dd>
          <dt>Points d'entrée</dt><dd>{{ selRoute.entrypoints.join(', ') || '—' }}</dd>
          <dt>TLS</dt><dd><component :is="selRoute.tls ? Lock : LockOpen" :size="13" /> {{ selRoute.tls ? (selRoute.certResolver ? `ACME (${selRoute.certResolver})` : 'certificat fourni') : 'non' }}{{ selRoute.passthrough ? ', passthrough' : '' }}{{ selRoute.redirectsToHttps ? ', redirection HTTPS' : '' }}</dd>
          <dt>Middlewares</dt><dd>{{ selRoute.middlewares.join(', ') || '—' }}</dd>
          <dt>Destination</dt><dd>{{ selRoute.container ? `${selRoute.container.stack ? `${selRoute.container.stack}/` : ''}${selRoute.container.service ?? selRoute.container.name}` : selRoute.targetUrl ?? '—' }}{{ selRoute.targetPort ? `:${selRoute.targetPort}` : '' }}{{ selRoute.network ? ` via ${selRoute.network}` : '' }}</dd>
        </dl>
        <template v-if="certsOfRoute(selRoute).length">
          <h4>Certificats</h4>
          <ul class="plain">
            <li v-for="c in certsOfRoute(selRoute)" :key="c.host">
              <span class="mono">{{ c.host }}</span> <UiBadge :tone="CERT_TONE[c.state]" dot>{{ CERT_LABEL[c.state] }}</UiBadge>
              <span v-if="c.notAfter" class="muted small"> {{ c.issuer }} · jusqu'au {{ fmtDate(c.notAfter) }}</span>
              <div v-if="c.error" class="err small">{{ c.error }}</div>
            </li>
          </ul>
        </template>
        <template v-if="selRoute.warnings.length">
          <h4>Alertes</h4>
          <ul class="warn-list"><li v-for="(w, i) in selRoute.warnings" :key="i">{{ w }}</li></ul>
        </template>
        <div v-if="selRoute.reattach && selRoute.container && canReattach" class="reattach">
          <span class="small">{{ selRoute.reattach.reason }}.</span>
          <UiButton size="sm" variant="primary" :loading="reattaching" @click="reattach([{ containerId: selRoute.container.id, name: selRoute.container.name, network: selRoute.reattach.network }])">Rebrancher derrière le proxy ({{ selRoute.reattach.network }})</UiButton>
        </div>
        </section>
      </div>

      <div v-else-if="selContainers.length" class="detail">
        <!-- Stack externe : la reprendre en projet géré (assistant de l'onglet Reprise du serveur). -->
        <div v-if="adoptStack" class="adopt-hint">
          <span class="small">Stack <strong class="mono">{{ adoptStack }}</strong> hors plateforme : non visible dans les projets.</span>
          <UiButton size="sm" variant="primary" @click="navigateTo(adoptLink(endpoint!.serverId, endpointId!, adoptStack))">Reprendre en projet</UiButton>
        </div>
        <ProxyRouteForm v-if="endpoint && endpointId" :endpoint-id="endpointId" :server-id="endpoint.serverId" :containers="selContainers" @changed="load(true)" />
        <section v-for="selContainer in selContainers" :key="selContainer.id" class="item">
        <h4 v-if="selContainers.length > 1">{{ selContainer.service ?? selContainer.name }}</h4>
        <dl>
          <dt>Conteneur</dt><dd class="mono">{{ selContainer.name }}</dd>
          <dt>Image</dt><dd class="mono">{{ selContainer.image }}</dd>
          <dt>État</dt><dd>{{ selContainer.state }}{{ selContainer.health ? ` (${selContainer.health})` : '' }}</dd>
          <dt>Stack</dt><dd>{{ selContainer.stack ?? '—' }}{{ selContainer.service ? ` / ${selContainer.service}` : '' }}</dd>
          <dt>Projet</dt><dd><NuxtLink v-if="selContainer.project" :to="`/projects/${selContainer.project.id}`">{{ selContainer.project.name }}</NuxtLink><template v-if="selContainer.project?.environment"> ({{ selContainer.project.environment }})</template><span v-if="!selContainer.project">{{ selContainer.managed ? 'plateforme' : 'hors plateforme' }}</span></dd>
          <dt>Réseaux de proxy</dt><dd>{{ selContainer.proxyNetworks.join(', ') || '—' }}</dd>
          <dt>Ports publiés</dt><dd class="mono">{{ selContainer.hostPorts.map(h => `${h.host} → ${h.container}/${h.protocol}`).join(', ') || '—' }}</dd>
        </dl>
        <h4>Routes</h4>
        <ul v-if="routesOfContainer(selContainer.id).length" class="plain">
          <li v-for="x in routesOfContainer(selContainer.id)" :key="x.i" class="clickable" @click="sel = { kind: 'routes', indexes: [x.i] }">
            <component :is="x.r.tls ? Lock : LockOpen" :size="13" /> <span class="mono">{{ x.r.hosts[0] ?? x.r.router }}{{ x.r.pathPrefix ?? '' }}</span> <span class="muted small">via {{ proxyName(x.r.proxyId) }}</span>
          </li>
        </ul>
        <p v-else class="muted small">Aucune route : joignable seulement par ses ports publiés ou par les autres conteneurs.</p>
        </section>
      </div>
    </UiDrawer>
  </div>
</template>

<style scoped>
.filters { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.input.sm { min-height: 30px; padding-top: 3px; padding-bottom: 3px; font-size: 13px; width: auto; max-width: 260px; field-sizing: content; }
.search { position: relative; display: inline-flex; align-items: center; }
.search svg { position: absolute; left: 8px; color: var(--text-muted); pointer-events: none; }
.search .input { padding-left: 28px; width: 200px; field-sizing: fixed; }
.tabline { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; margin-bottom: var(--space-2); }
.tabline :deep(.tabs) { margin-bottom: 0; }
.link { display: inline-flex; gap: 4px; align-items: center; }
.kpis { display: flex; flex-wrap: wrap; gap: 6px; margin-left: auto; }
.kpi { all: unset; box-sizing: border-box; display: inline-flex; align-items: baseline; gap: 5px; padding: 2px 10px; background: var(--surface); border: 1px solid var(--border); border-radius: 999px; }
button.kpi { cursor: pointer; }
button.kpi:hover { border-color: var(--primary); }
button.kpi:focus-visible { outline: 2px solid var(--focus); }
.kpi strong { font-size: 13.5px; font-variant-numeric: tabular-nums; }
.kpi.attn strong { color: var(--warning); }
.ok { color: var(--success); }
.pad { padding: var(--space-3) var(--space-4); }
.stack { display: flex; flex-direction: column; gap: var(--space-3); }
.opts { display: flex; gap: var(--space-4); flex-wrap: wrap; align-items: center; margin-bottom: var(--space-2); }
.opts label { display: flex; gap: 6px; align-items: center; }
.legend { display: flex; gap: var(--space-3); flex-wrap: wrap; margin-left: auto; color: var(--text-muted); }
.legend span { display: inline-flex; gap: 5px; align-items: center; }
.sw { display: inline-block; width: 22px; height: 0; border-top: 2px solid; }
.sw.route { border-color: color-mix(in srgb, var(--primary) 55%, var(--border)); }
.sw.target { border-color: color-mix(in srgb, var(--success) 60%, var(--border)); }
.sw.network { border-top-style: dotted; border-color: var(--border-strong); }
.sw.direct { border-top-style: dashed; border-color: var(--warning); }
.foot { margin: var(--space-3) 0 0; }
h3 { margin: 0 0 var(--space-2); font-size: 14px; }
h3 .small { font-weight: 400; }
h3:last-child { margin-bottom: 0; }
h4 { margin: var(--space-4) 0 var(--space-2); font-size: 13.5px; }
.resolvers { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: var(--space-3); }
.resolver { display: flex; flex-direction: column; gap: 4px; padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius); }
.r-title { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.tbl { width: 100%; border-collapse: collapse; font-size: 13px; }
.tbl th { text-align: left; font-weight: 500; color: var(--text-muted); font-size: 11px; text-transform: uppercase; padding: 4px 8px; border-bottom: 1px solid var(--border); }
.tbl td { padding: 4px 8px; border-bottom: 1px solid var(--border); vertical-align: middle; }
.clickable { cursor: pointer; }
tr.clickable:hover { background: var(--surface-2); }
.err { color: var(--danger); }
.errs, .alerts, .plain, .warn-list { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px; }
.alerts li { display: flex; gap: 6px; align-items: baseline; font-size: 13px; }
.alerts li svg { color: var(--warning); flex: none; }
.warn-list li { color: var(--warning); font-size: 13px; }
.reattach { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; margin-top: var(--space-2); }
.warn-banner { background: var(--warning-bg); color: var(--warning); display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.detail .item + .item { margin-top: var(--space-4); padding-top: var(--space-3); border-top: 1px solid var(--border); }
.detail dl { display: grid; grid-template-columns: 150px 1fr; gap: 6px var(--space-3); margin: 0; font-size: 13px; }
.detail dt { color: var(--text-muted); }
.detail dd { margin: 0; overflow-wrap: anywhere; }
.small { font-size: 12.5px; }
.alert { background: var(--danger-bg); color: var(--danger); padding: var(--space-3) var(--space-4); border-radius: var(--radius); }
@media (max-width: 640px) {
  .detail .item + .item { margin-top: var(--space-4); padding-top: var(--space-3); border-top: 1px solid var(--border); }
.detail dl { grid-template-columns: 1fr; }
}
.remove { display: flex; justify-content: space-between; align-items: center; gap: var(--space-2); margin-top: var(--space-3); padding-top: var(--space-3); border-top: 1px solid var(--border); }
.remove p { margin: 0; }
.adopt-hint { display: flex; justify-content: space-between; align-items: center; gap: var(--space-2); flex-wrap: wrap; padding: var(--space-2) var(--space-3); margin-bottom: var(--space-3); border: 1px solid color-mix(in srgb, var(--primary) 30%, var(--border)); background: var(--primary-soft); border-radius: var(--radius); }
</style>
