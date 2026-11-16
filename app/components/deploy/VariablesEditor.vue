<script setup lang="ts">
/** Variables d'une cible. Une valeur secrète n'est jamais réaffichée : laisser vide = inchangée. */
import { TriangleAlert } from 'lucide-vue-next'
const props = defineProps<{ targetId: string, focus?: string | null }>()
const emit = defineEmits<{ saved: [], redeploy: [] }>()
const toast = useToast()
const confirm = useConfirm()

interface Row { name: string, value: string, secret: boolean, existingSecret: boolean, notDeployed: boolean, initOnly: string | null, original: string, inject: string[] }
interface ApiVariable { name: string, secret: boolean, value: string | null, notDeployed: boolean, initOnly: string | null, inject: string[] }
const rows = ref<Row[]>([])
const busy = ref(false)
const error = ref<string | null>(null)
/** Modifications par rapport à l'état chargé (noms, valeurs, secret, ajouts, suppressions). */
const signature = (list: Row[]) => JSON.stringify(list.map(r => [r.name, r.value, r.secret, r.inject]))
const loaded = ref('')
/** Services de la release active : cibles possibles de l'injection. */
const services = ref<string[]>([])

async function load() {
  const [vars, svcs] = await Promise.all([$fetch<ApiVariable[]>(`/api/targets/${props.targetId}/variables`), $fetch<string[]>(`/api/targets/${props.targetId}/services`).catch(() => [] as string[])])
  services.value = svcs
  rows.value = vars.map(v => ({ name: v.name, value: v.value ?? '', secret: v.secret, existingSecret: v.secret, notDeployed: v.notDeployed, initOnly: v.initOnly, original: v.value ?? '', inject: [...(v.inject ?? [])] }))
  loaded.value = signature(rows.value)
}
await load()
watch(() => props.targetId, load)

// Lien direct (action en attente) : la variable demandée est mise en évidence, ajoutée si absente.
const table = ref<HTMLElement>()
const highlighted = ref<string | null>(null)
async function focusVariable(name: string | null | undefined) {
  if (!name) return
  if (!rows.value.some(r => r.name === name)) rows.value.push(newRow(name, /PASS|SECRET|TOKEN|KEY/i.test(name)))
  highlighted.value = name
  await nextTick()
  const input = table.value?.querySelector<HTMLInputElement>(`tr[data-var="${CSS.escape(name)}"] input[aria-label="Valeur"]`)
  input?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  input?.focus()
}
onMounted(() => focusVariable(props.focus))
watch(() => props.focus, f => focusVariable(f))

function newRow(name = '', secret = false): Row {
  return { name, value: '', secret, existingSecret: false, notDeployed: false, initOnly: null, original: '', inject: [] }
}
const injectLabel = (r: Row) => (r.inject.includes('*') ? 'tous' : r.inject.length ? r.inject.join(', ') : '—')
function toggleInject(r: Row, s: string) {
  r.inject = r.inject.includes(s) ? r.inject.filter(x => x !== s) : s === '*' ? ['*'] : [...r.inject, s]
}
function add() {
  rows.value.push(newRow())
}

/** Valeur modifiée dans le formulaire (secret : une saisie non vide). */
const edited = (r: Row) => (r.existingSecret ? r.value !== '' : r.value !== r.original)
const pendingDeploy = computed(() => rows.value.filter(r => r.notDeployed).map(r => r.name))

// Filtre d'affichage (les lignes masquées restent enregistrées) ; une ligne vide ajoutée reste visible.
const q = ref('')
const kind = ref<'' | 'secret' | 'plain' | 'pending' | 'init' | 'edited'>('')
const KINDS = { secret: 'Secrètes', plain: 'En clair', pending: 'À déployer', init: 'Lues à l\'initialisation', edited: 'Modifiées ici' } as const
const shown = computed(() => {
  const t = q.value.trim().toLowerCase()
  return rows.value.map((r, i) => ({ r, i })).filter(({ r }) => {
    if (!r.name) return true
    if (t && !r.name.toLowerCase().includes(t) && (r.secret || !r.value.toLowerCase().includes(t))) return false
    if (kind.value === 'secret') return r.secret
    if (kind.value === 'plain') return !r.secret
    if (kind.value === 'pending') return r.notDeployed
    if (kind.value === 'init') return !!r.initOnly
    if (kind.value === 'edited') return edited(r) || !r.original && !r.existingSecret
    return true
  })
})
const dirty = computed(() => signature(rows.value) !== loaded.value)

async function save() {
  // Variables lues seulement à l'initialisation : la modification ne prendra pas effet comme attendu.
  const risky = rows.value.filter(r => r.name && r.initOnly && edited(r))
  if (risky.length && !await confirm({
    title: 'Variable lue seulement à l\'initialisation',
    message: risky.map(r => `${r.name} : ${r.initOnly}`).join('\n\n'),
    confirmLabel: 'Enregistrer quand même',
    danger: true,
  })) return
  busy.value = true
  error.value = null
  try {
    await $fetch<unknown>(`/api/targets/${props.targetId}/variables`, {
      method: 'PUT',
      body: rows.value.filter(r => r.name).map(r => ({ name: r.name, secret: r.secret, value: r.existingSecret && r.secret && r.value === '' ? null : r.value, inject: r.inject })),
    })
    await load()
    toast.success(pendingDeploy.value.length ? 'Variables enregistrées : appliquées au prochain déploiement' : 'Variables enregistrées')
    emit('saved')
  }
  catch (err) {
    const e = apiError(err)
    error.value = Object.values(e.errors)[0] ?? e.message
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="vars">
    <div class="bar">
      <input v-model="q" class="input input-sm search" type="search" placeholder="Filtrer les variables…" aria-label="Filtrer les variables">
      <select v-model="kind" class="input input-sm auto" aria-label="Type de variable">
        <option value="">Toutes</option>
        <option v-for="(l, k) in KINDS" :key="k" :value="k">{{ l }}</option>
      </select>
      <span class="muted small">{{ shown.length === rows.length ? rows.length : `${shown.length} / ${rows.length}` }} variable(s)</span>
      <span class="muted small hint" title="Utilisées par le Compose sous la forme ${NOM}. Une variable secrète est chiffrée, transmise à Docker Compose au déploiement, jamais écrite dans le Compose ni réaffichée.">ⓘ <code>${NOM}</code> · secrète : chiffrée, jamais réaffichée</span>
    </div>
    <div v-if="pendingDeploy.length" class="pending" role="status">
      <span><strong>{{ pendingDeploy.length }} variable{{ pendingDeploy.length > 1 ? 's' : '' }} modifiée{{ pendingDeploy.length > 1 ? 's' : '' }} depuis le déploiement en service</strong> ({{ pendingDeploy.join(', ') }}) : les conteneurs utilisent encore l'ancienne valeur jusqu'au prochain déploiement.</span>
      <UiButton size="sm" variant="primary" @click="emit('redeploy')">Redéployer</UiButton>
    </div>
    <table v-if="rows.length" ref="table">
      <thead><tr><th class="c-name">Nom</th><th>Valeur</th><th class="c-sec">Secrète</th><th class="c-inj" title="Ajoute la variable à l'environnement des services choisis, même si le Compose ne la cite pas (ex. CSRF_TRUSTED_ORIGINS)">Injecter dans</th><th class="c-tags" /><th class="c-del" /></tr></thead>
      <tbody>
        <tr v-for="{ r, i } in shown" :key="i" :data-var="r.name" :class="{ hl: highlighted && r.name === highlighted }">
          <td><input v-model.trim="r.name" class="input input-sm mono" placeholder="NOM_VARIABLE" aria-label="Nom" :readonly="r.existingSecret"></td>
          <td><input v-model="r.value" class="input input-sm mono" :type="r.secret ? 'password' : 'text'" :placeholder="r.existingSecret ? '•••••• (inchangée)' : ''" autocomplete="off" aria-label="Valeur"></td>
          <td class="c-sec"><UiSwitch v-model="r.secret" :disabled="r.existingSecret" :aria-label="`Secrète : ${r.name}`" /></td>
          <td class="c-inj">
            <details class="inj">
              <summary :aria-label="`Injecter ${r.name} dans`" :class="{ on: r.inject.length }">{{ injectLabel(r) }}</summary>
              <div class="inj-menu">
                <label><input type="checkbox" :checked="r.inject.includes('*')" @change="toggleInject(r, '*')"> Tous les services</label>
                <label v-for="s in services" :key="s"><input type="checkbox" :checked="r.inject.includes(s) || r.inject.includes('*')" :disabled="r.inject.includes('*')" @change="toggleInject(r, s)"> {{ s }}</label>
                <span v-if="!services.length" class="muted small">Aucun service déployé</span>
              </div>
            </details>
          </td>
          <td class="c-tags">
            <UiBadge v-if="r.notDeployed" tone="warning" title="Modifiée depuis le déploiement en service">à déployer</UiBadge>
            <span v-if="r.initOnly" class="init" :title="`Lue seulement à l'initialisation : ${r.initOnly}`" :aria-label="`Lue seulement à l'initialisation : ${r.initOnly}`"><TriangleAlert :size="14" /></span>
          </td>
          <td class="c-del"><UiButton size="sm" variant="ghost" :aria-label="`Supprimer ${r.name}`" @click="rows.splice(i, 1)">✕</UiButton></td>
        </tr>
        <tr v-if="!shown.length"><td colspan="6" class="muted small">Aucune variable ne correspond au filtre.</td></tr>
      </tbody>
    </table>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <!-- Barre d'enregistrement toujours visible en bas de l'écran (listes longues). -->
    <div class="actions" :class="{ dirty }">
      <UiButton size="sm" @click="add(); q = ''; kind = ''">Ajouter une variable</UiButton>
      <span v-if="dirty" class="muted small">Modifications non enregistrées</span>
      <span class="spacer" />
      <UiButton variant="primary" size="sm" :loading="busy" @click="save">Enregistrer les variables</UiButton>
    </div>
  </div>
</template>

<style scoped>
.vars { display: flex; flex-direction: column; gap: var(--space-2); }
.bar { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.search { max-width: 240px; }
.auto { width: auto; }
.hint { margin-left: auto; cursor: help; }
.hint code { font-size: 11.5px; }
.c-name { width: 34%; }
.c-sec { width: 64px; }
.c-tags { width: 110px; white-space: nowrap; }
.c-inj { width: 130px; }
.inj { position: relative; }
.inj summary { cursor: pointer; font-size: 12.5px; color: var(--text-muted); list-style: none; padding: 4px 6px; border: 1px solid var(--border); border-radius: var(--radius); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 130px; }
.inj summary.on { color: var(--primary); border-color: var(--primary); }
.inj-menu { position: absolute; z-index: 5; top: 100%; left: 0; min-width: 180px; display: flex; flex-direction: column; gap: 4px; padding: var(--space-2); background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow, 0 4px 12px rgb(0 0 0 / .12)); font-size: 13px; }
.inj-menu label { display: flex; gap: 6px; align-items: center; white-space: nowrap; }
.c-del { width: 36px; }
.small { font-size: 12.5px; margin: 0; }
table { width: 100%; border-collapse: collapse; }
th { text-align: left; font-size: 11px; text-transform: uppercase; color: var(--text-muted); padding: 2px 4px; }
td { padding: 2px 4px; }
.actions { display: flex; gap: var(--space-2); align-items: center; position: sticky; bottom: 0; z-index: 2; padding: var(--space-2) 0; background: var(--surface); border-top: 1px solid var(--border); }
.actions.dirty { border-top-color: var(--warning); }
.spacer { flex: 1; }
.error { color: var(--danger); margin: 0; }
.pending { display: flex; gap: var(--space-3); align-items: center; justify-content: space-between; padding: var(--space-2) var(--space-3); border-radius: var(--radius); background: var(--warning-bg); font-size: 13px; }
.init { display: inline-flex; vertical-align: middle; margin-left: 4px; color: var(--warning); cursor: help; }
td { vertical-align: middle; }
@media (max-width: 640px) { .hint { display: none; } .c-tags { width: auto; } }
tr.hl td { background: var(--warning-bg); }
tr.hl td:first-child { border-radius: var(--radius) 0 0 var(--radius); }
tr.hl td:last-child { border-radius: 0 var(--radius) var(--radius) 0; }
</style>
