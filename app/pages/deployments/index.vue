<script setup lang="ts">
useHead({ title: 'Déploiements' })
</script>

<template>
  <div>
    <UiPageHeader title="Déploiements" icon="rocket" />
    <DeploymentsTable sync-route nl-search />
  </div>
</template>
