<script setup lang="ts">
/**
 * Source « dépôt GitHub » à partir d'une simple URL : inspection du dépôt, puis
 * seulement les questions nécessaires (jeton si privé, référence, fichier
 * Compose). Valider enregistre la source GitHub du projet.
 */
import { FileCode, GitBranch, KeyRound, TriangleAlert } from 'lucide-vue-next'
import type { StoredUpload } from '~/types/infra'

const props = defineProps<{ projectId: string, initialUrl?: string }>()
const emit = defineEmits<{ 'configured': [{ refType: 'branch' | 'tag' | 'commit', ref: string }], 'use-compose': [], 'use-release': [url: string], 'uploaded': [upload: StoredUpload] }>()
const toast = useToast()

interface InspectResult {
  needsToken: boolean
  message: string | null
  apiUrl: string
  repository: string
  auth: 'token' | 'stored' | 'none'
  repo: { fullName: string, visibility: string, defaultBranch: string, htmlUrl: string, archived: boolean } | null
  refType: 'branch' | 'tag' | 'commit' | null
  ref: string | null
  commit: { sha: string, message: string, author: string | null, date: string | null } | null
  subdirectory: string | null
  composeFiles: string[]
  suggestedCompose: string | null
  submodules: string[]
  truncated: boolean
  advice: { level: 'info' | 'warning', message: string }[]
}

const url = ref(props.initialUrl ?? '')
// Lien vers un fichier attaché à une release : à importer comme archive plutôt que comme dépôt.
const releaseAsset = computed(() => /\/releases\/download\/[^/]+\/.+\.(zip|tar\.gz|tgz|tar)$/i.test(url.value))
const token = ref('')
const askToken = ref(false)
const result = ref<InspectResult | null>(null)
const refType = ref<'branch' | 'tag' | 'commit'>('branch')
const refName = ref('')
const composePath = ref('')
const submodules = ref(false)
const inspecting = ref(false)
const saving = ref(false)
const urlError = ref<string | null>(null)

async function inspect(withRef = false) {
  inspecting.value = true
  urlError.value = null
  try {
    const r = await $fetch<InspectResult>(`/api/projects/${props.projectId}/source/inspect`, {
      method: 'POST',
      body: { url: url.value, token: token.value || null, ...(withRef ? { refType: refType.value, ref: refName.value } : {}) },
    })
    result.value = r
    if (r.needsToken) askToken.value = true
    if (r.refType && r.ref) {
      refType.value = r.refType
      refName.value = r.ref
    }
    composePath.value = r.suggestedCompose ?? ''
    submodules.value = false
  }
  catch (err) {
    const e = apiError(err)
    urlError.value = e.errors.url ?? e.message
  }
  finally {
    inspecting.value = false
  }
}

// Pas de Compose dans le dépôt : les releases de la version choisie (tag) ou de toutes les versions.
const releasesUrl = computed(() => {
  const r = result.value
  if (!r?.repo) return ''
  return `${r.repo.htmlUrl}/releases${refType.value === 'tag' && refName.value ? `/tag/${refName.value}` : ''}`
})

const ready = computed(() => !!result.value?.repo && !!result.value.commit && !!composePath.value)

async function confirm() {
  const r = result.value!
  const sub = r.subdirectory
  saving.value = true
  try {
    await $fetch(`/api/projects/${props.projectId}/source`, {
      method: 'PUT',
      body: {
        kind: 'github',
        apiUrl: r.apiUrl,
        repository: r.repository,
        refType: refType.value,
        ref: refName.value,
        subdirectory: sub,
        composePath: sub ? composePath.value.slice(sub.length + 1) : composePath.value,
        submodules: submodules.value,
        // Jeton saisi : conservé (chiffré) pour les déploiements suivants.
        ...(token.value ? { token: token.value } : {}),
      },
    })
    token.value = ''
    toast.success(`Source GitHub enregistrée : ${r.repository}`)
    emit('configured', { refType: refType.value, ref: refName.value })
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="gh-src">
    <form class="row" @submit.prevent="inspect()">
      <input v-model.trim="url" class="input mono" placeholder="https://github.com/organisation/depot" aria-label="URL du dépôt GitHub" spellcheck="false">
      <UiButton type="submit" variant="primary" size="sm" :loading="inspecting" :disabled="url.length < 3">Inspecter</UiButton>
    </form>
    <div v-if="releaseAsset" class="hint small">
      Ce lien désigne un fichier attaché à une release.
      <UiButton size="sm" variant="primary" @click="emit('use-release', url)">Importer ce fichier comme archive</UiButton>
    </div>
    <p v-if="urlError" class="err small">{{ urlError }}</p>
    <p v-else-if="!result" class="muted small">Page du dépôt, d'une branche (…/tree/main/dossier) ou d'un fichier Compose (…/blob/main/compose.yml).</p>

    <!-- Jeton : dépôt privé ou introuvable sans authentification -->
    <div v-if="askToken" class="step card">
      <div class="q"><KeyRound :size="15" /> <strong>Accès au dépôt</strong></div>
      <p v-if="result?.needsToken && result.message" class="warn small">{{ result.message }}</p>
      <div class="row">
        <input v-model="token" class="input mono" type="password" autocomplete="off" placeholder="Jeton GitHub (lecture du contenu)" aria-label="Jeton GitHub">
        <UiButton size="sm" :loading="inspecting" :disabled="token.length < 10" @click="inspect()">Réessayer avec ce jeton</UiButton>
      </div>
      <p class="muted small">Jeton à privilèges minimaux (fine-grained, « Contents : read-only » sur ce dépôt). Chiffré à l'enregistrement, jamais réaffiché.</p>
    </div>

    <template v-if="result?.repo">
      <div class="repo card">
        <GitBranch :size="16" />
        <div>
          <a :href="result.repo.htmlUrl" target="_blank" rel="noopener" class="mono">{{ result.repo.fullName }}</a>
          <UiBadge :tone="result.repo.visibility === 'public' ? 'neutral' : 'info'">{{ result.repo.visibility === 'public' ? 'public' : 'privé' }}</UiBadge>
          <UiBadge v-if="result.auth !== 'none'" tone="success">{{ result.auth === 'stored' ? 'jeton enregistré' : 'jeton saisi' }}</UiBadge>
          <div v-if="result.commit" class="muted small">Commit <code>{{ result.commit.sha.slice(0, 12) }}</code> — {{ result.commit.message.split('\n')[0] }}</div>
        </div>
      </div>
      <p v-if="result.message" class="warn small"><TriangleAlert :size="13" /> {{ result.message }}</p>
      <ul v-if="result.advice.length" class="advice">
        <li v-for="(a, i) in result.advice" :key="i" :class="a.level">{{ a.message }}</li>
      </ul>

      <div class="step card">
        <div class="q"><strong>1. Version à déployer</strong></div>
        <div class="row">
          <select v-model="refType" class="input reftype" aria-label="Type de référence">
            <option value="branch">Branche</option>
            <option value="tag">Tag</option>
            <option value="commit">Commit</option>
          </select>
          <input v-model.trim="refName" class="input mono" aria-label="Référence">
          <UiButton size="sm" variant="ghost" :loading="inspecting" :disabled="!refName" @click="inspect(true)">Résoudre</UiButton>
        </div>
        <p class="muted small">Branche par défaut : {{ result.repo.defaultBranch }}. Le commit exact est figé à l'analyse.</p>
      </div>

      <div class="step card">
        <div class="q"><FileCode :size="15" /> <strong>2. Fichier Compose</strong></div>
        <template v-if="result.composeFiles.length">
          <label v-for="f in result.composeFiles" :key="f" class="file" :class="{ on: composePath === f }">
            <input v-model="composePath" type="radio" name="compose" :value="f"> <span class="mono">{{ f }}</span>
            <UiBadge v-if="f === result.suggestedCompose" tone="info">proposé</UiBadge>
          </label>
        </template>
        <div v-else class="none">
          <p class="small">Aucun fichier Compose dans le dépôt{{ result.subdirectory ? ` (dossier ${result.subdirectory})` : '' }}. Voici les fichiers publiés dans ses releases : une archive d'installation peut contenir le Compose.</p>
          <GithubReleaseImport :key="releasesUrl" :project-id="projectId" :initial-url="releasesUrl" @uploaded="u => emit('uploaded', u)" />
          <UiButton size="sm" variant="ghost" @click="emit('use-compose')">Coller un Compose à la place</UiButton>
        </div>
        <p v-if="result.truncated" class="muted small">Dépôt volumineux : liste des fichiers incomplète.</p>
      </div>

      <label v-if="result.submodules.length" class="sub small"><input v-model="submodules" type="checkbox"> Inclure les sous-modules ({{ result.submodules.join(', ') }})</label>

      <div v-if="result.composeFiles.length" class="actions">
        <UiButton variant="primary" :loading="saving" :disabled="!ready" @click="confirm">Utiliser ce dépôt et analyser</UiButton>
      </div>
    </template>
  </div>
</template>

<style scoped>
.gh-src { display: flex; flex-direction: column; gap: var(--space-3); }
.row { display: flex; gap: var(--space-2); align-items: center; }
.row .input { flex: 1; }
.reftype { flex: 0 0 130px !important; }
.small { font-size: 12.5px; }
.err { color: var(--danger); margin: 0; }
.hint { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; padding: var(--space-2) var(--space-3); border-radius: var(--radius); background: var(--info-bg); }
.warn { color: var(--warning); margin: 0; display: flex; gap: 6px; align-items: center; }
.step { padding: var(--space-3) var(--space-4); display: flex; flex-direction: column; gap: var(--space-2); box-shadow: none; }
.q { display: flex; gap: 6px; align-items: center; }
.repo { display: flex; gap: var(--space-3); align-items: flex-start; padding: var(--space-3) var(--space-4); box-shadow: none; }
.repo a { font-weight: 600; margin-right: 6px; }
.advice { margin: 0; padding-left: var(--space-4); font-size: 12.5px; }
.advice .warning { color: var(--warning); }
.file { display: flex; gap: 8px; align-items: center; padding: 6px 10px; border: 1px solid var(--border); border-radius: var(--radius); cursor: pointer; font-size: 13px; }
.file.on { border-color: var(--primary); background: var(--info-bg); }
.none { display: flex; flex-direction: column; gap: var(--space-3); }
.none > .btn { align-self: flex-start; }
.sub { display: flex; gap: 6px; align-items: center; }
.actions { display: flex; justify-content: flex-end; }
p { margin: 0; }
</style>
