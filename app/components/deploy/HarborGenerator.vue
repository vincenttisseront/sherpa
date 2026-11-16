<script setup lang="ts">
/**
 * Installateur Harbor : génération du Compose par l'étape « prepare », exécutée
 * sur l'hôte cible. Seules les questions nécessaires : domaine (exposé par
 * Traefik, HTTPS), mot de passe administrateur, scanner Trivy.
 */
import { Eye, EyeOff, Wand2 } from 'lucide-vue-next'
import type { StoredUpload } from '~/types/infra'

const props = defineProps<{ targetId: string, uploadId: string, projectSlug: string, focusPassword?: boolean }>()
const emit = defineEmits<{ generated: [upload: StoredUpload, info: { version: string, imported: number, changes: string[] }] }>()
const toast = useToast()

const hostname = ref(`${props.projectSlug}.localhost`)
const adminPassword = ref('')
const showPassword = ref(false)
const withTrivy = ref(false)
const running = ref(false)
const errors = ref<Record<string, string>>({})
const failure = ref<{ message: string, logs: string[] } | null>(null)

// Lien direct (action en attente) : le champ du mot de passe est sélectionné.
const pwdField = ref<HTMLElement>()
const highlight = ref(false)
onMounted(async () => {
  if (!props.focusPassword) return
  highlight.value = true
  await nextTick()
  const input = pwdField.value?.querySelector('input')
  input?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  input?.focus()
})

// Mot de passe conforme aux règles de Harbor (majuscule, minuscule, chiffre), généré dans le navigateur.
function generatePassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  const bytes = crypto.getRandomValues(new Uint8Array(20))
  adminPassword.value = `${Array.from(bytes, b => alphabet[b % alphabet.length]).join('')}Aa7`
  showPassword.value = true
}

async function run() {
  running.value = true
  errors.value = {}
  failure.value = null
  try {
    const r = await $fetch<{ upload: StoredUpload, version: string, imported: number, changes: string[] }>(`/api/targets/${props.targetId}/generators/harbor`, {
      method: 'POST',
      body: { uploadId: props.uploadId, hostname: hostname.value, adminPassword: adminPassword.value || null, withTrivy: withTrivy.value },
    })
    adminPassword.value = ''
    toast.success(`Compose de Harbor ${r.version} généré : ${r.imported} variable(s) importée(s)`)
    emit('generated', r.upload, r)
  }
  catch (err) {
    const e = apiError(err)
    errors.value = e.errors
    const logs = ((err as { data?: { data?: { logs?: string[] } } }).data?.data?.logs) ?? []
    failure.value = { message: e.message, logs }
  }
  finally {
    running.value = false
  }
}
</script>

<template>
  <div class="gen">
    <div class="q"><Wand2 :size="15" /> <strong>Générer le Compose de Harbor</strong></div>
    <p class="muted small">L'étape « prepare » de l'installateur est exécutée sur le serveur cible (conteneur ponctuel sans réseau ni privilège). Harbor fonctionne en HTTP derrière le Traefik géré, qui assure le HTTPS ; données, secrets et journaux sont placés dans le dossier de données du projet.</p>
    <UiField label="Domaine" for="hb-host" :error="errors.hostname" hint="Exposé en HTTPS par Traefik (service proxy, port 8080)">
      <input id="hb-host" v-model.trim="hostname" class="input mono" spellcheck="false" placeholder="harbor.exemple.fr">
    </UiField>
    <UiField label="Mot de passe administrateur (admin)" for="hb-pwd" :error="errors.adminPassword" hint="8 caractères minimum, avec majuscule, minuscule et chiffre. Vide : celui déjà enregistré pour cette cible. Conservé en variable secrète HARBOR_ADMIN_PASSWORD.">
      <div ref="pwdField" class="row" :class="{ hl: highlight }">
        <input id="hb-pwd" v-model="adminPassword" class="input mono" :type="showPassword ? 'text' : 'password'" autocomplete="new-password">
        <UiButton size="sm" variant="ghost" :aria-label="showPassword ? 'Masquer' : 'Afficher'" @click="showPassword = !showPassword"><component :is="showPassword ? EyeOff : Eye" :size="14" /></UiButton>
        <UiButton size="sm" @click="generatePassword">Générer</UiButton>
      </div>
    </UiField>
    <label class="small check"><input v-model="withTrivy" type="checkbox"> Scanner de vulnérabilités Trivy (service et image supplémentaires)</label>
    <div><UiButton variant="primary" :loading="running" :disabled="hostname.length < 3" @click="run">Exécuter prepare et générer le Compose</UiButton></div>
    <div v-if="failure" class="fail small">
      <strong>{{ failure.message }}</strong>
      <pre v-if="failure.logs.length" class="mono">{{ failure.logs.join('\n') }}</pre>
    </div>
  </div>
</template>

<style scoped>
.gen { display: flex; flex-direction: column; gap: var(--space-3); margin-top: var(--space-2); padding-top: var(--space-3); border-top: 1px solid var(--border); }
.q { display: flex; gap: 6px; align-items: center; }
.row { display: flex; gap: var(--space-2); align-items: center; }
.row .input { flex: 1; }
.row.hl { padding: 6px; margin: -6px; border-radius: var(--radius); background: var(--warning-bg); }
.small { font-size: 12.5px; }
.check { display: flex; gap: 6px; align-items: center; }
.fail { color: var(--danger); display: flex; flex-direction: column; gap: 6px; }
.fail pre { margin: 0; max-height: 220px; overflow: auto; padding: var(--space-2); background: var(--surface-2); color: var(--text); border-radius: var(--radius); font-size: 11.5px; white-space: pre-wrap; }
p { margin: 0; }
</style>
