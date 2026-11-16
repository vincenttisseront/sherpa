<script setup lang="ts">
/**
 * Plage d'adresses des réseaux des projets d'un endpoint : chaque réseau de projet reçoit un
 * sous-réseau de la taille choisie (au lieu des /16 de Docker), stable d'un déploiement à l'autre.
 */
import type { NetworkPoolDto } from '#shared/schemas/network-pool'

const props = defineProps<{ endpointId: string, canManage: boolean }>()
const emit = defineEmits<{ saved: [] }>()
const toast = useToast()
const { data, error } = useFetch<NetworkPoolDto>(() => `/api/endpoints/${props.endpointId}/network-pool`, { server: false, lazy: true })

const PREFIXES = [24, 25, 26, 27, 28, 29].map(p => ({ prefix: p, hosts: 2 ** (32 - p) - 2 }))
const form = reactive({ enabled: false, base: '10.210.0.0/16', prefix: 27, avoid: [] as string[] })
watch(data, (d) => {
  if (!d) return
  Object.assign(form, d.pool ? { enabled: true, base: d.pool.base, prefix: d.pool.prefix, avoid: [...d.pool.avoid] } : { enabled: false })
}, { immediate: true })
const errors = ref<Record<string, string>>({})
const busy = ref(false)
const showHost = ref(false)

async function save() {
  busy.value = true
  errors.value = {}
  try {
    const r = await $fetch<NetworkPoolDto & { released: number }>(`/api/endpoints/${props.endpointId}/network-pool`, {
      method: 'PUT',
      body: { pool: form.enabled ? { base: form.base, prefix: form.prefix, avoid: form.avoid } : null },
    })
    data.value = r
    emit('saved')
    toast.success(form.enabled
      ? `Plage enregistrée${r.released ? ` ; ${r.released} attribution(s) hors plage libérée(s), réattribuée(s) au prochain déploiement` : ''}`
      : 'Plage retirée : Docker attribue de nouveau les sous-réseaux')
  }
  catch (err) {
    const e = apiError(err)
    errors.value = e.errors
    toast.error(e.message)
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="np">
    <p class="muted small">Sans plage, Docker donne à chaque réseau de projet un /16 (65 534 adresses) pris dans 172.17–172.31 ou 192.168, au risque de recouvrir un réseau de l'entreprise. Avec une plage, chaque réseau d'un projet (réseau « default » compris) reçoit un sous-réseau de la taille choisie, stable d'un déploiement à l'autre, hors des plages à éviter et des réseaux déjà présents sur l'hôte. Un réseau déjà créé change de sous-réseau à son prochain déploiement.</p>
    <p v-if="error" class="alert">{{ apiError(error).message }}</p>
    <template v-else-if="data">
      <label class="check"><input v-model="form.enabled" type="checkbox" :disabled="!canManage"> <span><strong>Attribuer les sous-réseaux depuis une plage</strong></span></label>
      <div v-if="form.enabled" class="grid">
        <UiField label="Plage" for="np-base" :error="errors.base" hint="Ex. 10.210.0.0/16 : à réserver aux conteneurs de cet hôte">
          <input id="np-base" v-model.trim="form.base" class="input mono" :disabled="!canManage" placeholder="10.210.0.0/16">
        </UiField>
        <UiField label="Taille de chaque réseau" for="np-prefix" :error="errors.prefix">
          <select id="np-prefix" v-model.number="form.prefix" class="input" :disabled="!canManage">
            <option v-for="p in PREFIXES" :key="p.prefix" :value="p.prefix">/{{ p.prefix }} — {{ p.hosts }} conteneurs</option>
          </select>
        </UiField>
        <UiField label="Plages à éviter" for="np-avoid" hint="Réseaux de l'entreprise, VPN, AWX… (Entrée pour ajouter)" class="wide">
          <UiTagInput id="np-avoid" v-model="form.avoid" placeholder="172.24.0.0/16" :max="50" />
        </UiField>
      </div>
      <div class="actions">
        <span v-if="data.pool && data.capacity" class="muted small">{{ data.allocations.length }} réseau(x) attribué(s) sur {{ data.capacity }} possibles dans {{ data.pool.base }}</span>
        <span class="spacer" />
        <UiButton v-if="canManage" size="sm" variant="primary" :loading="busy" @click="save">Enregistrer</UiButton>
      </div>

      <table v-if="data.allocations.length" class="table">
        <thead><tr><th>Sous-réseau</th><th>Projet</th><th>Environnement</th><th>Réseau</th></tr></thead>
        <tbody>
          <tr v-for="a in data.allocations" :key="a.subnet">
            <td class="mono small">{{ a.subnet }}</td>
            <td>{{ a.project }}</td>
            <td>{{ a.environment }}</td>
            <td class="mono small">{{ a.network }}</td>
          </tr>
        </tbody>
      </table>
      <div v-if="data.hostSubnets.length">
        <UiButton size="sm" variant="ghost" @click="showHost = !showHost">{{ showHost ? 'Masquer' : 'Voir' }} les {{ data.hostSubnets.length }} sous-réseau(x) déjà utilisés sur l'hôte</UiButton>
        <table v-if="showHost" class="table">
          <thead><tr><th>Sous-réseau</th><th>Réseau Docker</th></tr></thead>
          <tbody>
            <tr v-for="h in data.hostSubnets" :key="`${h.network}-${h.subnet}`"><td class="mono small">{{ h.subnet }}</td><td class="mono small">{{ h.network }}</td></tr>
          </tbody>
        </table>
      </div>
    </template>
    <p v-else class="muted small">Lecture…</p>
  </div>
</template>

<style scoped>
.np { display: flex; flex-direction: column; gap: var(--space-3); }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
.grid .wide { grid-column: 1 / -1; }
@media (max-width: 720px) { .grid { grid-template-columns: 1fr; } }
.actions { display: flex; align-items: center; gap: var(--space-2); }
.spacer { flex: 1; }
.check { display: flex; gap: 8px; align-items: flex-start; font-size: 13px; }
.small { font-size: 12.5px; }
p { margin: 0; }
.alert { padding: var(--space-2) var(--space-3); border-radius: var(--radius); background: var(--danger-bg); color: var(--danger); }
</style>
