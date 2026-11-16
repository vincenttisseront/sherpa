<script setup lang="ts">
/**
 * Double authentification du compte : application d'authentification (TOTP), passkeys, codes de secours.
 * Les opérations sensibles (désactiver, ajouter ou retirer une passkey, régénérer les codes) redemandent le mot de passe.
 */
import type { MfaStatusDto } from '#shared/schemas/mfa'
import { Copy, KeyRound, ShieldCheck, Smartphone } from 'lucide-vue-next'

const toast = useToast()
const confirm = useConfirm()
const { refresh: refreshMe } = useAuth()
const { data, refresh } = useFetch<MfaStatusDto>('/api/account/mfa', { server: false, lazy: true })

const password = ref('')
const errors = ref<Record<string, string>>({})
const busy = ref<string | null>(null)
const setup = ref<{ secret: string, qrSvg: string } | null>(null)
const code = ref('')
const codes = ref<string[] | null>(null)
const passkeyName = ref('')
const passkeyOk = ref(false)
onMounted(async () => { passkeyOk.value = (await import('@simplewebauthn/browser')).browserSupportsWebAuthn() })

const enabled = computed(() => !!data.value && (data.value.totp || data.value.passkeys.length > 0))

async function run<T>(key: string, fn: () => Promise<T>): Promise<T | undefined> {
  busy.value = key
  errors.value = {}
  try {
    return await fn()
  }
  catch (err) {
    const e = apiError(err)
    errors.value = e.errors
    if (!Object.keys(e.errors).length) toast.error(e.message)
  }
  finally {
    busy.value = null
  }
}
async function reload() {
  await refresh()
  await refreshMe()
}

async function startTotp() {
  const r = await run('totp-setup', () => $fetch<{ secret: string, qrSvg: string }>('/api/account/mfa/totp/setup', { method: 'POST' }))
  if (r) {
    setup.value = r
    code.value = ''
  }
}
async function confirmTotp() {
  const r = await run('totp-confirm', () => $fetch<{ recoveryCodes: string[] | null }>('/api/account/mfa/totp/confirm', { method: 'POST', body: { code: code.value } }))
  if (!r) return
  setup.value = null
  codes.value = r.recoveryCodes
  toast.success('Application d\'authentification activée')
  await reload()
}
async function disableTotp() {
  if (!(await confirm({ title: 'Désactiver l\'application d\'authentification', message: 'Le compte ne sera plus protégé par ce facteur.', confirmLabel: 'Désactiver', danger: true }))) return
  const r = await run('totp-off', () => $fetch<unknown>('/api/account/mfa/totp', { method: 'DELETE', body: { password: password.value } }))
  if (r) {
    password.value = ''
    toast.success('Application d\'authentification désactivée')
    await reload()
  }
}
async function newCodes() {
  const r = await run('codes', () => $fetch<{ recoveryCodes: string[] }>('/api/account/mfa/recovery-codes', { method: 'POST', body: { password: password.value } }))
  if (r) {
    codes.value = r.recoveryCodes
    password.value = ''
    await refresh()
  }
}
async function addPasskey() {
  const r = await run('passkey-add', async () => {
    const { startRegistration } = await import('@simplewebauthn/browser')
    const { options } = await $fetch<{ options: Record<string, unknown> }>('/api/account/mfa/passkeys', { method: 'POST', body: { step: 'options', password: password.value } })
    let response
    try {
      response = await startRegistration({ optionsJSON: options as never })
    }
    catch (err) {
      throw (err as { name?: string }).name === 'NotAllowedError' ? new Error('Enregistrement annulé ou expiré') : err
    }
    return $fetch<{ recoveryCodes: string[] | null }>('/api/account/mfa/passkeys', { method: 'POST', body: { step: 'register', name: passkeyName.value.trim() || 'Ma passkey', response } })
  })
  if (!r) return
  password.value = ''
  passkeyName.value = ''
  if (r.recoveryCodes) codes.value = r.recoveryCodes
  toast.success('Passkey enregistrée')
  await reload()
}
async function removePasskey(id: string, name: string) {
  if (!(await confirm({ title: 'Supprimer la passkey', message: `« ${name} » ne pourra plus servir à se connecter.`, confirmLabel: 'Supprimer', danger: true }))) return
  const r = await run('passkey-del', () => $fetch<unknown>(`/api/account/mfa/passkeys/${id}`, { method: 'DELETE', body: { password: password.value } }))
  if (r) {
    password.value = ''
    await reload()
  }
}
async function copyCodes() {
  try {
    await navigator.clipboard.writeText((codes.value ?? []).join('\n'))
    toast.success('Codes copiés')
  }
  catch {
    toast.error('Copie impossible : sélectionner le texte')
  }
}
const POLICY = { off: '', admins: 'La double authentification est obligatoire pour les administrateurs.', all: 'La double authentification est obligatoire pour tous les comptes.' } as const
</script>

<template>
  <section v-if="data?.supported" class="card pad mfa" data-testid="mfa-panel">
    <div class="head">
      <h2><ShieldCheck :size="16" /> Double authentification</h2>
      <UiBadge :tone="enabled ? 'success' : 'neutral'">{{ enabled ? 'activée' : 'non activée' }}</UiBadge>
    </div>
    <p v-if="data.required && !enabled" class="alert" role="alert" data-testid="mfa-required">
      {{ POLICY[data.policy] }} Activez une application d'authentification ou une passkey pour accéder au reste de la console.
    </p>
    <p v-else class="muted small">Un second facteur protège le compte même si le mot de passe est volé. {{ POLICY[data.policy] }}</p>

    <div v-if="codes" class="secret" role="status" data-testid="recovery-codes">
      <strong>Codes de secours (affichés une seule fois)</strong>
      <p class="muted small">Chaque code ne sert qu'une fois, si l'appareil est perdu. Les conserver hors de cet ordinateur (gestionnaire de mots de passe).</p>
      <ul class="codes mono"><li v-for="c in codes" :key="c">{{ c }}</li></ul>
      <div class="line"><UiButton size="sm" @click="copyCodes"><Copy :size="13" /> Copier</UiButton><UiButton size="sm" variant="ghost" @click="codes = null">J'ai conservé les codes</UiButton></div>
    </div>

    <h3><Smartphone :size="14" /> Application d'authentification</h3>
    <template v-if="!data.totp">
      <p class="muted small">Google Authenticator, Microsoft Authenticator, 1Password, Bitwarden… (code à 6 chiffres).</p>
      <UiButton v-if="!setup" size="sm" variant="primary" :loading="busy === 'totp-setup'" @click="startTotp">Configurer</UiButton>
      <div v-else class="setup">
        <img class="qr" :src="`data:image/svg+xml;charset=utf-8,${encodeURIComponent(setup.qrSvg)}`" alt="QR code à scanner avec l'application d'authentification" width="180" height="180">
        <form class="form" @submit.prevent="confirmTotp">
          <p class="small">Scanner le QR code, ou saisir la clé : <code class="mono" data-testid="totp-secret">{{ setup.secret }}</code></p>
          <UiField label="Code affiché par l'application" for="mfa-code" :error="errors.code" hint="6 chiffres">
            <input id="mfa-code" v-model.trim="code" class="input mono" inputmode="numeric" autocomplete="one-time-code" maxlength="12" required>
          </UiField>
          <div class="line"><UiButton type="submit" variant="primary" size="sm" :loading="busy === 'totp-confirm'">Activer</UiButton><UiButton size="sm" variant="ghost" @click="setup = null">Annuler</UiButton></div>
        </form>
      </div>
    </template>
    <p v-else class="small">Activée. <UiButton size="sm" variant="ghost" :disabled="!password" :loading="busy === 'totp-off'" @click="disableTotp">Désactiver…</UiButton></p>

    <h3><KeyRound :size="14" /> Passkeys</h3>
    <p class="muted small">Clé de sécurité (YubiKey…), empreinte ou visage du téléphone ou de l'ordinateur, gestionnaire de mots de passe. Une passkey permet aussi de se connecter sans mot de passe.</p>
    <ul v-if="data.passkeys.length" class="keys">
      <li v-for="k in data.passkeys" :key="k.id">
        <span>{{ k.name }} <UiBadge v-if="k.backedUp">synchronisée</UiBadge></span>
        <span class="muted small">ajoutée {{ fmtRelative(k.createdAt) }}{{ k.lastUsedAt ? `, utilisée ${fmtRelative(k.lastUsedAt)}` : '' }}</span>
        <UiButton size="sm" variant="ghost" :disabled="!password" :aria-label="`Supprimer la passkey ${k.name}`" @click="removePasskey(k.id, k.name)">Supprimer</UiButton>
      </li>
    </ul>
    <div v-if="passkeyOk" class="line">
      <input v-model.trim="passkeyName" class="input sm" maxlength="60" placeholder="Nom (ex. YubiKey bureau)" aria-label="Nom de la passkey">
      <UiButton size="sm" :disabled="!password" :loading="busy === 'passkey-add'" data-testid="passkey-add" @click="addPasskey">Ajouter une passkey</UiButton>
    </div>
    <p v-else class="muted small">Ce navigateur ne gère pas les passkeys.</p>

    <UiField label="Mot de passe actuel" for="mfa-pwd" :error="errors.password" hint="Demandé pour désactiver un facteur, ajouter ou retirer une passkey, ou régénérer les codes de secours">
      <input id="mfa-pwd" v-model="password" class="input sm" type="password" autocomplete="current-password">
    </UiField>

    <template v-if="enabled">
      <h3>Codes de secours</h3>
      <p class="small">{{ data.recoveryCodesLeft }} code(s) restant(s). <UiButton size="sm" variant="ghost" :disabled="!password" :loading="busy === 'codes'" @click="newCodes">Générer de nouveaux codes…</UiButton></p>
    </template>
  </section>
</template>

<style scoped>
.pad { padding: var(--space-5); display: flex; flex-direction: column; gap: var(--space-3); margin-bottom: var(--space-4); }
.head { display: flex; justify-content: space-between; align-items: center; }
h2 { display: flex; align-items: center; gap: 6px; }
h3 { display: flex; align-items: center; gap: 6px; margin: var(--space-2) 0 0; font-size: 13.5px; }
.small { font-size: 12.5px; margin: 0; }
.alert { margin: 0; padding: var(--space-3); border-radius: var(--radius); background: var(--danger-bg); color: var(--danger); }
.secret { border: 1px solid color-mix(in srgb, var(--warning) 45%, var(--border)); border-radius: var(--radius); background: var(--surface-2); padding: var(--space-3); display: flex; flex-direction: column; gap: var(--space-2); }
.codes { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 4px 16px; font-size: 13px; }
.line { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.setup { display: flex; gap: var(--space-4); flex-wrap: wrap; align-items: flex-start; }
.qr { width: 180px; height: 180px; background: #fff; border-radius: var(--radius); padding: 6px; flex: none; }
.form { display: flex; flex-direction: column; gap: var(--space-2); flex: 1; min-width: 220px; }
.keys { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.keys li { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; padding: 6px 0; border-bottom: 1px solid var(--border); }
.sm { max-width: 280px; }
</style>
