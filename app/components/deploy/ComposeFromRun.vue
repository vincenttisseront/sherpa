<script setup lang="ts">
/**
 * « docker run » → Compose, par le modèle local. Le Compose est seulement proposé : il est comparé à la
 * commande (rien d'ajouté, rien d'oublié) et revalidé par l'analyse de la cible, puis placé dans
 * l'éditeur pour la relecture et l'analyse habituelles. Les valeurs de variables sensibles de la
 * commande ne sont jamais envoyées au modèle : elles deviennent des variables `${NOM}` à renseigner.
 */
import type { ComposeGenDto } from '#shared/schemas/ollama'
import { Sparkles } from 'lucide-vue-next'

const props = defineProps<{ targetId: string }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ use: [payload: { compose: string, variables: string[] }] }>()
const toast = useToast()

const command = ref('')
const loading = ref(false)
const result = ref<ComposeGenDto | null>(null)
const error = ref<string | null>(null)

async function run() {
  loading.value = true
  error.value = null
  result.value = null
  try {
    result.value = await $fetch<ComposeGenDto>('/api/ollama/assist/compose-gen', { method: 'POST', body: { targetId: props.targetId, command: command.value } })
  }
  catch (err) {
    const e = apiError(err)
    error.value = Object.values(e.errors)[0] ?? e.message
    toast.error(error.value)
  }
  finally {
    loading.value = false
  }
}

const blocking = computed(() => result.value?.analysis?.issues.filter(i => i.severity === 'error') ?? [])
const warnings = computed(() => result.value?.analysis?.issues.filter(i => i.severity === 'warning') ?? [])
const toFill = computed(() => result.value?.variables.filter(v => !v.known) ?? [])

function use() {
  if (!result.value?.compose) return
  emit('use', { compose: result.value.compose, variables: toFill.value.map(v => v.name) })
  open.value = false
}
</script>

<template>
  <UiModal v-model:open="open" title="Depuis un « docker run »" width="860px">
    <form class="gen" @submit.prevent="run">
      <p class="muted small">Coller une commande <code>docker run</code> : le modèle local en fait un Compose, qui est ensuite comparé à la commande et analysé comme n'importe quel Compose de cette cible. Rien n'est enregistré ni déployé.</p>
      <textarea v-model="command" class="input mono" rows="5" maxlength="4000" spellcheck="false" aria-label="Commande docker run" placeholder="docker run -d --name app -p 8080:80 -e TZ=Europe/Paris nginx:1.27" />
      <p class="muted small">Les valeurs des variables d'environnement qui pourraient être sensibles (mots de passe, jetons, URL…) ne sont jamais envoyées au modèle : elles deviennent des variables <code>${NOM}</code>, à renseigner ensuite.</p>
      <div class="row"><UiButton type="submit" variant="primary" size="sm" :loading="loading" :disabled="command.trim().length < 10"><Sparkles :size="13" /> Générer le Compose</UiButton></div>
    </form>

    <p v-if="error" class="err small" role="alert">{{ error }}</p>

    <section v-if="result" class="out" data-testid="compose-gen-result">
      <p v-if="!result.compose" class="warn small">{{ result.notes[0] }}</p>
      <template v-else>
        <div class="verdict">
          <UiBadge :tone="result.analysis?.ok ? 'success' : blocking.length || result.fidelity.length ? 'danger' : 'warning'">{{ result.analysis === null ? 'Analyse indisponible' : result.analysis.ok ? 'Conforme' : 'À corriger' }}</UiBadge>
          <span class="muted small">{{ result.meta.model }} · {{ Math.round(result.meta.durationMs / 1000) }} s · à relire avant d'utiliser</span>
        </div>
        <pre class="compose mono" tabindex="0" aria-label="Compose proposé">{{ result.compose }}</pre>

        <div v-if="result.fidelity.length" class="block">
          <h4>Écarts avec la commande</h4>
          <ul><li v-for="f in result.fidelity" :key="f">{{ f }}</li></ul>
        </div>
        <div v-if="blocking.length || warnings.length" class="block">
          <h4>Analyse de la cible</h4>
          <ul>
            <li v-for="i in blocking" :key="`e-${i.code}-${i.service}-${i.message}`" class="bad"><code>{{ i.code }}</code> {{ i.service ? `(${i.service}) ` : '' }}{{ i.message }}</li>
            <li v-for="i in warnings" :key="`w-${i.code}-${i.service}-${i.message}`" class="warn"><code>{{ i.code }}</code> {{ i.service ? `(${i.service}) ` : '' }}{{ i.message }}</li>
          </ul>
        </div>
        <div v-if="toFill.length" class="block">
          <h4>Variables à renseigner</h4>
          <p class="small">Le Compose les référence à la place des valeurs de la commande : <code v-for="(v, i) in toFill" :key="v.name">{{ v.name }}{{ i < toFill.length - 1 ? ', ' : '' }}</code>. Saisir leurs valeurs (secrètes) à l'étape des variables.</p>
        </div>
        <div v-if="result.notes.length" class="block">
          <h4>Remarques du modèle</h4>
          <ul><li v-for="n in result.notes" :key="n">{{ n }}</li></ul>
        </div>
        <div class="row"><UiButton variant="primary" size="sm" data-testid="compose-gen-use" @click="use">Placer dans l'éditeur</UiButton><span class="muted small">Le Compose passera ensuite par l'analyse habituelle avant tout déploiement.</span></div>
      </template>
    </section>
  </UiModal>
</template>

<style scoped>
.gen { display: grid; gap: var(--space-2); }
.row { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
.out { margin-top: var(--space-4); display: grid; gap: var(--space-3); }
.verdict { display: flex; align-items: center; gap: var(--space-3); }
.compose { max-height: 320px; overflow: auto; padding: var(--space-3); background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm); white-space: pre; }
.block h4 { margin: 0 0 var(--space-1); }
.block ul { margin: 0; padding-left: var(--space-4); display: grid; gap: 2px; }
.bad { color: var(--danger); }
.warn { color: var(--warning); }
.err { color: var(--danger); }
</style>
