<script setup lang="ts">
useHead({ title: 'Rôles' })
const toast = useToast()
const confirm = useConfirm()
interface Role { id: string, key: string, name: string, description: string | null, builtin: boolean, permissions: string[] }
const { data, refresh } = await useFetch<{ permissions: string[], roles: Role[] }>('/api/admin/roles', { default: () => ({ permissions: [], roles: [] }) })
const editing = ref<(Omit<Role, 'id'> & { id: string | null }) | null>(null)
const errors = ref<Record<string, string>>({})

const LABELS: Record<string, string> = {
  'project:read': 'Voir les projets', 'deployment:read': 'Voir les déploiements', 'logs:read': 'Consulter les logs', 'dashboard:read': 'Consulter les tableaux de bord', 'server:read': 'Voir les serveurs',
  'project:create': 'Créer un projet', 'project:update': 'Modifier un projet', 'source:import': 'Importer une source', 'build:execute': 'Lancer un build', 'deployment:execute': 'Déployer / redémarrer', 'deployment:stop': 'Arrêter', 'deployment:delete': 'Supprimer une stack',
  'server:manage': 'Gérer les serveurs', 'path:manage': 'Gérer les chemins', 'network:manage': 'Gérer les réseaux', 'volume:manage': 'Gérer les volumes', 'port:manage': 'Gérer les ports', 'domain:manage': 'Gérer Traefik et les domaines',
  'policy:manage': 'Gérer les politiques', 'user:manage': 'Gérer les utilisateurs et le SSO', 'group:manage': 'Gérer les groupes', 'role:manage': 'Gérer les rôles et attributions', 'notification:manage': 'Gérer les notifications', 'audit:read': 'Consulter l\'audit complet', 'container:exec': 'Ouvrir un terminal dans un conteneur', 'deployment:approve': 'Valider les déploiements d\'autrui',
}

function startNew() {
  editing.value = { id: null, key: '', name: '', description: '', builtin: false, permissions: [] }
  errors.value = {}
}
async function save() {
  const r = editing.value!
  errors.value = {}
  try {
    if (r.id) await $fetch<unknown>(`/api/admin/roles/${r.id}`, { method: 'PATCH', body: { name: r.name, description: r.description || null, permissions: r.permissions } })
    else await $fetch<unknown>('/api/admin/roles', { method: 'POST', body: { key: r.key, name: r.name, description: r.description || null, permissions: r.permissions } })
    editing.value = null
    await refresh()
    toast.success('Rôle enregistré')
  }
  catch (err) {
    const e = apiError(err)
    errors.value = e.errors
    if (!Object.keys(e.errors).length) toast.error(e.message)
  }
}
async function remove(r: Role) {
  if (!(await confirm({ title: 'Supprimer le rôle', message: `Le rôle « ${r.name} » sera supprimé.`, confirmLabel: 'Supprimer', danger: true }))) return
  try {
    await $fetch<unknown>(`/api/admin/roles/${r.id}`, { method: 'DELETE' })
    await refresh()
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
}
</script>

<template>
  <div>
    <UiPageHeader title="Administration" icon="settings"><template #nav><AdminNav /></template><UiButton variant="primary" @click="startNew">Nouveau rôle</UiButton></UiPageHeader>
    <div class="roles">
      <section v-for="r in data.roles" :key="r.id" class="card pad">
        <div class="head">
          <h2>{{ r.name }}</h2>
          <UiBadge v-if="r.builtin">intégré</UiBadge>
          <span class="spacer" />
          <template v-if="!r.builtin">
            <UiButton size="sm" @click="editing = { ...r, permissions: [...r.permissions] }">Modifier</UiButton>
            <UiButton size="sm" variant="ghost" @click="remove(r)">Supprimer</UiButton>
          </template>
        </div>
        <p v-if="r.description" class="muted small">{{ r.description }}</p>
        <div class="perms"><UiBadge v-for="p in r.permissions" :key="p" tone="info" :title="p">{{ LABELS[p] ?? p }}</UiBadge></div>
      </section>
    </div>
    <p class="muted small">Un rôle s'attribue à un utilisateur ou à un groupe, pour toute la plateforme ou une portée limitée (serveur, environnement, projet) : fiches utilisateur et groupe.</p>

    <UiModal :open="!!editing" :title="editing?.id ? 'Modifier le rôle' : 'Nouveau rôle'" width="640px" @update:open="v => { if (!v) editing = null }">
      <form v-if="editing" class="stack" @submit.prevent="save">
        <UiField v-if="!editing.id" label="Identifiant" for="r-key" :error="errors.key" required><input id="r-key" v-model.trim="editing.key" class="input mono"></UiField>
        <UiField label="Nom" for="r-name" :error="errors.name" required><input id="r-name" v-model="editing.name" class="input"></UiField>
        <UiField label="Description" for="r-desc"><input id="r-desc" v-model="editing.description" class="input"></UiField>
        <UiField label="Permissions" for="r-perms" :error="errors.permissions">
          <div class="checks"><label v-for="p in data.permissions" :key="p"><input v-model="editing.permissions" type="checkbox" :value="p"> {{ LABELS[p] ?? p }}</label></div>
        </UiField>
      </form>
      <template #footer>
        <UiButton @click="editing = null">Annuler</UiButton>
        <UiButton variant="primary" :disabled="!editing?.permissions.length" @click="save">Enregistrer</UiButton>
      </template>
    </UiModal>
  </div>
</template>

<style scoped>
.roles { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: var(--space-4); margin-bottom: var(--space-3); }
.pad { padding: var(--space-4) var(--space-5); display: flex; flex-direction: column; gap: var(--space-2); }
.head { display: flex; align-items: center; gap: var(--space-2); }
.spacer { flex: 1; }
.perms { display: flex; flex-wrap: wrap; gap: 4px; }
.small { font-size: 12.5px; margin: 0; }
.stack { display: flex; flex-direction: column; gap: var(--space-3); }
.checks { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 4px 12px; }
.checks label { display: inline-flex; gap: 6px; align-items: center; font-size: 13px; }
</style>
