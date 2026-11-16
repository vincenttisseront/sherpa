<script setup lang="ts">
definePageMeta({ layout: 'auth' })
useHead({ title: 'Connexion' })
const route = useRoute()
const { refresh } = useAuth()
const { data: providers } = await useFetch<{ key: string, name: string, kind: string }[]>('/api/auth/providers', { default: () => [] })
const form = reactive({ email: '', password: '' })
const error = ref<string | null>(typeof route.query.error === 'string' ? route.query.error : null)
const busy = ref(false)
// Seconde étape : défi renvoyé par le serveur après le mot de passe.
interface Challenge { mfaToken: string, methods: { totp: boolean, passkey: boolean, recovery: boolean } }
const challenge = ref<Challenge | null>(null)
const mode = ref<'totp' | 'recovery' | 'passkey'>('totp')
const code = ref('')
const passkeySupported = ref(false)
onMounted(async () => { passkeySupported.value = (await import('@simplewebauthn/browser')).browserSupportsWebAuthn() })
const returnTo = computed(() => (typeof route.query.returnTo === 'string' && route.query.returnTo.startsWith('/') && !route.query.returnTo.startsWith('//') ? route.query.returnTo : '/'))

async function login() {
  busy.value = true
  error.value = null
  try {
    const r = await $fetch<{ ok: boolean, mfaRequired?: boolean, mfaToken?: string, methods?: Challenge['methods'] }>('/api/auth/login', { method: 'POST', body: form })
    if (r.mfaRequired && r.mfaToken && r.methods) {
      challenge.value = { mfaToken: r.mfaToken, methods: r.methods }
      mode.value = r.methods.totp ? 'totp' : 'passkey'
      form.password = ''
      if (mode.value === 'passkey') await verifyPasskey()
      return
    }
    await finish()
  }
  catch (err) {
    error.value = apiError(err).message
    form.password = ''
  }
  finally {
    busy.value = false
  }
}

async function finish() {
  await refresh()
  await navigateTo(returnTo.value)
}

async function verify() {
  if (!challenge.value) return
  busy.value = true
  error.value = null
  try {
    const r = await $fetch<{ recoveryCodesLeft?: number }>('/api/auth/mfa/verify', { method: 'POST', body: { mfaToken: challenge.value.mfaToken, method: mode.value, code: code.value } })
    if (r.recoveryCodesLeft !== undefined) useToast().success(`Code de secours utilisé : ${r.recoveryCodesLeft} restant(s)`)
    await finish()
  }
  catch (err) {
    onMfaError(err)
  }
  finally {
    busy.value = false
  }
}

function onMfaError(err: unknown) {
  error.value = apiError(err).message
  code.value = ''
  // Défi expiré ou épuisé : retour au mot de passe.
  if ((err as { statusCode?: number, status?: number }).statusCode === 401 && /Vérification expirée/.test(error.value)) challenge.value = null
}

async function verifyPasskey() {
  if (!challenge.value) return
  busy.value = true
  error.value = null
  try {
    const { startAuthentication } = await import('@simplewebauthn/browser')
    const token = challenge.value.mfaToken
    const optionsJSON = await $fetch<Record<string, unknown>>('/api/auth/mfa/passkey-options', { method: 'POST', body: { mfaToken: token } })
    const response = await startAuthentication({ optionsJSON: optionsJSON as never })
    await $fetch<unknown>('/api/auth/mfa/verify', { method: 'POST', body: { mfaToken: token, method: 'passkey', response } })
    await finish()
  }
  catch (err) {
    if ((err as { name?: string }).name === 'NotAllowedError') error.value = 'Vérification annulée ou expirée'
    else onMfaError(err)
  }
  finally {
    busy.value = false
  }
}

/** Connexion sans mot de passe : la passkey (avec vérification de l'utilisateur) vaut les deux facteurs. */
async function passkeyLogin() {
  busy.value = true
  error.value = null
  try {
    const { startAuthentication } = await import('@simplewebauthn/browser')
    const { flowId, options } = await $fetch<{ flowId: string, options: Record<string, unknown> }>('/api/auth/passkey/options', { method: 'POST' })
    const response = await startAuthentication({ optionsJSON: options as never })
    await $fetch<unknown>('/api/auth/passkey/login', { method: 'POST', body: { flowId, response } })
    await finish()
  }
  catch (err) {
    error.value = (err as { name?: string }).name === 'NotAllowedError' ? 'Connexion par passkey annulée ou expirée' : apiError(err).message
  }
  finally {
    busy.value = false
  }
}

const ICON: Record<string, string> = { keycloak: 'Keycloak', okta: 'Okta', oidc: 'SSO' }
</script>

<template>
  <div class="login">
    <div class="title">
      <h1>Connexion</h1>
    </div>
    <p v-if="error" class="alert" role="alert">{{ error }}</p>

    <div v-if="providers.length" class="sso">
      <a v-for="p in providers" :key="p.key" class="sso-btn" :href="`/api/auth/oidc/${p.key}/login?returnTo=${encodeURIComponent(returnTo)}`">
        Se connecter avec {{ p.name }} <span class="muted small">({{ ICON[p.kind] ?? p.kind }})</span>
      </a>
      <div class="sep"><span>ou avec un compte local</span></div>
    </div>

    <form v-if="challenge" class="form" aria-label="Vérification en deux étapes" @submit.prevent="mode === 'passkey' ? verifyPasskey() : verify()">
      <p class="muted small">Seconde étape : confirmer votre identité.</p>
      <template v-if="mode === 'totp'">
        <UiField label="Code de l'application d'authentification" for="l-code" hint="6 chiffres">
          <input id="l-code" v-model.trim="code" class="input mono" inputmode="numeric" autocomplete="one-time-code" maxlength="12" required autofocus>
        </UiField>
      </template>
      <template v-else-if="mode === 'recovery'">
        <UiField label="Code de secours" for="l-recovery" hint="Chaque code ne sert qu'une fois">
          <input id="l-recovery" v-model.trim="code" class="input mono" autocomplete="off" spellcheck="false" maxlength="40" required autofocus>
        </UiField>
      </template>
      <p v-else class="muted small">Utilisez votre passkey (clé de sécurité, empreinte, visage, code de l'appareil).</p>
      <UiButton type="submit" variant="primary" class="submit" :loading="busy">{{ mode === 'passkey' ? 'Utiliser ma passkey' : 'Valider' }}</UiButton>
      <div class="alt">
        <button v-if="mode !== 'totp' && challenge.methods.totp" type="button" class="link" @click="mode = 'totp'; code = ''">Utiliser l'application d'authentification</button>
        <button v-if="mode !== 'passkey' && challenge.methods.passkey && passkeySupported" type="button" class="link" @click="mode = 'passkey'; code = ''">Utiliser une passkey</button>
        <button v-if="mode !== 'recovery' && challenge.methods.recovery" type="button" class="link" @click="mode = 'recovery'; code = ''">Utiliser un code de secours</button>
        <button type="button" class="link" @click="challenge = null; error = null">Retour</button>
      </div>
    </form>

    <form v-else class="form" @submit.prevent="login">
      <UiField label="Email" for="l-email">
        <input id="l-email" v-model.trim="form.email" class="input" type="email" autocomplete="username" required autofocus>
      </UiField>
      <UiField label="Mot de passe" for="l-pwd">
        <input id="l-pwd" v-model="form.password" class="input" type="password" autocomplete="current-password" required>
      </UiField>
      <UiButton type="submit" variant="primary" class="submit" :loading="busy">Se connecter</UiButton>
      <UiButton v-if="passkeySupported" variant="secondary" class="submit" :loading="busy" data-testid="passkey-login" @click="passkeyLogin">Connexion par passkey</UiButton>
    </form>
  </div>
</template>

<style scoped>
.login { display: flex; flex-direction: column; gap: var(--space-5); }
.title h1 { font-size: 26px; letter-spacing: -0.02em; }
.title p { margin: 6px 0 0; }
.submit { width: 100%; margin-top: var(--space-2); }
.form { display: flex; flex-direction: column; gap: var(--space-3); }
.sso { display: flex; flex-direction: column; gap: var(--space-2); }
.sso-btn { display: block; text-align: center; padding: 10px 14px; border: 1px solid var(--border-strong); border-radius: var(--radius); background: var(--surface); color: var(--text); font-weight: 550; box-shadow: var(--shadow); }
.sso-btn:hover { background: var(--surface-2); text-decoration: none; }
.sep { display: flex; align-items: center; gap: var(--space-2); color: var(--text-muted); font-size: 12px; margin-top: var(--space-2); }
.sep::before, .sep::after { content: ''; flex: 1; border-top: 1px solid var(--border); }
.alert { margin: 0; padding: var(--space-3); border-radius: var(--radius); background: var(--danger-bg); color: var(--danger); }
.small { font-size: 12px; margin: 0; }
.alt { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; }
.link { background: none; border: 0; padding: 0; color: var(--primary); cursor: pointer; font: inherit; font-size: 13px; }
.link:hover { text-decoration: underline; }
</style>
