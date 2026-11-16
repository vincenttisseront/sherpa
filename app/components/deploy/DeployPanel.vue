<script setup lang="ts">
/**
 * Nouveau déploiement d'une cible : archive → choix du Compose → analyse
 * (variables, ports à valider) → confirmation → mise en file.
 * L'analyse est refaite par le serveur au moment de la demande.
 */
import type { AnalysisResult, PortApproval } from '#shared/schemas/analysis'
import type { StoredUpload } from '~/types/infra'
import type { ComposeOverrides } from '#shared/schemas/projects'
import type { ProgressStep } from '~/types/progress'
import type { UnpublishRequest } from '#shared/utils/web-ports'
import { describeWindows } from '#shared/utils/deploy-windows'

const props = defineProps<{ targetId: string, projectId: string, projectSlug: string, environmentName: string, isProduction: boolean, initialUpload?: StoredUpload | null, composeOverrides?: ComposeOverrides, initialMode?: 'release' | null, focus?: string | null }>()
const emit = defineEmits<{ 'cancel': [], 'target-changed': [] }>()
const toast = useToast()
const confirm = useConfirm()

interface SourceDto { kind: 'zip' | 'github', repository: string | null, refType: 'branch' | 'tag' | 'commit' | null, ref: string | null, composePath: string, subdirectory: string | null }
interface GithubPreview { commit: { sha: string, message: string, author: string | null, date: string | null, htmlUrl: string | null }, repository: string, refType: string, ref: string, composePath: string, submodules: { path: string }[], analysis: AnalysisResult }
const { data: source, refresh: refreshSource } = await useFetch<SourceDto>(() => `/api/projects/${props.projectId}/source`)
// Changement de source demandé : les onglets (Compose, ZIP, GitHub) reprennent la main.
const changingSource = ref(false)
const isGithub = computed(() => source.value?.kind === 'github' && !changingSource.value)
const ghRefType = ref<'branch' | 'tag' | 'commit'>('branch')
const ghRef = ref('')
watchEffect(() => {
  if (source.value?.kind === 'github') {
    ghRefType.value = source.value.refType ?? 'branch'
    ghRef.value = source.value.ref ?? ''
  }
})
const preview = ref<GithubPreview | null>(null)
const showExposures = ref(false)

const upload = ref<StoredUpload | null>(null)
const composePath = ref('')
const analysis = ref<AnalysisResult | null>(null)
const approvals = ref<PortApproval[]>([])
// Ports justifiés pendant la reprise d'une stack : proposés au premier déploiement (modifiables).
const adoptionApprovals = useState<Record<string, PortApproval[]>>('adoption-approvals', () => ({}))
const analyzing = ref(false)
const deploying = ref(false)
const showVars = ref(false)
// Une même demande rejouée (double clic, réseau) ne crée qu'un déploiement.
const idempotencyKey = crypto.randomUUID()

function onUploaded(u: StoredUpload) {
  upload.value = u
  // « Changer » / « Choisir un autre fichier » rouvre la même release.
  if (u.release) releaseUrl.value = u.release.htmlUrl
  analysis.value = null
  approvals.value = props.initialUpload && u.id === props.initialUpload.id ? [...(adoptionApprovals.value[props.targetId] ?? [])] : []
  composePath.value = u.report.composeFiles[0] ?? ''
  if (!u.report.composeFiles.length) toast.error('Aucun fichier Compose dans cette archive')
}

// Archive sans Compose : installateur (Compose produit par un script), modèle à renommer, ou contenu sans rapport.
const noCompose = computed(() => {
  const u = upload.value
  if (!u || u.report.composeFiles.length) return null
  const entries = u.report.entries ?? []
  const base = (p: string) => p.split('/').pop() ?? p
  const scripts = entries.filter(p => /^(install|setup|prepare|configure)(\.sh)?$/i.test(base(p)))
  const templates = entries.filter(p => /(compose|docker-compose)[^/]*\.(ya?ml)\.(tmpl|template|example|sample|dist|j2)$|\.ya?ml\.(tmpl|template)$/i.test(base(p)))
  const sample = entries.filter(p => !p.slice(u.report.rootFolder ? u.report.rootFolder.length + 1 : 0).includes('/')).slice(0, 10)
  const at = (f: string) => (u.report.rootFolder ? `${u.report.rootFolder}/${f}` : f)
  // Installateur Harbor : prepare + harbor.yml.tmpl à la racine → génération proposée.
  const harbor = entries.includes(at('prepare')) && entries.includes(at('harbor.yml.tmpl'))
  return { scripts: scripts.slice(0, 4), templates: templates.slice(0, 4), sample, total: entries.length, harbor }
})
function onGenerated(u: StoredUpload) {
  onUploaded(u)
}

// Source : Compose collé (enregistré comme une archive), archive (fichier ou release GitHub) ou dépôt GitHub.
const sourceMode = ref<'compose' | 'zip' | 'github'>('compose')
const archiveFrom = ref<'file' | 'release'>('file')
const releaseUrl = ref(source.value?.kind === 'github' && source.value.repository ? `https://github.com/${source.value.repository}/releases` : '')
// Archive de release importée depuis l'onglet « Dépôt GitHub » (dépôt sans Compose).
function onRepoRelease(u: StoredUpload) {
  sourceMode.value = 'zip'
  archiveFrom.value = 'release'
  onUploaded(u)
}
function openRelease(url: string) {
  releaseUrl.value = url
  archiveFrom.value = 'release'
  sourceMode.value = 'zip'
}
const composeText = ref('')
const savingCompose = ref(false)
// « docker run » → Compose par Ollama (proposé dans l'éditeur, jamais déployé directement).
const { available: composeGenAvailable } = useOllamaFeature('compose-gen')
const runOpen = ref(false)
function useGenerated({ compose, variables }: { compose: string, variables: string[] }) {
  composeText.value = compose
  sourceMode.value = 'compose'
  toast.info(`Compose placé dans l'éditeur : le relire${variables.length ? `, renseigner ${variables.join(', ')}` : ''}, puis l'analyser`)
}
// Modèles : catalogue (Compose + variables) et enregistrement du Compose saisi comme modèle de la plateforme.
const pickerOpen = ref(false)
const tplForm = ref<{ name: string, description: string } | null>(null)
const savingTpl = ref(false)
async function applyTemplate({ template, values }: { template: import('#shared/schemas/templates').TemplateDto, values: Record<string, string> }) {
  try {
    // Variables de la cible : celles du modèle s'ajoutent ; une variable déjà définie garde sa valeur.
    const existing = await $fetch<{ name: string, value: string | null, secret: boolean, inject: string[] }[]>(`/api/targets/${props.targetId}/variables`)
    const have = new Set(existing.map(v => v.name))
    const added = template.variables.filter(v => !have.has(v.name))
    if (added.length) {
      await $fetch<unknown>(`/api/targets/${props.targetId}/variables`, {
        method: 'PUT',
        body: [
          ...existing.map(v => ({ name: v.name, value: v.secret ? null : v.value, secret: v.secret, inject: v.inject })),
          ...added.map(v => ({ name: v.name, value: values[v.name] ?? '', secret: !!v.secret })),
        ],
      })
    }
    const kept = template.variables.filter(v => have.has(v.name)).map(v => v.name)
    composeText.value = template.compose
    sourceMode.value = 'compose'
    toast.success(`Modèle « ${template.name} » appliqué : ${added.length} variable${added.length > 1 ? 's' : ''} enregistrée${added.length > 1 ? 's' : ''}${kept.length ? `, ${kept.join(', ')} déjà définie${kept.length > 1 ? 's' : ''} (conservée${kept.length > 1 ? 's' : ''})` : ''}`)
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
}
async function saveTemplate() {
  if (!tplForm.value) return
  savingTpl.value = true
  try {
    await $fetch<unknown>('/api/templates', { method: 'POST', body: { name: tplForm.value.name, description: tplForm.value.description, compose: composeText.value } })
    toast.success(`Modèle « ${tplForm.value.name} » enregistré`)
    tplForm.value = null
  }
  catch (err) {
    const e = apiError(err)
    toast.error(Object.values(e.errors)[0] ?? e.message)
  }
  finally {
    savingTpl.value = false
  }
}
// Projet déjà déployé : on repart du Compose de la release active (ou de la dernière tentée), modifiable.
interface CurrentCompose { release: { number: number, active: boolean, sourceKind: 'zip' | 'github', at: string } | null, composePath: string | null, composeText: string | null, otherFiles: number }
const current = ref<CurrentCompose | null>(null)
function fromCurrent() {
  if (!current.value?.composeText) return
  composeText.value = current.value.composeText
  sourceMode.value = 'compose'
}
async function useCompose() {
  savingCompose.value = true
  try {
    onUploaded(await $fetch<StoredUpload>('/api/uploads/compose', { method: 'POST', body: { content: composeText.value, name: `${props.projectSlug}-compose` } }))
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    savingCompose.value = false
  }
}

// Opération en cours dans ce panneau (enregistrement, inspection, analyse, import) : étapes publiées par le serveur.
const { items: activities, update: updateActivity } = useActivity()
const INLINE = ['Enregistrement du Compose saisi', 'Inspection du dépôt GitHub', 'Analyse du Compose', 'Analyse depuis GitHub', 'Import des fichiers d\'environnement', 'Préparation du déploiement', 'Import depuis une release GitHub', 'Génération du Compose de Harbor (prepare)']
const inlineActivity = computed(() => [...activities.value].reverse().find(a => a.status === 'running' && INLINE.includes(a.label)) ?? null)
watch(() => inlineActivity.value?.id, (id) => {
  if (id && !inlineActivity.value?.inline) updateActivity(id, { inline: true })
})
const inlineSteps = computed<ProgressStep[]>(() => {
  const a = inlineActivity.value
  if (!a) return []
  const steps: ProgressStep[] = a.done.map(label => ({ label, state: 'done' }))
  const percent = a.current !== null && a.total ? Math.round(((a.current - 1) / a.total) * 100) : null
  steps.push({ label: a.step ?? 'Démarrage…', state: 'active', percent, detail: a.total ? `étape ${a.current ?? 1} sur ${a.total}` : null })
  const left = a.total && a.current ? a.total - a.current : 0
  if (left) steps.push({ label: `${left} étape${left > 1 ? 's' : ''} restante${left > 1 ? 's' : ''}`, state: 'pending' })
  return steps
})

// Variables des env_file du Compose : import proposé quand l'analyse les réclame.
const envImportIssues = computed(() => analysis.value?.issues.filter(i => i.code === 'env_file.import') ?? [])
const envRegen = ref(true)
const envOverwrite = ref(false)
const importingEnv = ref(false)
async function importEnv() {
  importingEnv.value = true
  try {
    const body = isGithub.value
      ? { source: 'github', refType: preview.value ? 'commit' : ghRefType.value, ref: preview.value?.commit.sha ?? ghRef.value }
      : { source: 'upload', uploadId: upload.value!.id, composePath: composePath.value }
    const r = await $fetch<{ imported: { name: string, secret: boolean, regenerated: boolean }[], kept: string[] }>(`/api/targets/${props.targetId}/env-import`, { method: 'POST', body: { ...body, overwrite: envOverwrite.value, regenerateSecrets: envRegen.value } })
    const regen = r.imported.filter(i => i.regenerated).length
    toast.success(`${r.imported.length} variable(s) importée(s), dont ${r.imported.filter(i => i.secret).length} secrète(s)${regen ? ` (${regen} régénérée(s))` : ''}${r.kept.length ? ` ; ${r.kept.length} déjà définie(s) conservée(s)` : ''}`)
    await analyze()
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    importingEnv.value = false
  }
}

// Service attendu « sain » par d'autres avec un délai court : délai de démarrage allongé pour cette cible.
const FIRST_START_SEC = 300
const graceIssues = computed(() => analysis.value?.issues.filter(i => i.code === 'healthcheck.short_grace' && i.service) ?? [])
const extendingGrace = ref(false)
async function extendGrace() {
  extendingGrace.value = true
  try {
    const healthchecks = { ...props.composeOverrides?.healthchecks }
    for (const i of graceIssues.value) healthchecks[i.service!] = { ...healthchecks[i.service!], startPeriodSec: FIRST_START_SEC }
    await $fetch(`/api/targets/${props.targetId}`, { method: 'PATCH', body: { composeOverrides: { ...props.composeOverrides, healthchecks } } })
    toast.success(`Délai de démarrage porté à ${FIRST_START_SEC / 60} min : ${graceIssues.value.map(i => i.service).join(', ')}`)
    emit('target-changed')
    await analyze()
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    extendingGrace.value = false
  }
}

// Dépôt GitHub configuré depuis son URL : source du projet enregistrée, puis analyse du commit.
async function onGithubConfigured(r: { refType: 'branch' | 'tag' | 'commit', ref: string }) {
  await refreshSource()
  changingSource.value = false
  ghRefType.value = r.refType
  ghRef.value = r.ref
  upload.value = null
  analysis.value = null
  await analyze()
}
function changeSource() {
  changingSource.value = true
  sourceMode.value = 'github'
  preview.value = null
  analysis.value = null
}

// Archive préparée par la plateforme (Compose converti d'une stack reprise).
// Lien direct : archive déjà importée, ou import depuis une release.
onMounted(() => {
  if ((props.initialUpload || props.initialMode === 'release') && isGithub.value) changingSource.value = true
  if (props.initialUpload) {
    sourceMode.value = 'zip'
    onUploaded(props.initialUpload)
  }
  else if (props.initialMode === 'release') {
    sourceMode.value = 'zip'
    archiveFrom.value = 'release'
  }
  void $fetch<CurrentCompose>(`/api/targets/${props.targetId}/current-compose`).then((c) => {
    current.value = c
    if (props.initialUpload || props.initialMode || upload.value || composeText.value || !c.composeText) return
    // Archive à plusieurs fichiers : le Compose seul ne suffit pas, la nouvelle archive est attendue.
    if (c.otherFiles > 0) sourceMode.value = 'zip'
    else fromCurrent()
  }).catch(() => {})
})

async function analyze() {
  if (isGithub.value) {
    if (!ghRef.value) return
    analyzing.value = true
    try {
      preview.value = await $fetch<GithubPreview>(`/api/targets/${props.targetId}/analyze-github`, { method: 'POST', body: { refType: ghRefType.value, ref: ghRef.value, portApprovals: approvals.value } })
      analysis.value = preview.value.analysis
      if (analysis.value.issues.some(i => i.code === 'variable.missing')) showVars.value = true
    }
    catch (err) {
      toast.error(apiError(err).message)
    }
    finally {
      analyzing.value = false
    }
    return
  }
  if (!upload.value || !composePath.value) return
  analyzing.value = true
  try {
    analysis.value = await $fetch<AnalysisResult>(`/api/targets/${props.targetId}/analyze`, { method: 'POST', body: { uploadId: upload.value.id, composePath: composePath.value, portApprovals: approvals.value } })
    if (analysis.value.issues.some(i => i.code === 'variable.missing')) showVars.value = true
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    analyzing.value = false
  }
}
watch(composePath, () => void analyze())

// Service suspendu repris dans ce déploiement (sans redéploiement séparé).
async function suspendService(e: { service: string, suspended: boolean }) {
  try {
    await $fetch(`/api/targets/${props.targetId}/suspended-services`, { method: 'PUT', body: { ...e, apply: false } })
    toast.success(`${e.service} : ${e.suspended ? 'suspendu' : 'repris'} dans ce déploiement`)
    await analyze()
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
}

// Service laissé hors de la console (ex. Traefik d'une stack reprise), ou réintégré.
async function excludeService(e: { service: string, excluded: boolean }) {
  if (e.excluded && !(await confirm({
    title: `Ne pas gérer ${e.service}`,
    message: `${e.service} sera retiré de la stack déployée par la console. Au prochain déploiement, son conteneur actuel est détaché de la stack (recréé à l'identique, quelques secondes d'interruption) et continue de tourner : la console ne l'arrêtera, ne le mettra à jour ni ne le supprimera plus. Les autres services ne l'attendent plus au démarrage.`,
    confirmLabel: 'Ne pas gérer',
  }))) return
  try {
    await $fetch(`/api/targets/${props.targetId}/excluded-services`, { method: 'PUT', body: e })
    toast.success(e.excluded ? `${e.service} : non géré par la console` : `${e.service} : réintégré`)
    await analyze()
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
}

// Image introuvable : autre source choisie (surcharge d'image de la cible), puis nouvelle analyse.
const busySource = ref<string | null>(null)
async function useImage(e: { service: string, from: string, image: string }) {
  busySource.value = `${e.service}:${e.image}`
  try {
    await $fetch(`/api/targets/${props.targetId}/image-source`, { method: 'PUT', body: e })
    toast.success(`${e.service} : image ${e.image} utilisée`)
    await analyze()
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    busySource.value = null
  }
}

// Reverse proxy de l'endpoint et expositions de la cible : ports web à placer derrière le proxy.
interface ExposureInfo { exposures: { service: string, host: string, port: number, pathPrefix: string | null, middlewares: string[] }[], traefik: { allowedDomains: string[], provider?: string } | null }
const { data: exposureInfo, refresh: refreshExposureInfo } = useFetch<ExposureInfo>(() => `/api/targets/${props.targetId}/exposures`, { server: false, lazy: true })
const exposuresKey = ref(0)
const busyPort = ref<string | null>(null)
async function setUnpublished(e: UnpublishRequest) {
  busyPort.value = `${e.service}:${e.published}/${e.protocol}`
  try {
    if (e.exposure) {
      await refreshExposureInfo()
      const current = exposureInfo.value?.exposures ?? []
      await $fetch(`/api/targets/${props.targetId}/exposures`, { method: 'PUT', body: [...current, { service: e.service, host: e.exposure.host, port: e.exposure.port, pathPrefix: null, middlewares: [] }] })
      exposuresKey.value++
      await refreshExposureInfo()
    }
    await $fetch(`/api/targets/${props.targetId}/unpublished-ports`, { method: 'PUT', body: { service: e.service, published: e.published, protocol: e.protocol, unpublished: e.unpublished } })
    toast.success(e.unpublished
      ? `${e.service} : port ${e.published} retiré${e.exposure ? `, exposé sur https://${e.exposure.host}` : ''} (reverse proxy uniquement)`
      : `${e.service} : port ${e.published} publié de nouveau`)
    emit('target-changed')
    await analyze()
  }
  catch (err) {
    const x = apiError(err)
    toast.error(Object.values(x.errors ?? {})[0] ?? x.message)
  }
  finally {
    busyPort.value = null
  }
}

// Revalide après modification des justifications de ports.
let timer: ReturnType<typeof setTimeout> | undefined
watch(approvals, () => {
  clearTimeout(timer)
  timer = setTimeout(() => void analyze(), 600)
}, { deep: true })

// Porte de déploiement de l'environnement : fenêtres, validation par une autre personne, planification.
const { data: gate } = useFetch<import('#shared/schemas/deploy-gate').GateInfoDto>(() => `/api/targets/${props.targetId}/gate`, { server: false, lazy: true })
const when = ref<'now' | 'later'>('now')
const whenAt = ref('')
const urgent = ref(false)
const closedNow = computed(() => !!gate.value && !gate.value.open)
// Valeur initiale de la planification : prochaine ouverture (ou dans une heure), à l'heure locale du navigateur.
const toLocalInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
watch(when, (w) => {
  if (w === 'later' && !whenAt.value) whenAt.value = toLocalInput(gate.value?.nextOpening && closedNow.value ? new Date(gate.value.nextOpening) : new Date(Date.now() + 3600_000))
})
const scheduleBody = computed(() => (when.value === 'later' && whenAt.value ? { at: new Date(whenAt.value).toISOString() } : closedNow.value && urgent.value ? { urgent: true } : undefined))
const blockedByWindow = computed(() => closedNow.value && when.value === 'now' && !urgent.value)

async function deploy() {
  if (!analysis.value?.ok || (!isGithub.value && !upload.value) || (isGithub.value && !preview.value)) return
  const ok = await confirm({
    title: `Déployer sur ${props.environmentName}`,
    message: `Release construite et déployée en stack « ${analysis.value.stackName} » : ${analysis.value.services.length} service(s), ${analysis.value.builds.length} build(s), ${analysis.value.ports.filter(p => p.published).length} port(s) publié(s).${props.isProduction ? '\n\nEnvironnement de PRODUCTION.' : ''}`,
    confirmLabel: when.value === 'later' ? 'Planifier' : gate.value?.requireApproval || (closedNow.value && urgent.value) ? 'Demander la validation' : 'Déployer',
    danger: props.isProduction,
    requireText: props.isProduction ? props.projectSlug : undefined,
  })
  if (!ok) return
  deploying.value = true
  try {
    const r = await $fetch<{ deploymentId: string }>(`/api/targets/${props.targetId}/deployments`, {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      // GitHub : on déploie le commit présenté à l'analyse, même si la branche a avancé depuis.
      body: isGithub.value
        ? { source: 'github', commitSha: preview.value!.commit.sha, portApprovals: approvals.value, schedule: scheduleBody.value }
        : { uploadId: upload.value!.id, composePath: composePath.value, portApprovals: approvals.value, schedule: scheduleBody.value },
    })
    await navigateTo(`/deployments/${r.deploymentId}`)
  }
  catch (err) {
    const e = apiError(err) as ReturnType<typeof apiError> & { data?: unknown }
    const data = (err as { data?: { data?: { analysis?: AnalysisResult } } }).data?.data
    if (data?.analysis) analysis.value = data.analysis
    toast.error(e.message)
  }
  finally {
    deploying.value = false
  }
}
</script>

<template>
  <div class="panel">
    <section v-if="isGithub && source">
      <h3>1. Source GitHub</h3>
      <div class="gh">
        <code>{{ source.repository }}</code>
        <select v-model="ghRefType" class="input reftype" aria-label="Type de référence"><option value="branch">Branche</option><option value="tag">Tag</option><option value="commit">Commit</option></select>
        <input v-model.trim="ghRef" class="input mono ref" aria-label="Référence">
        <UiButton size="sm" :loading="analyzing" @click="analyze">Résoudre et analyser</UiButton>
        <UiButton size="sm" variant="ghost" @click="changeSource">Changer de source</UiButton>
      </div>
      <div v-if="preview" class="commit card">
        Commit <a v-if="preview.commit.htmlUrl" :href="preview.commit.htmlUrl" target="_blank" rel="noopener"><code>{{ preview.commit.sha.slice(0, 12) }}</code></a><code v-else>{{ preview.commit.sha.slice(0, 12) }}</code>
        — {{ preview.commit.message }} <span class="muted">({{ preview.commit.author }}, {{ fmtDateTime(preview.commit.date) }})</span>
        <div class="muted small">Ce commit exact sera déployé. Compose : <code>{{ preview.composePath }}</code><template v-if="preview.submodules.length"> · sous-modules : {{ preview.submodules.map(s => s.path).join(', ') }}</template></div>
      </div>
    </section>

    <section v-else>
      <div class="head">
        <h3>1. Source</h3>
        <div v-if="!upload" class="modes" role="tablist" aria-label="Source du déploiement">
          <button type="button" role="tab" :aria-selected="sourceMode === 'compose'" :class="{ on: sourceMode === 'compose' }" @click="sourceMode = 'compose'">Compose saisi</button>
          <button type="button" role="tab" :aria-selected="sourceMode === 'zip'" :class="{ on: sourceMode === 'zip' }" @click="sourceMode = 'zip'">Archive</button>
          <button type="button" role="tab" :aria-selected="sourceMode === 'github'" :class="{ on: sourceMode === 'github' }" @click="sourceMode = 'github'">Dépôt GitHub</button>
        </div>
      </div>
      <GithubUrlSource v-if="!upload && sourceMode === 'github'" :project-id="projectId" :initial-url="source?.kind === 'github' && source.repository ? `https://github.com/${source.repository}` : ''" @configured="onGithubConfigured" @use-compose="sourceMode = 'compose'" @use-release="openRelease" @uploaded="onRepoRelease" />
      <template v-else-if="!upload && sourceMode === 'compose'">
        <p v-if="current?.release && composeText === current.composeText" class="muted small">Compose de la release #{{ current.release.number }}{{ current.release.active ? ' (active)' : ' (dernière tentée)' }} : le modifier puis l'analyser.</p>
        <p v-else-if="current?.composeText" class="small"><UiButton size="sm" variant="ghost" @click="fromCurrent">Repartir du Compose de la release #{{ current.release!.number }}</UiButton></p>
        <p v-if="current?.otherFiles && composeText === current.composeText" class="warn-note small">La release #{{ current.release!.number }} venait d'une archive de {{ current.otherFiles + 1 }} fichiers : un Compose saisi ne reprend pas les autres fichiers (montés ou construits). Déposer plutôt la nouvelle archive (onglet Archive).</p>
        <p class="small"><UiButton size="sm" data-testid="template-open" @click="pickerOpen = true">Partir d'un modèle…</UiButton> <span class="muted">PostgreSQL, Redis, Grafana, WordPress… ou les modèles enregistrés par votre équipe.</span> <UiButton v-if="composeGenAvailable" size="sm" variant="ghost" data-testid="compose-gen-open" @click="runOpen = true">Depuis un « docker run »…</UiButton></p>
        <textarea v-model="composeText" class="input mono compose-text" rows="18" spellcheck="false" aria-label="Contenu du fichier Compose" placeholder="services:&#10;  web:&#10;    image: …" />
        <p class="muted small">Les mots de passe se déclarent en variables (<code>${NOM}</code>), à renseigner en variables secrètes à l'étape suivante.</p>
        <div class="tpl-actions">
          <UiButton variant="primary" size="sm" :loading="savingCompose" :disabled="composeText.trim().length < 10" @click="useCompose">Analyser ce Compose</UiButton>
          <UiButton v-if="!tplForm" size="sm" variant="ghost" :disabled="composeText.trim().length < 20" @click="tplForm = { name: '', description: '' }">Enregistrer comme modèle…</UiButton>
        </div>
        <form v-if="tplForm" class="tpl-form" @submit.prevent="saveTemplate">
          <input v-model.trim="tplForm.name" class="input" maxlength="80" placeholder="Nom du modèle" aria-label="Nom du modèle" required>
          <input v-model.trim="tplForm.description" class="input" maxlength="300" placeholder="Description (facultative)" aria-label="Description du modèle">
          <p class="muted small">Visible par toutes les personnes qui importent des sources. Les valeurs des variables ne sont pas enregistrées, seulement leurs noms : ne jamais écrire de mot de passe en clair dans le Compose.</p>
          <div class="tpl-actions"><UiButton type="submit" size="sm" variant="primary" :loading="savingTpl" :disabled="tplForm.name.length < 2">Enregistrer</UiButton><UiButton size="sm" variant="ghost" @click="tplForm = null">Annuler</UiButton></div>
        </form>
        <TemplatePicker v-model:open="pickerOpen" @apply="applyTemplate" />
        <ComposeFromRun v-if="composeGenAvailable" v-model:open="runOpen" :target-id="targetId" @use="useGenerated" />
      </template>
      <template v-else-if="!upload">
        <p v-if="current?.otherFiles" class="muted small">Release #{{ current.release!.number }} : archive de {{ current.otherFiles + 1 }} fichiers. Déposer la nouvelle version de l'archive, ou <a href="#" @click.prevent="fromCurrent">partir de son seul Compose</a>.</p>
        <div class="archive-modes small" role="radiogroup" aria-label="Origine de l'archive">
          <label><input v-model="archiveFrom" type="radio" value="file"> Déposer un fichier</label>
          <label><input v-model="archiveFrom" type="radio" value="release"> Depuis une release GitHub</label>
        </div>
        <SourceUpload v-if="archiveFrom === 'file'" @uploaded="onUploaded" />
        <GithubReleaseImport v-else :key="releaseUrl" :project-id="projectId" :initial-url="releaseUrl" @uploaded="onUploaded" />
      </template>
      <div v-else class="uploaded card">
        <div>
          <strong>{{ upload.originalName }}</strong>
          <span class="muted"> · {{ upload.report.files }} fichiers · sha256 {{ (upload.report.source?.sha256 ?? upload.sha256).slice(0, 12) }}…<template v-if="upload.report.source"> · {{ upload.report.source.format }} converti en ZIP</template></span>
        </div>
        <UiButton size="sm" variant="ghost" @click="upload = null; analysis = null">Changer</UiButton>
      </div>
      <div v-if="noCompose" class="no-compose card">
        <strong>Pas de fichier Compose dans cette archive</strong>
        <p v-if="noCompose.harbor" class="small">Installateur Harbor : son Compose est produit par l'étape <code>prepare</code>, que la plateforme peut exécuter pour vous.</p>
        <p v-else-if="noCompose.scripts.length" class="small">
          C'est une archive d'installation : son Compose est généré au moment de l'installation par <template v-for="(f, i) in noCompose.scripts" :key="f"><code>{{ f }}</code>{{ i < noCompose.scripts.length - 1 ? ', ' : '' }}</template><template v-if="noCompose.templates.length"> à partir de <template v-for="(f, i) in noCompose.templates" :key="f"><code>{{ f }}</code>{{ i < noCompose.templates.length - 1 ? ', ' : '' }}</template></template>.
          La plateforme n'exécute pas ces scripts : choisir un autre fichier de la release, ou générer le Compose puis le coller dans « Compose saisi ».
        </p>
        <p v-else-if="noCompose.templates.length" class="small">Modèle de Compose présent (<code>{{ noCompose.templates[0] }}</code>) : à adapter puis coller dans « Compose saisi », ou à publier sous le nom compose.yml.</p>
        <p v-else class="small">Aucun compose.yml ni docker-compose.yml parmi les {{ noCompose.total }} fichiers.</p>
        <p v-if="noCompose.sample.length" class="muted small">Contenu : <code>{{ noCompose.sample.join(', ') }}</code>{{ noCompose.total > noCompose.sample.length ? '…' : '' }}</p>
        <HarborGenerator v-if="noCompose.harbor && upload" :target-id="targetId" :upload-id="upload.id" :project-slug="projectSlug" :focus-password="focus === 'adminPassword'" @generated="onGenerated" />
        <div class="row-btns">
          <UiButton size="sm" @click="upload = null; analysis = null">Choisir un autre fichier</UiButton>
          <UiButton size="sm" variant="ghost" @click="upload = null; analysis = null; sourceMode = 'compose'">Coller un Compose</UiButton>
        </div>
      </div>
    </section>

    <UiProgressSteps v-if="inlineActivity" :title="inlineActivity.label" :steps="inlineSteps" />

    <section v-if="upload && upload.report.composeFiles.length">
      <h3>2. Fichier Compose</h3>
      <select v-model="composePath" class="input compose-select" aria-label="Fichier Compose">
        <option v-for="c in upload.report.composeFiles" :key="c" :value="c">{{ c }}</option>
      </select>
    </section>

    <section v-if="upload || preview">
      <div class="head">
        <h3>{{ isGithub ? 2 : 3 }}. Variables</h3>
        <UiButton size="sm" variant="ghost" :aria-expanded="showVars" @click="showVars = !showVars">{{ showVars ? 'Masquer' : 'Afficher' }}</UiButton>
      </div>
      <VariablesEditor v-if="showVars" :target-id="targetId" @saved="analyze" />
    </section>

    <section v-if="upload || preview">
      <div class="head">
        <h3>{{ isGithub ? 3 : 4 }}. Exposition web (Traefik)</h3>
        <UiButton size="sm" variant="ghost" :aria-expanded="showExposures" @click="showExposures = !showExposures">{{ showExposures ? 'Masquer' : 'Afficher' }}</UiButton>
      </div>
      <ExposuresEditor v-if="showExposures" :key="exposuresKey" :target-id="targetId" :services="analysis?.services" @saved="analyze(); refreshExposureInfo()" />
    </section>

    <section v-if="upload || preview">
      <div class="head">
        <h3>{{ isGithub ? 4 : 5 }}. Analyse</h3>
        <UiButton size="sm" :loading="analyzing" @click="analyze">Relancer l'analyse</UiButton>
      </div>
      <p v-if="analyzing && !analysis && !inlineActivity" class="muted">Analyse en cours…</p>
      <div v-if="envImportIssues.length" class="env-import card">
        <strong>Variables des fichiers d'environnement</strong>
        <ul class="small"><li v-for="(i, k) in envImportIssues" :key="k">{{ i.message }}</li></ul>
        <label class="small"><input v-model="envRegen" type="checkbox"> Générer de nouvelles valeurs pour les mots de passe, clés et jetons (recommandé : les valeurs d'un dépôt sont connues de tous)</label>
        <label class="small"><input v-model="envOverwrite" type="checkbox"> Remplacer les variables déjà définies</label>
        <div><UiButton size="sm" variant="primary" :loading="importingEnv" @click="importEnv">Importer les variables</UiButton></div>
        <p class="muted small">Les valeurs sont chiffrées dans la plateforme et ne sont jamais réaffichées ; les noms évoquant un secret sont importés en variables secrètes.</p>
      </div>
      <div v-if="graceIssues.length" class="env-import card">
        <strong>Premier démarrage</strong>
        <ul class="small"><li v-for="(i, k) in graceIssues" :key="k"><strong>{{ i.service }}</strong> : {{ i.message }}</li></ul>
        <div><UiButton size="sm" variant="primary" :loading="extendingGrace" @click="extendGrace">Allonger le délai de démarrage à {{ FIRST_START_SEC / 60 }} min</UiButton></div>
        <p class="muted small">Le healthcheck tourne toujours à son intervalle : le service est déclaré sain dès qu'il répond, seul le délai avant échec s'allonge. Réglage de la cible, modifiable dans Réglages › Healthchecks.</p>
      </div>
      <AnalysisReport v-if="analysis" v-model:approvals="approvals" :analysis="analysis" :target-id="targetId" :busy-source="busySource" :proxy="exposureInfo ? exposureInfo.traefik : undefined" :busy-port="busyPort" @use-image="useImage" @exclude-service="excludeService" @suspend-service="suspendService" @unpublish-port="setUnpublished" />
    </section>

    <section v-if="gate && (gate.requireApproval || gate.windows.length)" class="gate card" data-testid="deploy-gate">
      <strong>Quand déployer</strong>
      <p v-if="gate.requireApproval" class="small">Cet environnement exige la <strong>validation d'une autre personne</strong> avant l'exécution.</p>
      <p v-if="gate.windows.length" class="small" :class="{ warn: closedNow }">Fenêtres de déploiement : {{ describeWindows(gate.windows) }} ({{ gate.timezone }}). {{ gate.open ? 'Ouverte actuellement.' : `Fermée actuellement${gate.nextOpening ? `, prochaine ouverture ${fmtDateTime(gate.nextOpening)}` : ''}.` }}</p>
      <div class="when" role="radiogroup" aria-label="Moment du déploiement">
        <label><input v-model="when" type="radio" value="now"> Maintenant</label>
        <label><input v-model="when" type="radio" value="later" data-testid="when-later"> Planifier</label>
        <input v-if="when === 'later'" v-model="whenAt" type="datetime-local" class="input" aria-label="Date et heure de l'exécution">
      </div>
      <label v-if="closedNow && when === 'now'" class="small"><input v-model="urgent" type="checkbox" data-testid="urgent"> Urgence : déployer hors fenêtre, sous réserve de la validation d'une autre personne</label>
    </section>

    <footer class="foot">
      <UiButton @click="emit('cancel')">Annuler</UiButton>
      <UiButton variant="primary" :disabled="!analysis?.ok || analyzing || blockedByWindow || (when === 'later' && !whenAt)" :loading="deploying" @click="deploy">{{ when === 'later' ? 'Planifier' : gate?.requireApproval || (closedNow && urgent) ? 'Demander la validation' : 'Déployer' }}</UiButton>
    </footer>
  </div>
</template>

<style scoped>
.panel { display: flex; flex-direction: column; gap: var(--space-5); }
h3 { margin: 0 0 var(--space-2); font-size: 15px; }
.head { display: flex; align-items: center; justify-content: space-between; }
.uploaded { display: flex; justify-content: space-between; align-items: center; padding: var(--space-3) var(--space-4); box-shadow: none; }
.compose-select { max-width: 420px; }
.no-compose { display: flex; flex-direction: column; gap: 6px; margin-top: var(--space-3); padding: var(--space-3) var(--space-4); box-shadow: none; border-color: color-mix(in srgb, var(--warning) 45%, var(--border)); }
.no-compose p { margin: 0; }
.row-btns { display: flex; gap: var(--space-2); }
.archive-modes { display: flex; gap: var(--space-4); margin-bottom: var(--space-3); }
.archive-modes label { display: flex; gap: 6px; align-items: center; }
.env-import { display: flex; flex-direction: column; gap: 6px; padding: var(--space-3) var(--space-4); margin-bottom: var(--space-3); border-color: color-mix(in srgb, var(--primary) 35%, var(--border)); box-shadow: none; }
.env-import ul { margin: 0; padding-left: var(--space-4); }
.env-import label { display: flex; gap: 6px; align-items: flex-start; }
.env-import p { margin: 0; }
.compose-text { width: 100%; font-size: 12.5px; line-height: 1.5; resize: vertical; }
.gate { display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-3) var(--space-4); }
.gate .small { margin: 0; font-size: 12.5px; }
.gate .warn { color: var(--warning); }
.when { display: flex; gap: var(--space-3); align-items: center; flex-wrap: wrap; font-size: 13px; }
.tpl-actions { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.tpl-form { display: flex; flex-direction: column; gap: var(--space-2); border: 1px solid var(--border); border-radius: var(--radius); padding: var(--space-3); max-width: 520px; }
.modes { display: inline-flex; gap: 2px; padding: 2px; border-radius: var(--radius); background: var(--surface-2); border: 1px solid var(--border); }
.modes button { all: unset; cursor: pointer; padding: 4px 12px; border-radius: calc(var(--radius) - 2px); font-size: 13px; color: var(--text-muted); }
.modes button.on { background: var(--surface); color: var(--text); box-shadow: var(--shadow-sm, 0 1px 2px rgb(0 0 0 / 8%)); }
.modes button:focus-visible { outline: 2px solid var(--focus); }
.gh { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.reftype { width: auto; }
.ref { max-width: 260px; }
.commit { margin-top: var(--space-2); padding: var(--space-3) var(--space-4); box-shadow: none; }
.small { font-size: 12.5px; }
.foot { display: flex; justify-content: flex-end; gap: var(--space-2); border-top: 1px solid var(--border); padding-top: var(--space-4); }
.warn-note { color: var(--warning); margin: 0; }
</style>
