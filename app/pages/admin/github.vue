<script setup lang="ts">
/** Connecteurs GitHub : packages publiés et artefacts Actions d'un compte, alertes (versions déployées disparues, artefacts expirés). */
import type { GithubConnectorDto, GithubScanSnapshot } from '#shared/schemas/github-connector'
import { formatBytes } from '#shared/utils/format'
import { ExternalLink, RefreshCw } from 'lucide-vue-next'

useHead({ title: 'Connecteurs GitHub' })
const route = useRoute()
const toast = useToast()
const confirm = useConfirm()
const { data: connectors, refresh } = await useFetch<GithubConnectorDto[]>('/api/admin/github-connectors', { default: () => [] })

const selectedId = ref<string | null>((route.query.connector as string) || null)
watchEffect(() => {
  if (!selectedId.value && connectors.value.length) selectedId.value = connectors.value[0]!.id
})
watch(selectedId, id => navigateTo({ query: { ...route.query, connector: id ?? undefined } }, { replace: true }))
type Detail = GithubConnectorDto & { snapshot: GithubScanSnapshot | null }
const detail = ref<Detail | null>(null)
async function loadDetail() {
  if (!selectedId.value) return
  detail.value = await $fetch<Detail>(`/api/admin/github-connectors/${selectedId.value}`).catch(() => null)
}
watch(selectedId, () => void loadDetail(), { immediate: true })

const tab = ref<'alerts' | 'packages' | 'artifacts'>('alerts')
const scanning = ref(false)
async function scan() {
  scanning.value = true
  try {
    detail.value = await $fetch<Detail>(`/api/admin/github-connectors/${selectedId.value}/scan`, { method: 'POST' })
    toast.success(`Relevé fait : ${detail.value.snapshot?.alerts.length ?? 0} alerte(s)`)
    await refresh()
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    scanning.value = false
  }
}

// Ajout / modification.
const blank = () => ({ name: '', apiUrl: 'https://api.github.com', owner: '', token: '', repositories: [] as string[], registryHost: 'ghcr.io', expiringDays: 7, enabled: true })
const form = ref(blank())
const editing = ref<GithubConnectorDto | null>(null)
const open = ref(false)
const saving = ref(false)
const errors = ref<Record<string, string>>({})
const validateRepo = (v: string) => (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v) ? null : 'org/dépôt')
function add() {
  editing.value = null
  form.value = blank()
  errors.value = {}
  open.value = true
}
function edit(c: GithubConnectorDto) {
  editing.value = c
  form.value = { name: c.name, apiUrl: c.apiUrl, owner: c.owner, token: '', repositories: [...c.repositories], registryHost: c.registryHost, expiringDays: c.expiringDays, enabled: c.enabled }
  errors.value = {}
  open.value = true
}
async function save() {
  saving.value = true
  errors.value = {}
  try {
    const body = { ...form.value, token: form.value.token || undefined }
    const c = editing.value
      ? await $fetch<GithubConnectorDto>(`/api/admin/github-connectors/${editing.value.id}`, { method: 'PATCH', body })
      : await $fetch<GithubConnectorDto>('/api/admin/github-connectors', { method: 'POST', body })
    toast.success(editing.value ? 'Connecteur enregistré' : `Connecteur ${c.name} ajouté (${c.ownerType === 'org' ? 'organisation' : 'utilisateur'} ${c.owner})`)
    open.value = false
    await refresh()
    selectedId.value = c.id
    await loadDetail()
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
async function remove(c: GithubConnectorDto) {
  if (!await confirm({ title: 'Supprimer le connecteur', message: `${c.name} et son jeton seront supprimés, avec le dernier relevé.`, confirmLabel: 'Supprimer', danger: true })) return
  await $fetch(`/api/admin/github-connectors/${c.id}`, { method: 'DELETE' }).catch(err => toast.error(apiError(err).message))
  selectedId.value = null
  detail.value = null
  await refresh()
}

const KIND = { 'package.missing': 'Package introuvable', 'package.version-missing': 'Version déployée supprimée', 'artifact.expired': 'Artefact expiré', 'artifact.expiring': 'Artefact bientôt expiré' } as const
const daysLeft = (iso: string | null) => (iso ? Math.ceil((new Date(iso).getTime() - Date.now()) / 864e5) : null)
</script>

<template>
  <div>
    <UiPageHeader title="Administration" icon="settings"><template #nav><AdminNav /></template></UiPageHeader>
    <section class="card pad">
      <div class="bar">
        <div>
          <h2>Connecteurs GitHub</h2>
          <p class="muted small">
            Packages publiés (GitHub Packages : images ghcr.io, npm, Maven…) et artefacts des workflows Actions d'une organisation ou d'un utilisateur, relevés chaque heure (GITHUB_SCAN_INTERVAL_MIN).
            Alertes : version d'image déployée par la console qui n'existe plus, dernier artefact d'un workflow expiré ou bientôt expiré. Notification « Alerte GitHub ».
          </p>
        </div>
        <UiButton variant="primary" size="sm" @click="add">Ajouter un connecteur</UiButton>
      </div>
      <div v-if="connectors.length" class="list">
        <button v-for="c in connectors" :key="c.id" type="button" class="conn" :class="{ on: c.id === selectedId }" @click="selectedId = c.id">
          <strong>{{ c.name }}</strong>
          <span class="muted small">{{ c.owner }} · {{ c.counts.packages }} package(s) · {{ c.counts.artifacts }} artefact(s)</span>
          <span>
            <UiBadge v-if="c.counts.errors" tone="danger">{{ c.counts.errors }}</UiBadge>
            <UiBadge v-if="c.counts.warnings" tone="warning">{{ c.counts.warnings }}</UiBadge>
            <UiBadge v-if="!c.enabled" tone="neutral">inactif</UiBadge>
          </span>
        </button>
      </div>
      <p v-else class="muted small">Aucun connecteur.</p>
    </section>

    <section v-if="detail" class="card pad">
      <div class="bar">
        <div>
          <h2>{{ detail.name }} <span class="muted small">{{ detail.ownerType === 'org' ? 'organisation' : 'utilisateur' }} {{ detail.owner }} · {{ detail.apiUrl }}</span></h2>
          <p class="muted small">Dernier relevé : {{ detail.lastScanAt ? fmtDateTime(detail.lastScanAt) : 'jamais' }}<span v-if="detail.lastError" class="err"> · {{ detail.lastError }}</span></p>
        </div>
        <div class="actions">
          <UiButton size="sm" :loading="scanning" @click="scan"><RefreshCw :size="14" /> Relever maintenant</UiButton>
          <UiButton size="sm" variant="ghost" @click="edit(detail)">Modifier</UiButton>
          <UiButton size="sm" variant="ghost" @click="remove(detail)">Supprimer</UiButton>
        </div>
      </div>
      <template v-if="detail.snapshot">
        <UiTabs v-model="tab" :tabs="[{ key: 'alerts', label: 'Alertes', badge: detail.snapshot.alerts.length || undefined }, { key: 'packages', label: `Packages (${detail.snapshot.packages.length})` }, { key: 'artifacts', label: `Artefacts (${detail.snapshot.artifacts.length})` }]" />
        <template v-if="tab === 'alerts'">
          <ul v-if="detail.snapshot.alerts.length" class="alerts">
            <li v-for="a in detail.snapshot.alerts" :key="a.key">
              <UiBadge :tone="a.level === 'error' ? 'danger' : 'warning'">{{ KIND[a.kind] }}</UiBadge>
              <span class="mono">{{ a.subject }}</span>
              <a v-if="a.url" :href="a.url" target="_blank" rel="noopener" class="small"><ExternalLink :size="12" /></a>
              <div class="small">{{ a.message }}</div>
              <div v-if="a.targets.length" class="small">Déployée par : <template v-for="(t, i) in a.targets" :key="t.targetId"><NuxtLink :to="`/projects/${t.projectId}`">{{ t.label }}</NuxtLink><template v-if="i < a.targets.length - 1">, </template></template></div>
            </li>
          </ul>
          <p v-else class="muted">Aucune alerte.</p>
          <ul v-if="detail.snapshot.errors.length" class="errs small"><li v-for="(e, i) in detail.snapshot.errors" :key="i">{{ e }}</li></ul>
        </template>
        <table v-else-if="tab === 'packages'" class="table">
          <thead><tr><th>Package</th><th>Type</th><th>Dépôt</th><th class="num">Versions</th><th>Dernière version</th><th>Déployé par</th></tr></thead>
          <tbody>
            <tr v-if="!detail.snapshot.packages.length"><td colspan="6" class="muted">Aucun package (ou jeton sans read:packages)</td></tr>
            <tr v-for="p in detail.snapshot.packages" :key="`${p.type}/${p.name}`">
              <td><a :href="p.url" target="_blank" rel="noopener" class="mono">{{ p.name }}</a> <UiBadge v-if="p.visibility === 'private'" tone="neutral">privé</UiBadge></td>
              <td>{{ p.type }}</td>
              <td class="mono small">{{ p.repository ?? '—' }}</td>
              <td class="num">{{ p.versions }}</td>
              <td class="small"><span class="mono">{{ p.latest?.tags.join(', ') || p.latest?.name.slice(0, 19) || '—' }}</span><div v-if="p.latest" class="muted">{{ fmtDateTime(p.latest.createdAt) }}</div></td>
              <td class="small">
                <div v-for="u in p.usedBy" :key="`${u.targetId}-${u.service}`">
                  <NuxtLink :to="`/projects/${u.projectId}`">{{ u.label }}</NuxtLink> · {{ u.service }} <UiBadge :tone="u.present ? 'success' : 'danger'">{{ u.present ? 'présente' : 'supprimée' }}</UiBadge>
                </div>
                <span v-if="!p.usedBy.length" class="muted">—</span>
              </td>
            </tr>
          </tbody>
        </table>
        <table v-else class="table">
          <thead><tr><th>Dépôt</th><th>Artefact</th><th>Branche</th><th class="num">Taille</th><th>Créé</th><th>Expiration</th></tr></thead>
          <tbody>
            <tr v-if="!detail.snapshot.artifacts.length"><td colspan="6" class="muted">Aucun artefact (ou jeton sans actions:read)</td></tr>
            <tr v-for="a in detail.snapshot.artifacts" :key="`${a.repository}/${a.name}`">
              <td class="mono small">{{ a.repository }}</td>
              <td class="mono">{{ a.name }} <span v-if="a.count > 1" class="muted small">×{{ a.count }}</span></td>
              <td class="mono small">{{ a.branch ?? '—' }}</td>
              <td class="num small">{{ formatBytes(a.sizeBytes) }}</td>
              <td class="small">{{ a.createdAt ? fmtDateTime(a.createdAt) : '—' }}</td>
              <td>
                <UiBadge v-if="a.expired" tone="danger">expiré</UiBadge>
                <UiBadge v-else-if="(daysLeft(a.expiresAt) ?? 99) <= detail.expiringDays" tone="warning">dans {{ daysLeft(a.expiresAt) }} j</UiBadge>
                <span v-else class="small muted">{{ a.expiresAt ? fmtDateTime(a.expiresAt) : '—' }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </template>
      <p v-else class="muted">Pas encore de relevé : « Relever maintenant ».</p>
    </section>

    <UiModal v-model:open="open" :title="editing ? `Modifier ${editing.name}` : 'Ajouter un connecteur GitHub'" width="620px">
      <form class="stack" autocomplete="off" @submit.prevent="save">
        <UiField label="Nom" for="gh-name" :error="errors.name" required><input id="gh-name" v-model="form.name" class="input" maxlength="100"></UiField>
        <UiField label="Organisation ou utilisateur" for="gh-owner" :error="errors.owner" required><input id="gh-owner" v-model.trim="form.owner" class="input mono" placeholder="mon-org"></UiField>
        <UiField label="API GitHub" for="gh-api" :error="errors.apiUrl" hint="Instances autorisées par l'administrateur (GITHUB_ALLOWED_API_URLS)"><input id="gh-api" v-model.trim="form.apiUrl" class="input mono"></UiField>
        <UiField label="Jeton" for="gh-token" :error="errors.token" :hint="editing ? 'Enregistré, jamais affiché : le renseigner pour le remplacer' : 'Jeton classique (ghp_…) : read:packages (repo pour les packages et artefacts privés). Un jeton fine-grained ne donne pas accès aux packages, seulement aux artefacts (Actions en lecture)'" :required="!editing">
          <input id="gh-token" v-model="form.token" class="input mono" type="password" autocomplete="new-password">
        </UiField>
        <UiField label="Dépôts suivis pour les artefacts" for="gh-repos" hint="Vide : dépôts liés aux packages et sources GitHub des projets de ce compte">
          <UiTagInput id="gh-repos" v-model="form.repositories" placeholder="mon-org/mon-depot" :validate="validateRepo" :max="100" />
        </UiField>
        <div class="row-2">
          <UiField label="Registre des images" for="gh-reg" :error="errors.registryHost"><input id="gh-reg" v-model.trim="form.registryHost" class="input mono"></UiField>
          <UiField label="Alerte avant expiration (jours)" for="gh-days"><input id="gh-days" v-model.number="form.expiringDays" type="number" min="1" max="90" class="input"></UiField>
        </div>
        <UiSwitch v-model="form.enabled" label="Relevés périodiques actifs" />
        <div class="foot">
          <UiButton variant="ghost" @click="open = false">Annuler</UiButton>
          <UiButton variant="primary" type="submit" :loading="saving">{{ editing ? 'Enregistrer' : 'Vérifier et ajouter' }}</UiButton>
        </div>
      </form>
    </UiModal>
  </div>
</template>

<style scoped>
.pad { padding: var(--space-3) var(--space-4); display: flex; flex-direction: column; gap: var(--space-2); margin-bottom: var(--space-3); }
.bar { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--space-3); flex-wrap: wrap; }
.bar h2 { margin: 0; font-size: 16px; }
.small { font-size: 12.5px; margin: 0; }
.err { color: var(--danger); }
.actions { display: flex; gap: var(--space-2); }
.list { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.conn { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 8px 12px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); cursor: pointer; text-align: left; }
.conn.on { border-color: var(--primary); box-shadow: 0 0 0 1px var(--primary); }
.alerts { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2); }
.alerts li { padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius); display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; }
.alerts li > div { flex-basis: 100%; }
.errs { color: var(--warning); margin: var(--space-2) 0 0; padding-left: 18px; }
.table { width: 100%; border-collapse: collapse; font-size: 13px; }
.table th { text-align: left; font-size: 11px; text-transform: uppercase; color: var(--text-muted); padding: 4px 6px; border-bottom: 1px solid var(--border); }
.table td { padding: 5px 6px; border-bottom: 1px solid var(--border); vertical-align: top; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.stack { display: flex; flex-direction: column; gap: var(--space-2); }
.row-2 { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-2); }
.foot { display: flex; justify-content: flex-end; gap: var(--space-2); }
</style>
