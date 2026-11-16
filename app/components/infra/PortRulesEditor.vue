<script setup lang="ts">
import type { PortRuleInput } from '#shared/schemas/infra'
import type { EnvironmentDto } from '#shared/schemas/environments'

defineProps<{ environments: EnvironmentDto[], errors?: Record<string, string> }>()
const model = defineModel<PortRuleInput[]>({ required: true })

const ALWAYS_FORBIDDEN = 'SSH 22 · Docker API 2375-2377 · PostgreSQL 5432 · Redis 6379 · Agent Portainer 9001'
const POLICY_LABEL = { allowed: 'Autorisé', approval: 'Soumis à validation', forbidden: 'Interdit' } as const

function add() {
  model.value = [...model.value, { portFrom: 8000, portTo: 8099, protocol: 'tcp', policy: 'allowed', environmentKey: null, description: null }]
}
function remove(i: number) {
  model.value = model.value.filter((_, j) => j !== i)
}
function update(i: number, patch: Partial<PortRuleInput>) {
  model.value = model.value.map((r, j) => (j === i ? { ...r, ...patch } : r))
}
</script>

<template>
  <div class="rules">
    <p class="muted fixed">Toujours interdits : {{ ALWAYS_FORBIDDEN }}. Un port sans règle est soumis à validation (justification et confirmation).</p>
    <div v-if="model.length" class="scroll">
      <table>
        <thead>
          <tr><th>De</th><th>À</th><th>Protocole</th><th>Politique</th><th>Environnement</th><th>Description</th><th /></tr>
        </thead>
        <tbody>
          <tr v-for="(r, i) in model" :key="i" :class="{ invalid: errors?.[String(i)] }">
            <td><input class="input num" type="number" min="1" max="65535" :value="r.portFrom" aria-label="Port de début" @input="update(i, { portFrom: Number(($event.target as HTMLInputElement).value) })"></td>
            <td><input class="input num" type="number" min="1" max="65535" :value="r.portTo" aria-label="Port de fin" @input="update(i, { portTo: Number(($event.target as HTMLInputElement).value) })"></td>
            <td>
              <select class="input" :value="r.protocol" aria-label="Protocole" @change="update(i, { protocol: ($event.target as HTMLSelectElement).value as 'tcp' })">
                <option value="tcp">TCP</option><option value="udp">UDP</option>
              </select>
            </td>
            <td>
              <select class="input" :value="r.policy" aria-label="Politique" @change="update(i, { policy: ($event.target as HTMLSelectElement).value as 'allowed' })">
                <option v-for="(l, k) in POLICY_LABEL" :key="k" :value="k">{{ l }}</option>
              </select>
            </td>
            <td>
              <select class="input" :value="r.environmentKey ?? ''" aria-label="Environnement" @change="update(i, { environmentKey: (($event.target as HTMLSelectElement).value || null) as PortRuleInput['environmentKey'] })">
                <option value="">Tous</option>
                <option v-for="e in environments" :key="e.key" :value="e.key">{{ e.name }}</option>
              </select>
            </td>
            <td><input class="input" :value="r.description ?? ''" maxlength="200" aria-label="Description" @input="update(i, { description: ($event.target as HTMLInputElement).value || null })"></td>
            <td><UiButton variant="ghost" size="sm" :aria-label="`Supprimer la règle ${i + 1}`" @click="remove(i)">✕</UiButton></td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-for="(m, k) in errors" :key="k" class="error-text">Règle {{ Number(String(k).split('.').pop()) + 1 }} : {{ m }}</p>
    <UiButton size="sm" class="add" @click="add">Ajouter une règle</UiButton>
  </div>
</template>

<style scoped>
.rules { display: flex; flex-direction: column; gap: var(--space-3); }
.fixed { margin: 0; font-size: 12.5px; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; }
th { text-align: left; font-size: 12px; color: var(--text-muted); font-weight: 600; padding: 4px; }
td { padding: 3px 4px; }
.num { width: 90px; }
tr.invalid .input { border-color: var(--danger); }
.add { align-self: flex-start; }
.error-text { color: var(--danger); font-size: 12px; margin: 0; }
</style>
