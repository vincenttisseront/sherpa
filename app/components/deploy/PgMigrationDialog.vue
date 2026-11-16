<script setup lang="ts">
/**
 * Migration d'un service PostgreSQL vers une nouvelle version majeure : plan relevé sur le
 * conteneur en service, choix de la version, confirmation, puis suivi dans le déploiement.
 */
import type { PgMigrationPlan } from '#shared/schemas/pg-migration'
import { DatabaseZap } from 'lucide-vue-next'

const props = defineProps<{ targetId: string, service: string }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ started: [deploymentId: string] }>()
const toast = useToast()

const { data: plan, error } = useFetch<PgMigrationPlan>(() => `/api/targets/${props.targetId}/pg-migration`, { query: { service: props.service }, server: false, lazy: true })
const tag = ref('')
watch(plan, (p) => {
  if (p?.candidates.length && !tag.value) tag.value = p.candidates.at(-1)!.tag
}, { immediate: true })
const target = computed(() => plan.value?.candidates.find(c => c.tag === tag.value) ?? null)
const newPgdata = computed(() => (plan.value?.mount && target.value ? `${plan.value.mount.destination.replace(/\/+$/, '')}/pg${target.value.major}` : null))
const confirmText = ref('')
const busy = ref(false)

async function run() {
  busy.value = true
  try {
    const r = await $fetch<{ deploymentId: string, from: string, to: string }>(`/api/targets/${props.targetId}/pg-migration`, {
      method: 'POST',
      body: { service: props.service, tag: tag.value, confirm: confirmText.value },
      headers: { 'Idempotency-Key': crypto.randomUUID() },
    })
    toast.success(`Migration lancée : ${r.from} → ${r.to}`)
    open.value = false
    emit('started', r.deploymentId)
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
  <UiModal v-model:open="open" :title="`Migrer les données de ${service}`" width="720px">
    <p v-if="error" class="alert">{{ apiError(error).message }}</p>
    <p v-else-if="!plan" class="muted small">Lecture du service, du volume et des versions publiées…</p>
    <div v-else class="mig">
      <p class="lead small"><DatabaseZap :size="16" class="ico" /> Une version majeure de PostgreSQL ne relit pas les données d'une autre : elles sont sauvegardées puis restaurées dans un nouveau cluster, sur l'hôte. Les anciennes données ne sont pas modifiées.</p>

      <ul v-if="plan.blockers.length" class="alert list">
        <li v-for="b in plan.blockers" :key="b">{{ b }}</li>
      </ul>

      <dl class="kv">
        <dt>En service</dt><dd class="mono">{{ plan.image }}</dd>
        <dt>Version cible</dt>
        <dd>
          <select v-if="plan.candidates.length" v-model="tag" class="input input-sm" aria-label="Version cible">
            <option v-for="c in plan.candidates" :key="c.tag" :value="c.tag">PostgreSQL {{ c.major }} ({{ c.tag }})</option>
          </select>
          <span v-else class="muted">—</span>
        </dd>
        <dt>Volume</dt><dd class="mono small">{{ plan.mount ? `${plan.mount.source} → ${plan.mount.destination}` : '—' }}</dd>
        <dt>Données actuelles</dt><dd class="mono small">{{ plan.pgdata ?? '—' }} <span class="muted">(conservées)</span></dd>
        <dt>Nouvelles données</dt><dd class="mono small">{{ newPgdata ?? '—' }}</dd>
        <dt>Superutilisateur</dt><dd class="mono small">{{ plan.user ?? '—' }}</dd>
        <dt>Sauvegarde</dt><dd class="mono small">{{ plan.backupDir ?? '—' }}</dd>
      </dl>

      <ol class="steps small">
        <li>Arrêt de la stack (plus aucune écriture).</li>
        <li>Sauvegarde complète (<code>pg_dumpall</code> : rôles, bases, droits) avec l'image actuelle.</li>
        <li>Nouveau cluster PostgreSQL {{ target?.major ?? '' }} dans <code>{{ newPgdata ?? '…' }}</code>, restauration, contrôle des bases.</li>
        <li>Redéploiement sur <code>{{ target?.image ?? '…' }}</code> et healthchecks.</li>
        <li>En cas d'échec à une étape : retour automatique à l'image actuelle, sur les données d'origine.</li>
      </ol>
      <ul v-if="plan.notes.length" class="muted small notes">
        <li v-for="n in plan.notes" :key="n">{{ n }}</li>
      </ul>

      <UiField :label="`Saisir le nom du service (${service}) pour confirmer l'arrêt de la stack et la migration`" for="pg-confirm">
        <input id="pg-confirm" v-model.trim="confirmText" class="input input-sm mono" autocomplete="off" :placeholder="service">
      </UiField>
    </div>
    <template #footer>
      <UiButton variant="ghost" @click="open = false">Annuler</UiButton>
      <UiButton variant="primary" :loading="busy" :disabled="!plan || plan.blockers.length > 0 || !target || confirmText !== service" @click="run">Migrer vers PostgreSQL {{ target?.major ?? '' }}</UiButton>
    </template>
  </UiModal>
</template>

<style scoped>
.mig { display: flex; flex-direction: column; gap: var(--space-3); }
.lead { display: flex; gap: 8px; align-items: flex-start; margin: 0; }
.ico { flex: none; color: var(--primary); margin-top: 1px; }
.kv { display: grid; grid-template-columns: 150px 1fr; gap: 6px 12px; margin: 0; font-size: 13px; align-items: center; }
.kv dt { color: var(--text-muted); }
.kv dd { margin: 0; overflow-wrap: anywhere; }
.steps { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 3px; }
.notes { margin: 0; padding-left: 18px; }
.small { font-size: 12.5px; }
.alert { margin: 0; padding: var(--space-2) var(--space-3); border-radius: var(--radius); background: var(--danger-bg); color: var(--danger); }
.alert.list { padding-left: 28px; }
</style>
