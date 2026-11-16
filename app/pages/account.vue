<script setup lang="ts">
useHead({ title: 'Mon compte' })
const { me, refresh } = useAuth()
const toast = useToast()
const confirm = useConfirm()
interface S { id: string, current: boolean, ip: string | null, userAgent: string | null, sso: boolean, createdAt: string, lastSeenAt: string }
const { data: sessions, refresh: reloadSessions } = await useFetch<S[]>('/api/account/sessions', { default: () => [] })
const pwd = reactive({ current: '', next: '', confirm: '' })
const errors = ref<Record<string, string>>({})
const busy = ref(false)

async function changePassword() {
  errors.value = {}
  if (pwd.next !== pwd.confirm) {
    errors.value = { confirm: 'Les mots de passe diffèrent' }
    return
  }
  busy.value = true
  try {
    const r = await $fetch<{ revokedSessions: number }>('/api/account/password', { method: 'POST', body: { current: pwd.current, next: pwd.next } })
    Object.assign(pwd, { current: '', next: '', confirm: '' })
    toast.success(`Mot de passe changé${r.revokedSessions ? ` ; ${r.revokedSessions} autre(s) session(s) fermée(s)` : ''}`)
    await reloadSessions()
  }
  catch (err) {
    const e = apiError(err)
    errors.value = e.errors
    if (!Object.keys(e.errors).length) toast.error(e.message)
  }
  finally {
    busy.value = false
  }
}

async function revoke(s: S) {
  if (!(await confirm({ title: 'Fermer la session', message: `Session ouverte depuis ${s.ip ?? 'une adresse inconnue'} : elle sera immédiatement déconnectée.`, confirmLabel: 'Fermer' }))) return
  await $fetch<unknown>(`/api/account/sessions/${s.id}`, { method: 'DELETE' })
  await reloadSessions()
  if (s.current) await refresh()
}
</script>

<template>
  <div v-if="me?.user">
    <UiPageHeader title="Mon compte" icon="user" />
    <div class="grid">
      <section class="card pad">
        <h2>Profil</h2>
        <dl class="kv">
          <dt>Nom</dt><dd>{{ me.user.displayName }}</dd>
          <dt>Email</dt><dd class="mono">{{ me.user.email }}</dd>
          <dt>Type</dt><dd>{{ { local: 'Compte local', external: 'Compte externe', sso: 'SSO', dev: 'Développement' }[me.user.kind] }}</dd>
          <dt>Droits</dt><dd class="small">{{ me.permissions?.length }} permission(s) dans au moins une portée</dd>
        </dl>
      </section>
      <section v-if="me.user.kind === 'local' || me.user.kind === 'external'" class="card pad">
        <h2>Mot de passe</h2>
        <form class="form" @submit.prevent="changePassword">
          <UiField label="Mot de passe actuel" for="a-cur" :error="errors.current"><input id="a-cur" v-model="pwd.current" class="input" type="password" autocomplete="current-password"></UiField>
          <UiField label="Nouveau mot de passe" for="a-new" :error="errors.next" hint="12 caractères minimum"><input id="a-new" v-model="pwd.next" class="input" type="password" autocomplete="new-password"></UiField>
          <UiField label="Confirmation" for="a-conf" :error="errors.confirm"><input id="a-conf" v-model="pwd.confirm" class="input" type="password" autocomplete="new-password"></UiField>
          <UiButton type="submit" variant="primary" :loading="busy">Changer le mot de passe</UiButton>
        </form>
      </section>
    </div>
    <MfaPanel />
    <ApiTokensPanel v-if="me.user.id" />
    <section class="card pad">
      <h2>Sessions ouvertes</h2>
      <table class="table">
        <thead><tr><th>Appareil</th><th>Adresse</th><th>Ouverte</th><th>Dernière activité</th><th /></tr></thead>
        <tbody>
          <tr v-for="s in sessions" :key="s.id">
            <td class="small">{{ (s.userAgent ?? '—').slice(0, 70) }} <UiBadge v-if="s.current" tone="info">cette session</UiBadge> <UiBadge v-if="s.sso">SSO</UiBadge></td>
            <td class="mono small">{{ s.ip }}</td>
            <td class="small">{{ fmtDateTime(s.createdAt) }}</td>
            <td class="small">{{ fmtDateTime(s.lastSeenAt) }}</td>
            <td><UiButton size="sm" variant="ghost" @click="revoke(s)">Fermer</UiButton></td>
          </tr>
        </tbody>
      </table>
    </section>
  </div>
</template>

<style scoped>
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: var(--space-4); margin-bottom: var(--space-4); }
.pad { padding: var(--space-5); display: flex; flex-direction: column; gap: var(--space-3); }
.kv { display: grid; grid-template-columns: 100px 1fr; gap: 6px var(--space-4); margin: 0; }
.kv dt { color: var(--text-muted); }
.kv dd { margin: 0; }
.form { display: flex; flex-direction: column; gap: var(--space-3); }
.small { font-size: 12.5px; }
.table { width: 100%; border-collapse: collapse; }
.table th { text-align: left; font-size: 12px; color: var(--text-muted); padding: 6px; border-bottom: 1px solid var(--border); }
.table td { padding: 8px 6px; border-bottom: 1px solid var(--border); }
</style>
