<script setup lang="ts">
/** Politique de double authentification : personne, administrateurs, ou tous les comptes locaux et externes (le SSO s'appuie sur son fournisseur). */
const toast = useToast()
const confirm = useConfirm()
const { data, refresh } = useFetch<{ required: 'off' | 'admins' | 'all' }>('/api/admin/mfa-policy', { server: false, lazy: true })
const saving = ref(false)
const OPTIONS = [
  { value: 'off', label: 'Facultative', hint: 'Chaque compte décide d\'activer ou non un second facteur.' },
  { value: 'admins', label: 'Obligatoire pour les administrateurs', hint: 'Comptes disposant de droits d\'administration (utilisateurs, rôles, serveurs, politiques, audit).' },
  { value: 'all', label: 'Obligatoire pour tous', hint: 'Tous les comptes locaux et externes.' },
] as const

async function set(value: 'off' | 'admins' | 'all') {
  if (value === data.value?.required) return
  if (value !== 'off' && !(await confirm({ title: 'Imposer la double authentification', message: 'Les comptes concernés sans second facteur sont limités à leur page « Mon compte » jusqu\'à l\'avoir activé. Activez le vôtre en premier pour ne pas vous bloquer.', confirmLabel: 'Imposer' }))) return
  saving.value = true
  try {
    await $fetch<unknown>('/api/admin/mfa-policy', { method: 'PUT', body: { required: value } })
    await refresh()
    toast.success('Politique enregistrée')
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    saving.value = false
  }
}
</script>

<template>
  <section v-if="data" class="card pad" data-testid="mfa-policy">
    <h2>Double authentification</h2>
    <p class="muted small">Application d'authentification (TOTP) et passkeys, au choix de chaque compte. Les comptes SSO s'appuient sur la double authentification de leur fournisseur d'identité.</p>
    <label v-for="o in OPTIONS" :key="o.value" class="opt">
      <input type="radio" name="mfa-policy" :value="o.value" :checked="data.required === o.value" :disabled="saving" @change="set(o.value)">
      <span><strong>{{ o.label }}</strong><span class="muted small"> — {{ o.hint }}</span></span>
    </label>
  </section>
</template>

<style scoped>
.pad { padding: var(--space-5); display: flex; flex-direction: column; gap: var(--space-2); margin-bottom: var(--space-4); }
.small { font-size: 12.5px; margin: 0; }
.opt { display: flex; align-items: flex-start; gap: var(--space-2); cursor: pointer; }
.opt input { margin-top: 3px; }
</style>
