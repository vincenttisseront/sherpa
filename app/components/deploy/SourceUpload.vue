<script setup lang="ts">
/**
 * Dépôt d'une archive ZIP : glisser-déposer, puis avancement en étapes —
 * envoi (pourcentage, volume, débit), contrôle de sécurité par le serveur
 * (étape publiée en direct), enregistrement.
 */
import type { StoredUpload } from '~/types/infra'
import type { ProgressStep } from '~/types/progress'

const emit = defineEmits<{ uploaded: [upload: StoredUpload] }>()
const { me } = useAuth()
const error = ref<string | null>(null)
const dragging = ref(false)
const input = ref<HTMLInputElement>()

const fileName = ref('')
const sent = ref(0)
const total = ref(0)
const phase = ref<'idle' | 'sending' | 'checking' | 'done' | 'error'>('idle')
const serverStep = ref<string | null>(null)
const startedAt = ref(0)
const busy = computed(() => phase.value === 'sending' || phase.value === 'checking')

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} Mo`
const steps = computed<ProgressStep[]>(() => {
  const pct = total.value ? Math.round((sent.value / total.value) * 100) : 0
  const secs = (Date.now() - startedAt.value) / 1000
  const rate = secs > 0.5 && sent.value ? ` · ${mb(sent.value / secs)}/s` : ''
  const st = (i: number): ProgressStep['state'] => {
    const order = ['sending', 'checking', 'done']
    const cur = phase.value === 'error' ? -1 : order.indexOf(phase.value)
    if (phase.value === 'error') return i === errorAt.value ? 'error' : i < errorAt.value ? 'done' : 'pending'
    return i < cur ? 'done' : i === cur ? 'active' : 'pending'
  }
  return [
    { label: `Envoi de ${fileName.value}`, state: st(0), detail: phase.value === 'sending' ? `${pct} % · ${mb(sent.value)} sur ${mb(total.value)}${rate}` : mb(total.value), percent: pct },
    { label: 'Contrôle de sécurité par la plateforme', state: st(1), detail: phase.value === 'error' && errorAt.value === 1 ? error.value : serverStep.value ?? 'Entrées, chemins, liens symboliques, taille décompressée', percent: null },
    { label: 'Archive prête', state: phase.value === 'done' ? 'done' : 'pending' },
  ]
})
const errorAt = ref(0)

const ARCHIVE_RE = /\.(zip|tar\.gz|tgz|tar)$/i
const contentType = (name: string) => (/\.zip$/i.test(name) ? 'application/zip' : /\.tar$/i.test(name) ? 'application/x-tar' : 'application/gzip')

const progressId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('')

function send(file: File) {
  error.value = null
  if (!ARCHIVE_RE.test(file.name)) {
    error.value = 'Archive .zip, .tar.gz (.tgz) ou .tar attendue'
    return
  }
  fileName.value = file.name
  total.value = file.size
  sent.value = 0
  serverStep.value = null
  startedAt.value = Date.now()
  phase.value = 'sending'
  const pid = progressId()
  let polling = false
  // Pendant le traitement serveur : étape courante publiée par la plateforme.
  const poll = async () => {
    polling = true
    while (polling) {
      const p = await fetch(`/api/progress/${pid}`).then(r => (r.ok ? r.json() : null)).catch(() => null) as { label: string } | null
      if (p && polling) serverStep.value = p.label
      await new Promise(r => setTimeout(r, 400))
    }
  }
  // XMLHttpRequest pour suivre la progression de l'envoi.
  const xhr = new XMLHttpRequest()
  xhr.open('POST', `/api/uploads?name=${encodeURIComponent(file.name)}`)
  xhr.setRequestHeader('content-type', contentType(file.name))
  xhr.setRequestHeader('x-progress-id', pid)
  // Hors de $fetch : le jeton CSRF de la session est joint explicitement.
  if (me.value?.csrfToken) xhr.setRequestHeader('x-csrf-token', me.value.csrfToken)
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      sent.value = e.loaded
      total.value = e.total
    }
  }
  xhr.upload.onload = () => {
    sent.value = total.value
    phase.value = 'checking'
    void poll()
  }
  xhr.onload = () => {
    polling = false
    let body: { statusMessage?: string } & Partial<StoredUpload> = {}
    try {
      body = JSON.parse(xhr.responseText)
    }
    catch { /* réponse non JSON */ }
    if (xhr.status === 201) {
      phase.value = 'done'
      emit('uploaded', body as StoredUpload)
    }
    else {
      error.value = body.statusMessage ?? `Archive refusée (${xhr.status})`
      errorAt.value = sent.value >= total.value ? 1 : 0
      phase.value = 'error'
    }
  }
  xhr.onerror = () => {
    polling = false
    error.value = 'Envoi interrompu'
    errorAt.value = 0
    phase.value = 'error'
  }
  xhr.send(file)
}

function onDrop(e: DragEvent) {
  dragging.value = false
  const f = e.dataTransfer?.files[0]
  if (f && !busy.value) send(f)
}
</script>

<template>
  <div class="upload">
    <div
      v-if="!busy"
      class="drop"
      :class="{ dragging }"
      role="button"
      tabindex="0"
      @click="input?.click()"
      @keydown.enter.prevent="input?.click()"
      @keydown.space.prevent="input?.click()"
      @dragover.prevent="dragging = true"
      @dragleave="dragging = false"
      @drop.prevent="onDrop"
    >
      <strong>Déposer l'archive du projet</strong>
      <span class="muted">.zip, .tar.gz (.tgz) ou .tar — ou cliquer pour la choisir ; elle est inspectée avant tout envoi vers le serveur</span>
      <input ref="input" type="file" accept=".zip,.tar.gz,.tgz,.tar,application/zip,application/gzip,application/x-tar" class="sr-only" @change="e => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) send(f); (e.target as HTMLInputElement).value = '' }">
    </div>
    <UiProgressSteps v-if="phase !== 'idle'" :steps="steps" />
    <p v-if="error && phase !== 'error'" class="error" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.upload { display: flex; flex-direction: column; gap: var(--space-3); }
.drop { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--space-2); min-height: 130px; padding: var(--space-5); border: 2px dashed var(--border); border-radius: var(--radius-lg); cursor: pointer; text-align: center; background: var(--surface); }
.drop:hover, .drop.dragging, .drop:focus-visible { border-color: var(--primary); background: var(--info-bg); outline: none; }
.error { color: var(--danger); margin: 0; }
</style>
