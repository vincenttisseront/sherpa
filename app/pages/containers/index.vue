<script setup lang="ts">
import { Activity } from 'lucide-vue-next'

useHead({ title: 'Conteneurs en direct' })
const route = useRoute()
const initialStack = typeof route.query.stack === 'string' ? route.query.stack : undefined
const endpointId = typeof route.query.endpoint === 'string' && /^[0-9a-f-]{36}$/.test(route.query.endpoint) ? route.query.endpoint : undefined
</script>

<template>
  <div>
    <LiveContainers title="Conteneurs en direct" :icon="Activity" :endpoint-id="endpointId" :initial-stack="initialStack" />
  </div>
</template>
