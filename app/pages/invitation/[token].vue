<script setup lang="ts">
definePageMeta({ layout: 'auth' })
useHead({ title: 'Définir le mot de passe' })
const route = useRoute()
const { refresh } = useAuth()
const token = String(route.params.token)
const { data: info, error: loadError } = await useFetch<{ email: string, displayName: string, purpose: 'invite' | 'reset' }>(`/api/auth/invitations/${token}`)
const form = reactive({ password: '', confirm: '' })
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
    await $fetch<unknown>(`/api/auth/invitations/${token}`, { method: 'POST', body: { password: form.password } })
    await refresh()
    await navigateTo('/')
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
  <div>
    <template v-if="loadError || !info">
      <h1>Lien invalide</h1>
      <p class="muted">Ce lien a expiré ou a déjà été utilisé. Demander un nouveau lien à un administrateur.</p>
      <NuxtLink to="/login">Retour à la connexion</NuxtLink>
    </template>
    <form v-else class="form" @submit.prevent="submit">
      <h1>{{ info.purpose === 'reset' ? 'Nouveau mot de passe' : 'Bienvenue' }}</h1>
      <p class="muted">{{ info.displayName }} · <span class="mono">{{ info.email }}</span></p>
      <p v-if="errors._" class="alert" role="alert">{{ errors._ }}</p>
      <UiField label="Mot de passe" for="i-pwd" hint="12 caractères minimum ; une phrase de passe est idéale" :error="errors.password" required>
        <input id="i-pwd" v-model="form.password" class="input" type="password" autocomplete="new-password" required>
      </UiField>
      <UiField label="Confirmation" for="i-confirm" :error="errors.confirm" required>
        <input id="i-confirm" v-model="form.confirm" class="input" type="password" autocomplete="new-password" required>
      </UiField>
      <UiButton type="submit" variant="primary" :loading="busy">Enregistrer et se connecter</UiButton>
    </form>
  </div>
</template>

<style scoped>
.form { display: flex; flex-direction: column; gap: var(--space-3); }
.alert { margin: 0; padding: var(--space-3); border-radius: var(--radius); background: var(--danger-bg); color: var(--danger); }
</style>
