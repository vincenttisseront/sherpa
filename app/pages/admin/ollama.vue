<script setup lang="ts">
/** Connecteur Ollama : serveur de modèles locaux utilisé par les fonctions d'assistance (désactivé par défaut). */
import { OLLAMA_FEATURES, type OllamaFeature, type OllamaSettingsDto, type OllamaTestResult } from '#shared/schemas/ollama'
import { formatBytes } from '#shared/utils/format'
import { Plug, Save } from 'lucide-vue-next'

useHead({ title: 'Connecteur Ollama' })
const toast = useToast()
const { data, refresh } = await useFetch<OllamaSettingsDto>('/api/admin/ollama')

const form = ref({ enabled: false, baseUrl: '', model: '', timeoutSec: 120, contextTokens: 8192, features: [] as OllamaFeature[], token: '', clearToken: false })
watch(data, (d) => {
  if (d) form.value = { enabled: d.enabled, baseUrl: d.baseUrl, model: d.model, timeoutSec: d.timeoutSec, contextTokens: d.contextTokens, features: [...d.features], token: '', clearToken: false }
}, { immediate: true })

function toggleFeature(key: OllamaFeature) {
  form.value.features = form.value.features.includes(key) ? form.value.features.filter(k => k !== key) : [...form.value.features, key]
}

const errors = ref<Record<string, string>>({})
const saving = ref(false)
const testing = ref(false)
const test = ref<OllamaTestResult | null>(null)

async function runTest() {
  testing.value = true
  test.value = null
  try {
    test.value = await $fetch<OllamaTestResult>('/api/admin/ollama/test', {
      method: 'POST',
      body: { baseUrl: form.value.baseUrl, model: form.value.model, token: form.value.token || undefined },
    })
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    testing.value = false
  }
}

async function save() {
  saving.value = true
  errors.value = {}
  try {
    await $fetch<OllamaSettingsDto>('/api/admin/ollama', { method: 'PUT', body: { ...form.value, token: form.value.token || undefined } })
    toast.success('Réglages Ollama enregistrés')
    await refresh()
  }
  catch (err) {
    const e = apiError(err)
    errors.value = e.errors
    toast.error(e.message)
  }
  finally {
    saving.value = false
  }
}
</script>

<template>
  <div>
    <UiPageHeader title="Administration" icon="settings"><template #nav><AdminNav /></template></UiPageHeader>
    <section class="card pad">
      <div>
        <h2>Connecteur Ollama</h2>
        <p class="muted small">
          Un serveur <a href="https://ollama.com" target="_blank" rel="noopener">Ollama</a> (modèles de langage locaux) alimente des fonctions d'assistance : analyse de logs, diagnostic d'un déploiement en échec, tri des vulnérabilités, recherche en langage naturel, synthèse des résumés, Compose à partir d'un « docker run »…
          Les secrets sont masqués avant tout envoi, rien n'est conservé, et la réponse du modèle est seulement affichée (aucune action n'est lancée). Cette analyse est une aide à la lecture : à vérifier avant d'agir.
        </p>
      </div>
      <form class="stack" autocomplete="off" @submit.prevent="save">
        <UiSwitch v-model="form.enabled" label="Assistance par Ollama activée" />
        <UiField label="Adresse du serveur" for="ol-url" :error="errors.baseUrl" hint="Ex. http://ollama:11434 (réseau interne) ; derrière un proxy inverse, l'adresse complète avec son préfixe" required>
          <input id="ol-url" v-model.trim="form.baseUrl" class="input mono" placeholder="http://localhost:11434">
        </UiField>
        <div class="row-2">
          <UiField label="Modèle" for="ol-model" :error="errors.model" hint="Doit être installé sur le serveur (ollama pull …)" required>
            <input id="ol-model" v-model.trim="form.model" class="input mono" list="ol-models" placeholder="llama3.1:8b">
            <datalist id="ol-models"><option v-for="m in test?.models ?? []" :key="m.name" :value="m.name" /></datalist>
          </UiField>
          <UiField label="Jeton (facultatif)" for="ol-token" :error="errors.token" :hint="data?.hasToken ? 'Un jeton est enregistré (jamais affiché) : le saisir pour le remplacer' : 'Jeton Bearer si un proxy protège Ollama'">
            <input id="ol-token" v-model="form.token" class="input mono" type="password" autocomplete="new-password">
          </UiField>
        </div>
        <div class="row-2">
          <UiField label="Délai maximal d'une analyse (secondes)" for="ol-timeout" :error="errors.timeoutSec" hint="Un modèle froid peut mettre un moment à se charger">
            <input id="ol-timeout" v-model.number="form.timeoutSec" class="input" type="number" min="10" max="900">
          </UiField>
          <UiField label="Fenêtre de contexte (tokens)" for="ol-ctx" :error="errors.contextTokens" hint="Borne la quantité de logs envoyée ; à ne pas dépasser ce que le modèle et sa mémoire supportent">
            <input id="ol-ctx" v-model.number="form.contextTokens" class="input" type="number" min="2048" max="131072" step="1024">
          </UiField>
        </div>
        <UiSwitch v-if="data?.hasToken" v-model="form.clearToken" label="Supprimer le jeton enregistré" />

        <fieldset class="features">
          <legend>Fonctions d'assistance actives</legend>
          <label v-for="f in OLLAMA_FEATURES" :key="f.key" class="feature">
            <input type="checkbox" :checked="form.features.includes(f.key)" @change="toggleFeature(f.key)">
            <span><strong>{{ f.label }}</strong> <span class="muted small">{{ f.hint }}</span></span>
          </label>
        </fieldset>

        <div v-if="test" class="result" :class="test.ok ? 'ok' : 'ko'" role="status">
          <template v-if="test.ok">
            <strong>Connexion établie</strong> — Ollama {{ test.version ?? '(version inconnue)' }}, {{ test.models.length }} modèle(s) installé(s).
            <span v-if="test.modelPresent"> Le modèle « {{ form.model }} » est disponible.</span>
            <span v-else class="warn"> Le modèle « {{ form.model }} » n'est pas installé sur ce serveur.</span>
            <ul v-if="test.models.length" class="models small">
              <li v-for="m in test.models" :key="m.name"><span class="mono">{{ m.name }}</span> <span v-if="m.sizeBytes" class="muted">{{ formatBytes(m.sizeBytes) }}</span></li>
            </ul>
          </template>
          <template v-else>
            <strong>Échec du test</strong> — {{ test.error }}
          </template>
        </div>

        <div class="foot">
          <UiButton :loading="testing" @click="runTest"><Plug :size="14" /> Tester la connexion</UiButton>
          <UiButton variant="primary" type="submit" :loading="saving"><Save :size="14" /> Enregistrer</UiButton>
        </div>
      </form>
    </section>
  </div>
</template>

<style scoped>
.pad { padding: var(--space-3) var(--space-4); display: flex; flex-direction: column; gap: var(--space-3); max-width: 880px; }
h2 { margin: 0 0 var(--space-1); font-size: 16px; }
.small { font-size: 12.5px; margin: 0; }
.stack { display: flex; flex-direction: column; gap: var(--space-3); }
.row-2 { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
.foot { display: flex; justify-content: flex-end; gap: var(--space-2); }
.features { border: 1px solid var(--border); border-radius: var(--radius); padding: var(--space-2) var(--space-3); display: grid; grid-template-columns: 1fr 1fr; gap: 4px var(--space-4); }
.features legend { font-size: 12.5px; color: var(--text-muted); padding: 0 6px; }
.feature { display: flex; gap: var(--space-2); align-items: flex-start; font-size: 13px; cursor: pointer; }
.feature input { margin-top: 3px; }
.result { padding: var(--space-2) var(--space-3); border-radius: var(--radius); font-size: 13px; }
.result.ok { background: var(--success-bg); color: var(--text); border: 1px solid color-mix(in srgb, var(--success) 25%, transparent); }
.result.ko { background: var(--danger-bg); color: var(--text); border: 1px solid color-mix(in srgb, var(--danger) 25%, transparent); }
.warn { color: var(--warning); font-weight: 550; }
.models { margin: var(--space-2) 0 0; padding-left: 18px; columns: 2; }
@media (max-width: 860px) { .row-2, .features { grid-template-columns: 1fr; } .models { columns: 1; } }
</style>
