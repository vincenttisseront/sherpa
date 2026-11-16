<script setup lang="ts">
const { hasAny } = useAuth()
const links = computed(() => [
  { to: '/admin/readiness', label: 'Mise en service', show: hasAny('policy:manage') },
  { to: '/admin/users', label: 'Utilisateurs', show: hasAny('user:manage') },
  { to: '/admin/groups', label: 'Groupes', show: hasAny('group:manage') },
  { to: '/admin/roles', label: 'Rôles', show: hasAny('role:manage') },
  { to: '/admin/sso', label: 'Fournisseurs SSO', show: hasAny('user:manage') },
  { to: '/admin/deploy-policy', label: 'Politique de déploiement', show: hasAny('policy:manage') },
  { to: '/admin/notifications', label: 'Notifications', show: hasAny('notification:manage') },
  { to: '/admin/dns', label: 'Comptes DNS', show: hasAny('domain:manage') },
  { to: '/admin/github', label: 'Connecteurs GitHub', show: hasAny('policy:manage') },
  { to: '/admin/retention', label: 'Rétention', show: hasAny('audit:read') },
].filter(l => l.show))
</script>

<template>
  <nav class="admin-nav" aria-label="Administration">
    <NuxtLink v-for="l in links" :key="l.to" :to="l.to" class="tab" active-class="on">{{ l.label }}</NuxtLink>
  </nav>
</template>

<style scoped>
.admin-nav { display: flex; gap: 2px; padding: 3px; margin-left: var(--space-2); overflow-x: auto; background: var(--surface-3); border-radius: calc(var(--radius) + 2px); width: fit-content; max-width: 100%; }
.tab { padding: 4px 11px; border-radius: var(--radius); color: var(--text-muted); font-weight: 550; font-size: 13px; white-space: nowrap; }
.tab:hover { color: var(--text); text-decoration: none; }
.tab.on { color: var(--text); background: var(--surface); box-shadow: var(--shadow); }
</style>
