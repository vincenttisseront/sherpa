<script setup lang="ts">
/**
 * Bouton d'assistance par Ollama : demande au serveur une analyse par un modèle local et affiche le
 * rapport (points clés, actions, texte à copier). Masqué tant que le connecteur ou la fonction n'est
 * pas activé. Le navigateur n'appelle jamais Ollama : seule l'API de la plateforme est jointe, et les
 * secrets sont masqués côté serveur avant envoi au modèle.
 */
import type { AiReportDto, OllamaFeature, OllamaStatusDto } from '#shared/schemas/ollama'
import { Copy, Sparkles } from 'lucide-vue-next'

const props = withDefaults(defineProps<{
  feature: OllamaFeature
  /** Route de la demande (POST) ; par défaut la route commune des assistants. */
  url?: string
  /** Corps de la demande ; la question libre y est ajoutée si `ask` est actif. */
  body?: Record<string, unknown>
  label?: string
  title?: string
  /** Titres des listes du rapport selon la fonction. */
  causesLabel?: string
  actionsLabel?: string
  draftLabel?: string
  /** Champ « Orienter l'analyse » (question libre). */
  ask?: boolean
  size?: 'sm' | 'md'
}>(), { url: undefined, body: () => ({}), label: 'Analyser avec Ollama', title: 'Analyse par Ollama', causesLabel: 'Causes probables', actionsLabel: 'Quoi faire', draftLabel: 'Texte proposé', ask: true, size: 'sm' })

const toast = useToast()
const { data: status } = useFetch<OllamaStatusDto>('/api/ollama/status', { key: 'ollama-status', default: () => ({ enabled: false, model: null, features: [] }) })
const available = computed(() => !!status.value?.enabled && status.value.features.includes(props.feature))

const open = ref(false)
const focus = ref('')
const loading = ref(false)
const result = ref<AiReportDto | null>(null)
const error = ref<string | null>(null)

const TONE = { ok: 'success', warning: 'warning', error: 'danger' } as const
const LABEL = { ok: 'Rien d\'anormal', warning: 'À surveiller', error: 'Problème' } as const

async function run() {
  loading.value = true
  error.value = null
  try {
    result.value = await $fetch<AiReportDto>(props.url ?? `/api/ollama/assist/${props.feature}`, { method: 'POST', body: { ...props.body, focus: focus.value.trim() || undefined } })
  }
  catch (err) {
    error.value = apiError(err).message
    toast.error(error.value)
  }
  finally {
    loading.value = false
  }
}

async function copyDraft() {
  try {
    await navigator.clipboard.writeText(result.value?.draft ?? '')
    toast.info('Texte copié')
  }
  catch {
    toast.error('Copie impossible')
  }
}

function start() {
  result.value = null
  error.value = null
  open.value = true
  void run()
}
</script>

<template>
  <template v-if="available">
    <UiButton :size="size" title="Demander une analyse au modèle local Ollama" @click="start"><Sparkles :size="14" /> {{ label }}</UiButton>
    <UiModal v-model:open="open" :title="title" width="720px">
      <div class="analysis">
        <p v-if="loading" class="muted" role="status">Analyse en cours par {{ status?.model }}… (jusqu'à une minute si le modèle doit se charger)</p>
        <template v-else-if="result">
          <div class="head">
            <UiBadge :tone="TONE[result.severity]" dot>{{ LABEL[result.severity] }}</UiBadge>
            <span class="muted small">{{ result.meta.model }} · {{ (result.meta.durationMs / 1000).toFixed(1) }} s · {{ result.meta.sentLines }}/{{ result.meta.totalLines }} lignes envoyées<template v-if="result.meta.truncated"> (extrait)</template></span>
          </div>
          <p class="summary">{{ result.summary }}</p>
          <p v-if="!result.structured" class="muted small">Le modèle n'a pas respecté le format demandé : texte repris tel quel.</p>
          <section v-if="result.causes.length">
            <h3>{{ causesLabel }}</h3>
            <ol>
              <li v-for="(c, i) in result.causes" :key="i">
                <strong>{{ c.title }}</strong>
                <div v-if="c.evidence" class="mono small evidence">{{ c.evidence }}</div>
              </li>
            </ol>
          </section>
          <section v-if="result.actions.length">
            <h3>{{ actionsLabel }}</h3>
            <ol>
              <li v-for="(a, i) in result.actions" :key="i">{{ a }}</li>
            </ol>
          </section>
          <section v-if="result.draft">
            <h3>{{ draftLabel }} <UiButton size="sm" variant="ghost" aria-label="Copier le texte" @click="copyDraft"><Copy :size="13" /></UiButton></h3>
            <pre class="draft mono small">{{ result.draft }}</pre>
          </section>
          <p class="muted small note">Généré par un modèle de langage local : il peut se tromper, à vérifier avant d'agir. Secrets masqués avant envoi ; rien n'est conservé.</p>
        </template>
        <p v-else-if="error" class="err" role="alert">{{ error }}</p>

        <form v-if="ask" class="ask" @submit.prevent="run">
          <label for="ol-focus" class="small muted">Orienter l'analyse (facultatif)</label>
          <div class="ask-row">
            <input id="ol-focus" v-model="focus" class="input" maxlength="300" placeholder="Ex. Pourquoi le service redémarre-t-il en boucle ?">
            <UiButton type="submit" variant="primary" size="sm" :loading="loading">{{ result || error ? 'Relancer' : 'Analyser' }}</UiButton>
          </div>
        </form>
      </div>
    </UiModal>
  </template>
</template>

<style scoped>
.analysis { display: flex; flex-direction: column; gap: var(--space-3); }
.head { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.summary { margin: 0; white-space: pre-wrap; }
h3 { margin: 0 0 var(--space-1); font-size: 13px; text-transform: uppercase; letter-spacing: .03em; color: var(--text-muted); }
ol { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: var(--space-2); }
.evidence { color: var(--text-muted); white-space: pre-wrap; word-break: break-word; }
.small { font-size: 12.5px; margin: 0; }
.err { color: var(--danger); margin: 0; }
.draft { margin: 0; padding: var(--space-2) var(--space-3); background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius); white-space: pre-wrap; word-break: break-word; max-height: 260px; overflow: auto; }
.note { border-top: 1px solid var(--border); padding-top: var(--space-2); }
.ask { display: flex; flex-direction: column; gap: 4px; }
.ask-row { display: flex; gap: var(--space-2); }
.ask-row .input { flex: 1; }
</style>
