<script setup lang="ts">
/** Suppression de l'ancien cluster PostgreSQL, une fois la migration validée. */
import type { ServiceUpgrade } from '#shared/schemas/image-upgrade'

const props = defineProps<{ targetId: string, service: ServiceUpgrade }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ done: [] }>()
const toast = useToast()
const m = computed(() => props.service.migrated!)
const removeBackup = ref(false)
const confirmText = ref('')
const busy = ref(false)
const log = ref<string[]>([])

async function run() {
  busy.value = true
  try {
    const r = await $fetch<{ log: string[], backupRemoved: boolean }>(`/api/targets/${props.targetId}/pg-migration/cleanup`, {
      method: 'POST',
      body: { service: props.service.service, confirm: confirmText.value, removeBackup: removeBackup.value },
    })
    log.value = r.log
    toast.success(`Ancien cluster de ${props.service.service} supprimé${r.backupRemoved ? ', sauvegarde comprise' : ''}`)
    emit('done')
  }
  catch (err) {
    const e = apiError(err)
    toast.error(Object.values(e.errors)[0] ?? e.message)
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <UiModal v-model:open="open" :title="`Supprimer l'ancien cluster de ${service.service}`" width="620px">
    <div class="cl">
      <p class="small">Migration vers PostgreSQL {{ m.major }} du {{ fmtDateTime(m.at) }}. À ne faire qu'une fois la nouvelle version validée (application vérifiée) : l'ancien cluster permet de revenir en arrière, il ne pourra plus l'être après.</p>
      <dl class="kv">
        <dt>Ancien cluster</dt><dd class="mono small">{{ m.oldPgdata }}</dd>
        <dt>Cluster en service</dt><dd class="mono small">{{ m.path }}</dd>
        <dt>Sauvegarde</dt><dd class="mono small">{{ m.backupDir ?? '—' }}</dd>
      </dl>
      <p class="muted small">Avant de supprimer, la console vérifie que {{ service.service }} tourne, sain, sur {{ m.path }}, et que ce cluster est présent. Les sous-dossiers pgNN ne sont jamais touchés.</p>
      <label v-if="m.backupDir" class="check"><input v-model="removeBackup" type="checkbox"> <span>Supprimer aussi la sauvegarde de la migration</span></label>
      <UiField :label="`Saisir le nom du service (${service.service}) pour confirmer`" for="pg-cl-confirm">
        <input id="pg-cl-confirm" v-model.trim="confirmText" class="input input-sm mono" autocomplete="off" :placeholder="service.service">
      </UiField>
      <pre v-if="log.length" class="mono small out">{{ log.join('\n') }}</pre>
    </div>
    <template #footer>
      <UiButton variant="ghost" @click="open = false">{{ log.length ? 'Fermer' : 'Annuler' }}</UiButton>
      <UiButton v-if="!log.length" variant="danger" :loading="busy" :disabled="confirmText !== service.service" @click="run">Supprimer l'ancien cluster</UiButton>
    </template>
  </UiModal>
</template>

<style scoped>
.cl { display: flex; flex-direction: column; gap: var(--space-3); }
.kv { display: grid; grid-template-columns: 140px 1fr; gap: 6px 12px; margin: 0; font-size: 13px; }
.kv dt { color: var(--text-muted); }
.kv dd { margin: 0; overflow-wrap: anywhere; }
.check { display: flex; gap: 8px; align-items: flex-start; font-size: 13px; }
.small { font-size: 12.5px; }
p { margin: 0; }
.out { margin: 0; padding: var(--space-2); background: var(--surface-2); border-radius: var(--radius); white-space: pre-wrap; }
</style>
