<script setup lang="ts">
/**
 * Assistant d'ajout d'un hôte, joint en SSH ou par son agent Portainer (§5.1).
 * Rien n'est enregistré avant la validation finale : le serveur et toute sa
 * configuration sont créés en une seule transaction côté API.
 * Le token reste uniquement en mémoire de la page, le temps de l'assistant.
 */
import { AGENT_IMAGE } from '#shared/utils/host-install'
import type { DiscoveredEndpoint, DiscoveryPreview, NetworkDecision, PathConfigInput, PortRuleInput, TraefikConfigInput } from '#shared/schemas/infra'
import { PROXY_DEFAULTS, defaultPathConfig } from '#shared/schemas/infra'
import type { ConnectionTestResult, SshHostKeyScan } from '#shared/schemas/servers'
import { CONSOLE_HOST, LOOPBACK_MESSAGE, isLoopbackHost, urlHost, withConsoleHost } from '#shared/utils/console-host'
import { defaultNetworkDecision } from '#shared/utils/networks'
import type { NetworkRow } from '~/types/infra'

useHead({ title: 'Ajouter un serveur' })
const toast = useToast()
const route = useRoute()
const confirm = useConfirm()
const { data: environments } = await useEnvironments()

const STEPS = [
  { key: 'identity', label: 'Identification' },
  { key: 'connection', label: 'Connexion' },
  { key: 'check', label: 'Sécurité, test et version' },
  { key: 'endpoints', label: 'Endpoints' },
  { key: 'environments', label: 'Environnements' },
  { key: 'networks', label: 'Réseaux et volumes' },
  { key: 'paths', label: 'Chemins de travail' },
  { key: 'ports', label: 'Ports' },
  { key: 'traefik', label: 'Traefik et domaines' },
  { key: 'summary', label: 'Validation finale' },
] as const
type StepKey = (typeof STEPS)[number]['key']

const step = ref(0)
const reached = ref(0)
const stepKey = computed<StepKey>(() => STEPS[step.value]!.key)

// --- État de l'assistant ---
const form = reactive({
  name: '', description: '', tags: [] as string[],
  // SSH (aucun agent ni Runner sur l'hôte) par défaut, ou agent Portainer.
  transport: 'ssh' as 'agent' | 'ssh',
  url: '', token: '', tlsVerify: false, useCa: false, caCertPem: '',
  sshHost: '', sshPort: 22, sshUser: '', sshAuth: 'key' as 'key' | 'password', sshPassword: '', sshKey: '', sshPassphrase: '',
  hostKey: '', dockerSocket: '/var/run/docker.sock',
})

// Hôte de la console : « localhost » désigne son conteneur, la machine se joint par CONSOLE_HOST.
const sshTarget = ref<'other' | 'console'>('other')
function useConsoleHost() {
  sshTarget.value = 'console'
}
watch(sshTarget, (t) => {
  if (t === 'console') form.sshHost = CONSOLE_HOST
  else if (form.sshHost === CONSOLE_HOST) form.sshHost = ''
})
const sshLoopback = computed(() => isLoopbackHost(form.sshHost))
const agentLoopback = computed(() => isLoopbackHost(urlHost(form.url)))

// Clé d'hôte SSH : lue, puis confirmée explicitement (comparée à celle de l'hôte, hors console).
const hostKeyScan = ref<SshHostKeyScan | null>(null)
const scanning = ref(false)
async function scanHostKey() {
  scanning.value = true
  form.hostKey = ''
  try {
    hostKeyScan.value = await $fetch<SshHostKeyScan>('/api/servers/ssh-host-key', { method: 'POST', body: { host: form.sshHost.trim(), port: form.sshPort } })
  }
  catch (err) {
    hostKeyScan.value = null
    toast.error(apiError(err).message)
  }
  finally {
    scanning.value = false
  }
}
watch(() => [form.sshHost, form.sshPort], () => {
  hostKeyScan.value = null
  form.hostKey = ''
})
async function readKeyFile(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (!f) return
  if (f.size > 20_000) return toast.error('Fichier trop volumineux pour une clé privée')
  form.sshKey = await f.text()
  ;(e.target as HTMLInputElement).value = ''
}
const keyTypeLabel = (t: string) => ({ 'ssh-ed25519': 'ED25519', 'ssh-rsa': 'RSA', 'ecdsa-sha2-nistp256': 'ECDSA P-256', 'ecdsa-sha2-nistp384': 'ECDSA P-384', 'ecdsa-sha2-nistp521': 'ECDSA P-521' } as Record<string, string>)[t] ?? t
const hostKeyFile = (t: string) => (t.startsWith('ecdsa-') ? 'ecdsa' : t.replace(/^ssh-/, ''))
const sshUrl = computed(() => `ssh://${form.sshUser.trim()}@${form.sshHost.trim()}:${form.sshPort}`)
function generateSecret() {
  form.token = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('')
  showSecret.value = true
}
const showSecret = ref(false)
// Secret généré par « Installer un hôte » (tableau de bord), transmis par l'état de navigation.
// Variante SSH : transport, utilisateur et socket préremplis.
onMounted(() => {
  const st = (history.state ?? {}) as { agentSecret?: unknown, transport?: unknown, sshUser?: unknown, dockerSocket?: unknown }
  if (typeof st.agentSecret === 'string' && /^[\w-]{16,128}$/.test(st.agentSecret) && !form.token) {
    form.token = st.agentSecret
    form.transport = 'agent'
  }
  if (st.transport === 'ssh') {
    form.transport = 'ssh'
    if (typeof st.sshUser === 'string' && /^[a-z_][a-z0-9_-]{0,31}$/.test(st.sshUser)) form.sshUser = st.sshUser
    if (typeof st.dockerSocket === 'string' && /^\/[\w./-]{1,255}$/.test(st.dockerSocket)) form.dockerSocket = st.dockerSocket
  }
})
const installCommand = computed(() => [
  'docker run -d --name portainer_agent --restart=always -p 9001:9001 \\',
  `  -e AGENT_SECRET=${showSecret.value && form.token ? form.token : '<AGENT_SECRET>'} \\`,
  '  -v /var/run/docker.sock:/var/run/docker.sock \\',
  '  -v /var/lib/docker/volumes:/var/lib/docker/volumes \\',
  `  ${AGENT_IMAGE}`,
].join('\n'))
async function copyInstall() {
  await navigator.clipboard.writeText(installCommand.value.replace('<AGENT_SECRET>', form.token || '<AGENT_SECRET>'))
  toast.success('Commande copiée')
}

interface EndpointState {
  enabled: boolean
  environmentKeys: string[]
  networks: Record<string, NetworkDecision>
  paths: Record<string, PathConfigInput>
  portRules: PortRuleInput[]
  traefikEnabled: boolean
  traefik: TraefikConfigInput
}

const test = ref<ConnectionTestResult | null>(null)
const testing = ref(false)
const preview = ref<DiscoveryPreview | null>(null)
const discovering = ref(false)
const eps = ref<Record<number, EndpointState>>({})
const pathErrors = ref<Record<string, Record<string, string>>>({})
const submitErrors = ref<Record<string, string>>({})
const submitting = ref(false)
const submitted = ref(false)

const connection = computed(() => form.transport === 'ssh'
  ? {
      transport: 'ssh' as const,
      host: form.sshHost.trim(),
      port: form.sshPort,
      username: form.sshUser.trim(),
      auth: form.sshAuth,
      ...(form.sshAuth === 'key' ? { privateKey: form.sshKey, ...(form.sshPassphrase ? { passphrase: form.sshPassphrase } : {}) } : { password: form.sshPassword }),
      hostKey: form.hostKey,
      dockerSocket: form.dockerSocket.trim(),
    }
  : {
      transport: 'agent' as const,
      url: form.url.trim(),
      token: form.token,
      tlsVerify: form.tlsVerify,
      ...(form.useCa && form.caCertPem.trim() ? { caCertPem: form.caCertPem.trim() } : {}),
    })

// Toute modification de la connexion invalide le test et la découverte.
watch(() => JSON.stringify(connection.value), () => {
  test.value = null
  preview.value = null
  eps.value = {}
  reached.value = Math.min(reached.value, 2)
})

const enabledEndpoints = computed<DiscoveredEndpoint[]>(() => (preview.value?.endpoints ?? []).filter(e => eps.value[e.id]?.enabled))
const envName = (key: string) => environments.value.find(e => e.key === key)?.name ?? key
const isProd = (key: string) => environments.value.find(e => e.key === key)?.isProduction ?? false

// --- Actions distantes ---
async function runTest() {
  testing.value = true
  try {
    test.value = await $fetch<ConnectionTestResult>('/api/servers/test-connection', { method: 'POST', body: connection.value })
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    testing.value = false
  }
}

async function runDiscovery() {
  discovering.value = true
  try {
    preview.value = await $fetch<DiscoveryPreview>('/api/servers/discover-preview', { method: 'POST', body: connection.value })
    initEndpoints(preview.value)
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    discovering.value = false
  }
}

function initEndpoints(p: DiscoveryPreview) {
  for (const ep of p.endpoints) {
    if (eps.value[ep.id]) continue
    const traefikNets = ep.inventory.traefik?.networks ?? []
    eps.value[ep.id] = {
      enabled: ep.supported && ep.online && !ep.error,
      environmentKeys: [],
      networks: Object.fromEntries(ep.networks.map(n => [n.name, defaultNetworkDecision(n, traefikNets)])),
      paths: {},
      portRules: [],
      traefikEnabled: !!ep.inventory.traefik,
      traefik: {
        ...PROXY_DEFAULTS,
        networkName: traefikNets[0] ?? '',
        certResolver: null,
        entrypointHttp: 'web',
        entrypointHttps: 'websecure',
        allowedDomains: [],
        defaultMiddlewares: [],
        routerNamePattern: '{project}-{env}-{service}',
        exposure: 'internal',
        redirectToHttps: true,
      },
    }
  }
}

function toggleEnvironment(id: number, key: string) {
  const s = eps.value[id]!
  s.environmentKeys = s.environmentKeys.includes(key) ? s.environmentKeys.filter(k => k !== key) : [...s.environmentKeys, key]
  s.paths[key] ??= defaultPathConfig(key)
}

function networkRows(ep: DiscoveredEndpoint): NetworkRow[] {
  const s = eps.value[ep.id]!
  return ep.networks.map(n => ({ ...s.networks[n.name]!, name: n.name, driver: n.driver, scope: n.scope, internal: n.internal }))
}

function allowedNetworks(id: number): string[] {
  return Object.entries(eps.value[id]?.networks ?? {}).filter(([, d]) => d.policy === 'allowed').map(([n]) => n)
}

/** Validation des chemins par l'API (règles de sécurité côté backend). */
async function validatePaths(): Promise<boolean> {
  const errors: Record<string, Record<string, string>> = {}
  await Promise.all(enabledEndpoints.value.map(async (ep) => {
    const s = eps.value[ep.id]!
    const configs = Object.fromEntries(s.environmentKeys.map(env => [env, s.paths[env]]))
    try {
      const r = await $fetch<{ ok: boolean, errors: Record<string, Record<string, string>>, values: Record<string, PathConfigInput> }>('/api/servers/validate-paths', { method: 'POST', body: { configs } })
      // Les valeurs normalisées par le serveur remplacent la saisie.
      for (const [env, v] of Object.entries(r.values)) if (!r.errors[env]) s.paths[env] = v
      for (const [env, fe] of Object.entries(r.errors)) errors[`${ep.id}:${env}`] = fe
    }
    catch (err) {
      const e = apiError(err)
      for (const env of s.environmentKeys) errors[`${ep.id}:${env}`] = { workingRoot: e.message }
    }
  }))
  pathErrors.value = errors
  return Object.keys(errors).length === 0
}

// --- Navigation ---
const stepBlocker = computed<string | null>(() => {
  switch (stepKey.value) {
    case 'identity': return form.name.trim().length >= 2 ? null : 'Nom requis (2 caractères minimum)'
    case 'connection':
      if (form.transport === 'ssh') {
        if (!form.sshHost.trim()) return 'Hôte SSH requis'
        if (sshLoopback.value) return LOOPBACK_MESSAGE
        if (!form.sshUser.trim()) return 'Utilisateur SSH requis'
        if (form.sshAuth === 'password' && !form.sshPassword) return 'Mot de passe requis'
        if (form.sshAuth === 'key' && !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(form.sshKey)) return 'Clé privée requise'
        if (!form.hostKey) return 'Lire puis confirmer l\'empreinte de la clé d\'hôte'
        return null
      }
      if (!/^https?:\/\/[^\s]+$/.test(form.url.trim())) return 'URL http(s) requise'
      if (agentLoopback.value) return LOOPBACK_MESSAGE
      if (form.token.length < 10) return 'AGENT_SECRET requis (10 caractères minimum)'
      return null
    case 'check': return test.value?.ok ? null : 'La connexion doit être validée'
    case 'endpoints': return enabledEndpoints.value.length ? null : 'Activer au moins un endpoint'
    case 'environments': {
      const missing = enabledEndpoints.value.find(e => eps.value[e.id]!.environmentKeys.length === 0)
      return missing ? `${missing.name} : choisir au moins un environnement` : null
    }
    case 'ports': {
      const bad = enabledEndpoints.value.find(e => eps.value[e.id]!.portRules.some(r => r.portTo < r.portFrom || r.portFrom < 1 || r.portTo > 65535))
      return bad ? `${bad.name} : plage de ports invalide` : null
    }
    case 'traefik': {
      for (const ep of enabledEndpoints.value) {
        const s = eps.value[ep.id]!
        if (!s.traefikEnabled) continue
        if (!s.traefik.networkName) return `${ep.name} : choisir le réseau Traefik`
        if (!allowedNetworks(ep.id).includes(s.traefik.networkName)) return `${ep.name} : le réseau Traefik doit être autorisé (étape Réseaux)`
        if (s.traefik.exposure === 'external' && !s.traefik.allowedDomains.length) return `${ep.name} : une exposition externe exige un domaine`
      }
      return null
    }
    default: return null
  }
})

async function next() {
  if (stepBlocker.value) return
  if (stepKey.value === 'paths' && !(await validatePaths())) {
    toast.error('Certains chemins sont refusés : voir le détail sous chaque champ')
    return
  }
  go(step.value + 1)
}

function go(i: number) {
  step.value = i
  reached.value = Math.max(reached.value, i)
}

watch(stepKey, (k) => {
  if (k === 'check' && !test.value && !testing.value) void runTest()
  if (k === 'endpoints' && !preview.value && !discovering.value) void runDiscovery()
  submitErrors.value = k === 'summary' ? submitErrors.value : {}
})

// --- Validation finale ---
const STEP_OF_ERROR: [RegExp, StepKey][] = [
  [/^name$/, 'identity'],
  [/\.paths\./, 'paths'],
  [/\.portRules\./, 'ports'],
  [/\.traefik\./, 'traefik'],
  [/\.networks\./, 'networks'],
  [/\.environmentKeys$/, 'environments'],
  [/\.(enabled|portainerEndpointId)$/, 'endpoints'],
]
function stepForError(key: string): number {
  const k = STEP_OF_ERROR.find(([re]) => re.test(key))?.[1] ?? 'summary'
  return STEPS.findIndex(s => s.key === k)
}

async function submit() {
  if (!preview.value) return
  submitting.value = true
  submitErrors.value = {}
  const body = {
    name: form.name.trim(),
    description: form.description.trim() || undefined,
    tags: form.tags,
    ...connection.value,
    endpoints: preview.value.endpoints.map((ep) => {
      const s = eps.value[ep.id]!
      return {
        portainerEndpointId: ep.id,
        enabled: s.enabled,
        environmentKeys: s.enabled ? s.environmentKeys : [],
        networks: s.networks,
        paths: s.enabled ? s.environmentKeys.map(env => ({ ...s.paths[env]!, environmentKey: env })) : [],
        portRules: s.enabled ? s.portRules : [],
        traefik: s.enabled && s.traefikEnabled ? s.traefik : null,
      }
    }),
  }
  try {
    const { id } = await $fetch<{ id: string }>('/api/servers/wizard', { method: 'POST', body })
    submitted.value = true
    form.token = ''
    form.sshPassword = ''
    form.sshKey = ''
    form.sshPassphrase = ''
    toast.success(`Serveur « ${body.name} » ajouté`)
    // Retour vers l'assistant d'initialisation s'il a ouvert cet écran (chemin local uniquement).
    const back = typeof route.query.returnTo === 'string' && /^\/(?!\/)[\w\-/?=&]*$/.test(route.query.returnTo) ? route.query.returnTo : null
    await navigateTo(back ?? `/servers/${id}`)
  }
  catch (err) {
    const e = apiError(err)
    submitErrors.value = Object.keys(e.errors).length ? e.errors : { _: e.message }
  }
  finally {
    submitting.value = false
  }
}

// Remplace la boîte native « quitter la page » par une confirmation custom.
onBeforeRouteLeave(async () => {
  if (submitted.value || (!form.name && !form.url && !form.token && !form.sshHost)) return true
  return confirm({ title: 'Abandonner l\'assistant ?', message: 'La configuration saisie n\'a pas été enregistrée et sera perdue.', confirmLabel: 'Abandonner', danger: true })
})

const summary = computed(() => enabledEndpoints.value.map((ep) => {
  const s = eps.value[ep.id]!
  const decisions = Object.values(s.networks)
  return {
    ep,
    s,
    allowed: decisions.filter(d => d.policy === 'allowed').length,
    forbidden: decisions.filter(d => d.policy === 'forbidden').length,
    unreviewed: decisions.filter(d => d.policy === 'unreviewed').length,
  }
}))
</script>

<template>
  <div>
    <UiPageHeader title="Ajouter un serveur" icon="server-cog" :back="{ to: '/servers', label: 'Serveurs' }" />

    <div class="wizard">
      <aside class="card side">
        <UiStepper :steps="[...STEPS]" :current="step" :reached="reached" @go="go" />
      </aside>

      <section class="card main">
        <header class="main-head">
          <span class="muted">Étape {{ step + 1 }} sur {{ STEPS.length }}</span>
          <h2>{{ STEPS[step]!.label }}</h2>
        </header>

        <div class="main-body">
          <!-- 1. Identification -->
          <div v-if="stepKey === 'identity'" class="stack">
            <UiField label="Nom du serveur" for="w-name" hint="Identifiant lisible, unique dans la plateforme" required>
              <input id="w-name" v-model="form.name" class="input" maxlength="100" placeholder="docker-prod-01" autofocus>
            </UiField>
            <UiField label="Description" for="w-desc">
              <textarea id="w-desc" v-model="form.description" class="input" rows="3" maxlength="1000" />
            </UiField>
            <UiField label="Étiquettes" for="w-tags" hint="Entrée pour ajouter">
              <UiTagInput id="w-tags" v-model="form.tags" placeholder="prod, paris…" :max="20" />
            </UiField>
          </div>

          <!-- 2. Connexion -->
          <div v-else-if="stepKey === 'connection'" class="stack">
            <div class="seg" role="radiogroup" aria-label="Mode de connexion">
              <button type="button" role="radio" :aria-checked="form.transport === 'ssh'" :class="{ on: form.transport === 'ssh' }" @click="form.transport = 'ssh'">SSH</button>
              <button type="button" role="radio" :aria-checked="form.transport === 'agent'" :class="{ on: form.transport === 'agent' }" @click="form.transport = 'agent'">Agent Portainer</button>
            </div>
            <template v-if="form.transport === 'ssh'">
              <p class="muted small">Rien à installer sur l'hôte : la console utilise sshd (API Docker par le socket de l'hôte, fichiers des releases par SFTP). Mêmes fonctions qu'avec l'agent et le Runner.</p>
              <div class="seg small-seg" role="radiogroup" aria-label="Hôte à joindre">
                <button type="button" role="radio" :aria-checked="sshTarget === 'other'" :class="{ on: sshTarget === 'other' }" @click="sshTarget = 'other'">Autre hôte</button>
                <button type="button" role="radio" :aria-checked="sshTarget === 'console'" :class="{ on: sshTarget === 'console' }" @click="sshTarget = 'console'">Hôte de la console</button>
              </div>
              <p v-if="sshTarget === 'console'" class="muted small">La machine qui héberge la console, jointe sous <code>{{ CONSOLE_HOST }}</code> : depuis le conteneur de la console, <code>localhost</code> désigne le conteneur lui-même. sshd doit accepter les connexions venant des réseaux Docker (pare-feu).</p>
              <div class="row-3">
                <UiField label="Hôte" for="w-ssh-host" :error="sshLoopback ? LOOPBACK_MESSAGE : null" required>
                  <input id="w-ssh-host" v-model.trim="form.sshHost" class="input mono" placeholder="docker-prod-01.interne" autocomplete="off" spellcheck="false" :readonly="sshTarget === 'console'">
                  <UiButton v-if="sshLoopback" size="sm" variant="ghost" @click="useConsoleHost">Utiliser {{ CONSOLE_HOST }}</UiButton>
                </UiField>
                <UiField label="Port" for="w-ssh-port">
                  <input id="w-ssh-port" v-model.number="form.sshPort" class="input mono" type="number" min="1" max="65535">
                </UiField>
                <UiField label="Utilisateur" for="w-ssh-user" required>
                  <input id="w-ssh-user" v-model.trim="form.sshUser" class="input mono" placeholder="deploy" autocomplete="off" spellcheck="false">
                </UiField>
              </div>
              <div class="seg small-seg" role="radiogroup" aria-label="Authentification SSH">
                <button type="button" role="radio" :aria-checked="form.sshAuth === 'key'" :class="{ on: form.sshAuth === 'key' }" @click="form.sshAuth = 'key'">Clé privée</button>
                <button type="button" role="radio" :aria-checked="form.sshAuth === 'password'" :class="{ on: form.sshAuth === 'password' }" @click="form.sshAuth = 'password'">Mot de passe</button>
              </div>
              <template v-if="form.sshAuth === 'key'">
                <UiField label="Clé privée" for="w-ssh-key" hint="OpenSSH ou PEM. Chiffrée à l'enregistrement, jamais réaffichée." required>
                  <textarea id="w-ssh-key" v-model="form.sshKey" class="input mono secret-text" rows="4" spellcheck="false" autocomplete="off" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" />
                  <label class="file small"><input type="file" @change="readKeyFile"> Charger un fichier…</label>
                </UiField>
                <UiField label="Phrase de passe de la clé" for="w-ssh-pass" hint="Si la clé est chiffrée">
                  <input id="w-ssh-pass" v-model="form.sshPassphrase" class="input" type="password" autocomplete="off">
                </UiField>
              </template>
              <UiField v-else label="Mot de passe" for="w-ssh-pw" hint="Chiffré à l'enregistrement, jamais réaffiché. Une clé dédiée est préférable." required>
                <input id="w-ssh-pw" v-model="form.sshPassword" class="input" type="password" autocomplete="off">
              </UiField>
              <UiField label="Socket Docker sur l'hôte" for="w-ssh-sock" hint="L'utilisateur doit pouvoir l'utiliser (groupe docker : équivalent à un accès root sur l'hôte).">
                <input id="w-ssh-sock" v-model.trim="form.dockerSocket" class="input mono">
              </UiField>
              <div class="install">
                <div class="install-head">
                  <strong class="small">Clé d'hôte</strong>
                  <UiButton size="sm" :loading="scanning" :disabled="!form.sshHost.trim()" @click="scanHostKey">{{ hostKeyScan ? 'Relire' : 'Lire la clé d\'hôte' }}</UiButton>
                </div>
                <template v-if="hostKeyScan">
                  <p class="small">L'hôte présente une clé <strong>{{ keyTypeLabel(hostKeyScan.keyType) }}</strong> d'empreinte :</p>
                  <pre class="mono">{{ hostKeyScan.fingerprint }}</pre>
                  <p class="muted small">Comparer sur l'hôte, par un autre canal : <code>ssh-keygen -lf /etc/ssh/ssh_host_{{ hostKeyFile(hostKeyScan.keyType) }}_key.pub</code></p>
                  <UiButton v-if="form.hostKey !== hostKeyScan.fingerprint" size="sm" variant="primary" class="self-start" @click="form.hostKey = hostKeyScan.fingerprint">Je confirme cette empreinte</UiButton>
                  <p v-else class="ok-text small">Empreinte confirmée : toute autre clé sera refusée.</p>
                </template>
                <p v-else class="muted small">La console refuse toute connexion dont la clé d'hôte n'a pas été confirmée (protection contre l'interception).</p>
              </div>
            </template>
            <template v-else>
            <UiField label="Adresse de l'agent" for="w-url" :hint="`Port 9001 de l'hôte, ex. https://docker-prod-01.interne:9001 ; hôte de la console : https://${CONSOLE_HOST}:9001`" :error="agentLoopback ? LOOPBACK_MESSAGE : null" required>
              <input id="w-url" v-model.trim="form.url" class="input mono" type="url" placeholder="https://docker-prod-01.interne:9001">
              <UiButton v-if="agentLoopback" size="sm" variant="ghost" @click="form.url = withConsoleHost(form.url)">Utiliser {{ CONSOLE_HOST }}</UiButton>
            </UiField>
            <UiField label="AGENT_SECRET" for="w-token" hint="Secret partagé défini sur l'agent. Chiffré à l'enregistrement, jamais réaffiché ; la console ne l'envoie jamais, elle signe ses requêtes avec." required>
              <div class="secret">
                <input id="w-token" v-model="form.token" class="input mono" :type="showSecret ? 'text' : 'password'" autocomplete="off" spellcheck="false">
                <UiButton size="sm" variant="ghost" @click="showSecret = !showSecret">{{ showSecret ? 'Masquer' : 'Afficher' }}</UiButton>
                <UiButton size="sm" @click="generateSecret">Générer</UiButton>
              </div>
            </UiField>
            <div class="install">
              <div class="install-head"><strong class="small">Installation de l'agent sur l'hôte</strong><UiButton size="sm" variant="ghost" @click="copyInstall">Copier</UiButton></div>
              <pre class="mono">{{ installCommand }}</pre>
              <p class="muted small">Un agent déjà installé doit être relancé avec AGENT_SECRET. Le port 9001 ne doit être ouvert qu'à la console.</p>
            </div>
            <UiSwitch v-model="form.tlsVerify" label="Vérifier le certificat TLS" />
            <div v-if="!form.tlsVerify" class="alert alert--warning">Vérification TLS désactivée : l'agent présente par défaut un certificat auto-signé, régénéré à chaque démarrage. Les requêtes restent signées, mais le trafic peut être intercepté. Pour vérifier le certificat, fournir à l'agent un certificat de votre AC (MTLS_SSL_CERT, MTLS_SSL_KEY, MTLS_SSL_CA).</div>
            <UiSwitch v-model="form.useCa" label="Utiliser une autorité de certification interne" :disabled="!form.tlsVerify" />
            <UiField v-if="form.useCa && form.tlsVerify" label="Certificat de l'AC (PEM)" for="w-ca">
              <textarea id="w-ca" v-model="form.caCertPem" class="input mono" rows="6" placeholder="-----BEGIN CERTIFICATE-----" />
            </UiField>
            </template>
          </div>

          <!-- 3. TLS, test et version -->
          <div v-else-if="stepKey === 'check'" class="stack">
            <ul class="checks">
              <li v-if="form.transport === 'ssh'" class="ok">
                <span class="dot" />
                Clé d'hôte confirmée : <span class="mono">{{ form.hostKey }}</span>
              </li>
              <li v-else :class="form.tlsVerify ? 'ok' : 'warn'">
                <span class="dot" />
                Validation TLS : {{ form.tlsVerify ? (form.useCa ? 'active, AC interne' : 'active') : 'désactivée' }}
              </li>
              <li :class="testing ? 'pending' : test?.ok ? 'ok' : test ? 'ko' : 'pending'">
                <span class="dot" />
                Connexion :
                <template v-if="testing">test en cours…</template>
                <template v-else-if="test?.ok">réussie en {{ test.durationMs }} ms</template>
                <template v-else-if="test">échec — {{ test.error }}</template>
              </li>
              <li :class="test?.supported ? 'ok' : test?.version ? 'ko' : 'pending'">
                <span class="dot" />
                {{ form.transport === 'ssh' ? 'Moteur Docker' : 'Version de l\'agent' }} : {{ test?.version ?? '—' }}
                <template v-if="test?.version">({{ test.supported ? 'supportée' : form.transport === 'ssh' ? 'Docker 20 ou plus récent requis' : '2.x requis' }})</template>
              </li>
            </ul>
            <UiButton :loading="testing" class="self-start" @click="runTest">Relancer le test</UiButton>
          </div>

          <!-- 4. Endpoints -->
          <div v-else-if="stepKey === 'endpoints'" class="stack">
            <p v-if="discovering" class="muted">Découverte des endpoints, réseaux et volumes…</p>
            <template v-else-if="preview">
              <p class="muted">{{ form.transport === 'ssh' ? preview.version : `Agent ${preview.version}` }} · {{ preview.endpoints.length }} endpoint(s). Seul Docker Standalone est déployable pour l'instant.</p>
              <div class="ep-list">
                <label v-for="ep in preview.endpoints" :key="ep.id" class="ep card" :class="{ disabled: !ep.supported || !!ep.error }">
                  <input v-model="eps[ep.id]!.enabled" type="checkbox" :disabled="!ep.supported || !!ep.error">
                  <div class="ep-body">
                    <div class="ep-title">
                      <strong>{{ ep.name }}</strong>
                      <UiBadge :tone="ep.online ? 'success' : 'danger'">{{ ep.online ? 'en ligne' : 'hors ligne' }}</UiBadge>
                      <UiBadge>{{ ep.kind }}</UiBadge>
                      <UiBadge v-if="!ep.supported" tone="warning">non supporté</UiBadge>
                    </div>
                    <div class="muted small mono">{{ ep.url }}</div>
                    <div v-if="ep.error" class="small error-inline">{{ ep.error }}</div>
                    <div v-else-if="ep.supported" class="small muted">
                      {{ ep.inventory.running }}/{{ ep.inventory.containers }} conteneurs actifs · {{ ep.inventory.images }} images · {{ ep.inventory.stacks }} stacks ·
                      {{ ep.networks.length }} réseaux · {{ ep.volumes.length }} volumes
                      <template v-if="ep.inventory.traefik"> · Traefik détecté ({{ ep.inventory.traefik.image }})</template>
                    </div>
                  </div>
                </label>
              </div>
              <UiButton size="sm" class="self-start" :loading="discovering" @click="runDiscovery">Relancer la découverte</UiButton>
            </template>
          </div>

          <!-- 5. Environnements -->
          <div v-else-if="stepKey === 'environments'" class="stack">
            <p class="muted">Environnements pouvant être déployés sur chaque endpoint. Les chemins de travail seront définis pour chacun.</p>
            <div v-for="ep in enabledEndpoints" :key="ep.id" class="block">
              <h3>{{ ep.name }}</h3>
              <div class="env-choices">
                <label v-for="e in environments" :key="e.key" class="env-choice" :class="{ on: eps[ep.id]!.environmentKeys.includes(e.key) }">
                  <input type="checkbox" :checked="eps[ep.id]!.environmentKeys.includes(e.key)" @change="toggleEnvironment(ep.id, e.key)">
                  {{ e.name }}
                  <UiBadge v-if="e.isProduction" tone="danger">prod</UiBadge>
                </label>
              </div>
              <p v-if="eps[ep.id]!.environmentKeys.some(isProd) && eps[ep.id]!.environmentKeys.some(k => !isProd(k))" class="alert alert--warning small">
                Production et hors-production partagent cet endpoint : les isoler sur des hôtes distincts est recommandé.
              </p>
            </div>
          </div>

          <!-- 6. Réseaux et volumes -->
          <div v-else-if="stepKey === 'networks'" class="stack">
            <p class="muted">
              Seuls les réseaux <strong>autorisés</strong> pourront être utilisés par les projets. Aucun réseau Docker n'est modifié :
              il s'agit uniquement de la politique de la plateforme. Propositions par défaut : réseaux système interdits, réseau de Traefik autorisé.
            </p>
            <div v-for="ep in enabledEndpoints" :key="ep.id" class="block">
              <h3>{{ ep.name }}</h3>
              <NetworkPolicyTable
                :rows="networkRows(ep)"
                :environments="environments.filter(e => eps[ep.id]!.environmentKeys.includes(e.key))"
                @change="(name: string, patch: Partial<NetworkDecision>) => Object.assign(eps[ep.id]!.networks[name]!, patch)"
              />
              <details class="volumes">
                <summary>{{ ep.volumes.length }} volume(s) Docker découvert(s)</summary>
                <ul>
                  <li v-for="v in ep.volumes" :key="v.name"><span class="mono">{{ v.name }}</span> <span class="muted small">{{ v.driver }}</span></li>
                </ul>
                <p class="muted small">Les chemins bind autorisés (whitelist) se configurent depuis la fiche du serveur.</p>
              </details>
            </div>
          </div>

          <!-- 7. Chemins -->
          <div v-else-if="stepKey === 'paths'" class="stack">
            <p class="muted">Racines utilisées sur l'hôte cible. Elles sont validées par le serveur : répertoires système, <code>..</code> et chemins relatifs sont refusés.</p>
            <template v-for="ep in enabledEndpoints" :key="ep.id">
              <div v-for="env in eps[ep.id]!.environmentKeys" :key="`${ep.id}:${env}`" class="block">
                <h3>{{ ep.name }} · {{ envName(env) }} <UiBadge v-if="isProd(env)" tone="danger">prod</UiBadge></h3>
                <PathConfigForm v-model="eps[ep.id]!.paths[env]!" :errors="pathErrors[`${ep.id}:${env}`]" />
              </div>
            </template>
          </div>

          <!-- 8. Ports -->
          <div v-else-if="stepKey === 'ports'" class="stack">
            <div v-for="ep in enabledEndpoints" :key="ep.id" class="block">
              <h3>{{ ep.name }}</h3>
              <PortRulesEditor v-model="eps[ep.id]!.portRules" :environments="environments.filter(e => eps[ep.id]!.environmentKeys.includes(e.key))" />
            </div>
          </div>

          <!-- 9. Traefik et domaines -->
          <div v-else-if="stepKey === 'traefik'" class="stack">
            <div v-for="ep in enabledEndpoints" :key="ep.id" class="block">
              <h3>{{ ep.name }}</h3>
              <p v-if="ep.inventory.traefik" class="muted small">Traefik détecté : {{ ep.inventory.traefik.container }} ({{ ep.inventory.traefik.image }}), réseaux {{ ep.inventory.traefik.networks.join(', ') || '—' }}.</p>
              <p v-else class="alert alert--warning small">Aucun conteneur Traefik détecté sur cet endpoint.</p>
              <UiSwitch v-model="eps[ep.id]!.traefikEnabled" label="Exposer les projets via le Traefik local" />
              <TraefikForm
                v-if="eps[ep.id]!.traefikEnabled"
                v-model="eps[ep.id]!.traefik"
                class="mt"
                :networks="allowedNetworks(ep.id)"
                :detected-networks="ep.inventory.traefik?.networks"
              />
            </div>
          </div>

          <!-- 10. Validation finale -->
          <div v-else-if="stepKey === 'summary'" class="stack">
            <dl class="recap">
              <dt>Serveur</dt><dd>{{ form.name }}<span v-if="form.tags.length" class="muted"> · {{ form.tags.join(', ') }}</span></dd>
              <template v-if="form.transport === 'ssh'">
                <dt>Connexion</dt><dd class="mono">{{ sshUrl }}</dd>
                <dt>Authentification</dt><dd>{{ form.sshAuth === 'key' ? 'clé privée' : 'mot de passe' }}</dd>
                <dt>Clé d'hôte</dt><dd class="mono">{{ form.hostKey }}</dd>
                <dt>Version</dt><dd>{{ preview?.version }}</dd>
              </template>
              <template v-else>
                <dt>URL</dt><dd class="mono">{{ form.url }}</dd>
                <dt>TLS</dt><dd>{{ form.tlsVerify ? (form.useCa ? 'vérifié (AC interne)' : 'vérifié') : 'non vérifié' }}</dd>
                <dt>Version</dt><dd>Agent {{ preview?.version }}</dd>
              </template>
            </dl>
            <div v-for="r in summary" :key="r.ep.id" class="block">
              <h3>{{ r.ep.name }}</h3>
              <dl class="recap">
                <dt>Environnements</dt><dd>{{ r.s.environmentKeys.map(envName).join(', ') }}</dd>
                <dt>Réseaux</dt>
                <dd>
                  {{ r.allowed }} autorisé(s), {{ r.forbidden }} interdit(s)
                  <UiBadge v-if="r.unreviewed" tone="warning">{{ r.unreviewed }} à examiner</UiBadge>
                </dd>
                <template v-for="env in r.s.environmentKeys" :key="env">
                  <dt>Chemins {{ envName(env) }}</dt><dd class="mono">{{ r.s.paths[env]?.workingRoot }}</dd>
                </template>
                <dt>Règles de ports</dt><dd>{{ r.s.portRules.length || 'aucune (ports soumis à validation)' }}</dd>
                <dt>Traefik</dt>
                <dd>
                  <template v-if="r.s.traefikEnabled">
                    réseau <span class="mono">{{ r.s.traefik.networkName }}</span>, exposition {{ r.s.traefik.exposure === 'external' ? 'externe' : 'interne' }},
                    {{ r.s.traefik.allowedDomains.length }} domaine(s)
                  </template>
                  <template v-else>non utilisé</template>
                </dd>
              </dl>
            </div>
            <div v-if="Object.keys(submitErrors).length" class="alert alert--danger" role="alert">
              <strong>L'enregistrement a été refusé :</strong>
              <ul class="err-list">
                <li v-for="(m, k) in submitErrors" :key="k">
                  {{ m }}
                  <UiButton v-if="k !== '_' && stepForError(String(k)) !== step" variant="ghost" size="sm" @click="go(stepForError(String(k)))">Corriger</UiButton>
                </li>
              </ul>
            </div>
          </div>
        </div>

        <footer class="main-foot">
          <UiButton v-if="step > 0" @click="go(step - 1)">Précédent</UiButton>
          <span class="spacer" />
          <span v-if="stepBlocker && stepKey !== 'summary'" class="muted small">{{ stepBlocker }}</span>
          <UiButton v-if="stepKey !== 'summary'" variant="primary" :disabled="!!stepBlocker || testing || discovering" @click="next">Suivant</UiButton>
          <UiButton v-else variant="primary" :loading="submitting" @click="submit">Enregistrer le serveur</UiButton>
        </footer>
      </section>
    </div>
  </div>
</template>

<style scoped>
.back { font-size: 13px; }
.wizard { display: grid; grid-template-columns: 230px 1fr; gap: var(--space-4); align-items: start; }
.side { padding: var(--space-3); position: sticky; top: var(--space-4); }
.main { display: flex; flex-direction: column; min-width: 0; }
.main-head { padding: var(--space-4) var(--space-5); border-bottom: 1px solid var(--border); }
.main-body { padding: var(--space-5); }
.main-foot { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-4) var(--space-5); border-top: 1px solid var(--border); }
.spacer { flex: 1; }
.stack { display: flex; flex-direction: column; gap: var(--space-4); }
.self-start { align-self: flex-start; }
.block { display: flex; flex-direction: column; gap: var(--space-3); padding-top: var(--space-4); border-top: 1px solid var(--border); }
.block:first-child { border-top: none; padding-top: 0; }
.small { font-size: 12.5px; }
.mt { margin-top: var(--space-3); }
.alert { padding: var(--space-3) var(--space-4); border-radius: var(--radius); margin: 0; }
.alert--warning { background: var(--warning-bg); color: var(--warning); }
.alert--danger { background: var(--danger-bg); color: var(--danger); }
.error-inline { color: var(--danger); }
.checks { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: var(--space-2); }
.checks li { display: flex; align-items: center; gap: var(--space-2); }
.dot { width: 10px; height: 10px; border-radius: 50%; background: var(--border); flex-shrink: 0; }
.ok .dot { background: var(--success); }
.ko .dot { background: var(--danger); }
.warn .dot { background: var(--warning); }
.pending .dot { background: var(--border); }
.ep-list { display: flex; flex-direction: column; gap: var(--space-2); }
.ep { display: flex; gap: var(--space-3); padding: var(--space-3) var(--space-4); cursor: pointer; box-shadow: none; }
.ep.disabled { cursor: default; opacity: .7; }
.ep-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ep-title { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.env-choices { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.env-choice { display: inline-flex; align-items: center; gap: var(--space-2); padding: 6px 12px; border: 1px solid var(--border); border-radius: var(--radius); cursor: pointer; }
.env-choice.on { border-color: var(--primary); background: var(--info-bg); }
.volumes summary { cursor: pointer; color: var(--text-muted); }
.volumes ul { margin: var(--space-2) 0; }
.recap { display: grid; grid-template-columns: 160px 1fr; gap: 6px var(--space-4); margin: 0; }
.recap dt { color: var(--text-muted); }
.recap dd { margin: 0; word-break: break-all; }
.err-list { margin: var(--space-2) 0 0; padding-left: var(--space-5); }
@media (max-width: 860px) {
  .wizard { grid-template-columns: 1fr; }
  .side { position: static; }
  .recap { grid-template-columns: 1fr; }
}
.secret { display: flex; gap: var(--space-2); align-items: center; }
.secret .input { flex: 1; }
.install { border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-2); padding: var(--space-3); display: flex; flex-direction: column; gap: 6px; }
.install-head { display: flex; justify-content: space-between; align-items: center; }
.install pre { margin: 0; font-size: 12px; white-space: pre-wrap; word-break: break-all; }
.install p { margin: 0; }
.seg { display: inline-flex; padding: 3px; background: var(--surface-3); border-radius: calc(var(--radius) + 2px); gap: 2px; align-self: flex-start; }
.seg button { all: unset; cursor: pointer; padding: 5px 14px; border-radius: var(--radius); font-size: 13px; font-weight: 550; color: var(--text-muted); }
.seg button.on { background: var(--surface); color: var(--text); box-shadow: var(--shadow); }
.seg button:focus-visible { outline: 2px solid var(--focus); }
.row-3 { display: grid; grid-template-columns: 2fr 90px 1fr; gap: var(--space-3); }
.secret-text { -webkit-text-security: disc; font-size: 11.5px; }
.file { display: inline-flex; gap: 6px; margin-top: 4px; color: var(--primary); cursor: pointer; }
/* Champ natif masqué (le libellé ouvre le sélecteur), toujours accessible au clavier. */
.file input { position: absolute; width: 1px; height: 1px; opacity: 0; }
.file:focus-within { outline: 2px solid var(--focus); outline-offset: 2px; }
.ok-text { color: var(--success); }
@media (max-width: 640px) { .row-3 { grid-template-columns: 1fr; } }
</style>
