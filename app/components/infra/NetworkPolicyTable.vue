<script setup lang="ts">
import type { EnvironmentDto } from '#shared/schemas/environments'
import type { NetworkDecision } from '#shared/schemas/infra'
import type { NetworkRow } from '~/types/infra'

const props = defineProps<{ rows: NetworkRow[], environments: EnvironmentDto[], busy?: string | null }>()
const emit = defineEmits<{ change: [name: string, patch: Partial<NetworkDecision>] }>()

const POLICY = { unreviewed: 'À examiner', allowed: 'Autorisé', forbidden: 'Interdit' } as const
const ROLE = { none: '—', traefik: 'Traefik', app: 'Applicatif' } as const
const tone = (p: keyof typeof POLICY) => (p === 'allowed' ? 'success' : p === 'forbidden' ? 'danger' : 'warning')

const f = useListFilter(() => props.rows, r => `${r.name} ${r.description ?? ''} ${r.driver ?? ''}`, r => r.missing ? 'missing' : r.policy)
const STATUSES = { ...POLICY, missing: 'Disparu' }

function toggleEnv(row: NetworkRow, key: string) {
  const set = new Set<string>(row.allowedEnvironmentKeys)
  if (set.has(key)) set.delete(key)
  else set.add(key)
  emit('change', row.name, { allowedEnvironmentKeys: [...set] as NetworkDecision['allowedEnvironmentKeys'] })
}
</script>

<template>
  <UiListFilter v-model:q="f.q.value" v-model:status="f.status.value" :statuses="STATUSES" :count="f.filtered.value.length" :total="f.total.value" :active="f.active.value" placeholder="Filtrer les réseaux…" @reset="f.reset" />
  <div class="scroll">
    <table>
      <thead>
        <tr><th>Réseau</th><th>Politique</th><th>Rôle</th><th>Environnements autorisés</th><th>Description</th></tr>
      </thead>
      <tbody>
        <tr v-if="f.filtered.value.length === 0"><td colspan="5" class="empty">{{ rows.length ? 'Aucun réseau ne correspond au filtre' : 'Aucun réseau découvert' }}</td></tr>
        <tr v-for="r in f.filtered.value" :key="r.name" :class="{ missing: r.missing }" :aria-busy="busy === r.name || undefined">
          <td>
            <span class="name">
              <strong class="mono">{{ r.name }}</strong>
              <span class="meta muted">{{ r.driver }} · {{ r.scope }}<template v-if="r.internal"> · interne</template></span>
              <UiBadge v-if="r.missing" tone="danger">disparu</UiBadge>
            </span>
          </td>
          <td>
            <select class="input input-sm policy" :class="tone(r.policy)" :value="r.policy" :aria-label="`Politique de ${r.name}`" @change="emit('change', r.name, { policy: ($event.target as HTMLSelectElement).value as NetworkDecision['policy'] })">
              <option v-for="(l, k) in POLICY" :key="k" :value="k">{{ l }}</option>
            </select>
          </td>
          <td>
            <select class="input input-sm" :value="r.role" :aria-label="`Rôle de ${r.name}`" @change="emit('change', r.name, { role: ($event.target as HTMLSelectElement).value as NetworkDecision['role'] })">
              <option v-for="(l, k) in ROLE" :key="k" :value="k">{{ l }}</option>
            </select>
          </td>
          <td>
            <div class="envs">
              <label v-for="e in environments" :key="e.key" class="env">
                <input type="checkbox" :checked="r.allowedEnvironmentKeys.includes(e.key as never)" :disabled="r.policy !== 'allowed'" @change="toggleEnv(r, e.key)">
                {{ e.name }}
              </label>
              <span v-if="r.policy === 'allowed' && r.allowedEnvironmentKeys.length === 0" class="muted small">tous</span>
            </div>
          </td>
          <td>
            <input class="input input-sm" :value="r.description ?? ''" maxlength="500" :aria-label="`Description de ${r.name}`" @change="emit('change', r.name, { description: ($event.target as HTMLInputElement).value || null })">
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; }
th { text-align: left; font-size: 11px; text-transform: uppercase; color: var(--text-muted); font-weight: 600; padding: 4px 8px; border-bottom: 1px solid var(--border); white-space: nowrap; }
td { padding: 3px 8px; border-bottom: 1px solid var(--border); vertical-align: middle; }
.name { display: inline-flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.meta { font-size: 11.5px; white-space: nowrap; }
.policy { min-width: 120px; font-weight: 550; }
.policy.success { color: var(--success); background: var(--success-bg); }
.policy.danger { color: var(--danger); background: var(--danger-bg); }
.policy.warning { color: var(--warning); background: var(--warning-bg); }
.envs { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: center; }
.env { display: inline-flex; gap: 4px; align-items: center; white-space: nowrap; }
.small { font-size: 12px; }
tr.missing { opacity: .6; }
tr[aria-busy] { opacity: .6; }
.empty { text-align: center; color: var(--text-muted); padding: var(--space-5); }
</style>
