<script setup lang="ts">
/**
 * Terminal dans un conteneur en marche (docker exec -it), à la demande : la sortie arrive par SSE, la saisie part
 * par lots ordonnés (une seule requête à la fois). Fermer l'onglet, le composant ou le terminal ferme la session.
 * Chaque ouverture est journalisée (audit container.exec_open / exec_close), jamais la saisie.
 */
import '@xterm/xterm/css/xterm.css'
import { Power, Terminal as TerminalIcon } from 'lucide-vue-next'

const props = defineProps<{ endpointId: string, containerId: string }>()
const toast = useToast()
const shell = ref<'auto' | 'sh' | 'bash'>('auto')
const state = ref<'idle' | 'connecting' | 'open' | 'closed'>('idle')
const message = ref<string | null>(null)
const host = ref<HTMLElement>()

type XTerm = import('@xterm/xterm').Terminal
type Fit = import('@xterm/addon-fit').FitAddon
let term: XTerm | null = null
let fit: Fit | null = null
let source: EventSource | null = null
let sessionId: string | null = null
let resizeObserver: ResizeObserver | null = null
let resizeTimer: ReturnType<typeof setTimeout> | undefined

// Saisie : un seul POST à la fois, les frappes arrivées entre-temps partent ensemble (ordre conservé).
let pending = ''
let sending = false
async function flush() {
  if (sending || !pending || !sessionId) return
  sending = true
  try {
    while (pending && sessionId) {
      const data = pending
      pending = ''
      await $fetch<unknown>(`/api/exec/${sessionId}`, { method: 'POST', body: { type: 'input', data } })
    }
  }
  catch (err) {
    if (state.value === 'open') message.value = `Saisie refusée : ${apiError(err).message}`
  }
  finally {
    sending = false
  }
}

function sendSize() {
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => {
    if (!term || !fit || !sessionId) return
    fit.fit()
    void $fetch<unknown>(`/api/exec/${sessionId}`, { method: 'POST', body: { type: 'resize', cols: term.cols, rows: term.rows } }).catch(() => undefined)
  }, 120)
}

async function open() {
  state.value = 'connecting'
  message.value = null
  try {
    const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')])
    await nextTick()
    term = new Terminal({
      cursorBlink: true, fontSize: 13, scrollback: 5000, convertEol: false,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      theme: { background: '#0f1420', foreground: '#e6e9f0', cursor: '#7aa2ff' },
    })
    fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host.value!)
    fit.fit()
    const r = await $fetch<{ sessionId: string }>(`/api/endpoints/${props.endpointId}/containers/${props.containerId}/exec`, { method: 'POST', body: { cols: term.cols, rows: term.rows, shell: shell.value } })
    sessionId = r.sessionId
    term.onData((d) => {
      pending += d
      void flush()
    })
    source = new EventSource(`/api/exec/${sessionId}/stream`)
    source.addEventListener('data', (e) => {
      const bin = atob((e as MessageEvent<string>).data)
      const bytes = Uint8Array.from(bin, ch => ch.charCodeAt(0))
      term?.write(bytes)
    })
    source.addEventListener('exit', (e) => {
      message.value = `Session terminée (${(e as MessageEvent<string>).data}).`
      end()
    })
    source.onerror = () => {
      // Le navigateur se reconnecte seul tant que la session existe ; fermé pour de bon = session introuvable.
      if (source?.readyState === EventSource.CLOSED && state.value === 'open') {
        message.value = 'Connexion au terminal perdue.'
        end()
      }
    }
    source.onopen = () => { state.value = 'open' }
    resizeObserver = new ResizeObserver(sendSize)
    resizeObserver.observe(host.value!)
    term.focus()
  }
  catch (err) {
    message.value = apiError(err).message
    toast.error(message.value)
    teardown()
    state.value = 'idle'
  }
}

function end() {
  source?.close()
  source = null
  state.value = 'closed'
}

function teardown() {
  clearTimeout(resizeTimer)
  resizeObserver?.disconnect()
  resizeObserver = null
  source?.close()
  source = null
  term?.dispose()
  term = null
  fit = null
}

async function close() {
  const id = sessionId
  sessionId = null
  teardown()
  state.value = 'idle'
  message.value = null
  if (id) await $fetch<unknown>(`/api/exec/${id}`, { method: 'DELETE' }).catch(() => undefined)
}

onBeforeUnmount(() => {
  const id = sessionId
  sessionId = null
  teardown()
  if (id) void $fetch<unknown>(`/api/exec/${id}`, { method: 'DELETE' }).catch(() => undefined)
})
</script>

<template>
  <section class="exec" data-testid="exec-panel">
    <div class="bar">
      <template v-if="state === 'idle' || state === 'closed'">
        <label class="small" for="exec-shell">Interpréteur</label>
        <select id="exec-shell" v-model="shell" class="input sm">
          <option value="auto">Automatique (bash, sinon sh)</option>
          <option value="sh">sh</option>
          <option value="bash">bash</option>
        </select>
        <UiButton size="sm" variant="primary" data-testid="exec-open" @click="state === 'closed' ? close().then(open) : open()"><TerminalIcon :size="13" /> {{ state === 'closed' ? 'Nouvelle session' : 'Ouvrir un terminal' }}</UiButton>
      </template>
      <template v-else>
        <UiBadge :tone="state === 'open' ? 'success' : 'info'">{{ state === 'open' ? 'connecté' : 'connexion…' }}</UiBadge>
        <UiButton size="sm" variant="ghost" data-testid="exec-close" @click="close"><Power :size="13" /> Fermer le terminal</UiButton>
      </template>
    </div>
    <p v-if="state === 'idle'" class="muted small">Accès shell au conteneur, avec les droits de son utilisateur. Chaque ouverture et fermeture est journalisée dans l'audit (la saisie ne l'est pas). Fermé après 15 minutes sans saisie.</p>
    <p v-if="message" class="note small" role="status" data-testid="exec-message">{{ message }}</p>
    <div v-show="state !== 'idle'" ref="host" class="term" role="application" aria-label="Terminal du conteneur" data-testid="exec-terminal" />
  </section>
</template>

<style scoped>
.exec { display: flex; flex-direction: column; gap: var(--space-2); }
.bar { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.small { font-size: 12.5px; margin: 0; }
.sm { max-width: 260px; }
.note { padding: 6px 10px; border-radius: var(--radius); background: var(--surface-2); border: 1px solid var(--border); }
.term { height: 420px; background: #0f1420; border-radius: var(--radius); padding: 8px; overflow: hidden; }
.term :deep(.xterm) { height: 100%; }
</style>
