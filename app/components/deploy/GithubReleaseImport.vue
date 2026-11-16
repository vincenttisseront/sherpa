<script setup lang="ts">
/**
 * Import d'une archive depuis les releases GitHub : URL du dépôt ou d'une
 * release (/releases, /releases/tag/…, /releases/download/…), choix de la
 * release puis de l'archive (fichier attaché .zip/.tar.gz/.tgz/.tar, ou code
 * source du tag). L'archive importée suit le circuit des archives déposées.
 */
import { FileArchive, KeyRound, Tag, TriangleAlert } from 'lucide-vue-next'
import type { StoredUpload } from '~/types/infra'

const props = defineProps<{ projectId: string, initialUrl?: string }>()
const emit = defineEmits<{ uploaded: [upload: StoredUpload] }>()
const toast = useToast()

interface ReleaseFile { key: string, kind: 'asset' | 'source', assetId: number | null, name: string, sizeBytes: number | null, format: 'zip' | 'tar.gz' | 'tar' | null, role: 'archive' | 'signature' | 'checksum' | 'other', importable: boolean, reason: string | null }
interface Release { tag: string, name: string | null, prerelease: boolean, publishedAt: string | null, htmlUrl: string, files: ReleaseFile[] }
interface Result { needsToken: boolean, message: string | null, apiUrl: string, repository: string, auth: 'token' | 'stored' | 'none', releases: Release[], selected: { tag: string | null, archiveKey: string | null } }

const url = ref(props.initialUrl ?? '')
const token = ref('')
const askToken = ref(false)
const result = ref<Result | null>(null)
const tag = ref('')
const archiveKey = ref('')
const loading = ref(false)
const importing = ref(false)
const urlError = ref<string | null>(null)

async function inspect() {
  loading.value = true
  urlError.value = null
  try {
    const r = await $fetch<Result>(`/api/projects/${props.projectId}/releases/inspect`, { method: 'POST', body: { url: url.value, token: token.value || null } })
    result.value = r
    if (r.needsToken) askToken.value = true
    tag.value = r.selected.tag ?? ''
    archiveKey.value = r.selected.archiveKey ?? ''
  }
  catch (err) {
    const e = apiError(err)
    urlError.value = e.errors.url ?? e.message
  }
  finally {
    loading.value = false
  }
}
onMounted(() => {
  if (url.value) void inspect()
})

const release = computed(() => result.value?.releases.find(r => r.tag === tag.value) ?? null)
// Changement de release : première archive attachée, sinon le code source.
watch(tag, () => {
  const r = release.value
  if (r && !r.files.some(a => a.key === archiveKey.value && a.importable)) archiveKey.value = r.files.find(a => a.kind === 'asset' && a.importable)?.key ?? 'source:tar.gz'
})

async function importArchive() {
  const r = result.value!
  importing.value = true
  try {
    const stored = await $fetch<StoredUpload>(`/api/projects/${props.projectId}/releases/import`, {
      method: 'POST',
      body: { apiUrl: r.apiUrl, repository: r.repository, tag: tag.value, archiveKey: archiveKey.value, token: token.value || null },
    })
    toast.success(`Archive importée : ${stored.originalName}`)
    emit('uploaded', stored)
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    importing.value = false
  }
}

const assets = computed(() => release.value?.files.filter(f => f.kind === 'asset') ?? [])
const sources = computed(() => release.value?.files.filter(f => f.kind === 'source') ?? [])
// Signatures et sommes de contrôle : repliées par défaut, elles n'aident pas au choix.
const showAux = ref(false)
const aux = (f: ReleaseFile) => f.role === 'signature' || f.role === 'checksum'
const visibleAssets = computed(() => assets.value.filter(f => showAux.value || !aux(f)))
const hiddenAux = computed(() => assets.value.filter(aux).length)

const fmtSize = (n: number | null) => (n === null ? '' : n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} Mo` : `${Math.max(1, Math.round(n / 1024))} Ko`)
</script>

<template>
  <div class="rel">
    <form class="row" @submit.prevent="inspect()">
      <input v-model.trim="url" class="input mono" placeholder="https://github.com/organisation/depot/releases" aria-label="URL du dépôt ou de la release GitHub" spellcheck="false">
      <UiButton type="submit" size="sm" variant="primary" :loading="loading" :disabled="url.length < 3">Lister les releases</UiButton>
    </form>
    <p v-if="urlError" class="err small">{{ urlError }}</p>
    <p v-else-if="!result" class="muted small">Dépôt, page des releases, d'une release (…/releases/tag/v1.2) ou lien d'un fichier attaché (…/releases/download/v1.2/app.tar.gz).</p>

    <div v-if="askToken" class="card step">
      <div class="q"><KeyRound :size="15" /> <strong>Accès au dépôt</strong></div>
      <p v-if="result?.needsToken && result.message" class="warn small">{{ result.message }}</p>
      <div class="row">
        <input v-model="token" class="input mono" type="password" autocomplete="off" placeholder="Jeton GitHub (lecture du contenu)" aria-label="Jeton GitHub">
        <UiButton size="sm" :loading="loading" :disabled="token.length < 10" @click="inspect()">Réessayer avec ce jeton</UiButton>
      </div>
      <p class="muted small">Utilisé uniquement pour cet import, jamais enregistré.</p>
    </div>

    <template v-if="result && result.releases.length">
      <p v-if="result.message" class="warn small"><TriangleAlert :size="13" /> {{ result.message }}</p>
      <div class="card step">
        <div class="q"><Tag :size="15" /> <strong>1. Release</strong> <span class="muted small">{{ result.repository }}</span></div>
        <select v-model="tag" class="input" aria-label="Release">
          <option v-for="r in result.releases" :key="r.tag" :value="r.tag">{{ r.tag }}{{ r.name && r.name !== r.tag ? ` — ${r.name}` : '' }}{{ r.prerelease ? ' (pré-version)' : '' }}{{ r.publishedAt ? ` · ${fmtDate(r.publishedAt)}` : '' }}</option>
        </select>
        <a v-if="release" :href="release.htmlUrl" target="_blank" rel="noopener" class="small">Voir la release sur GitHub</a>
      </div>
      <div v-if="release" class="card step">
        <div class="q"><FileArchive :size="15" /> <strong>2. Fichier</strong> <span class="muted small">{{ assets.length }} fichier{{ assets.length > 1 ? 's' : '' }} attaché{{ assets.length > 1 ? 's' : '' }} à la release, plus le code source</span></div>
        <p v-if="!assets.length" class="muted small">Aucun fichier attaché à cette release : seul le code source du tag est disponible.</p>
        <label v-for="f in visibleAssets" :key="f.key" class="file" :class="{ on: archiveKey === f.key, off: !f.importable }" :title="f.reason ?? undefined">
          <input v-model="archiveKey" type="radio" name="release-archive" :value="f.key" :disabled="!f.importable">
          <span class="mono name">{{ f.name }}</span>
          <UiBadge v-if="f.importable" tone="info">fichier attaché</UiBadge>
          <span class="muted small push">{{ f.reason ?? f.format }}{{ f.sizeBytes ? ` · ${fmtSize(f.sizeBytes)}` : '' }}</span>
        </label>
        <button v-if="hiddenAux" type="button" class="link small" @click="showAux = !showAux">{{ showAux ? 'Masquer' : 'Afficher' }} les {{ hiddenAux }} signature(s) et somme(s) de contrôle</button>
        <div class="sep muted small">Code source du tag {{ release.tag }}</div>
        <label v-for="f in sources" :key="f.key" class="file" :class="{ on: archiveKey === f.key }">
          <input v-model="archiveKey" type="radio" name="release-archive" :value="f.key">
          <span class="mono name">{{ f.name }}</span>
          <UiBadge tone="neutral">code source</UiBadge>
          <span class="muted small push">{{ f.format }}</span>
        </label>
        <p class="muted small">Un tar.gz est converti en ZIP à la réception, avec les mêmes contrôles (chemins, liens, taille décompressée).</p>
      </div>
      <div class="actions">
        <UiButton variant="primary" :loading="importing" :disabled="!tag || !archiveKey" @click="importArchive">Importer cette archive</UiButton>
      </div>
    </template>
    <p v-else-if="result && !result.needsToken && result.message" class="warn small"><TriangleAlert :size="13" /> {{ result.message }}</p>
  </div>
</template>

<style scoped>
.rel { display: flex; flex-direction: column; gap: var(--space-3); }
.row { display: flex; gap: var(--space-2); align-items: center; }
.row .input { flex: 1; }
.small { font-size: 12.5px; }
.err { color: var(--danger); margin: 0; }
.warn { color: var(--warning); margin: 0; display: flex; gap: 6px; align-items: center; }
.step { padding: var(--space-3) var(--space-4); display: flex; flex-direction: column; gap: var(--space-2); box-shadow: none; }
.q { display: flex; gap: 6px; align-items: center; }
.file { display: flex; gap: 8px; align-items: center; padding: 6px 10px; border: 1px solid var(--border); border-radius: var(--radius); cursor: pointer; font-size: 13px; }
.file.on { border-color: var(--primary); background: var(--info-bg); }
.file.off { cursor: default; opacity: .6; }
.file .name { overflow-wrap: anywhere; }
.sep { margin-top: var(--space-2); }
.link { all: unset; cursor: pointer; color: var(--primary); align-self: flex-start; }
.link:focus-visible { outline: 2px solid var(--focus); }
.push { margin-left: auto; }
.actions { display: flex; justify-content: flex-end; }
p { margin: 0; }
</style>
