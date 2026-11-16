<script setup lang="ts">
definePageMeta({ layout: 'auth' })
useHead({ title: 'Initialisation' })
const { refresh } = useAuth()
const form = reactive({ token: '', email: '', displayName: '', password: '', confirm: '' })
const errors = ref<Record<string, string>>({})
const busy = ref(false)

async function submit() {
  errors.value = {}
  if (form.password !== form.confirm) {
    errors.value = { confirm: 'Les mots de passe diffèrent' }
    return
  }
  busy.value = true
  try {
    await $fetch<unknown>('/api/auth/setup', { method: 'POST', body: { token: form.token.trim(), email: form.email, displayName: form.displayName, password: form.password } })
    await refresh()
    // Suite du premier démarrage : assistant d'initialisation.
    await navigateTo('/onboarding')
  }
  catch (err) {
    const e = apiError(err)
    errors.value = Object.keys(e.errors).length ? e.errors : { _: e.message }
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <form class="form" @submit.prevent="submit">
    <h1>Premier administrateur</h1>
    <p class="muted small">Aucun compte n'existe encore. Le jeton d'initialisation (usage unique, valable 24 h) est affiché dans les logs du conteneur de l'application à chaque démarrage :</p>
    <pre class="cmd">docker compose logs app | grep "Jeton d'initialisation"</pre>
    <p class="muted small">Pour en obtenir un nouveau sans redémarrer (le précédent est alors invalidé) :</p>
    <pre class="cmd">docker compose exec app node dist/setup-token.mjs</pre>
    <p v-if="errors._" class="alert" role="alert">{{ errors._ }}</p>
    <UiField label="Jeton d'initialisation" for="s-token" :error="errors.token" required>
      <input id="s-token" v-model="form.token" class="input mono" autocomplete="off" required>
    </UiField>
    <UiField label="Nom" for="s-name" :error="errors.displayName" required>
      <input id="s-name" v-model="form.displayName" class="input" required>
    </UiField>
    <UiField label="Email" for="s-email" :error="errors.email" required>
      <input id="s-email" v-model.trim="form.email" class="input" type="email" autocomplete="username" required>
    </UiField>
    <UiField label="Mot de passe" for="s-pwd" hint="12 caractères minimum ; une phrase de passe est idéale" :error="errors.password" required>
      <input id="s-pwd" v-model="form.password" class="input" type="password" autocomplete="new-password" required>
    </UiField>
    <UiField label="Confirmation" for="s-confirm" :error="errors.confirm" required>
      <input id="s-confirm" v-model="form.confirm" class="input" type="password" autocomplete="new-password" required>
    </UiField>
    <UiButton type="submit" variant="primary" :loading="busy">Créer le compte administrateur</UiButton>
  </form>
</template>

<style scoped>
.form { display: flex; flex-direction: column; gap: var(--space-3); }
.small { font-size: 12.5px; margin: 0; }
.cmd { margin: 0; padding: var(--space-2) var(--space-3); border-radius: var(--radius); background: var(--surface-2); font-size: 12px; overflow-x: auto; user-select: all; }
.alert { margin: 0; padding: var(--space-3); border-radius: var(--radius); background: var(--danger-bg); color: var(--danger); }
</style>
