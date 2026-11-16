<script setup lang="ts">
/**
 * Levée guidée des points bloquants d'une reprise, un par un :
 * - port publié : placé derrière le Traefik de l'endpoint (publication web,
 *   port retiré du Compose), justifié pour ce projet (repris au premier
 *   déploiement) ou autorisé durablement sur l'endpoint ;
 * - chemin bind hors liste blanche : ajout du chemin (ou de son dossier) ;
 * - port ou montage impossible à autoriser : retiré de la reprise (Compose repris sans lui) ;
 * - autres points : explication et réglage à faire (Compose, réseaux, Traefik).
 * Les règles d'endpoint sont écrites aussitôt (auditées) ; l'analyse est relancée à la fin.
 */
import { containerPortOf, suggestWebHost, webHint as webHintOf } from '#shared/utils/web-ports'
import type { AdoptionInput } from '#shared/schemas/adoption'
import type { AnalysisResult, ComposeIssue, MountReport, PortApproval, PortReport } from '#shared/schemas/analysis'
import { CheckCircle2, CircleAlert, Globe, SkipForward } from 'lucide-vue-next'

const props = defineProps<{
  analysis: AnalysisResult
  endpointId: string
  serverId: string
  stack: string
  environment: { key: string, name: string }
  /** Point à ouvrir en premier (index dans les points bloquants). */
  start?: number
}>()
const open = defineModel<boolean>('open', { required: true })
const approvals = defineModel<PortApproval[]>('approvals', { required: true })
const webExposures = defineModel<AdoptionInput['webExposures']>('webExposures', { required: true })
const droppedPorts = defineModel<AdoptionInput['droppedPorts']>('droppedPorts', { required: true })
const droppedMounts = defineModel<AdoptionInput['droppedMounts']>('droppedMounts', { required: true })
const emit = defineEmits<{ finish: [changed: boolean] }>()

interface Step { issue: ComposeIssue, kind: 'port' | 'bind' | 'mount' | 'other', port?: PortReport, mount?: MountReport, forbidden?: boolean }
const steps = computed<Step[]>(() => props.analysis.issues.filter(i => i.severity === 'error').map((issue) => {
  if (issue.code === 'ports.approval' || issue.code === 'ports.forbidden') {
    const n = Number(/Port (\d+)\//.exec(issue.message)?.[1])
    const port = props.analysis.ports.find(p => p.service === issue.service && p.published === n && !p.accepted)
    if (port) return { issue, kind: 'port', port, forbidden: issue.code === 'ports.forbidden' }
  }
  if (issue.code === 'volumes.refused' && /liste blanche/.test(issue.message)) {
    const mount = props.analysis.mounts.find(m => m.service === issue.service && !m.accepted && m.type === 'bind' && issue.message.includes(m.target))
    if (mount?.effectiveSource ?? mount?.source) return { issue, kind: 'bind', mount }
  }
  // Chemin impossible à autoriser (répertoire système, socket…) : seul le retrait du montage lève le point.
  if (issue.code === 'volumes.refused') {
    const mount = props.analysis.mounts.find(m => m.service === issue.service && !m.accepted && issue.message.includes(m.target))
    if (mount) return { issue, kind: 'mount', mount }
  }
  return { issue, kind: 'other' }
}))

const index = ref(0)
const status = ref<Record<number, 'done' | 'skipped'>>({})
const changed = ref(false)
const busy = ref(false)
const error = ref<string | null>(null)
const step = computed(() => steps.value[index.value] ?? null)

// Formulaire du point courant, réinitialisé à chaque point.
const form = reactive({ host: '', pathPrefix: '', choice: 'justify' as 'web' | 'justify' | 'allow' | 'file' | 'dir' | 'drop', justification: '', confirmed: false, allPorts: false, scope: 'env' as 'env' | 'all', mode: 'ro' as 'ro' | 'rw', description: '' })
const sourceOf = (m: MountReport) => (m.effectiveSource ?? m.source)!

// --- Publication web : le port publié devient une exposition derrière le Traefik de l'endpoint ---
const { data: epConfig, status: epConfigStatus } = useFetch<{ traefik: { allowedDomains: string[], networkName: string } | null }>(() => `/api/endpoints/${props.endpointId}/config`, { server: false })
const traefik = computed(() => epConfig.value?.traefik ?? null)
const containerPort = (p: PortReport) => containerPortOf(p)
const webHint = (p: PortReport) => webHintOf(p, props.analysis.images[p.service])
const suggestHost = (p: PortReport) => suggestWebHost(p.service, props.stack, traefik.value?.allowedDomains ?? [])
const parentOf = (p: string) => p.replace(/\/[^/]+\/?$/, '') || '/'
function reset() {
  error.value = null
  const s = step.value
  if (!s) return
  if (s.kind === 'port') {
    const existing = approvals.value.find(a => a.service === s.port!.service && a.published === s.port!.published && a.protocol === s.port!.protocol)
    const web = webExposures.value.find(w => w.service === s.port!.service && w.published === s.port!.published)
    Object.assign(form, {
      choice: web || (webHint(s.port!) && traefik.value) ? 'web' : s.forbidden ? (traefik.value ? 'web' : 'drop') : 'justify',
      host: web?.host ?? suggestHost(s.port!),
      pathPrefix: web?.pathPrefix ?? '',
      justification: existing?.justification ?? `Port publié par la stack existante ${props.stack} (service ${s.port!.service}), repris tel quel`,
      confirmed: existing?.confirmed ?? false,
      allPorts: false,
      scope: 'env',
      description: `Reprise de ${props.stack} : ${s.port!.service}`,
    })
  }
  else if (s.kind === 'bind') {
    Object.assign(form, { choice: 'file', scope: 'env', mode: s.mount!.readOnly ? 'ro' : 'rw', description: `Reprise de ${props.stack} : ${s.mount!.service} → ${s.mount!.target}` })
  }
}
watch([open, index], () => {
  if (open.value) reset()
}, { immediate: true })
// Configuration Traefik lue après l'ouverture : choix par défaut et domaine proposé recalculés.
watch(epConfigStatus, (st) => {
  if (st === 'success' && open.value) reset()
})
watch(open, (o) => {
  if (o) {
    index.value = Math.min(props.start ?? 0, Math.max(steps.value.length - 1, 0))
    status.value = {}
    changed.value = false
    reset()
  }
})

function next() {
  const after = steps.value.findIndex((_, i) => i > index.value && !status.value[i])
  if (after >= 0) index.value = after
  else if (index.value < steps.value.length - 1) index.value++
  else finish()
}
function skip() {
  status.value[index.value] = 'skipped'
  next()
}
function finish() {
  open.value = false
  emit('finish', changed.value)
}

const canApply = computed(() => {
  const s = step.value
  if (!s || s.kind === 'other') return false
  if (s.kind === 'mount' || form.choice === 'drop') return true
  if (s.kind === 'port' && form.choice === 'web') return !!traefik.value && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(form.host.trim()) && (!form.pathPrefix || form.pathPrefix.startsWith('/'))
  if (s.kind === 'port' && form.choice === 'justify') return form.justification.trim().length >= 10 && form.confirmed
  return form.description.trim().length >= 3
})

async function apply() {
  const s = step.value
  if (!s) return
  error.value = null
  busy.value = true
  try {
    const environmentKey = form.scope === 'env' ? props.environment.key : null
    if (s.kind === 'port' && form.choice === 'drop') {
      const p = s.port!
      const same = (x: { service: string, published: number, protocol: string }) => x.service === p.service && x.published === p.published && x.protocol === p.protocol
      droppedPorts.value = [...droppedPorts.value.filter(x => !same(x)), { service: p.service, published: p.published!, protocol: p.protocol }]
      approvals.value = approvals.value.filter(a => !same(a))
      webExposures.value = webExposures.value.filter(w => !same(w))
    }
    else if (s.kind === 'mount' || (s.kind === 'bind' && form.choice === 'drop')) {
      const m = s.mount!
      droppedMounts.value = [...droppedMounts.value.filter(x => !(x.service === m.service && x.target === m.target)), { service: m.service, target: m.target }]
    }
    else if (s.kind === 'port' && form.choice === 'web') {
      const p = s.port!
      webExposures.value = [
        ...webExposures.value.filter(w => !(w.service === p.service && w.published === p.published && w.protocol === p.protocol)),
        { service: p.service, published: p.published!, protocol: p.protocol, port: containerPort(p), host: form.host.trim().toLowerCase(), pathPrefix: form.pathPrefix.trim() || null },
      ]
      // Une justification devenue inutile est retirée.
      approvals.value = approvals.value.filter(a => !(a.service === p.service && a.published === p.published && a.protocol === p.protocol))
    }
    else if (s.kind === 'port' && form.choice === 'justify') {
      const targets = [{ s, i: index.value }, ...(form.allPorts ? otherPorts.value : [])]
      const same = (a: PortApproval, p: PortReport) => a.service === p.service && a.published === p.published && a.protocol === p.protocol
      approvals.value = [
        ...approvals.value.filter(a => !targets.some(t => same(a, t.s.port!))),
        ...targets.map(t => ({ service: t.s.port!.service, published: t.s.port!.published!, protocol: t.s.port!.protocol, justification: form.justification.trim(), confirmed: true })),
      ]
      for (const t of targets) status.value[t.i] = 'done'
    }
    else if (s.kind === 'port') {
      await $fetch(`/api/endpoints/${props.endpointId}/adoption/allow`, { method: 'POST', body: { kind: 'port', port: s.port!.published, protocol: s.port!.protocol, environmentKey, description: form.description.trim() } })
      changed.value = true
    }
    else if (s.kind === 'bind') {
      const src = sourceOf(s.mount!)
      await $fetch(`/api/endpoints/${props.endpointId}/adoption/allow`, { method: 'POST', body: { kind: 'bind', hostPath: form.choice === 'dir' ? parentOf(src) : src, mode: form.mode, environmentKey, description: form.description.trim() } })
      changed.value = true
    }
    status.value[index.value] = 'done'
    next()
  }
  catch (err) {
    const e = apiError(err)
    error.value = Object.values(e.errors)[0] ?? e.message
  }
  finally {
    busy.value = false
  }
}

/** Autres ports à justifier de la stack (ni levés ni passés) : même justification en une fois. */
const otherPorts = computed(() => steps.value.map((s, i) => ({ s, i })).filter(x => x.s.kind === 'port' && !x.s.forbidden && x.i !== index.value && !status.value[x.i]))

/** Points sans levée automatique : ce qu'il faut faire, et où. */
function adviceFor(i: ComposeIssue): { text: string, link?: { to: string, label: string } } {
  const server = `/servers/${props.serverId}`
  if (i.code === 'ports.forbidden') return { text: 'Ce port est interdit sur cet endpoint (ou toujours interdit). Après la reprise, changer le port publié dans le Compose du projet, ou ne plus le publier (exposition web via Traefik).' }
  if (i.code === 'ports.random') return { text: 'Préciser le port publié dans le Compose du projet après la reprise, ou utiliser « expose » si seul le réseau interne en a besoin.' }
  if (i.code === 'networks.refused') return { text: 'Le réseau est interdit ou à examiner sur cet endpoint : décider de sa politique.', link: { to: `${server}?tab=networks&endpoint=${props.endpointId}`, label: 'Réseaux de l\'endpoint' } }
  if (i.code === 'traefik.exposure') return { text: 'Le domaine n\'est pas autorisé par la configuration Traefik de l\'endpoint : l\'ajouter aux domaines autorisés, ou changer le domaine de l\'exposition après la reprise.', link: { to: `${server}?tab=traefik&endpoint=${props.endpointId}`, label: 'Traefik de l\'endpoint' } }
  if (i.code.startsWith('labels.')) return { text: 'Label à retirer du Compose : l\'exposition web se règle dans l\'onglet Exposition web du projet.' }
  if (i.code.startsWith('service.') || i.code.startsWith('compose.')) return { text: 'Option refusée par les règles de sécurité de la plateforme : la retirer du Compose du projet après la reprise.' }
  return { text: 'À corriger dans le Compose du projet après la reprise, puis relancer l\'analyse avant de déployer.' }
}
const done = computed(() => Object.values(status.value).filter(s => s === 'done').length)
</script>

<template>
  <UiModal v-model:open="open" :title="`Lever les points bloquants (${steps.length})`" width="640px">
    <div v-if="step" class="wiz">
      <ol class="dots" aria-label="Points bloquants">
        <li v-for="(s, i) in steps" :key="i">
          <button type="button" :class="[status[i], { on: i === index }]" :aria-current="i === index ? 'step' : undefined" :title="s.issue.message" @click="index = i">{{ i + 1 }}</button>
        </li>
      </ol>

      <p class="what"><CircleAlert :size="15" /> <span><strong v-if="step.issue.service" class="mono">{{ step.issue.service }}</strong> {{ step.issue.message }}</span></p>

      <!-- Port custom -->
      <template v-if="step.kind === 'port'">
        <p v-if="webHint(step.port!)" class="web-hint small"><Globe :size="13" /> Publication web probable ({{ webHint(step.port!) }})</p>
        <fieldset class="choices">
          <label :class="{ off: !traefik }">
            <input v-model="form.choice" type="radio" value="web" :disabled="!traefik">
            <span>
              <strong>Placer derrière le reverse proxy</strong>
              <span class="muted"> : servi par le Traefik de l'endpoint{{ traefik ? ` (réseau ${traefik.networkName})` : '' }} sur un nom de domaine ; le port {{ step.port!.published }} n'est plus publié sur l'hôte</span>
              <span v-if="!traefik" class="muted"> — Traefik non configuré pour cet endpoint : <NuxtLink :to="`/servers/${serverId}?tab=traefik&endpoint=${endpointId}`" target="_blank">le configurer ↗</NuxtLink></span>
            </span>
          </label>
          <template v-if="!step.forbidden">
            <label><input v-model="form.choice" type="radio" value="justify"> <span><strong>Garder le port et le justifier pour ce projet</strong> <span class="muted">: soumis à validation, justification reprise au premier déploiement</span></span></label>
            <label><input v-model="form.choice" type="radio" value="allow"> <span><strong>Garder le port et l'autoriser sur l'endpoint</strong> <span class="muted">: règle durable, valable pour tous les projets</span></span></label>
          </template>
          <p v-else class="muted small">Port interdit sur cet endpoint : il ne peut pas rester publié.</p>
          <label><input v-model="form.choice" type="radio" value="drop"> <span><strong>Ne plus publier ce port</strong> <span class="muted">: retiré du Compose repris (le service reste joignable par les autres conteneurs de la stack)</span></span></label>
        </fieldset>
        <div v-if="form.choice === 'web'" class="row">
          <UiField label="Nom de domaine" for="fix-host" class="grow" :hint="traefik?.allowedDomains.length ? `Domaines autorisés : ${traefik.allowedDomains.join(', ')}` : undefined">
            <input id="fix-host" v-model.trim="form.host" class="input input-sm mono" maxlength="253" autocomplete="off">
          </UiField>
          <UiField label="Préfixe de chemin" for="fix-path" hint="Facultatif, ex. /admin">
            <input id="fix-path" v-model.trim="form.pathPrefix" class="input input-sm mono" maxlength="200" placeholder="/">
          </UiField>
          <p class="muted small full">Le proxy routera {{ form.host || '…' }}{{ form.pathPrefix }} vers le port {{ containerPort(step.port!) }} du service {{ step.port!.service }}.</p>
        </div>
        <template v-if="form.choice === 'justify'">
          <UiField label="Justification" for="fix-just" hint="10 caractères au moins ; visible dans l'audit du déploiement">
            <textarea id="fix-just" v-model="form.justification" class="input" rows="2" maxlength="500" />
          </UiField>
          <label class="check"><input v-model="form.confirmed" type="checkbox"> Je confirme la publication du port {{ step.port!.published }}/{{ step.port!.protocol }} sur {{ step.port!.hostIp && step.port!.hostIp !== '0.0.0.0' ? step.port!.hostIp : 'toutes les interfaces de l\'hôte' }}<template v-if="form.allPorts"> et des ports {{ otherPorts.map(x => `${x.s.port!.published}/${x.s.port!.protocol}`).join(', ') }}</template></label>
          <label v-if="otherPorts.length" class="check"><input v-model="form.allPorts" type="checkbox"> Même justification pour les {{ otherPorts.length }} autre(s) port(s) à justifier de la stack</label>
        </template>
        <template v-else-if="form.choice === 'allow'">
          <div class="row">
            <UiField label="Projets concernés" for="fix-scope">
              <select id="fix-scope" v-model="form.scope" class="input input-sm"><option value="env">Projets en {{ environment.name }}</option><option value="all">Projets de tous les environnements</option></select>
            </UiField>
            <UiField label="Description de la règle" for="fix-desc" class="grow"><input id="fix-desc" v-model="form.description" class="input input-sm" maxlength="200"></UiField>
          </div>
        </template>
      </template>

      <!-- Chemin bind -->
      <template v-else-if="step.kind === 'bind'">
        <fieldset class="choices">
          <label><input v-model="form.choice" type="radio" value="file"> <span>Autoriser ce chemin : <code>{{ sourceOf(step.mount!) }}</code></span></label>
          <label><input v-model="form.choice" type="radio" value="dir"> <span>Autoriser son dossier : <code>{{ parentOf(sourceOf(step.mount!)) }}</code> <span class="muted">(et tout son contenu)</span></span></label>
          <label><input v-model="form.choice" type="radio" value="drop"> <span>Retirer ce montage de la reprise</span></label>
        </fieldset>
        <template v-if="form.choice !== 'drop'">
        <p class="mount-mode small">
          Le Compose monte ce chemin dans <code>{{ step.mount!.target }}</code>
          <strong>{{ step.mount!.readOnly ? 'en lecture seule' : 'en lecture et écriture' }}</strong>.
        </p>
        <div class="row">
          <UiField label="Droits accordés aux conteneurs" for="fix-mode" :hint="step.mount!.readOnly ? 'La lecture seule suffit à ce montage.' : 'Ce montage écrit : il faut l\'écriture (ou passer le montage en :ro dans le Compose).'">
            <select id="fix-mode" v-model="form.mode" class="input input-sm">
              <option value="ro">Lecture seule : lire, sans modifier</option>
              <option value="rw">Lecture et écriture : modifier et créer des fichiers</option>
            </select>
          </UiField>
          <UiField label="Projets concernés" for="fix-scope-b" hint="Environnement des projets autorisés à monter ce chemin">
            <select id="fix-scope-b" v-model="form.scope" class="input input-sm"><option value="env">Projets en {{ environment.name }}</option><option value="all">Projets de tous les environnements</option></select>
          </UiField>
        </div>
        <UiField label="Description de la règle" for="fix-desc-b"><input id="fix-desc-b" v-model="form.description" class="input input-sm" maxlength="300"></UiField>
        <p v-if="form.mode === 'ro' && !step.mount!.readOnly" class="warn small">Avec la lecture seule, ce point restera bloquant : le montage demande l'écriture.</p>
        <p v-else-if="form.mode === 'rw' && step.mount!.readOnly" class="muted small">L'écriture n'est pas nécessaire : le montage est en lecture seule.</p>
        </template>
      </template>

      <!-- Chemin impossible à autoriser -->
      <div v-else-if="step.kind === 'mount'" class="advice">
        <p>Ce chemin ne peut pas être autorisé : {{ step.mount!.reason }}. Le montage <code>{{ step.mount!.source }} → {{ step.mount!.target }}</code> peut être retiré de la reprise ; s'il est nécessaire, le remplacer ensuite dans le Compose du projet par un volume nommé ou un fichier des sources.</p>
      </div>

      <!-- Autres points -->
      <div v-else class="advice">
        <p>{{ adviceFor(step.issue).text }}</p>
        <NuxtLink v-if="adviceFor(step.issue).link" :to="adviceFor(step.issue).link!.to" target="_blank">{{ adviceFor(step.issue).link!.label }} ↗</NuxtLink>
      </div>

      <p v-if="error" class="err" role="alert">{{ error }}</p>
    </div>
    <p v-else class="muted">Aucun point bloquant.</p>

    <template #footer>
      <span class="muted small progress"><CheckCircle2 :size="13" /> {{ done }} levé(s) sur {{ steps.length }}</span>
      <UiButton variant="ghost" :disabled="index === 0" @click="index--">Précédent</UiButton>
      <UiButton v-if="step" variant="ghost" @click="skip"><SkipForward :size="14" /> Passer</UiButton>
      <UiButton v-if="step && step.kind !== 'other'" variant="primary" :loading="busy" :disabled="!canApply" @click="apply">{{ step.kind === 'mount' || form.choice === 'drop' ? 'Retirer' : step.kind === 'port' && form.choice === 'web' ? 'Exposer' : step.kind === 'port' && form.choice === 'justify' ? 'Justifier' : 'Autoriser' }} et continuer</UiButton>
      <UiButton v-else variant="primary" @click="finish">Terminer et réanalyser</UiButton>
    </template>
  </UiModal>
</template>

<style scoped>
.wiz { display: flex; flex-direction: column; gap: var(--space-3); }
.dots { display: flex; flex-wrap: wrap; gap: 4px; list-style: none; margin: 0; padding: 0; }
.dots button { all: unset; cursor: pointer; width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center; font-size: 11.5px; font-weight: 600; border: 1px solid var(--border-strong); color: var(--text-muted); }
.dots button.on { border-color: var(--primary); color: var(--primary); box-shadow: 0 0 0 2px color-mix(in srgb, var(--primary) 25%, transparent); }
.dots button.done { background: var(--success-bg); border-color: var(--success); color: var(--success); }
.dots button.skipped { background: var(--surface-3); border-style: dashed; }
.dots button:focus-visible { outline: 2px solid var(--focus); }
.what { margin: 0; display: flex; gap: 8px; align-items: flex-start; color: var(--danger); font-size: 13.5px; }
.what span { color: var(--text); overflow-wrap: anywhere; }
.what svg { flex: none; margin-top: 2px; }
.choices { border: 0; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; font-size: 13px; }
.choices label { display: flex; gap: 8px; align-items: flex-start; cursor: pointer; }
.choices input { margin-top: 3px; }
.choices code { font-size: 12px; overflow-wrap: anywhere; }
.check { display: flex; gap: 8px; align-items: flex-start; font-size: 13px; }
.row { display: flex; gap: var(--space-2); flex-wrap: wrap; align-items: flex-end; }
.grow { flex: 1; min-width: 200px; }
.advice { font-size: 13px; display: flex; flex-direction: column; gap: 6px; }
.advice p { margin: 0; }
.err { margin: 0; color: var(--danger); font-size: 12.5px; }
.warn { margin: 0; color: var(--warning); }
.mount-mode { margin: 0; }
.web-hint { margin: 0; display: inline-flex; gap: 5px; align-items: center; color: var(--info); }
.choices label.off { opacity: .7; cursor: default; }
.full { flex-basis: 100%; margin: 0; }
.mount-mode code { font-size: 12px; }
.small { font-size: 12.5px; }
.progress { margin-right: auto; display: inline-flex; gap: 4px; align-items: center; }
</style>
