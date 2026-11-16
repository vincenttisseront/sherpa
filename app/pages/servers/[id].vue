<script setup lang="ts">
import type { NetworkDecision, PathConfigInput, PortRuleInput, TraefikConfigInput } from '#shared/schemas/infra'
import { PROXY_DEFAULTS, PROXY_PROVIDER_LABEL, defaultPathConfig } from '#shared/schemas/infra'
import type { DiscoveryReport, NetworkDto, ServerDetailDto, SshHostKeyScan, VolumeDto } from '#shared/schemas/servers'
import type { TraefikSuggestion } from '#shared/schemas/proxy'
import { CONSOLE_HOST, LOOPBACK_MESSAGE, isLoopbackHost } from '#shared/utils/console-host'
import { Wand2 } from 'lucide-vue-next'
import type { NetworkRow } from '~/types/infra'

const route = useRoute()
const toast = useToast()
const confirm = useConfirm()
const id = computed(() => String(route.params.id))
const { can, hasAny } = useAuth()

const { data: server, error, refresh } = await useFetch<ServerDetailDto>(() => `/api/servers/${id.value}`)
if (error.value?.statusCode === 404) throw createError({ statusCode: 404, statusMessage: 'Serveur introuvable', fatal: true })
const { data: environments } = await useEnvironments()
useHead({ title: () => server.value?.name ?? 'Serveur' })

const STATUS = {
  online: { label: 'En ligne', tone: 'success' },
  degraded: { label: 'Dégradé', tone: 'warning' },
  offline: { label: 'Hors ligne', tone: 'danger' },
  unknown: { label: 'Inconnu', tone: 'neutral' },
} as const
const fmt = (iso: string | null) => fmtDateTime(iso)

const tab = ref((route.query.tab as string) || 'overview')
watch(tab, t => navigateTo({ query: { ...route.query, tab: t } }, { replace: true }))

const usableEndpoints = computed(() => (server.value?.endpoints ?? []).filter(e => !e.missing))
function pickEndpoint() {
  const wanted = typeof route.query.endpoint === 'string' ? usableEndpoints.value.find(e => e.id === route.query.endpoint) : undefined
  return (wanted ?? usableEndpoints.value.find(e => e.enabled) ?? usableEndpoints.value[0])?.id ?? ''
}
// Choisi dès la mise en place (rendu serveur compris) : les données de l'endpoint en dépendent.
const endpointId = ref<string>(pickEndpoint())
/** Onglets qui portent sur un endpoint (choix de l'endpoint affiché à côté des onglets). */
const endpointScoped = computed(() => !['overview', 'endpoints', 'live'].includes(tab.value))
watch(usableEndpoints, () => {
  if (!usableEndpoints.value.some(e => e.id === endpointId.value)) endpointId.value = pickEndpoint()
})
const endpoint = computed(() => server.value?.endpoints.find(e => e.id === endpointId.value))
// Plage des sous-réseaux enregistrée : plan d'adressage rechargé.
const poolVersion = ref(0)
// Liens internes vers cette même page (ex. « Reprendre en projet » de l'onglet Conteneurs) : seule
// l'URL change, la page n'est pas recréée ; onglet et endpoint suivent donc l'URL.
watch(() => [route.query.tab, route.query.endpoint], ([t, ep]) => {
  if (typeof t === 'string' && t !== tab.value) tab.value = t
  if (typeof ep === 'string' && ep !== endpointId.value && usableEndpoints.value.some(e => e.id === ep)) endpointId.value = ep
})

const unreviewed = computed(() => (server.value?.endpoints ?? []).reduce((n, e) => n + (e.enabled ? e.unreviewedNetworks : 0), 0))
const tabs = computed(() => [
  { key: 'overview', label: 'Vue d\'ensemble' },
  { key: 'endpoints', label: 'Endpoints' },
  { key: 'live', label: 'Conteneurs', title: 'Conteneurs en direct' },
  { key: 'proxy', label: 'Proxy', title: 'Proxy et expositions' },
  { key: 'adopt', label: 'Reprise', title: 'Reprise de l\'existant' },
  { key: 'networks', label: 'Réseaux et volumes', badge: unreviewed.value || undefined },
  { key: 'watchtower', label: 'Watchtower', title: 'Profils Watchtower du serveur' },
  { key: 'paths', label: 'Chemins' },
  { key: 'ports', label: 'Ports' },
  { key: 'traefik', label: 'Reverse proxy', title: 'Reverse proxy (Traefik, nginx-proxy, nginx) et domaines' },
  { key: 'runner', label: 'Runner', title: 'Target Runner' },
  ...(can('server:manage', { serverId: id.value }) ? [{ key: 'cleanup', label: 'Nettoyage' }] : []),
])

// --- Actions serveur ---
const busy = ref<string | null>(null)

async function run<T>(key: string, fn: () => Promise<T>): Promise<T | undefined> {
  busy.value = key
  try {
    return await fn()
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    busy.value = null
  }
}

async function check() {
  const r = await run('check', () => $fetch<ServerDetailDto>(`/api/servers/${id.value}/check`, { method: 'POST' }))
  if (r) {
    server.value = r
    if (r.status === 'online') toast.success('Connexion vérifiée')
    else toast.warning(r.lastError ?? `Statut : ${STATUS[r.status].label}`)
  }
}

async function discover() {
  const r = await run('discover', () => $fetch<DiscoveryReport>(`/api/servers/${id.value}/discover`, { method: 'POST' }))
  if (!r) return
  await refresh()
  await reloadEndpointData()
  const added = r.endpoints.added + r.networks.added + r.volumes.added
  const missing = r.endpoints.missing + r.networks.missing + r.volumes.missing
  toast.success(`Découverte terminée : ${added} nouvel(s) objet(s), ${missing} disparu(s)`)
  for (const e of r.errors) toast.warning(`${e.endpoint} : ${e.error}`)
}

// Modification
const editOpen = ref(false)
const edit = reactive({ name: '', description: '', tags: [] as string[], url: '', tlsVerify: true, caCertPem: '', sshHost: '', sshPort: 22, sshUser: '', dockerSocket: '', sshHostKey: '' })
const editErrors = ref<Record<string, string>>({})
function openEdit() {
  const s = server.value!
  Object.assign(edit, { name: s.name, description: s.description ?? '', tags: [...s.tags], url: s.url, tlsVerify: s.tlsVerify, caCertPem: s.caCertPem ?? '', sshHost: s.ssh?.host ?? '', sshPort: s.ssh?.port ?? 22, sshUser: s.ssh?.username ?? '', dockerSocket: s.ssh?.dockerSocket ?? '', sshHostKey: s.ssh?.hostKey ?? '' })
  editScan.value = null
  editErrors.value = {}
  editOpen.value = true
}
async function saveEdit() {
  editErrors.value = {}
  busy.value = 'edit'
  try {
    server.value = await $fetch<ServerDetailDto>(`/api/servers/${id.value}`, {
      method: 'PATCH',
      body: server.value!.transport === 'ssh'
        ? { name: edit.name, description: edit.description || null, tags: edit.tags, sshHost: edit.sshHost, sshPort: edit.sshPort, sshUser: edit.sshUser, dockerSocket: edit.dockerSocket, sshHostKey: edit.sshHostKey }
        : { name: edit.name, description: edit.description || null, tags: edit.tags, url: edit.url, tlsVerify: edit.tlsVerify, caCertPem: edit.caCertPem.trim() || null },
    })
    editOpen.value = false
    toast.success('Serveur mis à jour')
  }
  catch (err) {
    const e = apiError(err)
    editErrors.value = e.errors
    if (!Object.keys(e.errors).length) toast.error(e.message)
  }
  finally {
    busy.value = null
  }
}

// Nouvel hôte ou port SSH : la clé d'hôte présentée doit être relue et confirmée.
const editScan = ref<SshHostKeyScan | null>(null)
async function scanEditHostKey() {
  try {
    editScan.value = await $fetch<SshHostKeyScan>('/api/servers/ssh-host-key', { method: 'POST', body: { host: edit.sshHost, port: edit.sshPort } })
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
}

// Identifiants SSH : remplacement testé avant enregistrement.
const sshCredOpen = ref(false)
const sshCred = reactive({ auth: 'key' as 'key' | 'password', password: '', privateKey: '', passphrase: '' })
const sshCredError = ref<string | null>(null)
function closeSshCred() {
  sshCredOpen.value = false
  Object.assign(sshCred, { password: '', privateKey: '', passphrase: '' })
}
async function rotateSshCredentials() {
  sshCredError.value = null
  busy.value = 'ssh-cred'
  try {
    await $fetch<unknown>(`/api/servers/${id.value}/ssh-credentials`, { method: 'PUT', body: sshCred.auth === 'key' ? { auth: 'key', privateKey: sshCred.privateKey, ...(sshCred.passphrase ? { passphrase: sshCred.passphrase } : {}) } : { auth: 'password', password: sshCred.password } })
    closeSshCred()
    toast.success('Identifiants SSH remplacés ; les anciens ont été détruits')
    await refresh()
  }
  catch (err) {
    const e = apiError(err)
    sshCredError.value = e.errors.password ?? e.errors.privateKey ?? e.message
  }
  finally {
    busy.value = null
  }
}

// Clé d'hôte : vérification (présentée maintenant vs confirmée), nouvelle confirmation après réinstallation.
const hostKeyCheck = ref<{ fingerprint: string, keyType: string, confirmed: string | null, matches: boolean } | null>(null)
async function checkHostKey() {
  busy.value = 'hostkey'
  try {
    hostKeyCheck.value = await $fetch(`/api/servers/${id.value}/ssh-host-key`)
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    busy.value = null
  }
}
async function confirmHostKey(fingerprint: string) {
  const ok = await confirm({ title: 'Confirmer la nouvelle clé d\'hôte', message: `Empreinte présentée : ${fingerprint}\n\nNe confirmer qu'après l'avoir comparée sur l'hôte (ssh-keygen -lf /etc/ssh/ssh_host_*_key.pub). Une clé qui change sans réinstallation peut signaler une interception.`, confirmLabel: 'Confirmer', danger: true })
  if (!ok) return
  try {
    await $fetch(`/api/servers/${id.value}/ssh-host-key`, { method: 'PUT', body: { hostKey: fingerprint } })
    hostKeyCheck.value = null
    toast.success('Nouvelle clé d\'hôte confirmée')
    await refresh()
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
}

// Remplacement du secret de l'agent
const tokenOpen = ref(false)
const newToken = ref('')
const tokenError = ref<string | null>(null)
async function rotateToken() {
  tokenError.value = null
  busy.value = 'token'
  try {
    await $fetch<unknown>(`/api/servers/${id.value}/token`, { method: 'PUT', body: { token: newToken.value } })
    newToken.value = ''
    tokenOpen.value = false
    toast.success('AGENT_SECRET remplacé ; l\'ancien a été détruit')
    await refresh()
  }
  catch (err) {
    const e = apiError(err)
    tokenError.value = e.errors.token ?? e.message
  }
  finally {
    busy.value = null
  }
}

async function remove() {
  const s = server.value!
  const ok = await confirm({
    title: 'Supprimer le serveur',
    message: `Le serveur « ${s.name} », ses endpoints, ses politiques réseau et ses configurations (chemins, ports, Traefik) seront supprimés de la plateforme. Rien n'est modifié sur l'hôte ni sur l'agent.`,
    confirmLabel: 'Supprimer',
    danger: true,
    requireText: s.name,
  })
  if (!ok) return
  const r = await run('delete', () => $fetch<unknown>(`/api/servers/${id.value}`, { method: 'DELETE' }).then(() => true))
  if (r) {
    toast.success(`Serveur « ${s.name} » supprimé`)
    await navigateTo('/servers')
  }
}

// --- Endpoints ---
async function patchEndpoint(epId: string, body: { enabled?: boolean, environmentKeys?: string[] }) {
  const r = await run(`ep:${epId}`, () => $fetch<ServerDetailDto>(`/api/endpoints/${epId}`, { method: 'PATCH', body }))
  if (r) server.value = r
}

async function toggleEndpoint(epId: string, enabled: boolean) {
  if (!enabled) {
    const ok = await confirm({ title: 'Désactiver l\'endpoint', message: 'Aucun nouveau déploiement ne sera possible sur cet endpoint. Les stacks existantes ne sont pas touchées.', confirmLabel: 'Désactiver' })
    if (!ok) return
  }
  await patchEndpoint(epId, { enabled })
}

function toggleEndpointEnv(epId: string, key: string) {
  const ep = server.value!.endpoints.find(e => e.id === epId)!
  const keys = ep.environments.map(e => e.key)
  void patchEndpoint(epId, { environmentKeys: keys.includes(key) ? keys.filter(k => k !== key) : [...keys, key] })
}

// --- Données par endpoint ---
const networks = ref<NetworkDto[]>([])
const volumes = ref<VolumeDto[]>([])
/** Volumes Docker : aperçu, liste complète à la demande ou dès qu'un filtre est actif. */
const VOL_PREVIEW = 15
const volAll = ref(false)
const volFilter = useListFilter(() => volumes.value, v => `${v.name} ${v.driver ?? ''} ${v.mountpoint ?? ''}`, v => (v.missing ? 'missing' : 'present'))
const EP_STATUS = { online: 'En ligne', offline: 'Hors ligne', missing: 'Absent de l\'agent', disabled: 'Désactivé' }
const epFilter = useListFilter(() => server.value?.endpoints ?? [], ep => `${ep.name} ${ep.url} ${ep.type} ${ep.environments.map(e => e.name).join(' ')}`, ep => (ep.missing ? 'missing' : !ep.enabled ? 'disabled' : ep.online ? 'online' : 'offline'))
interface EndpointConfig { paths: Record<string, PathConfigInput & { updatedAt?: string }>, portRules: PortRuleInput[], traefik: TraefikConfigInput | null }
const config = ref<EndpointConfig | null>(null)
const pathDrafts = ref<Record<string, PathConfigInput>>({})
const pathErrors = ref<Record<string, Record<string, string>>>({})
const portDraft = ref<PortRuleInput[]>([])
const portErrors = ref<Record<string, string>>({})
const traefikDraft = ref<TraefikConfigInput | null>(null)
const traefikErrors = ref<Record<string, string>>({})

// Au rendu serveur, seul useRequestFetch transmet la session de la requête.
const requestFetch = useRequestFetch()
const { data: endpointData, refresh: reloadEndpointData } = await useAsyncData(
  () => `endpoint-data:${endpointId.value}`,
  async () => {
    if (!endpointId.value) return null
    const [n, v, c] = await Promise.all([
      requestFetch<NetworkDto[]>(`/api/endpoints/${endpointId.value}/networks`),
      requestFetch<VolumeDto[]>(`/api/endpoints/${endpointId.value}/volumes`),
      requestFetch<EndpointConfig>(`/api/endpoints/${endpointId.value}/config`),
    ])
    return { networks: n, volumes: v, config: c }
  },
  { watch: [endpointId] },
)

function applyConfig(c: EndpointConfig) {
  config.value = c
  pathDrafts.value = Object.fromEntries((endpoint.value?.environments ?? []).map((e) => {
    const { updatedAt: _, ...cfg } = c.paths[e.key] ?? { ...defaultPathConfig(e.key), updatedAt: undefined }
    return [e.key, cfg]
  }))
  pathErrors.value = {}
  portDraft.value = structuredClone(c.portRules)
  portErrors.value = {}
  traefikDraft.value = c.traefik ? structuredClone(c.traefik) : null
  traefikErrors.value = {}
}

watch([endpointData, () => endpoint.value?.environments.map(e => e.key).join()], () => {
  if (!endpointData.value) return
  networks.value = endpointData.value.networks
  volumes.value = endpointData.value.volumes
  applyConfig(endpointData.value.config)
}, { immediate: true })

const networkRows = computed<NetworkRow[]>(() => networks.value.map(n => ({
  name: n.name, driver: n.driver, scope: n.scope, internal: n.internal, missing: n.missing,
  policy: n.policy, role: n.role, external: n.external, description: n.description, tags: n.tags,
  allowedEnvironmentKeys: n.allowedEnvironmentKeys as NetworkDecision['allowedEnvironmentKeys'],
})))
const allowedNetworks = computed(() => networks.value.filter(n => n.policy === 'allowed' && !n.missing).map(n => n.name))

async function changeNetwork(name: string, patch: Partial<NetworkDecision>) {
  const net = networks.value.find(n => n.name === name)!
  if (patch.policy === 'allowed' && net.name === 'host') {
    const ok = await confirm({ title: 'Autoriser le réseau host ?', message: 'Les conteneurs attachés au réseau host partagent la pile réseau de l\'hôte et contournent l\'isolation. À éviter.', confirmLabel: 'Autoriser quand même', danger: true })
    if (!ok) return
  }
  busy.value = `net:${name}`
  try {
    await $fetch<unknown>(`/api/networks/${net.id}`, { method: 'PATCH', body: patch })
    networks.value = await $fetch<NetworkDto[]>(`/api/endpoints/${endpointId.value}/networks`)
    await refresh()
  }
  catch (err) {
    const e = apiError(err)
    toast.error(Object.values(e.errors)[0] ?? e.message)
  }
  finally {
    busy.value = null
  }
}

async function savePaths(env: string) {
  busy.value = `paths:${env}`
  try {
    const r = await $fetch<EndpointConfig & { directories?: { created: string[], failed: { path: string, error: string }[] } }>(`/api/endpoints/${endpointId.value}/paths/${env}`, { method: 'PUT', body: pathDrafts.value[env] })
    applyConfig(r)
    const d = r.directories
    if (d?.failed.length) toast.error(`Chemins enregistrés, mais répertoires non préparés : ${d.failed.map(f => `${f.path} (${f.error})`).join(' ; ')}`)
    else toast.success(d?.created.length ? `Chemins enregistrés ; répertoires créés ou rendus accessibles : ${d.created.join(', ')}` : 'Chemins enregistrés')
  }
  catch (err) {
    const e = apiError(err)
    pathErrors.value = { ...pathErrors.value, [env]: e.errors }
    toast.error(e.message)
  }
  finally {
    busy.value = null
  }
}

function resetPorts() {
  portDraft.value = structuredClone(toRaw(config.value!.portRules))
}

async function savePorts() {
  busy.value = 'ports'
  try {
    applyConfig(await $fetch<EndpointConfig>(`/api/endpoints/${endpointId.value}/port-rules`, { method: 'PUT', body: portDraft.value }))
    toast.success('Règles de ports enregistrées')
  }
  catch (err) {
    const e = apiError(err)
    portErrors.value = e.errors
    toast.error(e.message)
  }
  finally {
    busy.value = null
  }
}

function startTraefik() {
  traefikDraft.value = {
    ...PROXY_DEFAULTS,
    networkName: endpoint.value?.inventory.traefik?.networks.find(n => allowedNetworks.value.includes(n)) ?? '',
    certResolver: null, entrypointHttp: 'web', entrypointHttps: 'websecure', allowedDomains: [], defaultMiddlewares: [],
    routerNamePattern: '{project}-{env}-{service}', exposure: 'internal', redirectToHttps: true,
  }
}

// Configuration proposée à partir du Traefik en place (rien n'est enregistré sans validation).
const suggestion = ref<TraefikSuggestion | null>(null)
watch(endpointId, () => { suggestion.value = null })
const SUGGESTION_FIELDS: Record<string, string> = {
  networkName: 'Réseau', entrypointHttps: 'Entrypoint HTTPS', entrypointHttp: 'Entrypoint HTTP', certResolver: 'Resolver TLS',
  allowedDomains: 'Domaines', defaultMiddlewares: 'Middlewares', redirectToHttps: 'Redirection HTTPS', exposure: 'Exposition',
  provider: 'Reverse proxy', nginxContainer: 'Conteneur', nginxConfDir: 'Dossier des configurations', letsencrypt: 'Let\'s Encrypt',
}
async function useSuggestion(container?: string) {
  const s = await run('suggest', () => $fetch<TraefikSuggestion>(`/api/endpoints/${endpointId.value}/proxy/suggestion`, { query: typeof container === 'string' ? { container } : {} }))
  if (!s) return
  if (!s.available || !s.config) {
    suggestion.value = s
    tab.value = 'traefik'
    toast.warning(s.warnings[0] ?? 'Aucun reverse proxy détecté sur cet endpoint')
    return
  }
  suggestion.value = s
  traefikDraft.value = { ...PROXY_DEFAULTS, ...s.config, networkName: allowedNetworks.value.includes(s.config.networkName) ? s.config.networkName : '' }
  traefikErrors.value = {}
  tab.value = 'traefik'
  toast.info('Valeurs reprises de l\'existant : vérifier puis enregistrer')
}

const nginxCerts = computed(() => config.value?.traefik && config.value.traefik.provider !== 'traefik' && !!config.value.traefik.nginxContainer)
const certsKey = ref(0)
async function syncNginxCerts() {
  busy.value = 'nginx-certs'
  try {
    const { results } = await $fetch<{ results: { container: string | null, pushed: number, issued: string[], errors: string[] }[] }>(`/api/endpoints/${endpointId.value}/nginx-certificates/sync`, { method: 'POST' })
    for (const r of results) {
      if (r.errors.length) for (const e of r.errors) toast.warning(`${r.container} : ${e}`)
      else toast.success(`${r.container} : ${r.pushed} domaine(s) en HTTPS${r.issued.length ? `, Let's Encrypt : ${r.issued.join(', ')}` : ''}`)
    }
    certsKey.value++
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    busy.value = null
  }
}

async function saveTraefik() {
  busy.value = 'traefik'
  try {
    applyConfig(await $fetch<EndpointConfig>(`/api/endpoints/${endpointId.value}/traefik`, { method: 'PUT', body: traefikDraft.value }))
    toast.success(`Reverse proxy enregistré : ${PROXY_PROVIDER_LABEL[traefikDraft.value!.provider]}`)
  }
  catch (err) {
    const e = apiError(err)
    traefikErrors.value = e.errors
    toast.error(e.message)
  }
  finally {
    busy.value = null
  }
}

const isDirty = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b)
const pathDirty = (env: string) => {
  const saved = config.value?.paths[env]
  if (!saved) return true
  const { updatedAt: _, ...cfg } = saved
  return isDirty(cfg, pathDrafts.value[env])
}
</script>

<template>
  <div v-if="server">
    <UiPageHeader :title="server.name" icon="server" :back="{ to: '/servers', label: 'Serveurs' }">
      <template #nav>
        <span class="srv-meta">
          <UiBadge :tone="STATUS[server.status].tone" dot>{{ STATUS[server.status].label }}</UiBadge>
          <span class="mono small">{{ server.url }}</span>
          <span v-if="server.description" class="muted small desc-inline" :title="server.description">· {{ server.description }}</span>
        </span>
      </template>
      <div class="actions">
        <UiTechSupportButton :href="`/api/servers/${id}/tech-support`" title="Rapport texte du serveur : accès, moteur Docker, disque, Runner, chemins, Traefik, plan d'adressage, Watchtower, projets, conteneurs, audit (aucun secret)" />
        <UiButton size="sm" :loading="busy === 'check'" title="Tester la connexion maintenant" @click="check">Tester</UiButton>
        <UiButton size="sm" :loading="busy === 'discover'" title="Relancer la découverte (endpoints, réseaux, volumes)" @click="discover">Redécouvrir</UiButton>
      </div>
    </UiPageHeader>

    <!-- Onglets ; à droite, l'endpoint des onglets qui en dépendent (seulement s'il y a le choix). -->
    <div class="tabs-row">
      <UiTabs v-model="tab" :tabs="tabs" />
      <label v-if="endpointScoped && usableEndpoints.length > 1" class="ep-picker">
        <span class="muted small">Endpoint</span>
        <select id="ep-select" v-model="endpointId" class="input">
          <option v-for="ep in usableEndpoints" :key="ep.id" :value="ep.id">{{ ep.name }}{{ ep.enabled ? '' : ' (désactivé)' }}</option>
        </select>
      </label>
    </div>

    <!-- Vue d'ensemble -->
    <div v-if="tab === 'overview'" class="grid-2">
      <section class="card pad">
        <div class="section-head">
          <h2>Connexion</h2>
          <UiButton size="sm" @click="openEdit">Modifier</UiButton>
        </div>
        <dl class="kv">
          <template v-if="server.ssh">
            <dt>Mode</dt><dd>SSH <span class="muted small">(sans agent ni Runner)</span></dd>
            <dt>Connexion</dt><dd class="mono">{{ server.url }}</dd>
            <dt>Identifiants</dt><dd>{{ server.ssh.auth === 'password' ? 'mot de passe' : 'clé privée' }} •••• chiffré <UiButton size="sm" variant="ghost" @click="sshCredOpen = true; sshCredError = null; sshCred.auth = server.ssh.auth ?? 'key'">Remplacer</UiButton></dd>
            <dt>Clé d'hôte</dt>
            <dd>
              <span class="mono small">{{ server.ssh.hostKey ?? 'non confirmée' }}</span>
              <UiButton size="sm" variant="ghost" :loading="busy === 'hostkey'" @click="checkHostKey">Vérifier</UiButton>
              <div v-if="hostKeyCheck" class="small" :class="hostKeyCheck.matches ? 'ok-text' : 'warn-text'">
                <template v-if="hostKeyCheck.matches">L'hôte présente la clé confirmée.</template>
                <template v-else>L'hôte présente une autre clé : <span class="mono">{{ hostKeyCheck.fingerprint }}</span>. <UiButton size="sm" variant="ghost" @click="confirmHostKey(hostKeyCheck.fingerprint)">Confirmer cette clé…</UiButton></template>
              </div>
            </dd>
            <dt>Socket Docker</dt><dd class="mono">{{ server.ssh.dockerSocket }}</dd>
          </template>
          <template v-else>
            <dt>URL</dt><dd class="mono">{{ server.url }}</dd>
            <dt>TLS</dt><dd>{{ server.tlsVerify ? (server.caCertPem ? 'vérifié (AC interne)' : 'vérifié') : 'non vérifié' }} <UiBadge v-if="!server.tlsVerify" tone="warning">risque</UiBadge></dd>
            <dt>AGENT_SECRET</dt><dd>•••••• chiffré <UiButton size="sm" variant="ghost" @click="tokenOpen = true; tokenError = null">Renouveler</UiButton></dd>
          </template>
          <dt>Version</dt><dd>{{ server.detectedVersion ?? '—' }}</dd>
          <dt>Dernier contrôle</dt><dd>{{ fmt(server.lastCheckedAt) }}</dd>
          <dt>Dernière découverte</dt><dd>{{ fmt(server.lastDiscoveryAt) }}</dd>
          <dt>Étiquettes</dt><dd><UiBadge v-for="t in server.tags" :key="t">{{ t }}</UiBadge><span v-if="!server.tags.length">—</span></dd>
        </dl>
        <p v-if="server.lastError" class="alert alert--danger">{{ server.lastError }}</p>
      </section>

      <section class="card pad">
        <h2>Capacités détectées</h2>
        <ul class="caps">
          <li v-for="(v, k) in server.capabilities" :key="k" :class="v ? 'on' : 'off'">{{ v ? '✓' : '—' }} {{ k }}</li>
        </ul>
      </section>

      <section class="card pad danger-zone">
        <div class="dz-head">
          <h2>Zone sensible</h2>
          <UiButton size="sm" variant="danger" :loading="busy === 'delete'" @click="remove">Supprimer le serveur</UiButton>
        </div>
        <p class="muted small">Retire le serveur de la plateforme ; refusé tant que des projets y sont déployés.</p>
      </section>
    </div>

    <!-- Endpoints -->
    <div v-else-if="tab === 'endpoints'" class="card pad-s">
      <UiListFilter v-model:q="epFilter.q.value" v-model:status="epFilter.status.value" :statuses="EP_STATUS" :count="epFilter.filtered.value.length" :total="epFilter.total.value" :active="epFilter.active.value" placeholder="Filtrer les endpoints…" @reset="epFilter.reset" />
      <table class="table">
        <thead><tr><th>Endpoint</th><th>Statut</th><th>Inventaire</th><th>Environnements</th><th>Déploiements</th></tr></thead>
        <tbody>
          <tr v-if="!epFilter.filtered.value.length"><td colspan="5" class="muted">Aucun endpoint ne correspond au filtre</td></tr>
          <tr v-for="ep in epFilter.filtered.value" :key="ep.id" :class="{ missing: ep.missing }" :aria-busy="busy === `ep:${ep.id}` || undefined">
            <td>
              <strong>{{ ep.name }}</strong> <span class="muted small">#{{ ep.portainerEndpointId }}</span>
              <span class="muted small mono ep-type" :title="ep.url ?? undefined">{{ ep.type }}</span>
            </td>
            <td>
              <UiBadge v-if="ep.missing" tone="danger">absent de l'agent</UiBadge>
              <UiBadge v-else :tone="ep.online ? 'success' : 'danger'">{{ ep.online ? 'en ligne' : 'hors ligne' }}</UiBadge>
            </td>
            <td class="small">
              {{ ep.inventory.running }}/{{ ep.inventory.containers }} conteneurs · {{ ep.inventory.stacks }} stacks · {{ ep.networkCount }} réseaux · {{ ep.volumeCount }} volumes
              <span v-if="ep.inventory.traefik" class="muted">· Traefik {{ ep.inventory.traefik.image }}</span>
            </td>
            <td>
              <div class="envs">
                <label v-for="e in environments" :key="e.key" class="env">
                  <input type="checkbox" :checked="ep.environments.some(x => x.key === e.key)" :disabled="!ep.enabled || ep.missing" @change="toggleEndpointEnv(ep.id, e.key)">
                  {{ e.name }}
                </label>
              </div>
            </td>
            <td>
              <UiSwitch :model-value="ep.enabled" :disabled="ep.missing || ep.type !== 'docker_standalone'" :label="ep.enabled ? 'Activé' : 'Désactivé'" @update:model-value="v => toggleEndpoint(ep.id, v)" />
              <div v-if="ep.type !== 'docker_standalone'" class="muted small">Type non supporté</div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Conteneurs en direct (tous les endpoints activés de ce serveur) -->
    <div v-else-if="tab === 'live'">
      <p v-if="!usableEndpoints.some(e => e.enabled)" class="muted">Aucun endpoint activé sur ce serveur.</p>
      <div v-for="ep in usableEndpoints.filter(e => e.enabled)" :key="ep.id" class="live-ep">
        <LiveContainers :endpoint-id="ep.id" />
      </div>
    </div>

    <!-- Onglets par endpoint -->
    <template v-else>
      <p v-if="!endpoint" class="muted">Aucun endpoint disponible.</p>

      <section v-else-if="tab === 'watchtower'" class="card pad">
        <h2>Profils Watchtower</h2>
        <WatchtowerProfiles :key="endpoint.id" :endpoint-id="endpoint.id" :can-manage="can('server:manage', { serverId: id })" />
      </section>
      <div v-else-if="tab === 'networks'" class="stack">
        <section class="card pad">
          <h2>Réseaux</h2>
          <NetworkPolicyTable :rows="networkRows" :environments="endpoint.environments" :busy="busy?.startsWith('net:') ? busy.slice(4) : null" @change="changeNetwork" />
        </section>
        <section class="card pad">
          <h2>Plan d'adressage</h2>
          <AddressPlan :key="`plan-${endpoint.id}-${poolVersion}`" :endpoint-id="endpoint.id" :can-manage="can('network:manage', { serverId: id })" />
        </section>
        <section class="card pad">
          <h2>Plage des sous-réseaux</h2>
          <NetworkPoolEditor :key="endpoint.id" :endpoint-id="endpoint.id" :can-manage="can('network:manage', { serverId: id })" @saved="poolVersion++" />
        </section>
        <section class="card pad">
          <h2>Volumes bind autorisés</h2>
          <VolumeRulesEditor :endpoint-id="endpoint.id" :environments="endpoint.environments" :runtime-roots="Object.values(config?.paths ?? {}).map(p => p.runtimeRoot)" />
        </section>
        <section class="card pad">
          <h2>Volumes Docker</h2>
          <UiListFilter v-model:q="volFilter.q.value" v-model:status="volFilter.status.value" :statuses="{ present: 'Présent', missing: 'Disparu' }" :count="volFilter.filtered.value.length" :total="volFilter.total.value" :active="volFilter.active.value" placeholder="Filtrer les volumes…" @reset="volFilter.reset" />
          <table class="table">
            <thead><tr><th>Nom</th><th>Driver</th><th>Point de montage</th></tr></thead>
            <tbody>
              <tr v-if="!volFilter.filtered.value.length"><td colspan="3" class="muted">{{ volumes.length ? 'Aucun volume ne correspond au filtre' : 'Aucun volume' }}</td></tr>
              <tr v-for="v in volFilter.filtered.value.slice(0, volAll || volFilter.active.value ? undefined : VOL_PREVIEW)" :key="v.id" :class="{ missing: v.missing }">
                <td class="mono wrap">{{ v.name }} <UiBadge v-if="v.missing" tone="danger">disparu</UiBadge></td>
                <td>{{ v.driver }}</td>
                <td v-if="v.mountpoint === `/var/lib/docker/volumes/${v.name}/_data`" class="muted small" :title="v.mountpoint">emplacement par défaut</td>
                <td v-else class="mono small wrap">{{ v.mountpoint }}</td>
              </tr>
            </tbody>
          </table>
          <UiButton v-if="!volAll && !volFilter.active.value && volFilter.filtered.value.length > VOL_PREVIEW" size="sm" variant="ghost" class="more" @click="volAll = true">Afficher les {{ volFilter.filtered.value.length - VOL_PREVIEW }} autres volumes</UiButton>
        </section>
      </div>

      <div v-else-if="tab === 'paths'" class="stack">
        <p v-if="!endpoint.environments.length" class="muted">Associer d'abord des environnements à cet endpoint (onglet Endpoints).</p>
        <section v-for="env in endpoint.environments" :key="env.key" class="card pad">
          <div class="section-head">
            <h2>{{ env.name }} <UiBadge v-if="env.isProduction" tone="danger">prod</UiBadge></h2>
            <span v-if="!config?.paths[env.key]" class="muted small">non configuré</span>
            <span v-else class="muted small">modifié le {{ fmt(config.paths[env.key]!.updatedAt ?? null) }}</span>
          </div>
          <PathConfigForm v-if="pathDrafts[env.key]" v-model="pathDrafts[env.key]!" :errors="pathErrors[env.key]" />
          <div class="save">
            <UiButton variant="primary" :disabled="!pathDirty(env.key)" :loading="busy === `paths:${env.key}`" @click="savePaths(env.key)">Enregistrer</UiButton>
          </div>
        </section>
      </div>

      <section v-else-if="tab === 'ports'" class="card pad">
        <h2>Règles de ports</h2>
        <PortRulesEditor v-model="portDraft" :environments="endpoint.environments" :errors="portErrors" />
        <div class="save">
          <UiButton :disabled="!isDirty(portDraft, config?.portRules)" @click="resetPorts">Annuler</UiButton>
          <UiButton variant="primary" :disabled="!isDirty(portDraft, config?.portRules)" :loading="busy === 'ports'" @click="savePorts">Enregistrer</UiButton>
        </div>
      </section>

      <CleanupPanel v-else-if="tab === 'cleanup'" :key="endpoint.id" :endpoint-id="endpoint.id" :endpoint-name="endpoint.name" />
      <RunnerPanel v-else-if="tab === 'runner'" :endpoint-id="endpoint.id" :endpoint-name="endpoint.name" :has-paths="Object.keys(config?.paths ?? {}).length > 0" />

      <ProxyPanel v-else-if="tab === 'proxy'" :key="`proxy-${endpoint.id}`" :endpoint-id="endpoint.id" :can-configure="can('server:manage', { serverId: id })" @use-suggestion="useSuggestion" />
      <AdoptionPanel v-else-if="tab === 'adopt'" :key="`adopt-${endpoint.id}-${route.query.stack ?? ''}`" :endpoint-id="endpoint.id" :endpoint-name="endpoint.name" :environments="endpoint.environments" :can-adopt="can('server:manage', { serverId: id }) && hasAny('project:create')" :initial-stack="typeof route.query.stack === 'string' ? route.query.stack : undefined" :server-id="id" />

      <div v-else-if="tab === 'traefik'" class="stack">
      <ManagedProxyPanel :key="`mp-${endpoint.id}`" :proxy-provider="traefikDraft?.provider ?? config?.traefik?.provider ?? null" :endpoint-id="endpoint.id" :endpoint-name="endpoint.name" :can-manage="can('server:manage', { serverId: id })" :networks="networks.filter(n => !n.missing).map(n => n.name)" @applied="reloadEndpointData()" />
      <section class="card pad">
        <div class="section-head">
          <div class="title-line">
            <h2>Reverse proxy des projets et domaines</h2>
            <UiBadge v-if="config?.traefik && traefikDraft && isDirty(traefikDraft, config.traefik)" tone="warning" dot>Modifications non enregistrées</UiBadge>
            <UiBadge v-else-if="config?.traefik" tone="success" dot>{{ PROXY_PROVIDER_LABEL[config.traefik.provider] }}{{ config.traefik.provider !== 'traefik' && config.traefik.nginxContainer ? ` (${config.traefik.nginxContainer})` : '' }} · {{ config.traefik.networkName }}</UiBadge>
            <UiBadge v-else-if="traefikDraft" tone="warning" dot>Non enregistré</UiBadge>
            <UiBadge v-else tone="neutral" dot>Non configuré</UiBadge>
          </div>
          <UiButton size="sm" :loading="busy === 'suggest'" @click="useSuggestion()"><Wand2 :size="14" /> Détecter le reverse proxy</UiButton>
        </div>
        <p v-if="endpoint.inventory.traefik" class="muted small">Détecté : {{ endpoint.inventory.traefik.container }} ({{ endpoint.inventory.traefik.image }}). <a href="#" @click.prevent="tab = 'proxy'">Voir sa configuration et ses routes</a></p>
        <div v-if="suggestion" class="suggest">
          <strong v-if="suggestion.config" class="small">Valeurs reprises de l'existant</strong>
          <dl>
            <template v-for="(note, k) in suggestion.notes" :key="k"><dt>{{ SUGGESTION_FIELDS[k] ?? k }}</dt><dd>{{ note }}</dd></template>
          </dl>
          <p v-for="(w, i) in suggestion.warnings" :key="i" class="warn small">{{ w }}</p>
          <template v-if="suggestion.candidates?.length">
            <strong class="small">Conteneurs détectés</strong>
            <ul class="candidates">
              <li v-for="c in suggestion.candidates" :key="c.container" :class="{ selected: c.selected }">
                <span class="mono">{{ c.container }}</span>
                <span class="muted small">{{ c.image }}</span>
                <UiBadge v-if="c.provider" tone="info">{{ PROXY_PROVIDER_LABEL[c.provider] }}</UiBadge>
                <UiBadge v-else tone="neutral">{{ c.kind ?? 'inconnu' }}</UiBadge>
                <span v-if="c.ports.length" class="mono small">{{ c.ports.join(', ') }}</span>
                <span class="muted small">{{ c.reason }}</span>
                <UiBadge v-if="c.selected" tone="success">retenu</UiBadge>
                <UiButton v-else-if="c.provider" size="sm" variant="ghost" :loading="busy === 'suggest'" @click="useSuggestion(c.container)">Utiliser</UiButton>
              </li>
            </ul>
          </template>
        </div>
        <template v-if="traefikDraft">
          <TraefikForm v-model="traefikDraft" :networks="allowedNetworks" :detected-networks="endpoint.inventory.traefik?.networks" :errors="traefikErrors" />
          <div class="save">
            <UiButton variant="primary" :disabled="!isDirty(traefikDraft, config?.traefik)" :loading="busy === 'traefik'" @click="saveTraefik">Enregistrer</UiButton>
          </div>
        </template>
        <div v-else class="empty">
          <p class="muted">Aucun reverse proxy (Traefik, nginx-proxy ou nginx) n'est configuré pour cet endpoint : les projets ne peuvent pas être exposés par domaine.</p>
          <div class="actions">
            <UiButton variant="primary" :loading="busy === 'suggest'" @click="useSuggestion()"><Wand2 :size="14" /> Détecter et configurer</UiButton>
            <UiButton variant="ghost" @click="startTraefik">Configurer manuellement</UiButton>
          </div>
        </div>
      </section>
      <section v-if="nginxCerts" class="card pad">
        <div class="section-head">
          <h2>Certificats nginx</h2>
          <UiButton v-if="can('server:manage', { serverId: id })" size="sm" :loading="busy === 'nginx-certs'" @click="syncNginxCerts">Mettre en service maintenant</UiButton>
        </div>
        <ProxyCertificates
          :key="`ngx-certs-${endpoint.id}-${certsKey}`"
          :endpoint-id="endpoint.id"
          :can-manage="can('server:manage', { serverId: id })"
          :tracks-apply="false"
          :intro="config?.traefik?.provider === 'nginx'
            ? `Déposés dans ${config.traefik.nginxCertsDir} du conteneur ${config.traefik.nginxContainer} à chaque déploiement : certificat du nom exact, puis générique, puis par défaut.${config.traefik.nginxAcmeEmail ? ' Let\'s Encrypt pour les domaines sans certificat (renouvelé chaque nuit, 30 jours avant expiration).' : ''}`
            : `Déposés dans /etc/nginx/certs du conteneur ${config?.traefik?.nginxContainer} (<domaine>.crt, default.crt) avant le démarrage des services.`"
        />
        <p class="muted small">Certificats génériques et domaines internes : Let's Encrypt par DNS-01 avec un <NuxtLink to="/admin/dns">compte DNS</NuxtLink> couvrant la zone (Cloudflare, OVHcloud, Route 53).</p>
      </section>
      </div>
    </template>

    <!-- Modales -->
    <UiModal v-model:open="editOpen" title="Modifier le serveur" width="560px">
      <form class="stack" @submit.prevent="saveEdit">
        <UiField label="Nom" for="e-name" :error="editErrors.name" required>
          <input id="e-name" v-model="edit.name" class="input" maxlength="100">
        </UiField>
        <UiField label="Description" for="e-desc">
          <textarea id="e-desc" v-model="edit.description" class="input" rows="2" maxlength="1000" />
        </UiField>
        <UiField label="Étiquettes" for="e-tags">
          <UiTagInput id="e-tags" v-model="edit.tags" :max="20" />
        </UiField>
        <template v-if="server.ssh">
          <div class="row-3">
            <UiField label="Hôte" for="e-ssh-host" :error="editErrors.sshHost ?? (isLoopbackHost(edit.sshHost) ? LOOPBACK_MESSAGE : null)" :hint="`Testé avec les identifiants actuels ; hôte de la console : ${CONSOLE_HOST}`">
              <input id="e-ssh-host" v-model.trim="edit.sshHost" class="input mono">
              <UiButton v-if="isLoopbackHost(edit.sshHost)" size="sm" variant="ghost" @click="edit.sshHost = CONSOLE_HOST">Utiliser {{ CONSOLE_HOST }}</UiButton>
            </UiField>
            <UiField label="Port" for="e-ssh-port"><input id="e-ssh-port" v-model.number="edit.sshPort" class="input mono" type="number" min="1" max="65535"></UiField>
            <UiField label="Utilisateur" for="e-ssh-user" :error="editErrors.sshUser"><input id="e-ssh-user" v-model.trim="edit.sshUser" class="input mono"></UiField>
          </div>
          <template v-if="edit.sshHost !== server.ssh.host || edit.sshPort !== server.ssh.port">
            <UiField label="Clé d'hôte du nouvel hôte" for="e-ssh-hk" :error="editErrors.sshHostKey">
              <div class="row-inline">
                <span id="e-ssh-hk" class="mono small">{{ editScan?.fingerprint ?? 'à lire' }}</span>
                <UiButton size="sm" @click="scanEditHostKey">Lire</UiButton>
                <UiButton v-if="editScan && edit.sshHostKey !== editScan.fingerprint" size="sm" variant="primary" @click="edit.sshHostKey = editScan.fingerprint">Je confirme</UiButton>
              </div>
            </UiField>
          </template>
          <UiField label="Socket Docker" for="e-ssh-sock" :error="editErrors.dockerSocket"><input id="e-ssh-sock" v-model.trim="edit.dockerSocket" class="input mono"></UiField>
        </template>
        <template v-else>
          <UiField label="Adresse de l'agent" for="e-url" :error="editErrors.url" hint="Un changement d'adresse ou de TLS est testé avec le secret actuel avant enregistrement">
            <input id="e-url" v-model.trim="edit.url" class="input mono" type="url">
          </UiField>
          <UiSwitch v-model="edit.tlsVerify" label="Vérifier le certificat TLS" />
          <UiField v-if="edit.tlsVerify" label="AC interne (PEM, optionnel)" for="e-ca">
            <textarea id="e-ca" v-model="edit.caCertPem" class="input mono" rows="4" />
          </UiField>
        </template>
      </form>
      <template #footer>
        <UiButton @click="editOpen = false">Annuler</UiButton>
        <UiButton variant="primary" :loading="busy === 'edit'" @click="saveEdit">Enregistrer</UiButton>
      </template>
    </UiModal>

    <UiModal v-model:open="sshCredOpen" title="Remplacer les identifiants SSH" width="520px">
      <form class="stack" autocomplete="off" @submit.prevent="rotateSshCredentials">
        <p class="muted">Les nouveaux identifiants sont testés avant d'être enregistrés ; les anciens sont alors définitivement détruits.</p>
        <div class="row-inline">
          <UiButton size="sm" :variant="sshCred.auth === 'key' ? 'primary' : 'secondary'" @click="sshCred.auth = 'key'">Clé privée</UiButton>
          <UiButton size="sm" :variant="sshCred.auth === 'password' ? 'primary' : 'secondary'" @click="sshCred.auth = 'password'">Mot de passe</UiButton>
        </div>
        <template v-if="sshCred.auth === 'key'">
          <UiField label="Nouvelle clé privée" for="c-key" :error="sshCredError" required>
            <textarea id="c-key" v-model="sshCred.privateKey" class="input mono secret-text" rows="4" spellcheck="false" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" />
          </UiField>
          <UiField label="Phrase de passe" for="c-pass"><input id="c-pass" v-model="sshCred.passphrase" class="input" type="password"></UiField>
        </template>
        <UiField v-else label="Nouveau mot de passe" for="c-pw" :error="sshCredError" required>
          <input id="c-pw" v-model="sshCred.password" class="input" type="password">
        </UiField>
      </form>
      <template #footer>
        <UiButton @click="closeSshCred">Annuler</UiButton>
        <UiButton variant="primary" :disabled="sshCred.auth === 'key' ? !sshCred.privateKey : !sshCred.password" :loading="busy === 'ssh-cred'" @click="rotateSshCredentials">Tester et remplacer</UiButton>
      </template>
    </UiModal>

    <UiModal v-model:open="tokenOpen" title="Remplacer AGENT_SECRET" width="480px">
      <form class="stack" @submit.prevent="rotateToken">
        <p class="muted">Le nouveau secret est testé avant d'être enregistré. L'ancien est alors définitivement détruit.</p>
        <UiField label="Nouveau AGENT_SECRET (déjà appliqué sur l'agent)" for="t-token" :error="tokenError" required>
          <input id="t-token" v-model="newToken" class="input mono" type="password" autocomplete="off">
        </UiField>
      </form>
      <template #footer>
        <UiButton @click="tokenOpen = false; newToken = ''">Annuler</UiButton>
        <UiButton variant="primary" :disabled="newToken.length < 10" :loading="busy === 'token'" @click="rotateToken">Tester et remplacer</UiButton>
      </template>
    </UiModal>
  </div>
</template>

<style scoped>
.back { font-size: 13px; }
.title { display: flex; align-items: center; gap: var(--space-3); }
.desc { margin: 4px 0 0; }
.actions { display: flex; gap: var(--space-2); flex-wrap: wrap; align-items: center; }
.actions .link { display: inline-flex; gap: 4px; align-items: center; color: var(--primary); text-decoration: none; }
.grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: var(--space-3); align-items: start; }
.pad { padding: var(--space-3) var(--space-4); display: flex; flex-direction: column; gap: var(--space-2); }
.pad h2 { font-size: 15px; }
.section-head { display: flex; justify-content: space-between; align-items: center; gap: var(--space-3); }
.kv { display: grid; grid-template-columns: 130px 1fr; gap: 2px var(--space-3); margin: 0; font-size: 13px; align-items: baseline; }
.srv-meta { display: inline-flex; gap: 8px; align-items: center; min-width: 0; }
.desc-inline { max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.more { align-self: flex-start; }
.wrap { overflow-wrap: anywhere; }
.ep-type { margin-left: 6px; }
.kv dt { color: var(--text-muted); }
.kv dd { margin: 0; display: flex; gap: 4px; align-items: center; flex-wrap: wrap; word-break: break-all; }
.caps { list-style: none; padding: 0; margin: 0; columns: 2; font-size: 13px; }
.caps .off { color: var(--text-muted); }
.plain { list-style: none; padding: 0; margin: 0; }
.mt { margin-top: var(--space-3); }
.danger-zone { border-color: color-mix(in srgb, var(--danger) 35%, var(--border)); }
.dz-head { display: flex; justify-content: space-between; align-items: center; gap: var(--space-2); }
.dz-head h2 { margin: 0; }
.danger-zone p { margin: var(--space-2) 0 0; }
.alert { padding: var(--space-3) var(--space-4); border-radius: var(--radius); margin: 0; }
.alert--danger { background: var(--danger-bg); color: var(--danger); }
.table { width: 100%; border-collapse: collapse; }
.table th { text-align: left; font-size: 11px; text-transform: uppercase; color: var(--text-muted); padding: 4px var(--space-3); border-bottom: 1px solid var(--border); background: var(--surface-2); }
.table td { padding: 4px var(--space-3); border-bottom: 1px solid var(--border); vertical-align: middle; }
.card > .table { border-radius: var(--radius-lg); overflow: hidden; }
tr.missing { opacity: .6; }
tr[aria-busy] { opacity: .6; }
.small { font-size: 12.5px; }
.envs { display: flex; flex-wrap: wrap; gap: 2px 12px; }
.env { display: inline-flex; gap: 6px; align-items: center; }
.tabs-row { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap; }
.ep-picker { display: flex; align-items: center; gap: var(--space-2); }
.ep-picker .input { width: auto; min-width: 200px; min-height: 32px; padding-top: 4px; padding-bottom: 4px; font-size: 13px; }
.stack { display: flex; flex-direction: column; gap: var(--space-3); }
.save { display: flex; justify-content: flex-end; gap: var(--space-2); }
.empty { display: flex; flex-direction: column; align-items: flex-start; gap: var(--space-3); }
@media (max-width: 860px) { .kv { grid-template-columns: 110px minmax(0, 1fr); } }
.pad-s { padding: var(--space-3) var(--space-4); }
.live-ep + .live-ep { margin-top: var(--space-5); }
.suggest { border: 1px solid color-mix(in srgb, var(--primary) 30%, var(--border)); background: var(--primary-soft); border-radius: var(--radius); padding: var(--space-3) var(--space-4); display: flex; flex-direction: column; gap: 6px; }
.suggest dl { display: grid; grid-template-columns: 150px 1fr; gap: 4px var(--space-3); margin: 0; font-size: 12.5px; }
.suggest dt { color: var(--text-muted); }
.suggest dd { margin: 0; }
.suggest .warn { color: var(--warning); margin: 0; }
.row-3 { display: grid; grid-template-columns: 2fr 90px 1fr; gap: var(--space-3); }
.row-inline { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.secret-text { -webkit-text-security: disc; font-size: 11.5px; }
.ok-text { color: var(--success); }
.warn-text { color: var(--warning); }
@media (max-width: 640px) { .row-3 { grid-template-columns: 1fr; } }
.candidates { list-style: none; padding: 0; margin: var(--space-1) 0 0; display: grid; gap: 4px; }
.candidates li { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; padding: 6px 8px; border: 1px solid var(--border); border-radius: var(--radius); }
.candidates li.selected { border-color: var(--success); }
.title-line { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.title-line h2 { margin: 0; }
</style>
