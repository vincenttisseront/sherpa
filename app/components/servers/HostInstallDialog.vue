<script setup lang="ts">
/**
 * Installation d'un hôte cible depuis son terminal : profil (type d'hôte), composants (agent seul,
 * agent et Target Runner, ou connexion SSH sans agent) et commande complète à copier. Le secret de
 * l'agent est généré dans le navigateur et transmis à l'assistant d'ajout sans passer par l'URL.
 */
import { DEFAULT_RUNNER_IMAGE, HOST_PROFILES, type HostInstallOptions, type HostProfileKey, RUNNER_PORT, hostInstallCommand, hostInstallErrors } from '#shared/utils/host-install'
import { Copy, Eye, EyeOff, RefreshCw } from 'lucide-vue-next'

const open = defineModel<boolean>('open', { required: true })
const toast = useToast()
const router = useRouter()

const { data: defaults } = useFetch<{ agentImage: string, runnerImage: string, runnerImageConfigured: boolean }>('/api/install/defaults', { server: false, lazy: true })

const newSecret = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('')
const form = reactive({
  profile: 'docker' as HostProfileKey,
  components: 'agent-runner' as HostInstallOptions['components'],
  agentSecret: '',
  volumesDir: HOST_PROFILES.custom.volumes as string,
  image: DEFAULT_RUNNER_IMAGE as string,
  user: 'deploy',
  base: '/srv',
  bindIp: '',
  name: '',
  certMode: 'self-signed' as 'self-signed' | 'files',
  cert: '/etc/platform-runner/runner.crt',
  key: '/etc/platform-runner/runner.key',
  platformCa: '/etc/platform-runner/platform-ca.crt',
  sshKeyMode: 'generate' as 'generate' | 'public',
  publicKey: '',
})
const showSecret = ref(false)
watch(open, (v) => {
  if (v && !form.agentSecret) form.agentSecret = newSecret()
}, { immediate: true })
watch(defaults, (d) => {
  if (d && form.image === DEFAULT_RUNNER_IMAGE) form.image = d.runnerImage
})
// Changement de profil : racines et utilisateur par défaut du type d'hôte.
watch(() => form.profile, (key) => {
  const p = HOST_PROFILES[key]
  form.base = p.base
  form.user = p.user ?? ''
})

const options = computed<HostInstallOptions>(() => ({
  profile: form.profile,
  components: form.components,
  agentSecret: form.agentSecret,
  volumesDir: form.volumesDir,
  runner: {
    image: form.image.trim(),
    user: form.user.trim(),
    base: form.base.trim(),
    bindIp: form.bindIp.trim(),
    name: form.name.trim(),
    cert: form.certMode === 'self-signed' ? { mode: 'self-signed' } : { mode: 'files', cert: form.cert.trim(), key: form.key.trim() },
    platformCa: form.platformCa.trim(),
  },
  ssh: {
    user: form.user.trim(),
    base: form.base.trim(),
    key: form.sshKeyMode === 'generate' ? { mode: 'generate' } : { mode: 'public', publicKey: form.publicKey },
  },
}))
const errors = computed(() => hostInstallErrors(options.value))
const valid = computed(() => !Object.keys(errors.value).length)
const command = computed(() => (valid.value ? hostInstallCommand(options.value) : ''))
// Affichage : secret masqué tant qu'il n'est pas demandé ; la copie contient toujours le vrai secret.
const shown = computed(() => (showSecret.value || !form.agentSecret ? command.value : command.value.replaceAll(form.agentSecret, '•'.repeat(12))))
const withRunner = computed(() => form.components === 'agent-runner')
const viaSsh = computed(() => form.components === 'ssh')
const profile = computed(() => HOST_PROFILES[form.profile])

async function copy() {
  try {
    await navigator.clipboard.writeText(command.value)
    toast.success('Commande copiée : à coller dans le terminal de l\'hôte')
  }
  catch {
    toast.error('Copie impossible : afficher le secret puis sélectionner la commande')
  }
}
// Assistant d'ajout prérempli (état de navigation, jamais dans l'URL) : secret de l'agent, ou utilisateur et socket SSH.
async function addServer() {
  open.value = false
  const state = viaSsh.value
    ? { transport: 'ssh', sshUser: form.profile === 'rootless' ? '' : form.user.trim(), dockerSocket: profile.value.socket.startsWith('/') ? profile.value.socket : '' }
    : { agentSecret: form.agentSecret }
  await router.push({ path: '/servers/new', state })
}
const COMPONENTS_HINT = {
  'agent': 'Agent Portainer seul : le Runner pourra être ajouté plus tard (fichiers des releases et build des images).',
  'agent-runner': `Agent Portainer (inventaire, conteneurs, déploiements) et Target Runner (fichiers des releases, build des images), en mTLS sur le port ${RUNNER_PORT}.`,
  'ssh': 'Rien à installer : la console se connecte en SSH (API Docker par le socket de l\'hôte, fichiers par SFTP). Mêmes fonctions qu\'avec l\'agent et le Runner.',
} as const
</script>

<template>
  <UiModal v-model:open="open" title="Installer un hôte" width="860px">
    <div class="stack">
      <div class="row">
        <UiField label="Type d'hôte" for="hi-profile" :hint="profile.hint">
          <select id="hi-profile" v-model="form.profile" class="input">
            <option v-for="(p, key) in HOST_PROFILES" :key="key" :value="key">{{ p.label }}</option>
          </select>
        </UiField>
        <UiField label="Composants" for="hi-components">
          <div id="hi-components" class="seg" role="radiogroup" aria-label="Composants">
            <button type="button" role="radio" :aria-checked="form.components === 'agent'" :class="{ on: form.components === 'agent' }" @click="form.components = 'agent'">Agent seul</button>
            <button type="button" role="radio" :aria-checked="withRunner" :class="{ on: withRunner }" @click="form.components = 'agent-runner'">Agent + Runner</button>
            <button type="button" role="radio" :aria-checked="viaSsh" :class="{ on: viaSsh }" @click="form.components = 'ssh'">SSH</button>
          </div>
        </UiField>
      </div>
      <p class="muted small">{{ COMPONENTS_HINT[form.components] }}</p>

      <UiField v-if="form.profile === 'custom' && !viaSsh" label="Dossier des volumes du moteur" for="hi-volumes" :error="errors.volumesDir" hint="data-root de daemon.json suivi de /volumes">
        <input id="hi-volumes" v-model.trim="form.volumesDir" class="input mono">
      </UiField>

      <fieldset v-if="viaSsh" class="box">
        <legend>Connexion SSH</legend>
        <div class="grid">
          <UiField v-if="form.profile !== 'rootless'" label="Utilisateur de la console" for="hi-ssh-user" :error="errors.user" hint="Créé s'il n'existe pas, ajouté au groupe du socket (équivalent root sur l'hôte)">
            <input id="hi-ssh-user" v-model.trim="form.user" class="input mono">
          </UiField>
          <UiField label="Dossier des chemins de travail" for="hi-ssh-base" :error="errors.base" hint="Créés dessous : deployments, builds, tmp, apps-data (onglet Chemins de l'endpoint)">
            <input id="hi-ssh-base" v-model.trim="form.base" class="input mono">
          </UiField>
        </div>
        <div class="certs">
          <span class="small">Clé SSH de la console</span>
          <label class="small"><input v-model="form.sshKeyMode" type="radio" value="generate"> Générée sur l'hôte : clé privée affichée une fois, à coller dans l'assistant (rien ne reste sur l'hôte)</label>
          <label class="small"><input v-model="form.sshKeyMode" type="radio" value="public"> Clé publique existante (la clé privée reste chez vous)</label>
          <UiField v-if="form.sshKeyMode === 'public'" label="Clé publique" for="hi-pubkey" :error="errors.publicKey">
            <input id="hi-pubkey" v-model="form.publicKey" class="input mono" placeholder="ssh-ed25519 AAAA… console" spellcheck="false">
          </UiField>
        </div>
      </fieldset>

      <UiField v-if="!viaSsh" label="AGENT_SECRET" for="hi-secret" :error="errors.agentSecret" hint="Généré dans le navigateur, jamais envoyé à la console par cette fenêtre. À saisir dans l'assistant d'ajout du serveur.">
        <div class="secret">
          <input id="hi-secret" v-model.trim="form.agentSecret" class="input mono" :type="showSecret ? 'text' : 'password'" autocomplete="off" spellcheck="false">
          <UiButton size="sm" variant="ghost" :aria-label="showSecret ? 'Masquer le secret' : 'Afficher le secret'" @click="showSecret = !showSecret"><EyeOff v-if="showSecret" :size="14" /><Eye v-else :size="14" /></UiButton>
          <UiButton size="sm" variant="ghost" aria-label="Générer un nouveau secret" @click="form.agentSecret = newSecret()"><RefreshCw :size="14" /></UiButton>
        </div>
      </UiField>

      <fieldset v-if="withRunner" class="box">
        <legend>Target Runner</legend>
        <div class="grid">
          <UiField label="Image du Runner" for="hi-image" :error="errors.image" :hint="defaults?.runnerImageConfigured ? 'Image publiée (RUNNER_IMAGE de la console)' : 'RUNNER_IMAGE non défini : image à charger sur l\'hôte, ou à publier sur un registre joignable'">
            <input id="hi-image" v-model.trim="form.image" class="input mono">
          </UiField>
          <UiField v-if="form.profile !== 'rootless'" label="Utilisateur propriétaire des racines" for="hi-user" :error="errors.user" hint="Créé s'il n'existe pas ; le Runner tourne sous son UID">
            <input id="hi-user" v-model.trim="form.user" class="input mono">
          </UiField>
          <UiField label="Dossier des racines" for="hi-base" :error="errors.base" :hint="`Racines créées dessous : deployments, builds, tmp, apps-data (chemins de l'onglet Chemins de l'endpoint)`">
            <input id="hi-base" v-model.trim="form.base" class="input mono">
          </UiField>
          <UiField label="IP d'écoute (administration)" for="hi-ip" :error="errors.bindIp" hint="Vide : adresse principale de l'hôte">
            <input id="hi-ip" v-model.trim="form.bindIp" class="input mono" placeholder="10.0.0.11">
          </UiField>
          <UiField label="Nom de l'hôte dans l'URL" for="hi-name" :error="errors.name" hint="Vide : nom complet de l'hôte (hostname -f)">
            <input id="hi-name" v-model.trim="form.name" class="input mono" placeholder="docker-01.interne">
          </UiField>
          <UiField label="AC des certificats clients de la console" for="hi-ca" :error="errors.platformCa" hint="Fichier déjà présent sur l'hôte (AC du certificat client RUNNER_CLIENT_CERT_FILE)">
            <input id="hi-ca" v-model.trim="form.platformCa" class="input mono">
          </UiField>
        </div>
        <div class="certs">
          <span class="small">Certificat serveur du Runner</span>
          <label class="small"><input v-model="form.certMode" type="radio" value="self-signed"> Auto-signé, généré sur l'hôte (à coller dans « AC du certificat » de la console)</label>
          <label class="small"><input v-model="form.certMode" type="radio" value="files"> PKI d'entreprise : fichiers déjà présents sur l'hôte</label>
          <div v-if="form.certMode === 'files'" class="grid">
            <UiField label="Certificat (SAN = nom de l'URL, serverAuth)" for="hi-cert" :error="errors.cert"><input id="hi-cert" v-model.trim="form.cert" class="input mono"></UiField>
            <UiField label="Clé privée" for="hi-key" :error="errors.key"><input id="hi-key" v-model.trim="form.key" class="input mono"></UiField>
          </div>
        </div>
      </fieldset>

      <div class="install">
        <div class="install-head">
          <strong class="small">Commande à exécuter sur l'hôte</strong>
          <UiButton size="sm" variant="primary" :disabled="!valid" @click="copy"><Copy :size="13" /> Copier</UiButton>
        </div>
        <pre v-if="valid" class="mono" aria-label="Commande d'installation">{{ shown }}</pre>
        <p v-else class="small warn">Corriger les champs signalés pour obtenir la commande.</p>
      </div>
      <ol class="steps small">
        <li>Coller la commande dans le terminal de l'hôte{{ form.profile === 'rootless' ? ', sous l\'utilisateur du moteur rootless' : '' }}.</li>
        <template v-if="viaSsh">
          <li>Ajouter le serveur › SSH : hôte, utilisateur{{ form.profile === 'rootless' ? ' (celui qui a lancé la commande)' : ` ${form.user}` }}, socket affiché par la commande, clé privée {{ form.sshKeyMode === 'generate' ? 'affichée par la commande' : 'correspondant à la clé publique' }}.</li>
          <li>Lire la clé d'hôte dans l'assistant et comparer son empreinte avec celle affichée par la commande avant de la confirmer.</li>
        </template>
        <li v-else>Ajouter le serveur dans la console avec ce secret (adresse <span class="mono">https://&lt;hôte&gt;:9001</span>). N'ouvrir le port 9001{{ withRunner ? ` et ${RUNNER_PORT}` : '' }} qu'à la console.</li>
        <template v-if="withRunner">
          <li>Fiche du serveur › Runner : URL <span class="mono">https://&lt;hôte&gt;:{{ RUNNER_PORT }}</span>{{ form.certMode === 'self-signed' ? ', AC du certificat = certificat affiché par la commande' : '' }}. Coller la clé HMAC affichée dans le terminal où la commande l'attend.</li>
          <li>Lancer le diagnostic du Runner.</li>
        </template>
      </ol>
    </div>
    <template #footer>
      <UiButton variant="ghost" @click="open = false">Fermer</UiButton>
      <UiButton variant="secondary" :disabled="!viaSsh && !!errors.agentSecret" @click="addServer">Ajouter ce serveur…</UiButton>
    </template>
  </UiModal>
</template>

<style scoped>
.stack { display: flex; flex-direction: column; gap: var(--space-3); }
.row { display: grid; grid-template-columns: 1fr auto; gap: var(--space-3); align-items: start; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(240px, 100%), 1fr)); gap: var(--space-2) var(--space-3); }
.box { min-width: 0; border: 1px solid var(--border); border-radius: var(--radius); padding: var(--space-2) var(--space-3) var(--space-3); margin: 0; display: flex; flex-direction: column; gap: var(--space-2); }
.box legend { font-size: 12.5px; font-weight: 600; padding: 0 4px; }
.certs { display: flex; flex-direction: column; gap: 4px; }
.secret { display: flex; gap: var(--space-2); align-items: center; }
.secret .input { flex: 1; }
.seg { display: inline-flex; padding: 3px; background: var(--surface-3); border-radius: calc(var(--radius) + 2px); gap: 2px; }
.seg button { all: unset; cursor: pointer; padding: 5px 14px; border-radius: var(--radius); font-size: 13px; font-weight: 550; color: var(--text-muted); white-space: nowrap; }
.seg button.on { background: var(--surface); color: var(--text); box-shadow: var(--shadow); }
.install { border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-2); padding: var(--space-3); display: flex; flex-direction: column; gap: 6px; }
.install-head { display: flex; justify-content: space-between; align-items: center; }
.install pre { margin: 0; font-size: 12px; white-space: pre-wrap; word-break: break-all; max-height: 340px; overflow: auto; }
.small { font-size: 12.5px; margin: 0; }
.steps { margin: 0; padding-left: var(--space-5); display: flex; flex-direction: column; gap: 2px; }
.warn { color: var(--warning); }
@media (max-width: 640px) { .row { grid-template-columns: 1fr; } }
</style>
