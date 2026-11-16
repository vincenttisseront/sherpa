<script setup lang="ts">
/**
 * Catalogue de modèles de Compose : recherche, catégories, aperçu du Compose et saisie des variables
 * (mots de passe générés dans le navigateur). L'appelant reçoit le Compose et les valeurs ; rien n'est déployé ici.
 */
import { TEMPLATE_CATEGORIES, type TemplateDto } from '#shared/schemas/templates'
import { Dices, Eye, EyeOff, Trash2 } from 'lucide-vue-next'

const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ apply: [payload: { template: TemplateDto, values: Record<string, string> }] }>()
const toast = useToast()
const confirm = useConfirm()
const { me } = useAuth()

const { data, refresh } = useFetch<{ templates: TemplateDto[] }>('/api/templates', { server: false, lazy: true })
const q = ref('')
const category = ref<string>('')
const selected = ref<TemplateDto | null>(null)
const values = ref<Record<string, string>>({})
const shown = ref<Record<string, boolean>>({})
const showCompose = ref(false)

const norm = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
const list = computed(() => (data.value?.templates ?? []).filter(t => (!category.value || t.category === category.value) && (!q.value || norm(`${t.name} ${t.description}`).includes(norm(q.value)))))
const categories = computed(() => TEMPLATE_CATEGORIES.filter(c => data.value?.templates.some(t => t.category === c)))

function generate(kind: 'password' | 'hex' | undefined): string {
  if (kind === 'hex') return Array.from(crypto.getRandomValues(new Uint8Array(24)), b => b.toString(16).padStart(2, '0')).join('')
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), b => alphabet[b % alphabet.length]).join('')
}

function choose(t: TemplateDto) {
  selected.value = t
  showCompose.value = false
  values.value = Object.fromEntries(t.variables.map(v => [v.name, v.default ?? (v.generate ? generate(v.generate) : '')]))
  shown.value = {}
}

const missing = computed(() => selected.value?.variables.filter(v => !(values.value[v.name] ?? '').trim()) ?? [])

function apply() {
  if (!selected.value || missing.value.length) return
  emit('apply', { template: selected.value, values: { ...values.value } })
  open.value = false
}

async function remove(t: TemplateDto) {
  if (!(await confirm({ title: 'Supprimer le modèle', message: `« ${t.name} » disparaît du catalogue pour tout le monde. Les projets déjà créés ne changent pas.`, confirmLabel: 'Supprimer', danger: true }))) return
  try {
    await $fetch<unknown>(`/api/templates/${t.id}`, { method: 'DELETE' })
    if (selected.value?.id === t.id) selected.value = null
    await refresh()
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
}
const canDelete = (t: TemplateDto) => !t.builtin && (t.createdBy === me.value?.user?.email || me.value?.permissions?.includes('policy:manage'))
</script>

<template>
  <UiModal v-model:open="open" title="Partir d'un modèle" width="940px">
    <div class="picker">
      <div class="side">
        <input v-model="q" class="input" type="search" placeholder="Rechercher un modèle…" aria-label="Rechercher un modèle" autocomplete="off">
        <div class="chips" role="group" aria-label="Catégories">
          <button type="button" class="chip" :class="{ on: !category }" @click="category = ''">Tous</button>
          <button v-for="c in categories" :key="c" type="button" class="chip" :class="{ on: category === c }" @click="category = c">{{ c }}</button>
        </div>
        <ul class="cards" data-testid="template-list">
          <li v-for="t in list" :key="t.id">
            <button type="button" class="card-btn" :class="{ on: selected?.id === t.id }" :data-template="t.id" @click="choose(t)">
              <strong>{{ t.name }}</strong>
              <span class="muted small">{{ t.description || 'Modèle de la plateforme' }}</span>
              <span class="tags"><UiBadge>{{ t.category }}</UiBadge><UiBadge v-if="!t.builtin" tone="info">enregistré{{ t.createdBy ? ` par ${t.createdBy}` : '' }}</UiBadge></span>
            </button>
          </li>
          <li v-if="!list.length" class="muted small empty">Aucun modèle ne correspond.</li>
        </ul>
      </div>

      <div class="detail">
        <p v-if="!selected" class="muted">Choisir un modèle : ses variables sont enregistrées comme variables de la cible (les mots de passe sont chiffrés), puis le Compose est proposé à l'analyse habituelle (ports, réseaux, volumes, versions).</p>
        <template v-else>
          <div class="dhead">
            <h3>{{ selected.name }}</h3>
            <UiButton v-if="canDelete(selected)" size="sm" variant="ghost" :aria-label="`Supprimer le modèle ${selected.name}`" @click="remove(selected)"><Trash2 :size="13" /> Supprimer</UiButton>
          </div>
          <p class="muted small">{{ selected.description }}</p>
          <p v-if="selected.notes" class="note small">{{ selected.notes }}</p>

          <form v-if="selected.variables.length" class="vars" @submit.prevent="apply">
            <h4>Variables</h4>
            <div v-for="v in selected.variables" :key="v.name" class="var">
              <label :for="`tv-${v.name}`">{{ v.label }} <code>{{ v.name }}</code><UiBadge v-if="v.secret" tone="warning">secret</UiBadge></label>
              <div class="inp">
                <input :id="`tv-${v.name}`" v-model.trim="values[v.name]" class="input mono" :type="v.secret && !shown[v.name] ? 'password' : 'text'" autocomplete="off" spellcheck="false">
                <UiButton v-if="v.secret" size="sm" variant="ghost" :aria-label="shown[v.name] ? 'Masquer' : 'Afficher'" @click="shown[v.name] = !shown[v.name]"><component :is="shown[v.name] ? EyeOff : Eye" :size="13" /></UiButton>
                <UiButton v-if="v.generate" size="sm" variant="ghost" :aria-label="`Générer ${v.label}`" @click="values[v.name] = generate(v.generate)"><Dices :size="13" /></UiButton>
              </div>
              <span v-if="v.description" class="muted small">{{ v.description }}</span>
            </div>
          </form>
          <p v-else class="muted small">Aucune variable à renseigner.</p>

          <button type="button" class="link" @click="showCompose = !showCompose">{{ showCompose ? 'Masquer' : 'Voir' }} le Compose</button>
          <pre v-if="showCompose" class="compose mono">{{ selected.compose }}</pre>

          <div class="actions">
            <UiButton variant="primary" :disabled="missing.length > 0" data-testid="template-apply" @click="apply">Utiliser ce modèle</UiButton>
            <span v-if="missing.length" class="muted small">À renseigner : {{ missing.map(v => v.name).join(', ') }}</span>
          </div>
        </template>
      </div>
    </div>
  </UiModal>
</template>

<style scoped>
.picker { display: grid; grid-template-columns: 300px 1fr; gap: var(--space-4); min-height: 420px; }
@media (max-width: 760px) { .picker { grid-template-columns: 1fr; } }
.side { display: flex; flex-direction: column; gap: var(--space-2); min-width: 0; }
.chips { display: flex; flex-wrap: wrap; gap: 4px; }
.chip { border: 1px solid var(--border); background: var(--surface); color: var(--text-muted); border-radius: 999px; padding: 2px 10px; font-size: 12px; cursor: pointer; }
.chip.on { background: var(--primary-soft, var(--surface-2)); color: var(--text); border-color: var(--primary); }
.cards { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; max-height: 420px; overflow-y: auto; }
.card-btn { width: 100%; text-align: left; display: flex; flex-direction: column; gap: 3px; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); color: var(--text); cursor: pointer; font: inherit; }
.card-btn:hover { background: var(--surface-2); }
.card-btn.on { border-color: var(--primary); background: var(--primary-soft, var(--surface-2)); }
.tags { display: flex; gap: 4px; flex-wrap: wrap; }
.small { font-size: 12.5px; margin: 0; }
.empty { padding: var(--space-2); }
.detail { display: flex; flex-direction: column; gap: var(--space-2); min-width: 0; }
.dhead { display: flex; justify-content: space-between; align-items: center; }
h3 { margin: 0; font-size: 16px; }
h4 { margin: var(--space-2) 0 0; font-size: 13.5px; }
.note { padding: 6px 10px; border-radius: var(--radius); background: var(--surface-2); border: 1px solid var(--border); }
.vars { display: flex; flex-direction: column; gap: var(--space-2); }
.var { display: flex; flex-direction: column; gap: 3px; }
.var label { font-size: 12.5px; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.inp { display: flex; gap: 4px; align-items: center; }
.link { background: none; border: 0; padding: 0; color: var(--primary); cursor: pointer; font: inherit; font-size: 13px; text-align: left; width: fit-content; }
.compose { margin: 0; padding: var(--space-2) var(--space-3); background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius); font-size: 12px; max-height: 240px; overflow: auto; white-space: pre; }
.actions { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; margin-top: var(--space-2); }
</style>
