<script setup lang="ts">
/** Exposition web des services par le reverse proxy de l'endpoint (Traefik, nginx-proxy, nginx) : domaine, port interne, chemin. */
import { isAllowedHost } from '#shared/utils/domains'

const props = defineProps<{ targetId: string, services?: string[] }>()
const emit = defineEmits<{ saved: [] }>()
const toast = useToast()

interface Exp { service: string, host: string, port: number, pathPrefix: string | null, middlewares: string[] }
interface Info { exposures: Exp[], traefik: { networkName: string, allowedDomains: string[], exposure: string, redirectToHttps: boolean, entrypointHttps: string, provider?: 'traefik' | 'nginx-proxy' | 'nginx' } | null, takenHosts: { host: string, owner: string }[] }
const { data: info, refresh } = await useFetch<Info>(() => `/api/targets/${props.targetId}/exposures`)
const rows = ref<Exp[]>([])
const errors = ref<Record<string, string>>({})
const busy = ref(false)
watch(info, v => { rows.value = structuredClone(toRaw(v?.exposures ?? [])); errors.value = {} }, { immediate: true })

function add() {
  rows.value.push({ service: props.services?.[0] ?? '', host: '', port: 80, pathPrefix: null, middlewares: [] })
}
const hostHint = (h: string) => (h && info.value?.traefik && !isAllowedHost(h, info.value.traefik.allowedDomains) ? 'Domaine non autorisé' : null)

async function save() {
  busy.value = true
  errors.value = {}
  try {
    await $fetch<unknown>(`/api/targets/${props.targetId}/exposures`, { method: 'PUT', body: rows.value })
    await refresh()
    toast.success('Exposition enregistrée')
    emit('saved')
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
  <div v-if="info" class="exp">
    <p v-if="!info.traefik" class="alert">Aucun reverse proxy n'est configuré pour l'endpoint de cette cible : configurer d'abord l'onglet « Reverse proxy » de la fiche du serveur (Traefik, nginx-proxy ou nginx).</p>
    <template v-else>
      <p class="muted small">
        Domaines autorisés : <code>{{ info.traefik.allowedDomains.join(', ') || 'aucun' }}</code> · réseau <code>{{ info.traefik.networkName }}</code> ·
        exposition {{ info.traefik.exposure === 'external' ? 'externe' : 'interne' }}{{ info.traefik.redirectToHttps ? ' · HTTP redirigé vers HTTPS' : '' }}.
        {{ info.traefik.provider === 'nginx-proxy' ? 'Les variables VIRTUAL_HOST de nginx-proxy sont générées par la plateforme.' : info.traefik.provider === 'nginx' ? 'La configuration nginx (conf.d) est écrite par la plateforme au déploiement.' : 'Les labels Traefik sont générés par la plateforme.' }}
      </p>
      <table v-if="rows.length">
        <thead><tr><th>Service</th><th>Domaine</th><th>Port interne</th><th>Chemin</th><th /></tr></thead>
        <tbody>
          <tr v-for="(r, i) in rows" :key="i">
            <td>
              <select v-if="services?.length" v-model="r.service" class="input" aria-label="Service"><option v-for="s in services" :key="s" :value="s">{{ s }}</option></select>
              <input v-else v-model.trim="r.service" class="input mono" aria-label="Service" placeholder="web">
            </td>
            <td>
              <input v-model.trim="r.host" class="input mono" aria-label="Domaine" placeholder="app.apps.interne.fr">
              <span v-if="errors[`${i}.host`] || hostHint(r.host)" class="error-text">{{ errors[`${i}.host`] ?? hostHint(r.host) }}</span>
            </td>
            <td><input v-model.number="r.port" class="input num" type="number" min="1" max="65535" aria-label="Port interne"></td>
            <td>
              <input :value="r.pathPrefix ?? ''" class="input mono" aria-label="Chemin" placeholder="/" @input="r.pathPrefix = ($event.target as HTMLInputElement).value || null">
              <span v-if="errors[`${i}.pathPrefix`]" class="error-text">{{ errors[`${i}.pathPrefix`] }}</span>
            </td>
            <td><UiButton size="sm" variant="ghost" :aria-label="`Retirer ${r.host}`" @click="rows.splice(i, 1)">✕</UiButton></td>
          </tr>
        </tbody>
      </table>
      <p v-else class="muted small">Aucun service exposé par domaine.</p>
      <div class="actions">
        <UiButton size="sm" @click="add">Exposer un service</UiButton>
        <span class="spacer" />
        <UiButton size="sm" variant="primary" :loading="busy" @click="save">Enregistrer l'exposition</UiButton>
      </div>
    </template>
  </div>
</template>

<style scoped>
.exp { display: flex; flex-direction: column; gap: var(--space-3); }
.small { font-size: 12.5px; margin: 0; }
.alert { margin: 0; padding: var(--space-3) var(--space-4); border-radius: var(--radius); background: var(--warning-bg); color: var(--warning); }
table { width: 100%; border-collapse: collapse; }
th { text-align: left; font-size: 12px; color: var(--text-muted); padding: 4px; }
td { padding: 3px 4px; vertical-align: top; }
.num { width: 100px; }
.error-text { color: var(--danger); font-size: 12px; display: block; }
.actions { display: flex; gap: var(--space-2); align-items: center; }
.spacer { flex: 1; }
</style>
