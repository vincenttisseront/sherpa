<script setup lang="ts">
/**
 * « Passer derrière le Traefik géré » : conteneurs d'une stack hors plateforme
 * choisis un par un (domaine, port, HTTPS). La plateforme les rattache au réseau
 * du proxy et ajoute leurs routes, effectives à l'application du Traefik géré.
 * Une stack de la plateforme passe par l'exposition web de son projet.
 */
import { ArrowRightLeft, ExternalLink, Trash2, TriangleAlert } from 'lucide-vue-next'
import type { MapContainer } from '#shared/schemas/proxy-map'
import type { ProxyRouteDto } from '#shared/schemas/proxy-routes'
import type { ManagedProxyDto } from '#shared/schemas/managed-proxy'

const props = defineProps<{ endpointId: string, serverId: string, containers: MapContainer[] }>()
const emit = defineEmits<{ changed: [] }>()
const { can } = useAuth()
const toast = useToast()
const confirm = useConfirm()
const canManage = computed(() => can('domain:manage', { serverId: props.serverId }))

const { data: managed, refresh: refreshManaged } = await useFetch<ManagedProxyDto>(() => `/api/endpoints/${props.endpointId}/managed-proxy`, { server: false })
const { data: routes, refresh: refreshRoutes } = await useFetch<ProxyRouteDto[]>(() => `/api/endpoints/${props.endpointId}/proxy-routes`, { server: false })

const platformContainers = computed(() => props.containers.filter(c => c.managed))
const external = computed(() => props.containers.filter(c => !c.managed))
const routesHere = computed(() => (routes.value ?? []).filter(r => props.containers.some(c => c.name === r.containerName || (c.stack && c.stack === r.stack && c.service === r.service))))

const portsOf = (c: MapContainer) => [...new Set([...c.ports, ...c.hostPorts.filter(h => h.protocol === 'tcp').map(h => h.container)])].sort((a, b) => a - b)
const containerOf = (id: string) => props.containers.find(c => c.id === id)!

interface Row { id: string, pick: boolean, port: number | null, host: string, pathPrefix: string, https: boolean }
const rows = ref<Row[]>([])
watch(() => props.containers.map(c => c.id).join(), () => {
  rows.value = external.value.map((c) => {
    const ports = portsOf(c)
    return { id: c.id, pick: false, port: ports[0] ?? null, host: `${(c.service ?? c.name).toLowerCase().replace(/[^a-z0-9-]/g, '-')}.localhost`, pathPrefix: '', https: true }
  })
}, { immediate: true })
const picked = computed(() => rows.value.filter(r => r.pick))
/** Conteneur déjà servi par une route du Traefik géré. */
const routed = (c: MapContainer) => routesHere.value.some(r => r.containerName === c.name || (!!c.stack && r.stack === c.stack && r.service === c.service))

const busy = ref<string | null>(null)
const error = ref<string | null>(null)
async function submit() {
  error.value = null
  busy.value = 'save'
  try {
    await $fetch(`/api/endpoints/${props.endpointId}/proxy-routes`, {
      method: 'POST',
      body: { routes: picked.value.map(r => ({ containerId: r.id, host: r.host, pathPrefix: r.pathPrefix.trim() || null, port: r.port!, https: r.https })) },
    })
    toast.success(`${picked.value.length} conteneur${picked.value.length > 1 ? 's' : ''} rattaché${picked.value.length > 1 ? 's' : ''} au réseau du proxy ; routes à appliquer au Traefik géré`)
    rows.value.forEach((r) => { r.pick = false })
    await Promise.all([refreshRoutes(), refreshManaged()])
    emit('changed')
  }
  catch (err) {
    error.value = apiError(err).message
  }
  finally {
    busy.value = null
  }
}

async function apply() {
  if (!await confirm({ title: 'Appliquer au Traefik géré', message: 'Traefik est redéployé avec ses routes : les connexions en cours vers les applications qu\'il sert sont coupées quelques secondes.', confirmLabel: 'Appliquer' })) return
  busy.value = 'apply'
  try {
    await $fetch(`/api/endpoints/${props.endpointId}/managed-proxy/apply`, { method: 'POST' })
    toast.success('Traefik géré mis à jour : routes en service')
    await Promise.all([refreshRoutes(), refreshManaged()])
    emit('changed')
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    busy.value = null
  }
}

async function reattach() {
  busy.value = 'reattach'
  try {
    const r = await $fetch<{ reattached: string[] }>(`/api/endpoints/${props.endpointId}/proxy-routes/reattach`, { method: 'POST' })
    toast.success(r.reattached.length ? `Rattaché(s) : ${r.reattached.join(', ')}` : 'Déjà rattachés')
    await refreshRoutes()
    emit('changed')
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    busy.value = null
  }
}

async function remove(r: ProxyRouteDto) {
  if (!await confirm({ title: 'Retirer la route', message: `${r.host}${r.pathPrefix ?? ''} → ${r.containerName}:${r.port}. Le conteneur est détaché du réseau du proxy si c'est la plateforme qui l'y avait rattaché. Effectif à la prochaine application du Traefik géré.`, confirmLabel: 'Retirer', danger: true })) return
  try {
    await $fetch(`/api/endpoints/${props.endpointId}/proxy-routes/${r.id}`, { method: 'DELETE' })
    await Promise.all([refreshRoutes(), refreshManaged()])
    emit('changed')
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
}
const url = (r: { host: string, pathPrefix: string | null, https: boolean }) => `${r.https ? 'https' : 'http'}://${r.host}${managed.value?.config ? `:${r.https ? managed.value.config.httpsPort : managed.value.config.httpPort}`.replace(/:(443|80)$/, '') : ''}${r.pathPrefix ?? ''}`
</script>

<template>
  <section class="route-form">
    <h4><ArrowRightLeft :size="14" /> Passer derrière le Traefik géré</h4>

    <p v-if="platformContainers.length && !external.length" class="muted small">
      Stack de la plateforme : l'exposition se règle dans le projet<template v-if="platformContainers[0]?.project"> (<NuxtLink :to="`/projects/${platformContainers[0].project.id}?tab=exposure`">Exposition web de {{ platformContainers[0].project.name }}</NuxtLink>)</template>, appliquée au prochain déploiement.
    </p>
    <template v-else>
      <p v-if="managed && !managed.config" class="alert alert--info small">
        Aucun Traefik géré sur cet hôte. <NuxtLink :to="`/servers/${serverId}?tab=proxy&endpoint=${endpointId}`">Le créer</NuxtLink> (ports, réseau, certificats), puis revenir ici.
      </p>
      <template v-else-if="managed?.config">
        <p class="muted small">Cocher les conteneurs à servir par le Traefik géré (réseau <code>{{ managed.config.networks[0] }}</code>). Les autres ne sont pas touchés.</p>
        <table class="tbl small">
          <colgroup><col class="c-pick"><col class="c-name"><col class="c-port"><col class="c-host"><col class="c-path"><col class="c-https"></colgroup>
          <thead><tr><th /><th>Conteneur</th><th>Port</th><th>Domaine</th><th>Chemin</th><th>HTTPS</th></tr></thead>
          <tbody>
            <tr v-for="r in rows" :key="r.id" :class="{ off: !r.pick }">
              <td><input v-model="r.pick" type="checkbox" :disabled="!canManage || !portsOf(containerOf(r.id)).length || routed(containerOf(r.id))" :aria-label="`Basculer ${containerOf(r.id).service ?? containerOf(r.id).name}`"></td>
              <td>
                <strong>{{ containerOf(r.id).service ?? containerOf(r.id).name }}</strong>
                <UiBadge v-if="routed(containerOf(r.id))" tone="success">déjà routé</UiBadge>
                <div class="muted mono ellipsis" :title="containerOf(r.id).image">{{ containerOf(r.id).image }}</div>
              </td>
              <td>
                <select v-if="portsOf(containerOf(r.id)).length" v-model.number="r.port" class="input sm" :disabled="!r.pick" aria-label="Port du conteneur">
                  <option v-for="p in portsOf(containerOf(r.id))" :key="p" :value="p">{{ p }}</option>
                </select>
                <span v-else class="muted">aucun port</span>
              </td>
              <td><input v-model.trim="r.host" class="input sm mono" :disabled="!r.pick" aria-label="Domaine"></td>
              <td><input v-model.trim="r.pathPrefix" class="input sm mono path" :disabled="!r.pick" placeholder="/" aria-label="Préfixe de chemin"></td>
              <td><input v-model="r.https" type="checkbox" :disabled="!r.pick" aria-label="HTTPS"></td>
            </tr>
          </tbody>
        </table>
        <p v-if="error" class="error small" role="alert">{{ error }}</p>
        <UiButton v-if="canManage" size="sm" variant="primary" class="self-start" :disabled="!picked.length || picked.some(r => !r.port || !r.host)" :loading="busy === 'save'" @click="submit">{{ picked.length ? `Passer ${picked.length} conteneur${picked.length > 1 ? 's' : ''} derrière le proxy` : 'Cocher les conteneurs à basculer' }}</UiButton>
      </template>
    </template>

    <template v-if="routesHere.length">
      <h4>Routes vers ces conteneurs</h4>
      <ul class="plain">
        <li v-for="r in routesHere" :key="r.id" class="route">
          <a :href="url(r)" target="_blank" rel="noopener noreferrer" class="mono">{{ r.host }}{{ r.pathPrefix ?? '' }} <ExternalLink :size="11" /></a>
          <span class="muted small">→ {{ r.containerName }}:{{ r.port }}</span>
          <UiBadge :tone="r.applied ? 'success' : 'warning'">{{ r.applied ? 'en service' : 'à appliquer' }}</UiBadge>
          <UiBadge v-if="!r.containerFound" tone="danger">conteneur absent</UiBadge>
          <template v-else-if="!r.attached">
            <UiBadge tone="warning" title="Conteneur recréé par son Compose : rattaché automatiquement sous 30 s">hors réseau du proxy</UiBadge>
            <UiButton v-if="canManage" size="sm" variant="ghost" :loading="busy === 'reattach'" @click="reattach">Rattacher maintenant</UiButton>
          </template>
          <UiButton v-if="canManage" size="sm" variant="ghost" :aria-label="`Retirer ${r.host}`" @click="remove(r)"><Trash2 :size="13" /></UiButton>
          <div v-if="r.publishedPorts.length" class="warn small"><TriangleAlert :size="12" /> Encore publié en direct ({{ r.publishedPorts.join(', ') }}) : retirer ces ports du Compose d'origine pour ne passer que par le proxy.</div>
        </li>
      </ul>
      <UiButton v-if="canManage && managed?.pending" size="sm" variant="primary" class="self-start" :loading="busy === 'apply'" @click="apply">Appliquer au Traefik géré</UiButton>
    </template>
  </section>
</template>

<style scoped>
.route-form { display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-2); margin-bottom: var(--space-3); }
h4 { margin: 0; display: flex; gap: 6px; align-items: center; font-size: 13.5px; }
.small { font-size: 12.5px; }
p { margin: 0; }
.tbl { width: 100%; border-collapse: collapse; table-layout: fixed; }
.c-pick { width: 26px; } .c-port { width: 76px; } .c-host { width: 34%; } .c-path { width: 70px; } .c-https { width: 50px; }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tbl th { text-align: left; font-weight: 500; color: var(--text-muted); padding: 3px 6px 3px 0; }
.tbl td { padding: 4px 6px 4px 0; vertical-align: middle; }
.tbl tr.off td:not(:first-child) { opacity: .6; }
.input.sm { min-height: 28px; padding: 2px 8px; font-size: 12.5px; width: 100%; }
.plain { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.route { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.warn { flex-basis: 100%; color: var(--warning); display: flex; gap: 4px; align-items: center; }
.error { color: var(--danger); }
.self-start { align-self: flex-start; }
</style>
