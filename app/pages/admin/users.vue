<script setup lang="ts">
import type { AdminUserRow } from '#shared/schemas/admin'
import type { Paginated } from '#shared/schemas/common'
import type { Column, TableState } from '~/types/table'

useHead({ title: 'Utilisateurs' })
const toast = useToast()
const confirm = useConfirm()
const { me } = useAuth()

const query = ref<TableState & { status?: string, kind?: string }>({ page: 1, pageSize: 25, sort: 'email:asc' })
const { data, status, refresh } = await useFetch<Paginated<AdminUserRow>>('/api/admin/users', { query, watch: [query] })
const { data: groups } = await useFetch<{ id: string, name: string }[]>('/api/admin/groups', { default: () => [] })

const columns: Column<AdminUserRow>[] = [
  { key: 'email', label: 'Utilisateur', sortable: true },
  { key: 'kind', label: 'Type' },
  { key: 'status', label: 'Statut' },
  { key: 'groups', label: 'Groupes' },
  { key: 'lastLoginAt', label: 'Dernière connexion', sortable: true },
]
const KIND = { local: 'Local', external: 'Externe', sso: 'SSO' } as const
const STATUS: Record<string, { label: string, tone: 'success' | 'warning' | 'danger' | 'neutral' | 'info' }> = {
  active: { label: 'Actif', tone: 'success' }, invited: { label: 'Invité', tone: 'info' }, suspended: { label: 'Suspendu', tone: 'danger' }, expired: { label: 'Expiré', tone: 'warning' }, locked: { label: 'Verrouillé', tone: 'warning' },
}
const statusOf = (u: AdminUserRow) => (u.locked ? 'locked' : u.expiresAt && new Date(u.expiresAt) < new Date() ? 'expired' : u.status)

// --- Création ---
const createOpen = ref(false)
const form = reactive({ email: '', displayName: '', kind: 'local' as 'local' | 'external', expiresAt: '', groupIds: [] as string[] })
const formErrors = ref<Record<string, string>>({})
const link = ref<{ url: string, expiresAt: string, title: string, emailed?: boolean, emailError?: string | null, email?: string } | null>(null)
async function create() {
  formErrors.value = {}
  try {
    const r = await $fetch<{ id: string, invitationUrl: string, invitationExpiresAt: string, emailed: boolean, emailError: string | null }>('/api/admin/users', {
      method: 'POST',
      body: { ...form, expiresAt: form.expiresAt ? new Date(`${form.expiresAt}T23:59:59`).toISOString() : null },
    })
    createOpen.value = false
    link.value = { url: r.invitationUrl, expiresAt: r.invitationExpiresAt, title: `Invitation de ${form.displayName}`, emailed: r.emailed, emailError: r.emailError, email: form.email }
    Object.assign(form, { email: '', displayName: '', kind: 'local', expiresAt: '', groupIds: [] })
    await refresh()
  }
  catch (err) {
    const e = apiError(err)
    formErrors.value = e.errors
    if (!Object.keys(e.errors).length) toast.error(e.message)
  }
}

// --- Détail ---
interface Detail { id: string, email: string, displayName: string, kind: 'local' | 'sso' | 'external', status: string, idp: string | null, locked: boolean, lockedUntil: string | null, expiresAt: string | null, lastLoginAt: string | null, passwordChangedAt: string | null, groups: { id: string, name: string, fromIdp: boolean }[], sessions: { ip: string | null, userAgent: string | null, lastSeenAt: string }[] }
const selected = ref<Detail | null>(null)
const memberOf = ref<string[]>([])
async function open(id: string) {
  selected.value = await $fetch<Detail>(`/api/admin/users/${id}`)
  memberOf.value = selected.value.groups.filter(g => !g.fromIdp).map(g => g.id)
}
async function act(fn: () => Promise<unknown>, success: string) {
  try {
    await fn()
    toast.success(success)
    await refresh()
    if (selected.value) await open(selected.value.id)
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
}
async function suspend(u: Detail) {
  if (!(await confirm({ title: 'Suspendre le compte', message: `${u.displayName} ne pourra plus se connecter et ses sessions sont fermées immédiatement.`, confirmLabel: 'Suspendre', danger: true }))) return
  await act(() => $fetch<unknown>(`/api/admin/users/${u.id}`, { method: 'PATCH', body: { status: 'suspended' } }), 'Compte suspendu')
}
const reactivate = (u: Detail) => act(() => $fetch<unknown>(`/api/admin/users/${u.id}`, { method: 'PATCH', body: { status: 'active' } }), 'Compte réactivé')
const unlock = (u: Detail) => act(() => $fetch<unknown>(`/api/admin/users/${u.id}/unlock`, { method: 'POST' }), 'Compte déverrouillé')
async function resetMfa(u: Detail) {
  if (!(await confirm({ title: 'Réinitialiser la double authentification', message: `Tous les seconds facteurs de ${u.displayName} (application, passkeys, codes de secours) sont retirés et ses sessions fermées : le compte devra les reconfigurer.`, confirmLabel: 'Réinitialiser', danger: true }))) return
  await act(() => $fetch<unknown>(`/api/admin/users/${u.id}/mfa-reset`, { method: 'POST' }), 'Double authentification réinitialisée')
}
const closeSessions = (u: Detail) => act(() => $fetch<unknown>(`/api/admin/users/${u.id}/sessions`, { method: 'DELETE' }), 'Sessions fermées')
const saveGroups = (u: Detail) => act(() => $fetch<unknown>(`/api/admin/users/${u.id}/groups`, { method: 'PUT', body: memberOf.value }), 'Groupes enregistrés')

async function resetLink(u: Detail) {
  try {
    const r = await $fetch<{ url: string, expiresAt: string, purpose: string, emailed: boolean, emailError: string | null }>(`/api/admin/users/${u.id}/reset`, { method: 'POST' })
    link.value = { url: r.url, expiresAt: r.expiresAt, title: r.purpose === 'reset' ? `Réinitialisation pour ${u.displayName}` : `Nouvelle invitation pour ${u.displayName}`, emailed: r.emailed, emailError: r.emailError, email: u.email }
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
}
async function setExpiry(u: Detail, value: string) {
  await act(() => $fetch<unknown>(`/api/admin/users/${u.id}`, { method: 'PATCH', body: { expiresAt: value ? new Date(`${value}T23:59:59`).toISOString() : null } }), 'Expiration enregistrée')
}
async function copy(text: string) {
  await navigator.clipboard.writeText(text).then(() => toast.info('Lien copié'), () => toast.error('Copie impossible'))
}
</script>

<template>
  <div>
    <UiPageHeader title="Administration" icon="settings"><template #nav><AdminNav /></template>
      <UiButton variant="primary" @click="createOpen = true">Nouveau compte</UiButton>
    </UiPageHeader>

    <UiDataTable v-model:query="query" table-key="users" export-url="/api/admin/users" period :columns="columns" :rows="data?.items ?? []" :total="data?.total ?? 0" :loading="status === 'pending'" empty-text="Aucun utilisateur">
      <template #filters>
        <select v-model="query.kind" class="input auto" aria-label="Type"><option :value="undefined">Tous les types</option><option v-for="(l, k) in KIND" :key="k" :value="k">{{ l }}</option></select>
        <select v-model="query.status" class="input auto" aria-label="Statut"><option :value="undefined">Tous les statuts</option><option v-for="(s, k) in STATUS" :key="k" :value="k">{{ s.label }}</option></select>
      </template>
      <template #cell-email="{ row }">
        <button type="button" class="link" @click="open(row.id)"><strong>{{ row.displayName }}</strong></button>
        <div class="muted small mono">{{ row.email }}</div>
      </template>
      <template #cell-kind="{ row }">{{ KIND[row.kind] }}<span v-if="row.idp" class="muted small"> · {{ row.idp }}</span></template>
      <template #cell-status="{ row }"><UiBadge :tone="STATUS[statusOf(row)]!.tone">{{ STATUS[statusOf(row)]!.label }}</UiBadge></template>
      <template #cell-groups="{ row }"><span class="small">{{ row.groups.join(', ') || '—' }}</span></template>
      <template #cell-lastLoginAt="{ row }"><span class="small">{{ fmtDateTime(row.lastLoginAt) }}</span></template>
    </UiDataTable>

    <UiModal v-model:open="createOpen" title="Nouveau compte" width="520px">
      <form class="stack" @submit.prevent="create">
        <div class="kinds">
          <label class="kind" :class="{ on: form.kind === 'local' }"><input v-model="form.kind" type="radio" value="local"> Compte local <span class="muted small">secours, environnement sans SSO</span></label>
          <label class="kind" :class="{ on: form.kind === 'external' }"><input v-model="form.kind" type="radio" value="external"> Compte externe <span class="muted small">prestataire, durée limitée</span></label>
        </div>
        <UiField label="Nom" for="u-name" :error="formErrors.displayName" required><input id="u-name" v-model="form.displayName" class="input"></UiField>
        <UiField label="Email" for="u-email" :error="formErrors.email" required><input id="u-email" v-model.trim="form.email" class="input" type="email"></UiField>
        <UiField :label="form.kind === 'external' ? 'Expire le' : 'Expire le (facultatif)'" for="u-exp" :error="formErrors.expiresAt" :required="form.kind === 'external'">
          <input id="u-exp" v-model="form.expiresAt" class="input" type="date">
        </UiField>
        <UiField label="Groupes" for="u-groups">
          <div class="checks"><label v-for="g in groups" :key="g.id"><input v-model="form.groupIds" type="checkbox" :value="g.id"> {{ g.name }}</label></div>
        </UiField>
        <p class="muted small">Un lien d'invitation (72 h) permettra à la personne de définir son mot de passe.</p>
      </form>
      <template #footer>
        <UiButton @click="createOpen = false">Annuler</UiButton>
        <UiButton variant="primary" @click="create">Créer et générer l'invitation</UiButton>
      </template>
    </UiModal>

    <UiModal :open="!!link" :title="link?.title ?? ''" width="560px" :dismissible="false" @update:open="() => {}">
      <div class="stack">
        <p v-if="link?.emailed" class="sent">Lien envoyé par email à <strong>{{ link.email }}</strong>. Vous pouvez aussi le transmettre vous-même.</p>
        <p v-else-if="link?.emailError" class="alert">L'envoi par email a échoué ({{ link.emailError }}).</p>
        <p class="alert">Lien à transmettre à la personne concernée par un canal sûr. Il ne sera <strong>plus affiché</strong> et expire le {{ fmtDateTime(link?.expiresAt) }}.</p>
        <textarea class="input mono" rows="3" readonly :value="link?.url" aria-label="Lien" @focus="($event.target as HTMLTextAreaElement).select()" />
      </div>
      <template #footer>
        <UiButton @click="copy(link!.url)">Copier</UiButton>
        <UiButton variant="primary" @click="link = null">Fermer</UiButton>
      </template>
    </UiModal>

    <UiModal :open="!!selected" :title="selected?.displayName ?? ''" width="760px" @update:open="v => { if (!v) selected = null }">
      <div v-if="selected" class="stack">
        <dl class="kv">
          <dt>Email</dt><dd class="mono">{{ selected.email }}</dd>
          <dt>Type</dt><dd>{{ KIND[selected.kind] }}<template v-if="selected.idp"> · {{ selected.idp }}</template></dd>
          <dt>Statut</dt><dd>{{ STATUS[selected.locked ? 'locked' : selected.status]?.label }}<template v-if="selected.locked"> jusqu'au {{ fmtDateTime(selected.lockedUntil) }}</template></dd>
          <dt>Dernière connexion</dt><dd>{{ fmtDateTime(selected.lastLoginAt) }}</dd>
          <dt>Sessions actives</dt><dd>{{ selected.sessions.length }}</dd>
          <template v-if="selected.kind !== 'sso'">
            <dt>Expiration</dt>
            <dd><input class="input date" type="date" :value="selected.expiresAt?.slice(0, 10) ?? ''" aria-label="Expiration" @change="setExpiry(selected, ($event.target as HTMLInputElement).value)"></dd>
          </template>
        </dl>
        <div class="actions">
          <UiButton v-if="selected.status === 'active'" variant="danger" size="sm" :disabled="selected.id === me?.user?.id" @click="suspend(selected)">Suspendre</UiButton>
          <UiButton v-if="selected.status === 'suspended'" size="sm" @click="reactivate(selected)">Réactiver</UiButton>
          <UiButton v-if="selected.kind !== 'sso'" size="sm" @click="resetLink(selected)">{{ selected.status === 'invited' ? 'Nouvelle invitation' : 'Lien de réinitialisation' }}</UiButton>
          <UiButton v-if="selected.locked" size="sm" @click="unlock(selected)">Déverrouiller</UiButton>
          <UiButton v-if="selected.sessions.length" size="sm" variant="ghost" @click="closeSessions(selected)">Fermer les sessions</UiButton>
          <UiButton v-if="selected.kind !== 'sso'" size="sm" variant="ghost" @click="resetMfa(selected)">Réinitialiser la 2FA…</UiButton>
        </div>

        <h3>Groupes</h3>
        <div class="checks">
          <label v-for="g in groups" :key="g.id" :title="selected.groups.find(x => x.id === g.id)?.fromIdp ? 'Attribué par le fournisseur SSO' : ''">
            <input v-model="memberOf" type="checkbox" :value="g.id" :disabled="selected.groups.find(x => x.id === g.id)?.fromIdp">
            {{ g.name }}<span v-if="selected.groups.find(x => x.id === g.id)?.fromIdp" class="muted small"> (SSO)</span>
          </label>
        </div>
        <UiButton size="sm" class="self-start" @click="saveGroups(selected)">Enregistrer les groupes</UiButton>

        <h3>Rôles attribués directement</h3>
        <BindingsEditor subject-type="user" :subject-id="selected.id" />
      </div>
    </UiModal>
  </div>
</template>

<style scoped>
.auto { width: auto; }
.small { font-size: 12.5px; }
.sent { margin: 0; padding: var(--space-3) var(--space-4); border-radius: var(--radius); background: var(--success-bg); color: var(--success); }
.link { all: unset; cursor: pointer; color: var(--primary); }
.link:focus-visible { outline: 2px solid var(--focus); }
.stack { display: flex; flex-direction: column; gap: var(--space-3); }
.kinds { display: flex; flex-direction: column; gap: var(--space-2); }
.kind { display: flex; gap: var(--space-2); align-items: center; padding: 8px 12px; border: 1px solid var(--border); border-radius: var(--radius); cursor: pointer; }
.kind.on { border-color: var(--primary); background: var(--info-bg); }
.checks { display: flex; flex-wrap: wrap; gap: 6px 16px; }
.checks label { display: inline-flex; gap: 6px; align-items: center; }
.kv { display: grid; grid-template-columns: 160px 1fr; gap: 6px var(--space-4); margin: 0; }
.kv dt { color: var(--text-muted); }
.kv dd { margin: 0; }
.date { max-width: 180px; }
.actions { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.alert { margin: 0; padding: var(--space-3); border-radius: var(--radius); background: var(--warning-bg); color: var(--warning); }
.self-start { align-self: flex-start; }
h3 { margin: var(--space-2) 0 0; font-size: 14px; }
</style>
