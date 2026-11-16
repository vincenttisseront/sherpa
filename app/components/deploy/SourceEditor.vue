<script setup lang="ts">
/** Source du projet : archive ZIP déposée à chaque déploiement, ou dépôt GitHub. */
const props = defineProps<{ projectId: string }>()
const emit = defineEmits<{ saved: [] }>()
const toast = useToast()

interface SourceDto { kind: 'zip' | 'github', apiUrl: string, repository: string | null, refType: 'branch' | 'tag' | 'commit' | null, ref: string | null, subdirectory: string | null, composePath: string, submodules: boolean, hasToken: boolean, allowedApiUrls: string[] }
interface TestResult { access: { authenticated: boolean, tokenKind: string, advice: { level: 'info' | 'warning', message: string }[] }, repository: { visibility?: string, archived?: boolean, fullName: string, private: boolean, defaultBranch: string, htmlUrl: string }, commit: { sha: string, message: string, author: string | null, date: string | null, htmlUrl: string | null }, composeFiles: string[], composePath: string, composeFound: boolean, submodules: string[], truncated: boolean }

const { data: source, refresh } = await useFetch<SourceDto>(() => `/api/projects/${props.projectId}/source`)
const form = reactive({ kind: 'zip' as 'zip' | 'github', apiUrl: '', repository: '', refType: 'branch' as 'branch' | 'tag' | 'commit', ref: 'main', subdirectory: '', composePath: 'compose.yml', submodules: false, token: '', clearToken: false })
const errors = ref<Record<string, string>>({})
const busy = ref<string | null>(null)
const test = ref<TestResult | null>(null)
const VISIBILITY: Record<string, string> = { public: 'public', private: 'privé', internal: 'interne (entreprise)' }
const TOKEN_KIND: Record<string, string> = { none: 'anonyme (sans token)', classic: 'par token classique', 'fine-grained': 'par token fine-grained', app: 'par jeton d\'application GitHub', oauth: 'par jeton OAuth' }

watchEffect(() => {
  const s = source.value
  if (!s) return
  Object.assign(form, { kind: s.kind, apiUrl: s.apiUrl, repository: s.repository ?? '', refType: s.refType ?? 'branch', ref: s.ref ?? 'main', subdirectory: s.subdirectory ?? '', composePath: s.composePath, submodules: s.submodules, token: '', clearToken: false })
})

async function save() {
  busy.value = 'save'
  errors.value = {}
  try {
    await $fetch<unknown>(`/api/projects/${props.projectId}/source`, {
      method: 'PUT',
      body: {
        kind: form.kind, apiUrl: form.apiUrl, repository: form.repository || null, refType: form.kind === 'github' ? form.refType : null, ref: form.kind === 'github' ? form.ref : null,
        subdirectory: form.subdirectory || null, composePath: form.composePath, submodules: form.submodules,
        ...(form.clearToken ? { token: null } : form.token ? { token: form.token } : {}),
      },
    })
    form.token = ''
    await refresh()
    toast.success('Source enregistrée')
    emit('saved')
  }
  catch (err) {
    const e = apiError(err)
    errors.value = e.errors
    toast.error(e.message)
  }
  finally {
    busy.value = null
  }
}

async function runTest() {
  busy.value = 'test'
  test.value = null
  try {
    test.value = await $fetch<TestResult>(`/api/projects/${props.projectId}/source/test`, { method: 'POST' })
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    busy.value = null
  }
}
</script>

<template>
  <div v-if="source" class="src">
    <div class="kinds">
      <label class="kind" :class="{ on: form.kind === 'zip' }"><input v-model="form.kind" type="radio" value="zip"> Archive ZIP <span class="muted small">déposée à chaque déploiement</span></label>
      <label class="kind" :class="{ on: form.kind === 'github' }"><input v-model="form.kind" type="radio" value="github"> Dépôt GitHub <span class="muted small">commit résolu et figé à chaque déploiement</span></label>
    </div>

    <div v-if="form.kind === 'github'" class="grid">
      <UiField label="API GitHub" for="s-api" hint="Seules les API autorisées par l'administrateur sont proposées" :error="errors.apiUrl">
        <select id="s-api" v-model="form.apiUrl" class="input"><option v-for="a in source.allowedApiUrls" :key="a" :value="a">{{ a }}</option></select>
      </UiField>
      <UiField label="Dépôt" for="s-repo" hint="organisation/depot" :error="errors.repository" required>
        <input id="s-repo" v-model.trim="form.repository" class="input mono" placeholder="acme/boutique">
      </UiField>
      <UiField label="Référence" for="s-reftype">
        <select id="s-reftype" v-model="form.refType" class="input"><option value="branch">Branche</option><option value="tag">Tag</option><option value="commit">Commit</option></select>
      </UiField>
      <UiField :label="form.refType === 'commit' ? 'SHA du commit' : form.refType === 'tag' ? 'Tag' : 'Branche'" for="s-ref" :error="errors.ref" required>
        <input id="s-ref" v-model.trim="form.ref" class="input mono">
      </UiField>
      <UiField label="Sous-répertoire du projet" for="s-sub" hint="Vide : racine du dépôt" :error="errors.subdirectory">
        <input id="s-sub" v-model.trim="form.subdirectory" class="input mono" placeholder="services/web">
      </UiField>
      <UiField label="Fichier Compose" for="s-compose" hint="Relatif au sous-répertoire" :error="errors.composePath">
        <input id="s-compose" v-model.trim="form.composePath" class="input mono">
      </UiField>
      <UiField class="span" label="Token d'accès" for="s-token" :hint="source.hasToken ? 'Un token est enregistré (jamais réaffiché) : laisser vide pour le conserver' : 'Facultatif pour un dépôt public (lève la limite de 60 appels/heure). Obligatoire pour un dépôt privé : token fine-grained limité à ce dépôt, Contents et Metadata en lecture seule. Organisation en SAML SSO : autoriser le token pour l\'organisation.'">
        <input id="s-token" v-model="form.token" class="input mono" type="password" autocomplete="off" :placeholder="source.hasToken ? '•••••• (enregistré)' : ''" :disabled="form.clearToken">
      </UiField>
      <label v-if="source.hasToken" class="check span"><input v-model="form.clearToken" type="checkbox"> Supprimer le token enregistré</label>
      <UiSwitch v-model="form.submodules" class="span" label="Inclure les sous-modules (hébergés sur la même instance GitHub)" />
    </div>
    <p v-else class="muted small">Chaque déploiement se fait en déposant une archive du projet dans le panneau « Nouveau déploiement ».</p>

    <div class="actions">
      <UiButton v-if="source.kind === 'github'" :loading="busy === 'test'" @click="runTest">Tester l'accès</UiButton>
      <span class="spacer" />
      <UiButton variant="primary" :loading="busy === 'save'" @click="save">Enregistrer la source</UiButton>
    </div>

    <div v-if="test" class="test card">
      <div>
        <strong>{{ test.repository.fullName }}</strong>
        <UiBadge :tone="test.repository.private ? 'info' : 'neutral'">{{ VISIBILITY[test.repository.visibility ?? (test.repository.private ? 'private' : 'public')] }}</UiBadge>
        <span class="small muted">· accès {{ TOKEN_KIND[test.access.tokenKind] ?? 'par token' }}</span>
      </div>
      <ul v-if="test.access.advice.length" class="advice">
        <li v-for="(a, i) in test.access.advice" :key="i" :class="a.level">{{ a.message }}</li>
      </ul>
      <div class="small">Commit <code>{{ test.commit.sha.slice(0, 12) }}</code> — {{ test.commit.message }} <span class="muted">({{ test.commit.author }}, {{ fmtDateTime(test.commit.date) }})</span></div>
      <div class="small">
        Compose <code>{{ test.composePath }}</code> :
        <UiBadge :tone="test.composeFound ? 'success' : 'danger'">{{ test.composeFound ? 'trouvé' : 'absent' }}</UiBadge>
        <template v-if="!test.composeFound && test.composeFiles.length"> — disponibles : {{ test.composeFiles.join(', ') }}</template>
      </div>
      <div v-if="test.submodules.length" class="small muted">Sous-modules : {{ test.submodules.join(', ') }}</div>
    </div>
  </div>
</template>

<style scoped>
.src { display: flex; flex-direction: column; gap: var(--space-4); }
.kinds { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.kind { display: inline-flex; gap: var(--space-2); align-items: center; padding: 8px 12px; border: 1px solid var(--border); border-radius: var(--radius); cursor: pointer; }
.kind.on { border-color: var(--primary); background: var(--info-bg); }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: var(--space-4); }
.span { grid-column: 1 / -1; }
.check { display: flex; gap: var(--space-2); align-items: center; }
.small { font-size: 12.5px; }
.actions { display: flex; gap: var(--space-2); align-items: center; }
.spacer { flex: 1; }
.advice { margin: 2px 0; padding-left: var(--space-4); font-size: 12.5px; }
.advice .warning { color: var(--warning); }
.advice .info { color: var(--text-muted); }
.test { padding: var(--space-3) var(--space-4); display: flex; flex-direction: column; gap: 4px; box-shadow: none; }
</style>
