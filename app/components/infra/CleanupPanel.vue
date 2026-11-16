<script setup lang="ts">
/** Nettoyage Docker d'un endpoint : occupation, choix, candidats (protections visibles), résultat. */
import type { CleanupItem, CleanupPreview, CleanupResult } from '#shared/schemas/cleanup'
import { Box, Database, HardDrive, Layers, Network, ShieldCheck } from 'lucide-vue-next'

const props = defineProps<{ endpointId: string, endpointName: string }>()
const toast = useToast()
const confirm = useConfirm()

const { data: preview, refresh, status, error } = await useFetch<CleanupPreview>(() => `/api/endpoints/${props.endpointId}/cleanup`, { server: false })

const opts = reactive({
  containers: false, containersOld: false,
  images: false, imagesMode: 'dangling' as 'dangling' | 'unused',
  buildCache: false, buildCacheOld: true,
})
const volumes = ref<string[]>([])
const networks = ref<string[]>([])
const open = ref<string | null>(null)
// Rien n'est présélectionné : volumes et réseaux peuvent appartenir à d'autres projets de l'hôte.
watch(preview, () => {
  volumes.value = []
  networks.value = []
})

const free = (items: CleanupItem[]) => items.filter(i => !i.protectedBy)
const sum = (items: CleanupItem[]) => items.reduce((a, i) => a + (i.sizeBytes ?? 0), 0)
const imagesSel = computed(() => (preview.value ? (opts.imagesMode === 'dangling' ? preview.value.images.dangling : [...preview.value.images.dangling, ...preview.value.images.unused]) : []))
const estimate = computed(() => {
  const p = preview.value
  if (!p) return 0
  return (opts.images ? sum(free(imagesSel.value)) : 0)
    + (opts.containers ? p.usage.containers.reclaimableBytes : 0)
    + (opts.buildCache ? p.buildCache.reclaimableBytes : 0)
    + sum(p.volumes.filter(v => volumes.value.includes(v.id)))
})
const chosen = computed(() => opts.containers || opts.images || opts.buildCache || volumes.value.length > 0 || networks.value.length > 0)

const running = ref(false)
const result = ref<CleanupResult | null>(null)
const LABEL = { containers: 'Conteneurs arrêtés', images: 'Images', volumes: 'Volumes', networks: 'Réseaux', buildCache: 'Cache de build' } as const

async function run() {
  const parts = [
    opts.containers && `${free(preview.value!.containers).length} conteneur(s) arrêté(s)`,
    opts.images && `images ${opts.imagesMode === 'dangling' ? 'sans tag' : 'inutilisées'}`,
    volumes.value.length && `${volumes.value.length} volume(s) et leurs données`,
    networks.value.length && `${networks.value.length} réseau(x)`,
    opts.buildCache && `cache de build${opts.buildCacheOld ? ' de plus de 24 h' : ''}`,
  ].filter(Boolean)
  const ok = await confirm({
    title: `Nettoyer ${props.endpointName}`,
    message: `Suppression définitive : ${parts.join(', ')}. Environ ${fmtBytesShort(estimate.value)} récupérés. Les ressources protégées sont conservées.`,
    confirmLabel: 'Nettoyer',
    danger: true,
    requireText: volumes.value.length ? props.endpointName : undefined,
  })
  if (!ok) return
  running.value = true
  result.value = null
  try {
    result.value = await $fetch<CleanupResult>(`/api/endpoints/${props.endpointId}/cleanup`, {
      method: 'POST',
      body: {
        ...(opts.containers ? { containers: { olderThan24h: opts.containersOld } } : {}),
        ...(opts.images ? { images: { mode: opts.imagesMode } } : {}),
        ...(volumes.value.length ? { volumes: { names: volumes.value } } : {}),
        ...(networks.value.length ? { networks: { ids: networks.value } } : {}),
        ...(opts.buildCache ? { buildCache: { olderThan24h: opts.buildCacheOld } } : {}),
      },
    })
    toast.success(`Nettoyage terminé : ${fmtBytesShort(result.value.reclaimedBytes)} récupérés`)
    Object.assign(opts, { containers: false, images: false, buildCache: false })
    await refresh()
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    running.value = false
  }
}
// Dans le gabarit, les refs sont déballées : on passe donc le nom de la liste.
function toggleAll(kind: 'volumes' | 'networks', items: CleanupItem[]) {
  const list = kind === 'volumes' ? volumes : networks
  const ids = free(items).map(i => i.id)
  list.value = list.value.length === ids.length ? [] : ids
}
</script>

<template>
  <div class="cleanup">
    <p v-if="error" class="alert">{{ apiError(error).message }}</p>
    <div v-else-if="!preview" class="muted">Lecture de l'occupation disque…</div>
    <template v-else-if="preview">
      <p v-if="preview.busy" class="alert warn">Nettoyage indisponible : {{ preview.busy }}.</p>

      <div class="usage">
        <div class="u card"><span class="ico"><Layers :size="17" /></span><span class="k">Images</span><strong>{{ fmtBytesShort(preview.usage.images.sizeBytes) }}</strong><small>{{ preview.usage.images.count }} · {{ fmtBytesShort(preview.usage.images.reclaimableBytes) }} récupérables</small></div>
        <div class="u card"><span class="ico"><Box :size="17" /></span><span class="k">Conteneurs</span><strong>{{ fmtBytesShort(preview.usage.containers.sizeBytes) }}</strong><small>{{ preview.usage.containers.count }} · {{ fmtBytesShort(preview.usage.containers.reclaimableBytes) }} récupérables</small></div>
        <div class="u card"><span class="ico"><Database :size="17" /></span><span class="k">Volumes</span><strong>{{ fmtBytesShort(preview.usage.volumes.sizeBytes) }}</strong><small>{{ preview.usage.volumes.count }} · {{ fmtBytesShort(preview.usage.volumes.reclaimableBytes) }} inutilisés</small></div>
        <div class="u card"><span class="ico"><HardDrive :size="17" /></span><span class="k">Cache de build</span><strong>{{ fmtBytesShort(preview.usage.buildCache.sizeBytes) }}</strong><small>{{ fmtBytesShort(preview.usage.buildCache.reclaimableBytes) }} récupérables</small></div>
      </div>

      <section class="card opt" :class="{ on: opts.containers }">
        <label class="head"><input v-model="opts.containers" type="checkbox"> <strong>Conteneurs arrêtés</strong>
          <span class="muted">{{ free(preview.containers).length }} à supprimer<template v-if="preview.containers.length - free(preview.containers).length"> · {{ preview.containers.length - free(preview.containers).length }} protégés</template></span>
          <button type="button" class="more" @click.prevent="open = open === 'containers' ? null : 'containers'">{{ open === 'containers' ? 'Masquer' : 'Détail' }}</button>
        </label>
        <label v-if="opts.containers" class="sub"><input v-model="opts.containersOld" type="checkbox"> Seulement ceux arrêtés depuis plus de 24 h</label>
        <ul v-if="open === 'containers'" class="items">
          <li v-for="c in preview.containers" :key="c.id" :class="{ prot: c.protectedBy }"><span class="mono">{{ c.name }}</span> <span class="muted">{{ c.detail }}</span> <span v-if="c.protectedBy" class="pb"><ShieldCheck :size="13" /> {{ c.protectedBy }}</span></li>
          <li v-if="!preview.containers.length" class="muted">Aucun conteneur arrêté.</li>
        </ul>
      </section>

      <section class="card opt" :class="{ on: opts.images }">
        <label class="head"><input v-model="opts.images" type="checkbox"> <strong>Images</strong>
          <span class="muted">{{ free(imagesSel).length }} à supprimer · {{ fmtBytesShort(sum(free(imagesSel))) }}</span>
          <button type="button" class="more" @click.prevent="open = open === 'images' ? null : 'images'">{{ open === 'images' ? 'Masquer' : 'Détail' }}</button>
        </label>
        <div v-if="opts.images" class="sub radios">
          <label><input v-model="opts.imagesMode" type="radio" value="dangling"> Sans tag uniquement ({{ free(preview.images.dangling).length }})</label>
          <label><input v-model="opts.imagesMode" type="radio" value="unused"> Toutes les images inutilisées ({{ free(preview.images.dangling).length + free(preview.images.unused).length }})</label>
        </div>
        <ul v-if="open === 'images'" class="items">
          <li v-for="i in imagesSel" :key="i.id" :class="{ prot: i.protectedBy }"><span class="mono">{{ i.name }}</span> <span class="muted">{{ fmtBytesShort(i.sizeBytes) }}</span> <span v-if="i.protectedBy" class="pb"><ShieldCheck :size="13" /> {{ i.protectedBy }}</span></li>
          <li v-if="!imagesSel.length" class="muted">Aucune image inutilisée.</li>
        </ul>
      </section>

      <section class="card opt" :class="{ on: volumes.length }">
        <div class="head"><Database :size="16" class="hi" /> <strong>Volumes inutilisés</strong>
          <span class="muted">{{ volumes.length }} / {{ free(preview.volumes).length }} sélectionnés · {{ fmtBytesShort(sum(preview.volumes.filter(v => volumes.includes(v.id)))) }}</span>
          <button v-if="free(preview.volumes).length" type="button" class="more" @click="toggleAll('volumes', preview.volumes)">{{ volumes.length === free(preview.volumes).length ? 'Tout désélectionner' : 'Tout sélectionner' }}</button>
        </div>
        <p class="warn-text small">Supprime les données des volumes. Aucun volume n'est sélectionné par défaut.</p>
        <ul class="items">
          <li v-for="v in preview.volumes" :key="v.id" :class="{ prot: v.protectedBy }">
            <label><input v-model="volumes" type="checkbox" :value="v.id" :disabled="!!v.protectedBy"> <span class="mono">{{ v.name.length > 40 ? `${v.name.slice(0, 12)}…` : v.name }}</span></label>
            <span class="muted">{{ v.detail }} · {{ fmtBytesShort(v.sizeBytes) }}</span>
            <span v-if="v.protectedBy" class="pb"><ShieldCheck :size="13" /> {{ v.protectedBy }}</span>
          </li>
          <li v-if="!preview.volumes.length" class="muted">Aucun volume inutilisé.</li>
        </ul>
      </section>

      <section class="card opt" :class="{ on: networks.length }">
        <div class="head"><Network :size="16" class="hi" /> <strong>Réseaux inutilisés</strong>
          <span class="muted">{{ networks.length }} / {{ free(preview.networks).length }} sélectionnés</span>
          <button v-if="free(preview.networks).length" type="button" class="more" @click="toggleAll('networks', preview.networks)">{{ networks.length === free(preview.networks).length ? 'Tout désélectionner' : 'Tout sélectionner' }}</button>
        </div>
        <ul class="items">
          <li v-for="n in preview.networks" :key="n.id" :class="{ prot: n.protectedBy }">
            <label><input v-model="networks" type="checkbox" :value="n.id" :disabled="!!n.protectedBy"> <span class="mono">{{ n.name }}</span></label>
            <span class="muted">{{ n.detail }}</span>
            <span v-if="n.protectedBy" class="pb"><ShieldCheck :size="13" /> {{ n.protectedBy }}</span>
          </li>
          <li v-if="!preview.networks.length" class="muted">Aucun réseau inutilisé.</li>
        </ul>
      </section>

      <section class="card opt" :class="{ on: opts.buildCache }">
        <label class="head"><input v-model="opts.buildCache" type="checkbox"> <strong>Cache de build</strong>
          <span class="muted">{{ preview.buildCache.count }} entrées · {{ fmtBytesShort(preview.buildCache.reclaimableBytes) }} récupérables</span>
        </label>
        <label v-if="opts.buildCache" class="sub"><input v-model="opts.buildCacheOld" type="checkbox"> Seulement les entrées de plus de 24 h (les builds récents restent rapides)</label>
      </section>

      <div class="bar card">
        <span>Estimation : <strong>{{ fmtBytesShort(estimate) }}</strong></span>
        <span class="spacer" />
        <UiButton variant="ghost" :loading="status === 'pending'" @click="refresh()">Actualiser</UiButton>
        <UiButton variant="danger" :loading="running" :disabled="!chosen || !!preview.busy" @click="run">Nettoyer</UiButton>
      </div>

      <section v-if="result" class="card result">
        <strong>{{ fmtBytesShort(result.reclaimedBytes) }} récupérés</strong>
        <ul>
          <li v-for="s in result.steps" :key="s.action">
            {{ LABEL[s.action] }} : {{ s.deleted }} supprimé{{ s.deleted > 1 ? 's' : '' }}<template v-if="s.reclaimedBytes"> · {{ fmtBytesShort(s.reclaimedBytes) }}</template>
            <div v-for="(e, i) in s.errors" :key="i" class="err small">{{ e }}</div>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>

<style scoped>
.cleanup { display: flex; flex-direction: column; gap: var(--space-2); }
.alert { margin: 0; padding: var(--space-3) var(--space-4); border-radius: var(--radius); background: var(--danger-bg); color: var(--danger); }
.alert.warn { background: var(--warning-bg); color: var(--warning); }
.usage { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: var(--space-2); }
.u { padding: var(--space-2) var(--space-3); display: grid; grid-template-columns: auto auto 1fr; grid-template-rows: auto auto; column-gap: var(--space-2); align-items: baseline; }
.u .ico { grid-row: 1 / 3; align-self: center; }
.u small { grid-column: 2 / 4; }
.u .ico { width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center; background: var(--primary-soft); color: var(--primary); }
.u .k { font-size: 12px; color: var(--text-muted); }
.u strong { font-size: 16px; justify-self: end; font-variant-numeric: tabular-nums; }
.u small { color: var(--text-muted); font-size: 12px; }
.opt { padding: var(--space-2) var(--space-4); display: flex; flex-direction: column; gap: var(--space-2); transition: border-color .12s; }
.opt.on { border-color: color-mix(in srgb, var(--danger) 45%, var(--border)); }
.head { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; cursor: pointer; }
.head .muted { font-size: 13px; }
.hi { color: var(--text-muted); }
.more { all: unset; margin-left: auto; cursor: pointer; color: var(--primary); font-size: 12.5px; }
.more:focus-visible { outline: 2px solid var(--focus); }
.sub { display: flex; gap: var(--space-2); align-items: center; font-size: 13px; padding-left: 24px; }
.radios { flex-direction: column; align-items: flex-start; }
.radios label { display: flex; gap: var(--space-2); align-items: center; }
.items { list-style: none; margin: 0; padding: 0 0 0 24px; display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; max-height: 280px; overflow: auto; }
.items li { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.items li label { display: flex; gap: var(--space-2); align-items: center; }
.items li.prot { opacity: .75; }
.pb { display: inline-flex; gap: 4px; align-items: center; color: var(--success); font-size: 12px; }
.warn-text { margin: 0; padding-left: 24px; color: var(--warning); }
.small { font-size: 12.5px; }
.bar { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-3) var(--space-4); position: sticky; bottom: var(--space-3); }
.spacer { flex: 1; }
.result { padding: var(--space-4); }
.result ul { margin: var(--space-2) 0 0; padding-left: var(--space-5); font-size: 13px; }
.err { color: var(--danger); }
</style>
