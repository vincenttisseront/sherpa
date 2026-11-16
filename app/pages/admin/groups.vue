<script setup lang="ts">
useHead({ title: 'Groupes' })
const toast = useToast()
const confirm = useConfirm()
interface G { id: string, name: string, description: string | null, members: number }
const { data: groups, refresh } = await useFetch<G[]>('/api/admin/groups', { default: () => [] })
const form = reactive({ name: '', description: '' })
const gFilter = useListFilter(() => groups.value, g => `${g.name} ${g.description ?? ''}`, g => (g.members ? 'members' : 'empty'))
const selected = ref<{ id: string, name: string, members: { id: string, email: string, displayName: string, fromIdp: boolean }[] } | null>(null)

async function create() {
  try {
    await $fetch<unknown>('/api/admin/groups', { method: 'POST', body: { name: form.name, description: form.description || null } })
    Object.assign(form, { name: '', description: '' })
    await refresh()
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
}
async function remove(g: G) {
  if (!(await confirm({ title: 'Supprimer le groupe', message: `« ${g.name} » et ses attributions de rôles seront supprimés ; ${g.members} membre(s) perdront les droits associés.`, confirmLabel: 'Supprimer', danger: true, requireText: g.name }))) return
  try {
    await $fetch<unknown>(`/api/admin/groups/${g.id}`, { method: 'DELETE' })
    if (selected.value?.id === g.id) selected.value = null
    await refresh()
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
}
async function open(g: G) {
  selected.value = await $fetch<NonNullable<typeof selected.value>>(`/api/admin/groups/${g.id}`)
}
</script>

<template>
  <div>
    <UiPageHeader title="Administration" icon="settings"><template #nav><AdminNav /></template></UiPageHeader>
    <div class="grid">
      <section class="card pad">
        <UiListFilter v-model:q="gFilter.q.value" v-model:status="gFilter.status.value" :statuses="{ members: 'Avec membres', empty: 'Sans membre' }" :count="gFilter.filtered.value.length" :total="gFilter.total.value" :active="gFilter.active.value" placeholder="Filtrer les groupes…" @reset="gFilter.reset" />
        <table class="table">
          <thead><tr><th>Groupe</th><th>Membres</th><th /></tr></thead>
          <tbody>
            <tr v-if="!gFilter.filtered.value.length"><td colspan="3" class="muted">{{ groups.length ? 'Aucun groupe ne correspond au filtre' : 'Aucun groupe' }}</td></tr>
            <tr v-for="g in gFilter.filtered.value" :key="g.id" :class="{ on: selected?.id === g.id }">
              <td><button type="button" class="link" @click="open(g)"><strong>{{ g.name }}</strong></button> <span v-if="g.description" class="muted small">{{ g.description }}</span></td>
              <td>{{ g.members }}</td>
              <td><UiButton size="sm" variant="ghost" @click="remove(g)">Supprimer</UiButton></td>
            </tr>
          </tbody>
        </table>
        <form class="add" @submit.prevent="create">
          <input v-model.trim="form.name" class="input sm" placeholder="Nouveau groupe" aria-label="Nom du groupe" required>
          <input v-model.trim="form.description" class="input sm" placeholder="Description (facultatif)" aria-label="Description">
          <UiButton type="submit" size="sm" variant="primary">Créer</UiButton>
        </form>
      </section>
      <section v-if="selected" class="card pad">
        <h2>{{ selected.name }} <span class="muted small">· rôles du groupe</span></h2>
        <BindingsEditor subject-type="group" :subject-id="selected.id" />
        <h3>Membres</h3>
        <ul class="members">
          <li v-for="m in selected.members" :key="m.id">{{ m.displayName }} <span class="muted small mono">{{ m.email }}</span> <UiBadge v-if="m.fromIdp">SSO</UiBadge></li>
          <li v-if="!selected.members.length" class="muted">Aucun membre</li>
        </ul>
        <p class="muted small">Les membres se gèrent depuis la fiche utilisateur, ou par les mappings des fournisseurs SSO.</p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: var(--space-4); align-items: start; }
.pad { padding: var(--space-3) var(--space-4); display: flex; flex-direction: column; gap: var(--space-2); }
h2 { margin: 0; font-size: 15px; }
.table { width: 100%; border-collapse: collapse; }
.table th { text-align: left; font-size: 11px; text-transform: uppercase; color: var(--text-muted); padding: 4px 6px; border-bottom: 1px solid var(--border); }
.table td { padding: 4px 6px; border-bottom: 1px solid var(--border); }
tr.on { background: var(--info-bg); }
.link { all: unset; cursor: pointer; color: var(--primary); }
.add { display: grid; grid-template-columns: 1fr 2fr auto; gap: var(--space-2); }
.input.sm { height: 30px; padding: 0 8px; font-size: 13px; }
.small { font-size: 12.5px; margin: 0; }
.members { margin: 0; padding-left: var(--space-5); }
h3 { margin: var(--space-2) 0 0; font-size: 14px; }
</style>
