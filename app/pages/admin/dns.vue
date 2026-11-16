<script setup lang="ts">
/** Comptes DNS du défi ACME DNS-01 : certificats génériques et domaines non joignables depuis Internet. */
import { DNS_PROVIDERS, DNS_PROVIDER_LABEL, type DnsAccountDto, type DnsCheckResult, type DnsProvider, OVH_ENDPOINTS } from '#shared/schemas/dns'
import { DOMAIN_PATTERN_RE } from '#shared/schemas/infra'

useHead({ title: 'Comptes DNS' })
const toast = useToast()
const confirm = useConfirm()
const { data: accounts, refresh } = await useFetch<DnsAccountDto[]>('/api/admin/dns-accounts', { default: () => [] })

const HELP: Record<DnsProvider, string> = {
  cloudflare: 'Jeton d\'API (My Profile → API Tokens) avec les droits Zone → Zone : Read et Zone → DNS : Edit, limité aux zones concernées.',
  ovh: 'Clés d\'API créées sur la page createToken de l\'API OVHcloud, droits : GET /domain/zone, GET/POST/DELETE /domain/zone/*/record*, POST /domain/zone/*/refresh.',
  route53: 'Utilisateur IAM : route53:ListHostedZones, route53:ListResourceRecordSets, route53:ChangeResourceRecordSets, route53:GetChange (zones publiques).',
}

const blank = () => ({ name: '', provider: 'cloudflare' as DnsProvider, zones: [] as string[], wildcard: true, apiToken: '', endpoint: 'ovh-eu' as keyof typeof OVH_ENDPOINTS, applicationKey: '', applicationSecret: '', consumerKey: '', accessKeyId: '', secretAccessKey: '' })
const form = ref(blank())
const editing = ref<DnsAccountDto | null>(null)
const open = ref(false)
const busy = ref<string | null>(null)
const errors = ref<Record<string, string>>({})
const checks = ref<Record<string, DnsCheckResult>>({})
const validateZone = (v: string) => (!v.startsWith('*') && DOMAIN_PATTERN_RE.test(v.toLowerCase()) ? null : 'Zone invalide (ex. exemple.fr)')

function credentials() {
  const f = form.value
  if (f.provider === 'cloudflare') return f.apiToken ? { provider: 'cloudflare', apiToken: f.apiToken } : null
  if (f.provider === 'ovh') return f.applicationKey || f.applicationSecret || f.consumerKey ? { provider: 'ovh', endpoint: f.endpoint, applicationKey: f.applicationKey, applicationSecret: f.applicationSecret, consumerKey: f.consumerKey } : null
  return f.accessKeyId || f.secretAccessKey ? { provider: 'route53', accessKeyId: f.accessKeyId, secretAccessKey: f.secretAccessKey } : null
}

function add() {
  editing.value = null
  form.value = blank()
  errors.value = {}
  open.value = true
}
function edit(a: DnsAccountDto) {
  editing.value = a
  form.value = { ...blank(), name: a.name, provider: a.provider, zones: [...a.zones], wildcard: a.wildcard }
  errors.value = {}
  open.value = true
}

async function save() {
  busy.value = 'save'
  errors.value = {}
  try {
    const creds = credentials()
    if (editing.value) {
      await $fetch(`/api/admin/dns-accounts/${editing.value.id}`, { method: 'PATCH', body: { name: form.value.name, zones: form.value.zones, wildcard: form.value.wildcard, ...(creds ? { credentials: creds } : {}) } })
      toast.success(`Compte ${form.value.name} enregistré`)
    }
    else {
      const r = await $fetch<{ account: DnsAccountDto }>('/api/admin/dns-accounts', { method: 'POST', body: { name: form.value.name, zones: form.value.zones, wildcard: form.value.wildcard, credentials: creds ?? { provider: form.value.provider } } })
      toast.success(`Compte ${r.account.name} ajouté : ${r.account.zones.length} zone(s)`)
    }
    open.value = false
    form.value = blank()
    await refresh()
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

async function check(a: DnsAccountDto) {
  busy.value = `check-${a.id}`
  try {
    const r = await $fetch<DnsCheckResult>(`/api/admin/dns-accounts/${a.id}/check`, { method: 'POST' })
    checks.value[a.id] = r
    if (r.ok) toast.success(`${a.name} : accès vérifié, ${r.zones.length} zone(s) visibles`)
    else toast.error(`${a.name} : ${r.error}`)
    await refresh()
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    busy.value = null
  }
}

async function remove(a: DnsAccountDto) {
  if (!await confirm({ title: 'Supprimer le compte DNS', message: `${a.name} et ses identifiants seront supprimés. Les certificats déjà obtenus restent en service mais ne seront plus renouvelés par DNS-01.`, confirmLabel: 'Supprimer', danger: true })) return
  try {
    await $fetch(`/api/admin/dns-accounts/${a.id}`, { method: 'DELETE' })
    toast.success(`Compte ${a.name} supprimé`)
    await refresh()
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
}
</script>

<template>
  <div>
    <UiPageHeader title="Administration" icon="settings"><template #nav><AdminNav /></template></UiPageHeader>
    <section class="card pad">
      <div class="bar">
        <div>
          <h2>Comptes DNS (Let's Encrypt DNS-01)</h2>
          <p class="muted small">
            La console crée l'enregistrement TXT <span class="mono">_acme-challenge</span> du domaine par l'API du fournisseur, puis le retire :
            certificats génériques (<span class="mono">*.domaine</span>) et domaines non joignables depuis Internet, pour nginx classique et nginx-proxy.
            Un domaine utilise le compte de la zone la plus précise ; sans compte, nginx classique passe par le défi HTTP-01.
          </p>
        </div>
        <UiButton variant="primary" size="sm" @click="add">Ajouter un compte</UiButton>
      </div>

      <table v-if="accounts.length" class="table">
        <thead><tr><th>Compte</th><th>Fournisseur</th><th>Zones</th><th>Génériques</th><th>Dernier contrôle</th><th /></tr></thead>
        <tbody>
          <tr v-for="a in accounts" :key="a.id">
            <td><strong>{{ a.name }}</strong></td>
            <td>{{ DNS_PROVIDER_LABEL[a.provider] }}</td>
            <td><span v-for="z in a.zones" :key="z" class="chip mono">{{ z }}</span><span v-if="!a.zones.length" class="muted">aucune</span></td>
            <td><UiBadge :tone="a.wildcard ? 'info' : 'neutral'">{{ a.wildcard ? '*.parent' : 'par nom' }}</UiBadge></td>
            <td class="small">
              <UiBadge v-if="a.lastError" tone="danger" dot>erreur</UiBadge>
              <UiBadge v-else-if="a.lastCheckAt" tone="success" dot>ok</UiBadge>
              <span class="muted"> {{ fmtDateTime(a.lastCheckAt) }}</span>
              <div v-if="a.lastError" class="err">{{ a.lastError }}</div>
            </td>
            <td class="actions">
              <UiButton size="sm" variant="ghost" :loading="busy === `check-${a.id}`" @click="check(a)">Tester</UiButton>
              <UiButton size="sm" variant="ghost" @click="edit(a)">Modifier</UiButton>
              <UiButton size="sm" variant="ghost" :aria-label="`Supprimer ${a.name}`" @click="remove(a)">Supprimer</UiButton>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="muted small">Aucun compte DNS : seuls les domaines joignables depuis Internet (défi HTTP-01, nginx classique) obtiennent un certificat Let's Encrypt.</p>
    </section>

    <UiModal v-model:open="open" :title="editing ? `Modifier ${editing.name}` : 'Ajouter un compte DNS'" width="600px">
      <form class="stack" autocomplete="off" @submit.prevent="save">
        <UiField label="Nom" for="dns-name" :error="errors.name" required>
          <input id="dns-name" v-model="form.name" class="input" maxlength="100" placeholder="Cloudflare production">
        </UiField>
        <UiField label="Fournisseur" for="dns-prov" :hint="HELP[form.provider]">
          <select id="dns-prov" v-model="form.provider" class="input" :disabled="!!editing">
            <option v-for="p in DNS_PROVIDERS" :key="p" :value="p">{{ DNS_PROVIDER_LABEL[p] }}</option>
          </select>
        </UiField>
        <p v-if="editing" class="muted small">Identifiants enregistrés, jamais affichés : les renseigner pour les remplacer.</p>
        <template v-if="form.provider === 'cloudflare'">
          <UiField label="Jeton d'API" for="dns-cf" :error="errors.credentials" :required="!editing">
            <input id="dns-cf" v-model="form.apiToken" class="input mono" type="password" autocomplete="new-password">
          </UiField>
        </template>
        <template v-else-if="form.provider === 'ovh'">
          <UiField label="Point d'accès" for="dns-ovh-ep">
            <select id="dns-ovh-ep" v-model="form.endpoint" class="input">
              <option v-for="(url, k) in OVH_ENDPOINTS" :key="k" :value="k">{{ k }} ({{ url }})</option>
            </select>
          </UiField>
          <UiField label="Application key" for="dns-ovh-ak" :error="errors.credentials"><input id="dns-ovh-ak" v-model="form.applicationKey" class="input mono" autocomplete="off"></UiField>
          <UiField label="Application secret" for="dns-ovh-as"><input id="dns-ovh-as" v-model="form.applicationSecret" class="input mono" type="password" autocomplete="new-password"></UiField>
          <UiField label="Consumer key" for="dns-ovh-ck"><input id="dns-ovh-ck" v-model="form.consumerKey" class="input mono" type="password" autocomplete="new-password"></UiField>
        </template>
        <template v-else>
          <UiField label="Access key ID" for="dns-r53-ak" :error="errors.credentials"><input id="dns-r53-ak" v-model="form.accessKeyId" class="input mono" autocomplete="off"></UiField>
          <UiField label="Secret access key" for="dns-r53-sk"><input id="dns-r53-sk" v-model="form.secretAccessKey" class="input mono" type="password" autocomplete="new-password"></UiField>
        </template>
        <UiField label="Zones" for="dns-zones" :error="errors.zones" hint="Vide à l'ajout : toutes les zones visibles avec ces identifiants">
          <UiTagInput id="dns-zones" v-model="form.zones" placeholder="exemple.fr" :validate="validateZone" :max="200" />
        </UiField>
        <UiSwitch v-model="form.wildcard" label="Certificats génériques : un certificat *.parent (et parent) partagé par les domaines voisins, au lieu d'un certificat par nom" />
        <div class="foot">
          <UiButton variant="ghost" @click="open = false">Annuler</UiButton>
          <UiButton variant="primary" type="submit" :loading="busy === 'save'">{{ editing ? 'Enregistrer' : 'Vérifier et ajouter' }}</UiButton>
        </div>
      </form>
    </UiModal>
  </div>
</template>

<style scoped>
.pad { padding: var(--space-3) var(--space-4); display: flex; flex-direction: column; gap: var(--space-2); }
.bar { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--space-3); flex-wrap: wrap; }
.bar h2 { margin: 0; font-size: 16px; }
.small { font-size: 13px; margin: 0; }
.table { width: 100%; border-collapse: collapse; }
.table th { text-align: left; font-size: 12px; color: var(--text-muted); padding: 6px; border-bottom: 1px solid var(--border); }
.table td { padding: 8px 6px; border-bottom: 1px solid var(--border); vertical-align: top; }
.chip { display: inline-block; margin: 0 4px 4px 0; padding: 1px 6px; border-radius: var(--radius); background: var(--surface-3); font-size: 12px; }
.err { color: var(--danger); font-size: 12px; max-width: 320px; }
.actions { white-space: nowrap; text-align: right; }
.stack { display: flex; flex-direction: column; gap: var(--space-2); }
.foot { display: flex; justify-content: flex-end; gap: var(--space-2); }
</style>
