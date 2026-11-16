<script setup lang="ts">
/**
 * Jetons d'API de l'utilisateur : scripts et CI (curl, GitHub Actions, CLI sherpa). Un jeton agit au nom de son
 * propriétaire avec au plus ses droits, restreints à un profil et éventuellement à un projet ou un environnement.
 * La valeur n'est affichée qu'une fois, à la création.
 */
import { API_TOKEN_PRESETS, type ApiTokenDto, type ApiTokenPreset } from '#shared/schemas/api-tokens'
import type { ProjectListItem } from '#shared/schemas/projects'
import { Copy, KeyRound } from 'lucide-vue-next'

const toast = useToast()
const confirm = useConfirm()
const origin = useRequestURL().origin
const { data: tokens, refresh } = await useFetch<ApiTokenDto[]>('/api/account/tokens', { default: () => [] })
const { data: envs } = useEnvironments()

const creating = ref(false)
const busy = ref(false)
const created = ref<string | null>(null)
const errors = ref<Record<string, string>>({})
const projects = ref<ProjectListItem[]>([])
const form = reactive({ name: '', preset: 'deploy' as ApiTokenPreset, projectId: '', environmentId: '', expiresInDays: 90 })

async function openForm() {
  creating.value = true
  created.value = null
  errors.value = {}
  Object.assign(form, { name: '', preset: 'deploy', projectId: '', environmentId: '', expiresInDays: 90 })
  projects.value = (await $fetch<{ items: ProjectListItem[] }>('/api/projects?pageSize=100').catch(() => ({ items: [] }))).items
}

async function create() {
  busy.value = true
  errors.value = {}
  try {
    const r = await $fetch<{ token: string }>('/api/account/tokens', { method: 'POST', body: { name: form.name, preset: form.preset, projectId: form.projectId || null, environmentId: form.environmentId || null, expiresInDays: form.expiresInDays } })
    created.value = r.token
    creating.value = false
    await refresh()
  }
  catch (err) {
    const e = apiError(err)
    errors.value = e.errors
    if (!Object.keys(e.errors).length) toast.error(e.message)
  }
  finally {
    busy.value = false
  }
}

async function revoke(t: ApiTokenDto) {
  if (!(await confirm({ title: `Révoquer « ${t.name} »`, message: 'Les scripts qui utilisent ce jeton seront refusés aussitôt.', confirmLabel: 'Révoquer', danger: true }))) return
  try {
    await $fetch(`/api/account/tokens/${t.id}`, { method: 'DELETE' })
    await refresh()
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
}

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(`${what} copié`)
  }
  catch {
    toast.error('Copie impossible : sélectionner le texte')
  }
}

const presetOf = (t: ApiTokenDto) => (Object.values(API_TOKEN_PRESETS).find(p => p.permissions.length === t.permissions.length && p.permissions.every(x => t.permissions.includes(x)))?.label ?? 'Personnalisé')
const STATUS = { active: { label: 'actif', tone: 'success' }, expired: { label: 'expiré', tone: 'warning' }, revoked: { label: 'révoqué', tone: 'neutral' } } as const
const usage = computed(() => `export SHERPA_URL=${origin}\nexport SHERPA_TOKEN=${created.value ?? 'shp_…'}\ncurl -fsSL $SHERPA_URL/cli/sherpa.mjs -o sherpa && chmod +x sherpa\n./sherpa deploy mon-projet --env production --wait`)
</script>

<template>
  <section class="card pad tokens">
    <div class="head">
      <h2>Jetons d'API</h2>
      <UiButton size="sm" variant="primary" @click="openForm"><KeyRound :size="13" /> Nouveau jeton</UiButton>
    </div>
    <p class="muted small">Pour la CI ou un script (<code>curl</code>, GitHub Actions, CLI <code>sherpa</code>). Un jeton agit en votre nom avec au plus vos droits ; il expire et se révoque à tout moment.</p>

    <div v-if="created" class="secret" role="status">
      <strong>Votre jeton (affiché une seule fois)</strong>
      <div class="line"><code class="val" data-testid="api-token">{{ created }}</code><UiButton size="sm" aria-label="Copier le jeton" @click="copy(created, 'Jeton')"><Copy :size="13" /> Copier</UiButton></div>
      <pre class="mono usage">{{ usage }}</pre>
      <p class="muted small">Dans GitHub Actions : enregistrer le jeton comme secret du dépôt (<code>SHERPA_TOKEN</code>) puis <code>run: ./sherpa deploy mon-projet --env production --wait</code>.</p>
      <UiButton size="sm" variant="ghost" @click="created = null">J'ai noté le jeton</UiButton>
    </div>

    <form v-if="creating" class="form" @submit.prevent="create">
      <div class="row">
        <UiField label="Nom" for="tk-name" :error="errors.name" hint="Ex. ci-github"><input id="tk-name" v-model.trim="form.name" class="input" maxlength="80" autocomplete="off"></UiField>
        <UiField label="Profil" for="tk-preset" :hint="API_TOKEN_PRESETS[form.preset].hint">
          <select id="tk-preset" v-model="form.preset" class="input"><option v-for="(p, k) in API_TOKEN_PRESETS" :key="k" :value="k">{{ p.label }}</option></select>
        </UiField>
      </div>
      <div class="row">
        <UiField label="Projet" for="tk-project" hint="Vide : tous vos projets">
          <select id="tk-project" v-model="form.projectId" class="input"><option value="">Tous</option><option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option></select>
        </UiField>
        <UiField label="Environnement" for="tk-env" hint="Vide : tous">
          <select id="tk-env" v-model="form.environmentId" class="input"><option value="">Tous</option><option v-for="e in envs" :key="e.id" :value="e.id">{{ e.name }}</option></select>
        </UiField>
        <UiField label="Validité" for="tk-days" :error="errors.expiresInDays">
          <select id="tk-days" v-model.number="form.expiresInDays" class="input"><option :value="30">30 jours</option><option :value="90">90 jours</option><option :value="180">180 jours</option><option :value="365">1 an</option></select>
        </UiField>
      </div>
      <div class="actions"><UiButton type="submit" variant="primary" :loading="busy" :disabled="form.name.length < 2">Créer le jeton</UiButton><UiButton variant="ghost" @click="creating = false">Annuler</UiButton></div>
    </form>

    <p v-if="!tokens.length" class="muted small">Aucun jeton.</p>
    <table v-else class="table">
      <thead><tr><th>Nom</th><th>Profil</th><th>Portée</th><th>Expire</th><th>Dernier usage</th><th>État</th><th /></tr></thead>
      <tbody>
        <tr v-for="t in tokens" :key="t.id">
          <td>{{ t.name }}<div class="mono small muted">{{ t.prefix }}…</div></td>
          <td class="small">{{ presetOf(t) }}</td>
          <td class="small">{{ t.project?.name ?? 'tous les projets' }} · {{ t.environment?.name ?? 'tous les environnements' }}</td>
          <td class="small">{{ fmtDateTime(t.expiresAt) }}</td>
          <td class="small">{{ t.lastUsedAt ? `${fmtRelative(t.lastUsedAt)}${t.lastUsedIp ? ` (${t.lastUsedIp})` : ''}` : 'jamais' }}</td>
          <td><UiBadge :tone="STATUS[t.status].tone">{{ STATUS[t.status].label }}</UiBadge></td>
          <td><UiButton v-if="t.status === 'active'" size="sm" variant="ghost" :aria-label="`Révoquer ${t.name}`" @click="revoke(t)">Révoquer</UiButton></td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<style scoped>
.pad { padding: var(--space-5); display: flex; flex-direction: column; gap: var(--space-3); margin-bottom: var(--space-4); }
.head { display: flex; justify-content: space-between; align-items: center; }
.small { font-size: 12.5px; margin: 0; }
.secret { border: 1px solid color-mix(in srgb, var(--warning) 45%, var(--border)); border-radius: var(--radius); background: var(--surface-2); padding: var(--space-3); display: flex; flex-direction: column; gap: var(--space-2); }
.line { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.val { word-break: break-all; font-size: 12.5px; }
.usage { margin: 0; padding: var(--space-2) var(--space-3); background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); font-size: 12px; white-space: pre-wrap; word-break: break-all; }
.form { display: flex; flex-direction: column; gap: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius); padding: var(--space-3); }
.row { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: var(--space-3); }
.actions { display: flex; gap: var(--space-2); }
.table { width: 100%; border-collapse: collapse; }
.table th { text-align: left; font-size: 12px; color: var(--text-muted); padding: 6px; border-bottom: 1px solid var(--border); }
.table td { padding: 8px 6px; border-bottom: 1px solid var(--border); vertical-align: top; }
</style>
