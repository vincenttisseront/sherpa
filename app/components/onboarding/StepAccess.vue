<script setup lang="ts">
/** Étape 2 : groupes de départ liés aux rôles intégrés, second administrateur. */
import type { OnboardingFacts } from '#shared/schemas/onboarding'

const props = defineProps<{ facts: OnboardingFacts }>()
const emit = defineEmits<{ changed: [] }>()
const toast = useToast()

const PRESETS = [
  { role: 'admin', name: 'Administrateurs plateforme', description: 'Administration complète (serveurs, politiques, comptes, droits)' },
  { role: 'creator', name: 'Équipes DevOps', description: 'Projets, sources, builds et déploiements' },
  { role: 'viewer', name: 'Lecture', description: 'Consultation des projets, déploiements, logs et tableaux de bord' },
]
const drafts = ref(PRESETS.map(p => ({ ...p, selected: !props.facts.groups.some(g => g.name === p.name) })))
const creating = ref(false)

async function createGroups() {
  creating.value = true
  try {
    for (const d of drafts.value.filter(x => x.selected && !props.facts.groups.some(g => g.name === x.name))) {
      const role = props.facts.roles.find(r => r.key === d.role)
      const { id } = await $fetch<{ id: string }>('/api/admin/groups', { method: 'POST', body: { name: d.name, description: d.description } })
      if (role) await $fetch<unknown>('/api/admin/bindings', { method: 'POST', body: { roleId: role.id, subjectType: 'group', subjectId: id } })
    }
    toast.success('Groupes créés avec leurs rôles')
    emit('changed')
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    creating.value = false
  }
}

// Second administrateur (compte local de secours).
const admin = reactive({ email: '', displayName: '' })
const adminErrors = ref<Record<string, string>>({})
const invitation = ref<{ url: string, expiresAt: string, emailed: boolean, email: string } | null>(null)
const adminGroup = computed(() => props.facts.groups.find(g => g.roles.includes('Administrateur')))
async function invite() {
  adminErrors.value = {}
  try {
    const r = await $fetch<{ id: string, invitationUrl: string, invitationExpiresAt: string, emailed: boolean }>('/api/admin/users', {
      method: 'POST',
      body: { email: admin.email, displayName: admin.displayName, kind: 'local', groupIds: adminGroup.value ? [adminGroup.value.id] : [] },
    })
    if (!adminGroup.value) {
      const role = props.facts.roles.find(x => x.key === 'admin')!
      await $fetch<unknown>('/api/admin/bindings', { method: 'POST', body: { roleId: role.id, subjectType: 'user', subjectId: r.id } })
    }
    invitation.value = { url: r.invitationUrl, expiresAt: r.invitationExpiresAt, emailed: r.emailed, email: admin.email }
    Object.assign(admin, { email: '', displayName: '' })
    emit('changed')
  }
  catch (err) {
    const e = apiError(err)
    adminErrors.value = e.errors
    if (!Object.keys(e.errors).length) toast.error(e.message)
  }
}
const copy = (t: string) => navigator.clipboard.writeText(t).then(() => toast.info('Lien copié'), () => toast.error('Copie impossible'))
</script>

<template>
  <div class="step">
    <section>
      <h3>Groupes et rôles</h3>
      <p class="muted small">Les droits s'attribuent à des groupes. Les groupes du SSO seront associés à ces groupes à l'étape suivante. Chaque création est tracée dans l'audit.</p>
      <ul class="presets">
        <li v-for="d in drafts" :key="d.role">
          <label class="check">
            <input v-model="d.selected" type="checkbox" :disabled="facts.groups.some(g => g.name === d.name)">
            <input v-model.trim="d.name" class="input name" :aria-label="`Nom du groupe ${d.role}`" :disabled="facts.groups.some(g => g.name === d.name)">
          </label>
          <span class="muted small">{{ facts.roles.find(r => r.key === d.role)?.name }} — {{ d.description }}</span>
          <UiBadge v-if="facts.groups.some(g => g.name === d.name)" tone="success">créé</UiBadge>
        </li>
      </ul>
      <UiButton size="sm" variant="primary" :loading="creating" :disabled="!drafts.some(d => d.selected && !facts.groups.some(g => g.name === d.name))" @click="createGroups">Créer les groupes sélectionnés</UiButton>
      <table v-if="facts.groups.length" class="table">
        <thead><tr><th>Groupe</th><th>Rôles</th><th>Membres</th></tr></thead>
        <tbody><tr v-for="g in facts.groups" :key="g.id"><td>{{ g.name }}</td><td class="small">{{ g.roles.join(', ') || '—' }}</td><td>{{ g.members }}</td></tr></tbody>
      </table>
    </section>

    <section>
      <h3>Second administrateur</h3>
      <p class="muted small">
        {{ facts.admins.total }} administrateur(s), dont {{ facts.admins.local }} compte(s) local(aux).
        Un second compte local garantit l'accès si le SSO ou la personne sont indisponibles.
      </p>
      <form class="inline" @submit.prevent="invite">
        <UiField label="Nom" for="a-name" :error="adminErrors.displayName"><input id="a-name" v-model.trim="admin.displayName" class="input" required></UiField>
        <UiField label="Email" for="a-email" :error="adminErrors.email"><input id="a-email" v-model.trim="admin.email" class="input" type="email" required></UiField>
        <UiButton type="submit" size="sm">Inviter comme administrateur</UiButton>
      </form>
      <div v-if="invitation" class="invite">
        <p v-if="invitation.emailed" class="small">Invitation envoyée par email à <strong>{{ invitation.email }}</strong>.</p>
        <p class="small">Lien d'invitation, valable jusqu'au {{ fmtDateTime(invitation.expiresAt) }}, à transmettre par un canal sûr. Il ne sera plus affiché :</p>
        <div class="row"><input class="input mono" readonly :value="invitation.url" aria-label="Lien d'invitation" @focus="($event.target as HTMLInputElement).select()"><UiButton size="sm" @click="copy(invitation.url)">Copier</UiButton></div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.step { display: flex; flex-direction: column; gap: var(--space-5); }
section { display: flex; flex-direction: column; gap: var(--space-2); }
h3 { margin: 0; font-size: 15px; }
.small { font-size: 12.5px; margin: 0; }
.presets { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2); }
.presets li { display: flex; gap: var(--space-3); align-items: center; flex-wrap: wrap; }
.check { display: flex; gap: var(--space-2); align-items: center; }
.name { width: 240px; }
.table { width: 100%; border-collapse: collapse; margin-top: var(--space-2); }
.table th { text-align: left; font-size: 12px; color: var(--text-muted); padding: 4px 6px; border-bottom: 1px solid var(--border); }
.table td { padding: 6px; border-bottom: 1px solid var(--border); }
.inline { display: flex; gap: var(--space-3); align-items: flex-end; flex-wrap: wrap; }
.invite { padding: var(--space-3); border-radius: var(--radius); background: var(--surface-2); display: flex; flex-direction: column; gap: var(--space-2); }
.row { display: flex; gap: var(--space-2); }
</style>
