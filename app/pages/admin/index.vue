<script setup lang="ts">
const { hasAny } = useAuth()
await navigateTo(hasAny('policy:manage') ? '/admin/readiness' : hasAny('user:manage') ? '/admin/users' : hasAny('group:manage') ? '/admin/groups' : hasAny('role:manage') ? '/admin/roles' : hasAny('notification:manage') ? '/admin/notifications' : hasAny('audit:read') ? '/admin/retention' : hasAny('domain:manage') ? '/admin/dns' : '/', { replace: true })
</script>

<template><div /></template>
