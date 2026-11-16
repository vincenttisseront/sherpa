<script setup lang="ts">
/**
 * Traefik géré par la plateforme sur un endpoint : synthèse, assistant de
 * configuration (écoute, réseaux, ACME) et application via l'agent.
 */
import { type AcmeStatusDto, DEFAULT_TRAEFIK_IMAGE, type ManagedProxyConfig, type ManagedProxyDto, type ManagedProxyPreview } from '#shared/schemas/managed-proxy'
import { Lock, Plus, RefreshCw, ShieldCheck, Trash2, TriangleAlert } from 'lucide-vue-next'

const props = defineProps<{ endpointId: string, endpointName: string, canManage: boolean, networks: string[], /** Reverse proxy des projets : un Traefik géré inutilisé n'est pas proposé à côté de nginx. */ proxyProvider?: string | null }>()
const emit = defineEmits<{ applied: [] }>()
const toast = useToast()
const confirm = useConfirm()

const { data, refresh } = await useFetch<ManagedProxyDto>(() => `/api/endpoints/${props.endpointId}/managed-proxy`, { server: false })

const STEPS = [
  { key: 'listen', label: 'Écoute' },
  { key: 'networks', label: 'Réseaux' },
  { key: 'acme', label: 'Certificats ACME' },
  { key: 'review', label: 'Aperçu et application' },
] as const
const open = ref(false)
const step = ref(0)
const reached = ref(0)
const errors = ref<Record<string, string>>({})
const saving = ref(false)
const applying = ref(false)
const preview = ref<ManagedProxyPreview | null>(null)

function defaults(): ManagedProxyConfig {
  return {
    image: DEFAULT_TRAEFIK_IMAGE, bindAddress: '0.0.0.0', httpPort: 80, httpsPort: 443, networks: ['platform-edge'],
    redirectToHttps: true, onlyManaged: true, logLevel: 'INFO',
    acme: { enabled: true, email: null, challenge: 'http', dnsProvider: null, staging: true, caServer: null },
  }
}
const cfg = ref<ManagedProxyConfig>(defaults())
const dnsEnv = ref<{ name: string, value: string, existing: boolean }[]>([])

function start() {
  cfg.value = structuredClone(toRaw(data.value?.config) ?? defaults())
  dnsEnv.value = (data.value?.dnsEnvNames ?? []).map(name => ({ name, value: '', existing: true }))
  step.value = 0
  reached.value = 0
  errors.value = {}
  preview.value = null
  open.value = true
}
const go = (i: number) => {
  step.value = i
  reached.value = Math.max(reached.value, i)
  if (STEPS[i]!.key === 'review') void saveAndPreview()
}

const stepBlocker = computed(() => {
  const c = cfg.value
  switch (STEPS[step.value]!.key) {
    case 'listen':
      if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(c.bindAddress)) return 'Adresse IPv4 attendue'
      if (c.httpPort === c.httpsPort) return 'Ports HTTP et HTTPS identiques'
      return null
    case 'networks':
      return c.networks.length ? null : 'Au moins un réseau'
    case 'acme':
      if (!c.acme.enabled) return null
      if (!c.acme.email) return 'E-mail requis'
      if (c.acme.challenge === 'dns' && !c.acme.dnsProvider) return 'Fournisseur DNS requis'
      if (dnsEnv.value.some(v => !/^[A-Z][A-Z0-9_]*$/.test(v.name) || (!v.existing && !v.value))) return 'Variables DNS incomplètes'
      return null
    default:
      return null
  }
})
const validateNetwork = (v: string) => (/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(v) ? null : 'Nom de réseau invalide')

async function saveAndPreview() {
  saving.value = true
  errors.value = {}
  preview.value = null
  try {
    await $fetch(`/api/endpoints/${props.endpointId}/managed-proxy`, {
      method: 'PUT',
      body: { config: cfg.value, dnsEnv: cfg.value.acme.enabled && cfg.value.acme.challenge === 'dns' ? dnsEnv.value.map(v => ({ name: v.name, value: v.value || null })) : [] },
    })
    preview.value = await $fetch<ManagedProxyPreview>(`/api/endpoints/${props.endpointId}/managed-proxy/preview`)
    await refresh()
  }
  catch (err) {
    const e = apiError(err)
    errors.value = e.errors
    toast.error(Object.values(e.errors)[0] ?? e.message)
  }
  finally {
    saving.value = false
  }
}

/** Application de la configuration enregistrée (ex. certificat importé à mettre en service). */
async function applySaved() {
  const ok = await confirm({ title: `Appliquer le Traefik géré sur ${props.endpointName}`, message: 'Traefik est redéployé avec la configuration enregistrée et les certificats importés (coupure de quelques secondes).', confirmLabel: 'Appliquer' })
  if (!ok) return
  applying.value = true
  try {
    await $fetch(`/api/endpoints/${props.endpointId}/managed-proxy/apply`, { method: 'POST' })
    toast.success('Traefik géré appliqué')
    await refresh()
    await loadAcme()
    emit('applied')
  }
  catch (err) {
    toast.error(apiError(err).message)
    await refresh()
  }
  finally {
    applying.value = false
  }
}

async function apply() {
  const c = cfg.value
  const ok = await confirm({
    title: `Déployer Traefik sur ${props.endpointName}`,
    message: `Traefik écoutera sur ${c.bindAddress}:${c.httpPort} et ${c.bindAddress}:${c.httpsPort}${preview.value?.networksToCreate.length ? `, réseaux créés : ${preview.value.networksToCreate.join(', ')}` : ''}. ${c.acme.enabled ? `Certificats ACME (${c.acme.staging ? 'autorité de test' : 'production'}, challenge ${c.acme.challenge}).` : 'Sans ACME.'} La configuration Traefik de l'endpoint sera alignée.`,
    confirmLabel: 'Déployer',
  })
  if (!ok) return
  applying.value = true
  try {
    await $fetch(`/api/endpoints/${props.endpointId}/managed-proxy/apply`, { method: 'POST' })
    toast.success('Traefik déployé et configuration de l\'endpoint alignée')
    open.value = false
    await refresh()
    await loadAcme()
    emit('applied')
  }
  catch (err) {
    toast.error(apiError(err).message)
    await refresh()
  }
  finally {
    applying.value = false
  }
}

// État ACME : certificats par domaine exposé et erreurs récentes (lu sur l'hôte via l'agent).
const acme = ref<AcmeStatusDto | null>(null)
const acmeLoading = ref(false)
const acmeError = ref<string | null>(null)
async function loadAcme() {
  if (!data.value?.appliedAt || !data.value.config?.acme.enabled) {
    acme.value = null
    return
  }
  acmeLoading.value = true
  acmeError.value = null
  try {
    acme.value = await $fetch<AcmeStatusDto>(`/api/endpoints/${props.endpointId}/managed-proxy/acme`)
  }
  catch (err) {
    acmeError.value = apiError(err).message
  }
  finally {
    acmeLoading.value = false
  }
}
watch(() => [data.value?.appliedAt, data.value?.config?.acme.enabled], () => void loadAcme(), { immediate: true })
const ACME_STATE = {
  valid: { label: 'Certificat valide', tone: 'success' },
  expiring: { label: 'Expire bientôt', tone: 'warning' },
  expired: { label: 'Expiré', tone: 'danger' },
  error: { label: 'Échec', tone: 'danger' },
  pending: { label: 'En attente', tone: 'neutral' },
} as const

const STATUS = { none: { label: 'Non configuré', tone: 'neutral' }, draft: { label: 'Non appliqué', tone: 'warning' }, applied: { label: 'Déployé', tone: 'success' }, failed: { label: 'Échec', tone: 'danger' } } as const
</script>

<template>
  <section v-if="!(proxyProvider && proxyProvider !== 'traefik' && (!data || data.status === 'none'))" class="card pad">
    <div class="head">
      <div class="title">
        <span class="ico"><ShieldCheck :size="17" /></span>
        <div>
          <h2>Traefik géré par la plateforme</h2>
          <span class="muted small">Déployé sur l'hôte via l'agent, avec ses réseaux et ses certificats (ACME ou importés)</span>
        </div>
      </div>
      <UiBadge v-if="data" :tone="STATUS[data.status].tone" dot>{{ STATUS[data.status].label }}</UiBadge>
    </div>

    <template v-if="data?.config">
      <dl class="kv">
        <dt>Écoute</dt><dd class="mono">{{ data.config.bindAddress }}:{{ data.config.httpPort }} → web, {{ data.config.bindAddress }}:{{ data.config.httpsPort }} → websecure</dd>
        <dt>Réseaux</dt><dd><span v-for="n in data.config.networks" :key="n" class="chip mono">{{ n }}</span></dd>
        <dt>ACME</dt>
        <dd>
          <template v-if="data.config.acme.enabled"><Lock :size="13" /> {{ data.config.acme.email }} · challenge {{ data.config.acme.challenge }}<template v-if="data.config.acme.dnsProvider"> ({{ data.config.acme.dnsProvider }})</template> · <UiBadge :tone="data.config.acme.staging ? 'warning' : 'success'">{{ data.config.acme.staging ? 'autorité de test' : 'production' }}</UiBadge></template>
          <span v-else class="muted">désactivé</span>
        </dd>
        <dt>Appliqué</dt>
        <dd>
          {{ fmtDateTime(data.appliedAt) }}<UiBadge v-if="data.pending" tone="warning">modifications non appliquées</UiBadge>
          <UiButton v-if="data.pending && canManage && data.appliedAt" size="sm" variant="primary" :loading="applying" @click="applySaved">Appliquer les modifications</UiButton>
        </dd>
      </dl>
      <p v-if="data.lastError" class="alert"><TriangleAlert :size="14" /> {{ data.lastError }}</p>

      <div v-if="data.config.acme.enabled && data.appliedAt" class="acme">
        <div class="acme-head">
          <h3>Certificats ACME</h3>
          <span v-if="acme" class="muted small">
            compte {{ acme.account === 'registered' ? 'enregistré' : acme.account === 'not_registered' ? 'non enregistré' : 'inconnu' }} · lu à {{ fmtTime(acme.checkedAt) }}
          </span>
          <span class="spacer" />
          <UiButton size="sm" variant="ghost" :loading="acmeLoading" @click="loadAcme"><RefreshCw :size="14" /> Actualiser</UiButton>
        </div>
        <p v-if="acmeError" class="alert"><TriangleAlert :size="14" /> {{ acmeError }}</p>
        <template v-else-if="acme">
          <p v-if="!acme.running" class="alert"><TriangleAlert :size="14" /> Traefik géré arrêté ou absent : aucun certificat ne peut être obtenu.</p>
          <p v-if="acme.generalError" class="alert"><TriangleAlert :size="14" /> {{ acme.generalError }}</p>
          <table v-if="acme.domains.length" class="table">
            <thead><tr><th>Domaine</th><th>État</th><th>Émetteur</th><th>Expiration</th></tr></thead>
            <tbody>
              <tr v-for="d in acme.domains" :key="d.host">
                <td><span class="mono">{{ d.host }}</span><div v-if="d.project" class="muted small">{{ d.project }}</div></td>
                <td>
                  <UiBadge :tone="ACME_STATE[d.state].tone" dot>{{ ACME_STATE[d.state].label }}</UiBadge>
                  <UiBadge v-if="d.staging" tone="warning">test</UiBadge>
                  <div v-if="d.error" class="err-msg small">{{ d.error }}</div>
                </td>
                <td class="small">{{ d.issuer ?? '—' }}</td>
                <td class="small">{{ d.notAfter ? fmtDateTime(d.notAfter) : '—' }}</td>
              </tr>
            </tbody>
          </table>
          <p v-else class="muted small">Aucun domaine exposé sur cet endpoint pour l'instant.</p>
          <p v-if="acme.orphanCertificates" class="muted small">{{ acme.orphanCertificates }} certificat(s) pour des domaines qui ne sont plus exposés.</p>
        </template>
      </div>
      <ProxyCertificates :endpoint-id="endpointId" :can-manage="canManage" @changed="refresh()" />
    </template>
    <p v-else class="muted">La plateforme peut déployer elle-même le Traefik de cet hôte, avec des certificats ACME (Let's Encrypt). Ses projets y sont alors raccordés automatiquement.</p>
    <div v-if="canManage" class="actions">
      <UiButton :variant="data?.config ? 'ghost' : 'primary'" @click="start">{{ data?.config ? 'Modifier' : 'Configurer Traefik et ACME' }}</UiButton>
    </div>

    <UiDrawer v-model:open="open" :title="`Traefik géré — ${endpointName}`" width="820px">
      <div class="wiz">
        <UiStepper :steps="[...STEPS]" :current="step" :reached="reached" class="stepper" @go="go" />

        <div v-if="STEPS[step]!.key === 'listen'" class="stack">
          <div class="grid">
            <UiField label="Adresse d'écoute" for="mp-bind" hint="0.0.0.0 : toutes les interfaces de l'hôte">
              <input id="mp-bind" v-model.trim="cfg.bindAddress" class="input mono">
            </UiField>
            <UiField label="Image" for="mp-img">
              <input id="mp-img" v-model.trim="cfg.image" class="input mono">
            </UiField>
            <UiField label="Port HTTP sur l'hôte" for="mp-http">
              <input id="mp-http" v-model.number="cfg.httpPort" class="input" type="number" min="1" max="65535">
            </UiField>
            <UiField label="Port HTTPS sur l'hôte" for="mp-https">
              <input id="mp-https" v-model.number="cfg.httpsPort" class="input" type="number" min="1" max="65535">
            </UiField>
          </div>
          <UiSwitch v-model="cfg.redirectToHttps" label="Rediriger HTTP vers HTTPS" />
          <UiSwitch v-model="cfg.onlyManaged" label="Ne router que les conteneurs déployés par la plateforme" />
        </div>

        <div v-else-if="STEPS[step]!.key === 'networks'" class="stack">
          <UiField label="Réseaux partagés avec les projets" for="mp-nets" hint="Le premier est le réseau par défaut des projets ; les réseaux absents sont créés sur l'hôte">
            <UiTagInput id="mp-nets" v-model="cfg.networks" :validate="validateNetwork" :max="10" placeholder="platform-edge" />
          </UiField>
          <p v-if="networks.length" class="muted small">Réseaux existants : <span v-for="n in networks" :key="n" class="chip mono link" @click="!cfg.networks.includes(n) && cfg.networks.push(n)">{{ n }}</span></p>
        </div>

        <div v-else-if="STEPS[step]!.key === 'acme'" class="stack">
          <UiSwitch v-model="cfg.acme.enabled" label="Obtenir les certificats automatiquement (ACME)" />
          <template v-if="cfg.acme.enabled">
            <UiField label="E-mail de contact ACME" for="mp-mail" :error="errors['config.acme.email']" required>
              <input id="mp-mail" :value="cfg.acme.email ?? ''" class="input" type="email" @input="cfg.acme.email = ($event.target as HTMLInputElement).value.trim() || null">
            </UiField>
            <div class="radios" role="radiogroup" aria-label="Challenge ACME">
              <label :class="{ on: cfg.acme.challenge === 'http' }"><input v-model="cfg.acme.challenge" type="radio" value="http"> <strong>HTTP-01</strong> <span class="muted small">port 80 joignable depuis Internet</span></label>
              <label :class="{ on: cfg.acme.challenge === 'tls' }"><input v-model="cfg.acme.challenge" type="radio" value="tls"> <strong>TLS-ALPN-01</strong> <span class="muted small">port 443 joignable depuis Internet</span></label>
              <label :class="{ on: cfg.acme.challenge === 'dns' }"><input v-model="cfg.acme.challenge" type="radio" value="dns"> <strong>DNS-01</strong> <span class="muted small">hôte non exposé, jokers possibles</span></label>
            </div>
            <template v-if="cfg.acme.challenge === 'dns'">
              <UiField label="Fournisseur DNS" for="mp-dns" hint="Code du fournisseur (ex. ovh, cloudflare, route53, gandiv5)" required>
                <input id="mp-dns" :value="cfg.acme.dnsProvider ?? ''" class="input mono" @input="cfg.acme.dnsProvider = ($event.target as HTMLInputElement).value.trim().toLowerCase() || null">
              </UiField>
              <div class="env">
                <strong class="small">Identifiants du fournisseur (variables chiffrées, jamais réaffichées)</strong>
                <div v-for="(v, i) in dnsEnv" :key="i" class="env-row">
                  <input v-model.trim="v.name" class="input mono" placeholder="OVH_APPLICATION_KEY" aria-label="Nom de la variable" @input="v.name = v.name.toUpperCase()">
                  <input v-model="v.value" class="input mono" type="password" autocomplete="off" :placeholder="v.existing ? 'inchangée' : 'valeur'" aria-label="Valeur">
                  <UiButton size="sm" variant="ghost" aria-label="Retirer" @click="dnsEnv.splice(i, 1)"><Trash2 :size="14" /></UiButton>
                </div>
                <UiButton size="sm" variant="ghost" @click="dnsEnv.push({ name: '', value: '', existing: false })"><Plus :size="14" /> Ajouter une variable</UiButton>
              </div>
            </template>
            <UiSwitch v-model="cfg.acme.staging" label="Autorité de test (recommandé pour les premiers essais)" />
            <UiField label="Autre autorité ACME (facultatif)" for="mp-ca" hint="URL du répertoire ACME ; vide : Let's Encrypt">
              <input id="mp-ca" :value="cfg.acme.caServer ?? ''" class="input mono" placeholder="https://acme.example.org/directory" @input="cfg.acme.caServer = ($event.target as HTMLInputElement).value.trim() || null">
            </UiField>
          </template>
        </div>

        <div v-else class="stack">
          <p v-if="saving" class="muted">Enregistrement et aperçu…</p>
          <template v-if="preview">
            <ul v-if="preview.conflicts.length" class="issues">
              <li v-for="(c, i) in preview.conflicts" :key="i" class="err"><TriangleAlert :size="14" /> {{ c }}</li>
            </ul>
            <ul v-if="preview.warnings.length" class="issues">
              <li v-for="(w, i) in preview.warnings" :key="i" class="warn"><TriangleAlert :size="14" /> {{ w }}</li>
            </ul>
            <p v-if="preview.networksToCreate.length" class="small">Réseaux créés sur l'hôte : <span v-for="n in preview.networksToCreate" :key="n" class="chip mono">{{ n }}</span></p>
            <details>
              <summary class="small">Compose généré</summary>
              <pre class="code">{{ preview.composeText }}</pre>
            </details>
          </template>
        </div>

        <footer class="foot">
          <UiButton v-if="step > 0" @click="go(step - 1)">Précédent</UiButton>
          <span class="spacer" />
          <span v-if="stepBlocker" class="muted small">{{ stepBlocker }}</span>
          <UiButton v-if="step < STEPS.length - 1" variant="primary" :disabled="!!stepBlocker" @click="go(step + 1)">Suivant</UiButton>
          <UiButton v-else variant="primary" :loading="applying" :disabled="!preview || preview.conflicts.length > 0" @click="apply">Déployer Traefik</UiButton>
        </footer>
      </div>
    </UiDrawer>
  </section>
</template>

<style scoped>
.pad { padding: var(--space-3) var(--space-4); display: flex; flex-direction: column; gap: var(--space-3); }
.head { display: flex; justify-content: space-between; align-items: center; gap: var(--space-3); }
.title { display: flex; gap: var(--space-3); align-items: center; }
.title h2 { margin: 0; }
.ico { width: 34px; height: 34px; border-radius: 9px; display: grid; place-items: center; background: var(--primary-soft); color: var(--primary); }
.small { font-size: 12.5px; }
.kv { display: grid; grid-template-columns: 110px 1fr; gap: 3px var(--space-4); margin: 0; font-size: 13.5px; }
.kv dt { color: var(--text-muted); }
.kv dd { margin: 0; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.chip { display: inline-block; padding: 1px 8px; border-radius: 999px; background: var(--surface-2); border: 1px solid var(--border); font-size: 12px; margin-right: 4px; }
.chip.link { cursor: pointer; }
.alert { margin: 0; padding: var(--space-3) var(--space-4); border-radius: var(--radius); background: var(--danger-bg); color: var(--danger); display: flex; gap: 6px; align-items: center; }
.actions { display: flex; gap: var(--space-2); }
.acme { display: flex; flex-direction: column; gap: var(--space-2); border-top: 1px solid var(--border); padding-top: var(--space-3); }
.acme-head { display: flex; align-items: center; gap: var(--space-3); }
.acme-head h3 { margin: 0; font-size: 14px; }
.table { width: 100%; border-collapse: collapse; font-size: 13px; }
.table th { text-align: left; font-size: 11px; text-transform: uppercase; color: var(--text-muted); padding: 4px 8px; border-bottom: 1px solid var(--border); }
.table td { padding: 4px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
.err-msg { color: var(--danger); margin-top: 4px; max-width: 520px; word-break: break-word; }
.wiz { display: flex; flex-direction: column; gap: var(--space-4); }
.stack { display: flex; flex-direction: column; gap: var(--space-3); }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
.radios { display: flex; flex-direction: column; gap: 6px; }
.radios label { display: flex; gap: 8px; align-items: center; padding: 8px 12px; border: 1px solid var(--border); border-radius: var(--radius); cursor: pointer; }
.radios label.on { border-color: var(--primary); background: var(--info-bg); }
.env { display: flex; flex-direction: column; gap: 6px; }
.env-row { display: grid; grid-template-columns: 1fr 1fr auto; gap: var(--space-2); }
.issues { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
.issues li { display: flex; gap: 6px; align-items: center; }
.issues .err { color: var(--danger); }
.issues .warn { color: var(--warning); }
.code { margin: var(--space-2) 0 0; padding: var(--space-3); background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius); font-size: 12px; max-height: 360px; overflow: auto; }
.foot { display: flex; align-items: center; gap: var(--space-3); border-top: 1px solid var(--border); padding-top: var(--space-3); }
.spacer { flex: 1; }
@media (max-width: 760px) { .grid, .env-row { grid-template-columns: 1fr; } }
</style>
