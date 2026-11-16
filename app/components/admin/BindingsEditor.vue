<script setup lang="ts">
/** Rôles attribués à un utilisateur ou à un groupe, avec leur portée (§16). */
const props = defineProps<{ subjectType: 'user' | 'group', subjectId: string }>()
const toast = useToast()
const confirm = useConfirm()

interface Binding { id: string, role: { key: string, name: string }, scope: { server: string | null, environment: string | null, project: string | null } }
interface Role { id: string, key: string, name: string }
const { data: bindings, refresh } = await useFetch<Binding[]>('/api/admin/bindings', { query: { subjectType: props.subjectType, subjectId: props.subjectId }, default: () => [] })
const { data: roles } = await useFetch<{ roles: Role[] }>('/api/admin/roles', { default: () => ({ roles: [] }) })
const { data: servers } = await useFetch<{ items: { id: string, name: string }[] }>('/api/servers', { query: { pageSize: 200 }, default: () => ({ items: [] }) })
const { data: projects } = await useFetch<{ items: { id: string, name: string, slug: string }[] }>('/api/projects', { query: { pageSize: 200 }, default: () => ({ items: [] }) })
const { data: environments } = await useEnvironments()

const form = reactive({ roleId: '', serverId: '', environmentKey: '', projectId: '' })
const busy = ref(false)

const scopeLabel = (s: Binding['scope']) => {
  const parts = [s.server && `serveur ${s.server}`, s.environment && `environnement ${s.environment}`, s.project && `projet ${s.project}`].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'Toute la plateforme'
}

async function add() {
  busy.value = true
  try {
    await $fetch<unknown>('/api/admin/bindings', { method: 'POST', body: { roleId: form.roleId, subjectType: props.subjectType, subjectId: props.subjectId, serverId: form.serverId || null, environmentKey: form.environmentKey || null, projectId: form.projectId || null } })
    Object.assign(form, { roleId: '', serverId: '', environmentKey: '', projectId: '' })
    await refresh()
    toast.success('Rôle attribué')
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    busy.value = false
  }
}

async function remove(b: Binding) {
  if (!(await confirm({ title: 'Retirer le rôle', message: `${b.role.name} — ${scopeLabel(b.scope)}`, confirmLabel: 'Retirer', danger: true }))) return
  try {
    await $fetch<unknown>(`/api/admin/bindings/${b.id}`, { method: 'DELETE' })
    await refresh()
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
}
</script>

<template>
  <div class="bindings">
    <ul v-if="bindings.length" class="list">
      <li v-for="b in bindings" :key="b.id">
        <UiBadge :tone="b.role.key === 'admin' ? 'danger' : 'info'">{{ b.role.name }}</UiBadge>
        <span class="small">{{ scopeLabel(b.scope) }}</span>
        <UiButton size="sm" variant="ghost" :aria-label="`Retirer ${b.role.name}`" @click="remove(b)">✕</UiButton>
      </li>
    </ul>
    <p v-else class="muted small">Aucun rôle attribué directement.</p>
    <form class="add" @submit.prevent="add">
      <select v-model="form.roleId" class="input" aria-label="Rôle" required>
        <option value="" disabled>Rôle…</option>
        <option v-for="r in roles.roles" :key="r.id" :value="r.id">{{ r.name }}</option>
      </select>
      <select v-model="form.serverId" class="input" aria-label="Serveur"><option value="">Tous les serveurs</option><option v-for="s in servers.items" :key="s.id" :value="s.id">{{ s.name }}</option></select>
      <select v-model="form.environmentKey" class="input" aria-label="Environnement"><option value="">Tous les environnements</option><option v-for="e in environments" :key="e.key" :value="e.key">{{ e.name }}</option></select>
      <select v-model="form.projectId" class="input" aria-label="Projet"><option value="">Tous les projets</option><option v-for="p in projects.items" :key="p.id" :value="p.id">{{ p.name }}</option></select>
      <UiButton type="submit" size="sm" variant="primary" :loading="busy" :disabled="!form.roleId">Attribuer</UiButton>
    </form>
  </div>
</template>

<style scoped>
.bindings { display: flex; flex-direction: column; gap: var(--space-3); }
.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.list li { display: flex; align-items: center; gap: var(--space-2); }
.small { font-size: 12.5px; margin: 0; }
.add { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)) auto; gap: var(--space-2); align-items: center; }
</style>
