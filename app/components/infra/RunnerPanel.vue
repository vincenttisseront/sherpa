<script setup lang="ts">
/**
 * Target Runner d'un endpoint : enregistrement, clé HMAC (affichée une seule
 * fois), diagnostic de bout en bout, rotation de clé, retrait.
 */
import type { RunnerConfigInput } from '#shared/schemas/infra'
import type { DiagnosticResult, RunnerDto } from '#shared/schemas/runner'

const props = defineProps<{ endpointId: string, endpointName: string, hasPaths: boolean }>()
const toast = useToast()
const confirm = useConfirm()

const { data: runner, refresh } = await useFetch<RunnerDto>(() => `/api/endpoints/${props.endpointId}/runner`)
const form = reactive<RunnerConfigInput>({ url: '', caCertPem: null, serverName: null, maxConcurrentBuilds: 2 })
const errors = ref<Record<string, string>>({})
const busy = ref<string | null>(null)
const diagnostic = ref<DiagnosticResult | null>(null)
const issuedKey = ref<{ key: string, fingerprint: string } | null>(null)
const editing = ref(false)

watchEffect(() => {
  const r = runner.value
  if (!r) return
  Object.assign(form, { url: r.url ?? '', caCertPem: r.caCertPem, serverName: r.serverName, maxConcurrentBuilds: r.maxConcurrentBuilds })
  editing.value = !r.configured && !r.viaSsh
})
watch(() => props.endpointId, () => { diagnostic.value = null })

const STATUS = {
  unconfigured: { label: 'Non vérifié', tone: 'neutral' },
  online: { label: 'Opérationnel', tone: 'success' },
  offline: { label: 'Injoignable', tone: 'danger' },
  error: { label: 'En erreur', tone: 'warning' },
} as const
const STEP_TONE = { ok: 'success', warning: 'warning', error: 'danger', skipped: 'neutral' } as const
const STEP_ICON = { ok: '✓', warning: '!', error: '✕', skipped: '–' } as const

async function save() {
  busy.value = 'save'
  errors.value = {}
  try {
    const r = await $fetch<{ runner: RunnerDto, hmacKey: string | null }>(`/api/endpoints/${props.endpointId}/runner`, { method: 'PUT', body: form })
    runner.value = r.runner
    editing.value = false
    if (r.hmacKey) issuedKey.value = { key: r.hmacKey, fingerprint: r.runner.keyFingerprint ?? '' }
    else toast.success('Configuration du Runner enregistrée')
  }
  catch (err) {
    const e = apiError(err)
    errors.value = e.errors
    toast.error(e.message)
  }
  finally {
    busy.value = null
  }
}

async function diagnose() {
  busy.value = 'diag'
  try {
    diagnostic.value = await $fetch<DiagnosticResult>(`/api/endpoints/${props.endpointId}/runner/diagnose`, { method: 'POST' })
    await refresh()
    if (diagnostic.value.ok) toast.success('Diagnostic réussi')
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    busy.value = null
  }
}

async function rotate() {
  const ok = await confirm({ title: 'Renouveler la clé HMAC', message: 'L\'ancienne clé est détruite immédiatement : le Runner refusera la plateforme tant que la nouvelle clé n\'est pas installée sur l\'hôte.', confirmLabel: 'Renouveler', danger: true })
  if (!ok) return
  busy.value = 'rotate'
  try {
    const r = await $fetch<{ hmacKey: string, keyFingerprint: string }>(`/api/endpoints/${props.endpointId}/runner/rotate-key`, { method: 'POST' })
    issuedKey.value = { key: r.hmacKey, fingerprint: r.keyFingerprint }
    await refresh()
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    busy.value = null
  }
}

async function remove() {
  const ok = await confirm({ title: 'Retirer le Runner', message: `Les dépôts de fichiers et builds seront impossibles sur ${props.endpointName}. La clé HMAC est détruite.`, confirmLabel: 'Retirer', danger: true, requireText: props.endpointName })
  if (!ok) return
  busy.value = 'remove'
  try {
    await $fetch<unknown>(`/api/endpoints/${props.endpointId}/runner`, { method: 'DELETE' })
    diagnostic.value = null
    await refresh()
    toast.success('Runner retiré')
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    busy.value = null
  }
}

async function copyKey() {
  try {
    await navigator.clipboard.writeText(issuedKey.value!.key)
    toast.info('Clé copiée')
  }
  catch {
    toast.error('Copie impossible : sélectionner la clé manuellement')
  }
}

function closeKey() {
  issuedKey.value = null
  toast.success('Clé fermée : elle ne sera plus jamais affichée')
}
</script>

<template>
  <div v-if="runner" class="stack">
    <section v-if="runner.viaSsh" class="card pad">
      <div class="head">
        <h2>Fichiers et build par SSH</h2>
        <UiBadge tone="info">sans Runner</UiBadge>
      </div>
      <p class="muted small">Hôte joint en SSH : les actions du Runner (dépôt et extraction des releases, empreintes, build, nettoyage) passent par la connexion SSH du serveur (SFTP et API Docker), avec les mêmes contrôles. Rien à installer sur l'hôte.</p>
      <dl class="kv">
        <dt>Racines autorisées</dt><dd class="mono">{{ runner.sshRoots.join(', ') || 'aucune : configurer les chemins de travail' }}</dd>
      </dl>
      <div class="actions">
        <UiButton variant="primary" :loading="busy === 'diag'" @click="diagnose">Lancer le diagnostic</UiButton>
      </div>
    </section>
    <template v-else>
    <p v-if="runner.adapter === 'mock'" class="alert alert--info">
      Mode développement : le Runner est simulé (<code>RUNNER_ADAPTER=mock</code>). La configuration est enregistrée mais les appels n'atteignent pas l'hôte.
    </p>
    <p v-else-if="!runner.platformIdentity" class="alert alert--warning">
      Certificat client de la plateforme absent (<code>RUNNER_CLIENT_CERT_FILE</code> / <code>RUNNER_CLIENT_KEY_FILE</code>) : le mTLS ne pourra pas aboutir.
    </p>

    <section class="card pad">
      <div class="head">
        <h2>Target Runner</h2>
        <UiBadge v-if="runner.configured" :tone="STATUS[runner.status].tone">{{ STATUS[runner.status].label }}</UiBadge>
      </div>

      <dl v-if="runner.configured && !editing" class="kv">
        <dt>URL</dt><dd class="mono">{{ runner.url }}</dd>
        <dt>Hôte</dt><dd>{{ runner.hostname ?? '—' }} <span v-if="runner.version" class="muted">· v{{ runner.version }}</span></dd>
        <dt>Racines de l'hôte</dt><dd class="mono">{{ runner.hostRoots.join(', ') || '—' }}</dd>
        <dt>Certificat</dt><dd>{{ runner.caCertPem ? 'AC dédiée' : 'AC système' }}<template v-if="runner.serverName"> · nom attendu <span class="mono">{{ runner.serverName }}</span></template></dd>
        <dt>Clé HMAC</dt><dd>empreinte <span class="mono">{{ runner.keyFingerprint ?? '—' }}</span></dd>
        <dt>Builds simultanés</dt><dd>{{ runner.maxConcurrentBuilds }}</dd>
        <dt>Dernier contrôle</dt><dd>{{ fmtDateTime(runner.lastCheckedAt) }}</dd>
      </dl>
      <p v-if="runner.lastError && !editing" class="alert alert--danger">{{ runner.lastError }}</p>

      <form v-if="editing" class="grid" @submit.prevent="save">
        <UiField class="span-all" label="URL du Runner" for="r-url" :error="errors.url" hint="Ex. https://docker-prod-01.interne:8443" required>
          <input id="r-url" v-model.trim="form.url" class="input mono" type="url" placeholder="https://hote.interne:8443">
        </UiField>
        <UiField class="span-all" label="AC du certificat du Runner (PEM)" for="r-ca" :error="errors.caCertPem" hint="Vide : magasin de certificats système">
          <textarea id="r-ca" :value="form.caCertPem ?? ''" class="input mono" rows="4" placeholder="-----BEGIN CERTIFICATE-----" @input="form.caCertPem = ($event.target as HTMLTextAreaElement).value.trim() || null" />
        </UiField>
        <UiField label="Nom attendu dans le certificat" for="r-sn" :error="errors.serverName" hint="Si différent de l'hôte de l'URL">
          <input id="r-sn" :value="form.serverName ?? ''" class="input mono" @input="form.serverName = ($event.target as HTMLInputElement).value.trim() || null">
        </UiField>
        <UiField label="Builds simultanés" for="r-max" :error="errors.maxConcurrentBuilds">
          <input id="r-max" v-model.number="form.maxConcurrentBuilds" class="input" type="number" min="1" max="16">
        </UiField>
      </form>

      <div class="actions">
        <template v-if="editing">
          <UiButton v-if="runner?.configured" @click="editing = false">Annuler</UiButton>
          <UiButton variant="primary" :loading="busy === 'save'" :disabled="!form.url" @click="save">{{ runner?.configured ? 'Enregistrer' : 'Enregistrer et générer la clé' }}</UiButton>
        </template>
        <template v-else>
          <UiButton variant="primary" :loading="busy === 'diag'" @click="diagnose">Lancer le diagnostic</UiButton>
          <UiButton @click="editing = true">Modifier</UiButton>
          <UiButton :loading="busy === 'rotate'" @click="rotate">Renouveler la clé</UiButton>
          <span class="spacer" />
          <UiButton variant="ghost" :loading="busy === 'remove'" @click="remove">Retirer</UiButton>
        </template>
      </div>
    </section>
    </template>

    <section v-if="diagnostic" class="card pad">
      <h2>Diagnostic <UiBadge :tone="diagnostic.ok ? 'success' : 'danger'">{{ diagnostic.ok ? 'réussi' : 'échec' }}</UiBadge></h2>
      <p v-if="!hasPaths" class="muted small">Aucun chemin configuré sur cet endpoint : seules la connexion et l'authentification sont testées.</p>
      <ol class="steps">
        <li v-for="s in diagnostic.steps" :key="s.key" :class="`st-${s.status}`">
          <UiBadge :tone="STEP_TONE[s.status]">{{ STEP_ICON[s.status] }}</UiBadge>
          <div>
            <strong>{{ s.label }}</strong> <span class="muted small">{{ s.durationMs }} ms</span>
            <div class="detail">{{ s.detail }}</div>
          </div>
        </li>
      </ol>
    </section>

    <UiModal :open="!!issuedKey" title="Clé HMAC du Runner" width="560px" :dismissible="false" @update:open="() => {}">
      <div class="stack">
        <p class="alert alert--warning">Cette clé ne sera <strong>plus jamais affichée</strong>. La copier maintenant dans le fichier désigné par <code>RUNNER_HMAC_KEY_FILE</code> sur l'hôte, puis redémarrer le Runner.</p>
        <textarea class="input mono key" readonly rows="2" :value="issuedKey?.key" aria-label="Clé HMAC" @focus="($event.target as HTMLTextAreaElement).select()" />
        <p class="muted small">
          Vérification sur l'hôte : <code>tr -d '\n' &lt; hmac.key | sha256sum | cut -c1-16</code> doit afficher <code>{{ issuedKey?.fingerprint }}</code>.
        </p>
      </div>
      <template #footer>
        <UiButton @click="copyKey">Copier</UiButton>
        <UiButton variant="primary" @click="closeKey">J'ai installé la clé</UiButton>
      </template>
    </UiModal>
  </div>
</template>

<style scoped>
.stack { display: flex; flex-direction: column; gap: var(--space-3); }
.pad { padding: var(--space-3) var(--space-4); display: flex; flex-direction: column; gap: var(--space-3); }
.head { display: flex; align-items: center; gap: var(--space-3); }
.small { font-size: 12.5px; margin: 0; }
.kv { display: grid; grid-template-columns: 170px 1fr; gap: 3px var(--space-4); margin: 0; }
.kv dt { color: var(--text-muted); }
.kv dd { margin: 0; word-break: break-all; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: var(--space-2) var(--space-4); }
.span-all { grid-column: 1 / -1; }
.actions { display: flex; gap: var(--space-2); flex-wrap: wrap; align-items: center; }
.spacer { flex: 1; }
.alert { padding: var(--space-3) var(--space-4); border-radius: var(--radius); margin: 0; }
.alert--warning { background: var(--warning-bg); color: var(--warning); }
.alert--danger { background: var(--danger-bg); color: var(--danger); }
.alert--info { background: var(--info-bg); color: var(--info); }
.steps { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: var(--space-3); }
.steps li { display: flex; gap: var(--space-3); align-items: flex-start; }
.detail { font-size: 12.5px; color: var(--text-muted); word-break: break-word; }
.st-error .detail { color: var(--danger); }
.st-warning .detail { color: var(--warning); }
.key { word-break: break-all; }
@media (max-width: 860px) { .kv { grid-template-columns: 110px minmax(0, 1fr); } }
</style>
