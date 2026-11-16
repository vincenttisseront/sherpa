<script setup lang="ts">
useHead({ title: 'Fournisseurs SSO' })
const toast = useToast()
const { hasAny } = useAuth()
const confirm = useConfirm()
interface Idp { id: string, key: string, kind: 'keycloak' | 'okta' | 'oidc', name: string, issuerUrl: string, clientId: string, hasSecret: boolean, scopes: string[], groupsClaim: string, requireMappedGroup: boolean, allowedEmailDomains: string[], enabled: boolean, redirectUri: string, mappings: { externalGroup: string, groupId: string, group: string }[] }
const { data: idps, refresh } = await useFetch<Idp[]>('/api/admin/idps', { default: () => [] })
const { data: groups } = await useFetch<{ id: string, name: string }[]>('/api/admin/groups', { default: () => [] })

const PRESETS = {
  keycloak: { label: 'Keycloak', issuer: 'https://keycloak.interne/realms/<realm>', claim: 'groups', hint: 'Ajouter au client un mapper « Group Membership » (claim groups). Les groupes arrivent sous la forme /nom.' },
  okta: { label: 'Okta', issuer: 'https://<org>.okta.com/oauth2/default', claim: 'groups', hint: 'Ajouter un claim « groups » (filtre de groupes) au serveur d\'autorisation, et le scope groups.' },
  oidc: { label: 'OIDC générique', issuer: 'https://idp.interne', claim: 'groups', hint: 'Tout fournisseur OpenID Connect avec découverte (.well-known/openid-configuration).' },
} as const

type Form = { id: string | null, key: string, kind: Idp['kind'], name: string, issuerUrl: string, clientId: string, clientSecret: string, scopes: string[], groupsClaim: string, requireMappedGroup: boolean, allowedEmailDomains: string[], enabled: boolean }
const editing = ref<Form | null>(null)
const errors = ref<Record<string, string>>({})
const testResult = ref<Record<string, { ok: boolean, error?: string, issuer?: string, pkce?: boolean, endSession?: boolean }>>({})
const mappingDraft = ref<Record<string, { externalGroup: string, groupId: string }[]>>({})
watch(idps, v => { mappingDraft.value = Object.fromEntries(v.map(i => [i.id, i.mappings.map(m => ({ externalGroup: m.externalGroup, groupId: m.groupId }))])) }, { immediate: true })

function startNew(kind: Idp['kind']) {
  editing.value = { id: null, key: kind, kind, name: PRESETS[kind].label, issuerUrl: '', clientId: 'sherpa', clientSecret: '', scopes: ['openid', 'profile', 'email', ...(kind === 'okta' ? ['groups'] : [])], groupsClaim: PRESETS[kind].claim, requireMappedGroup: true, allowedEmailDomains: [], enabled: true }
  errors.value = {}
}
function edit(i: Idp) {
  editing.value = { ...i, clientSecret: '', scopes: [...i.scopes], allowedEmailDomains: [...i.allowedEmailDomains] }
  errors.value = {}
}
async function save() {
  const f = editing.value!
  errors.value = {}
  const body = { key: f.key, kind: f.kind, name: f.name, issuerUrl: f.issuerUrl, clientId: f.clientId, ...(f.clientSecret ? { clientSecret: f.clientSecret } : {}), scopes: f.scopes, groupsClaim: f.groupsClaim, requireMappedGroup: f.requireMappedGroup, allowedEmailDomains: f.allowedEmailDomains, enabled: f.enabled }
  try {
    if (f.id) await $fetch<unknown>(`/api/admin/idps/${f.id}`, { method: 'PATCH', body })
    else await $fetch<unknown>('/api/admin/idps', { method: 'POST', body })
    editing.value = null
    await refresh()
    toast.success('Fournisseur enregistré')
  }
  catch (err) {
    const e = apiError(err)
    errors.value = e.errors
    if (!Object.keys(e.errors).length) toast.error(e.message)
  }
}
async function test(i: Idp) {
  const r = await $fetch<{ ok: boolean, error?: string, issuer?: string, pkce?: boolean, endSession?: boolean }>(`/api/admin/idps/${i.id}/test`, { method: 'POST' })
  testResult.value = { ...testResult.value, [i.id]: r }
}
async function saveMappings(i: Idp) {
  try {
    await $fetch<unknown>(`/api/admin/idps/${i.id}/mappings`, { method: 'PUT', body: mappingDraft.value[i.id]!.filter(m => m.externalGroup && m.groupId) })
    await refresh()
    toast.success('Mappings enregistrés (appliqués à la prochaine connexion)')
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
}
async function remove(i: Idp) {
  if (!(await confirm({ title: 'Supprimer le fournisseur', message: `« ${i.name} » ne sera plus proposé à la connexion.`, confirmLabel: 'Supprimer', danger: true, requireText: i.key }))) return
  try {
    await $fetch<unknown>(`/api/admin/idps/${i.id}`, { method: 'DELETE' })
    await refresh()
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
}
const copy = (t: string) => navigator.clipboard.writeText(t).then(() => toast.info('Copié'))
const addMenu = ref<HTMLDetailsElement | null>(null)
</script>

<template>
  <div>
    <UiPageHeader title="Administration" icon="settings"><template #nav><AdminNav /></template>
      <details ref="addMenu" class="add">
        <summary>Ajouter un fournisseur ▾</summary>
        <div class="menu" role="menu">
          <button v-for="(p, k) in PRESETS" :key="k" type="button" role="menuitem" @click="addMenu?.removeAttribute('open'); startNew(k)">{{ p.label }}</button>
        </div>
      </details>
    </UiPageHeader>
    <MfaPolicyPanel v-if="hasAny('policy:manage')" />
    <p v-if="!idps.length" class="muted">Aucun fournisseur SSO : seuls les comptes locaux et externes peuvent se connecter.</p>
    <section v-for="i in idps" :key="i.id" class="card pad">
      <div class="head">
        <h2>{{ i.name }}</h2>
        <UiBadge>{{ PRESETS[i.kind].label }}</UiBadge>
        <UiBadge :tone="i.enabled ? 'success' : 'neutral'">{{ i.enabled ? 'actif' : 'désactivé' }}</UiBadge>
        <span class="spacer" />
        <UiButton size="sm" @click="test(i)">Tester la découverte</UiButton>
        <UiButton size="sm" @click="edit(i)">Modifier</UiButton>
        <UiButton size="sm" variant="ghost" @click="remove(i)">Supprimer</UiButton>
      </div>
      <dl class="kv">
        <dt>Émetteur</dt><dd class="mono">{{ i.issuerUrl }}</dd>
        <dt>Client</dt><dd class="mono">{{ i.clientId }} <span class="muted">· secret {{ i.hasSecret ? 'enregistré' : 'absent (client public)' }}</span></dd>
        <dt>URL de retour</dt><dd class="mono">{{ i.redirectUri }} <UiButton size="sm" variant="ghost" @click="copy(i.redirectUri)">Copier</UiButton></dd>
        <dt>Groupes</dt><dd>claim <code>{{ i.groupsClaim }}</code> · {{ i.requireMappedGroup ? 'accès refusé sans groupe mappé' : 'accès sans groupe autorisé' }}</dd>
        <dt>Domaines</dt><dd>{{ i.allowedEmailDomains.join(', ') || 'tous' }}</dd>
      </dl>
      <p v-if="testResult[i.id]" class="test" :class="testResult[i.id]!.ok ? 'ok' : 'ko'">
        <template v-if="testResult[i.id]!.ok">Découverte réussie : {{ testResult[i.id]!.issuer }} · PKCE {{ testResult[i.id]!.pkce ? 'supporté' : 'non annoncé' }} · déconnexion {{ testResult[i.id]!.endSession ? 'supportée' : 'non supportée' }}</template>
        <template v-else>Échec : {{ testResult[i.id]!.error }}</template>
      </p>
      <h3>Mapping des groupes</h3>
      <table class="map">
        <thead><tr><th>Groupe chez le fournisseur</th><th>Groupe de la plateforme</th><th /></tr></thead>
        <tbody>
          <tr v-for="(m, k) in mappingDraft[i.id]" :key="k">
            <td><input v-model.trim="m.externalGroup" class="input mono" placeholder="/devops" aria-label="Groupe chez le fournisseur"></td>
            <td><select v-model="m.groupId" class="input" aria-label="Groupe de la plateforme"><option value="" disabled>Choisir…</option><option v-for="g in groups" :key="g.id" :value="g.id">{{ g.name }}</option></select></td>
            <td><UiButton size="sm" variant="ghost" aria-label="Retirer" @click="mappingDraft[i.id]!.splice(k, 1)">✕</UiButton></td>
          </tr>
        </tbody>
      </table>
      <div class="actions">
        <UiButton size="sm" @click="mappingDraft[i.id]!.push({ externalGroup: '', groupId: '' })">Ajouter un mapping</UiButton>
        <UiButton size="sm" variant="primary" @click="saveMappings(i)">Enregistrer les mappings</UiButton>
      </div>
    </section>

    <UiModal :open="!!editing" :title="editing?.id ? `Modifier ${editing.name}` : `Nouveau fournisseur ${editing ? PRESETS[editing.kind].label : ''}`" width="640px" @update:open="v => { if (!v) editing = null }">
      <form v-if="editing" class="grid" @submit.prevent="save">
        <p class="muted small span">{{ PRESETS[editing.kind].hint }}</p>
        <UiField label="Identifiant" for="i-key" :error="errors.key" hint="Utilisé dans l'URL de retour"><input id="i-key" v-model.trim="editing.key" class="input mono" :disabled="!!editing.id"></UiField>
        <UiField label="Nom affiché" for="i-name" :error="errors.name"><input id="i-name" v-model="editing.name" class="input"></UiField>
        <UiField class="span" label="URL de l'émetteur (issuer)" for="i-iss" :error="errors.issuerUrl"><input id="i-iss" v-model.trim="editing.issuerUrl" class="input mono" :placeholder="PRESETS[editing.kind].issuer"></UiField>
        <UiField label="Client ID" for="i-cid" :error="errors.clientId"><input id="i-cid" v-model.trim="editing.clientId" class="input mono"></UiField>
        <UiField label="Secret client" for="i-sec" :hint="editing.id ? 'Laisser vide pour conserver le secret enregistré' : 'Chiffré, jamais réaffiché'"><input id="i-sec" v-model="editing.clientSecret" class="input mono" type="password" autocomplete="off"></UiField>
        <UiField label="Scopes" for="i-scopes" :error="errors.scopes"><UiTagInput id="i-scopes" v-model="editing.scopes" /></UiField>
        <UiField label="Claim des groupes" for="i-claim" :error="errors.groupsClaim"><input id="i-claim" v-model.trim="editing.groupsClaim" class="input mono"></UiField>
        <UiField class="span" label="Domaines d'email autorisés" for="i-dom" hint="Vide : tous"><UiTagInput id="i-dom" v-model="editing.allowedEmailDomains" placeholder="acme.fr" /></UiField>
        <UiSwitch v-model="editing.requireMappedGroup" class="span" label="Refuser l'accès aux utilisateurs sans groupe mappé (recommandé)" />
        <UiSwitch v-model="editing.enabled" class="span" label="Proposer ce fournisseur sur la page de connexion" />
      </form>
      <template #footer>
        <UiButton @click="editing = null">Annuler</UiButton>
        <UiButton variant="primary" @click="save">Enregistrer</UiButton>
      </template>
    </UiModal>
  </div>
</template>

<style scoped>
.pad { padding: var(--space-5); display: flex; flex-direction: column; gap: var(--space-3); margin-bottom: var(--space-4); }
.head { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.spacer { flex: 1; }
.actions { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.kv { display: grid; grid-template-columns: 140px 1fr; gap: 6px var(--space-4); margin: 0; }
.kv dt { color: var(--text-muted); }
.kv dd { margin: 0; word-break: break-all; }
.test { margin: 0; padding: var(--space-2) var(--space-3); border-radius: var(--radius); font-size: 13px; }
.test.ok { background: var(--success-bg); color: var(--success); }
.test.ko { background: var(--danger-bg); color: var(--danger); }
.map { width: 100%; border-collapse: collapse; }
.map th { text-align: left; font-size: 12px; color: var(--text-muted); padding: 4px; }
.map td { padding: 3px 4px; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
.span { grid-column: 1 / -1; }
.small { font-size: 12.5px; margin: 0; }
h3 { margin: var(--space-2) 0 0; font-size: 14px; }
.add { position: relative; }
.add summary { list-style: none; cursor: pointer; display: inline-flex; align-items: center; padding: 5px 13px; min-height: 32px; font-size: 13px; font-weight: 550; border-radius: var(--radius); background: var(--primary); color: var(--primary-contrast); white-space: nowrap; }
.add summary:hover { background: var(--primary-hover); }
.add summary:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.add summary::-webkit-details-marker { display: none; }
.add .menu { position: absolute; right: 0; top: calc(100% + 4px); z-index: 20; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: 0 8px 24px rgba(0, 0, 0, .12); padding: 4px; display: flex; flex-direction: column; min-width: 180px; }
.add .menu button { all: unset; padding: 6px 10px; border-radius: var(--radius); font-size: 13px; cursor: pointer; }
.add .menu button:hover, .add .menu button:focus-visible { background: var(--surface-2); }
</style>
