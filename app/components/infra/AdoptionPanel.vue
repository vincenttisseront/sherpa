<script setup lang="ts">
/** Reprise de l'existant : stacks présentes sur l'endpoint et assistant de reprise en projet géré. */
import type { AdoptableStack, AdoptionInput, AdoptionPreview } from '#shared/schemas/adoption'
import type { PortApproval } from '#shared/schemas/analysis'
import type { StoredUpload } from '~/types/infra'
import { CircleAlert, FileCode, Info, KeyRound, Lock, TriangleAlert } from 'lucide-vue-next'

/** `initialStack` : stack à reprendre dès l'ouverture (lien « Reprendre » des conteneurs, des proxies ou des projets). */
const props = defineProps<{ endpointId: string, endpointName: string, environments: { key: string, name: string, isProduction: boolean }[], canAdopt: boolean, initialStack?: string, serverId: string }>()
const toast = useToast()

const { data: stacks, error, status, refresh } = await useFetch<AdoptableStack[]>(() => `/api/endpoints/${props.endpointId}/adoptable`, { server: false })
const filter = useListFilter(
  () => stacks.value ?? [],
  s => `${s.name} ${s.services.join(' ')} ${s.images.join(' ')} ${s.hosts.join(' ')}`,
  s => (s.managedBy ? 'managed' : 'free'),
)
filter.status.value = 'free'
const STATUSES = { free: 'Non gérées', managed: 'Gérées par la plateforme' }

// --- Assistant ---
const open = ref(false)
const current = ref<AdoptableStack | null>(null)
const form = reactive({ projectName: '', slug: '', environmentKey: '', description: '' })
const errors = ref<Record<string, string>>({})
const preview = ref<AdoptionPreview | null>(null)
const analyzing = ref(false)
const adopting = ref(false)
const accept = ref(false)
const showCompose = ref(false)
// Ports justifiés dans l'assistant de levée des points bloquants (repris au premier déploiement).
const approvals = ref<PortApproval[]>([])
// Ports publiés placés derrière le Traefik de l'endpoint (port retiré du Compose, exposition ajoutée).
const webExposures = ref<AdoptionInput['webExposures']>([])
const droppedPorts = ref<AdoptionInput['droppedPorts']>([])
const droppedMounts = ref<AdoptionInput['droppedMounts']>([])
const fixOpen = ref(false)
const fixStart = ref(0)
function openFix(at = 0) {
  fixStart.value = at
  fixOpen.value = true
}

// L'identifiant suit le nom tant qu'il n'a pas été saisi à la main ; vidé, il le suit de nouveau au prochain changement du nom.
const slugTouched = ref(false)
function onSlugInput(e: Event) {
  const el = e.target as HTMLInputElement
  slugTouched.value = el.value !== ''
  form.slug = slugTyping(el.value)
  el.value = form.slug
}

function start(s: AdoptableStack) {
  current.value = s
  Object.assign(form, { projectName: s.name, slug: slugFromName(s.name), environmentKey: props.environments.find(e => !e.isProduction)?.key ?? props.environments[0]?.key ?? '', description: '' })
  slugTouched.value = false
  errors.value = {}
  preview.value = null
  accept.value = false
  showCompose.value = false
  approvals.value = []
  webExposures.value = []
  droppedPorts.value = []
  droppedMounts.value = []
  open.value = true
}
// Ouverture directe de l'assistant sur la stack demandée (une seule fois, si elle n'est pas déjà gérée).
let initialHandled = false
watch(stacks, (list) => {
  if (initialHandled || !list || !props.initialStack) return
  initialHandled = true
  const s = list.find(x => x.name === props.initialStack)
  if (!s) {
    toast.error(`Stack « ${props.initialStack} » introuvable sur ${props.endpointName}`)
    return
  }
  filter.q.value = s.name
  if (s.managedBy) filter.status.value = ''
  else if (props.canAdopt && props.environments.length) start(s)
}, { immediate: true })

watch(() => [form.projectName, form.slug, form.environmentKey], () => {
  preview.value = null
})

const body = () => ({ stack: current.value!.name, projectName: form.projectName, slug: form.slug, environmentKey: form.environmentKey, description: form.description.trim() || null, portApprovals: approvals.value, webExposures: webExposures.value, droppedPorts: droppedPorts.value, droppedMounts: droppedMounts.value })

async function analyze() {
  errors.value = {}
  analyzing.value = true
  try {
    preview.value = await $fetch<AdoptionPreview>(`/api/endpoints/${props.endpointId}/adoption/preview`, { method: 'POST', body: body() })
  }
  catch (err) {
    const e = apiError(err)
    errors.value = e.errors
    if (!Object.keys(e.errors).length) toast.error(e.message)
  }
  finally {
    analyzing.value = false
  }
}

const adoptionUpload = useState<Record<string, StoredUpload>>('adoption-uploads', () => ({}))
const adoptionApprovals = useState<Record<string, PortApproval[]>>('adoption-approvals', () => ({}))
async function adopt() {
  adopting.value = true
  try {
    const r = await $fetch<{ projectId: string, targetId: string, upload: StoredUpload }>(`/api/endpoints/${props.endpointId}/adoption`, { method: 'POST', body: { ...body(), acceptDroppedRoutes: accept.value } })
    adoptionUpload.value = { ...adoptionUpload.value, [r.targetId]: r.upload }
    if (approvals.value.length) adoptionApprovals.value = { ...adoptionApprovals.value, [r.targetId]: approvals.value }
    toast.success(`Stack « ${current.value!.name} » reprise : projet ${form.projectName} créé`)
    open.value = false
    await navigateTo(`/projects/${r.projectId}`)
  }
  catch (err) {
    const e = apiError(err)
    errors.value = e.errors
    toast.error(Object.values(e.errors)[0] ?? e.message)
  }
  finally {
    adopting.value = false
  }
}

const notesBy = (level: 'error' | 'warning' | 'info') => preview.value?.notes.filter(n => n.level === level) ?? []
const blocking = computed(() => preview.value?.analysis.issues.filter(i => i.severity === 'error') ?? [])
const analysisWarnings = computed(() => preview.value?.analysis.issues.filter(i => i.severity === 'warning') ?? [])
/** Fichiers Compose d'origine (séparés par des virgules) : nom du premier, nombre des suivants. */
function composeName(files: string) {
  const list = files.split(',').filter(Boolean)
  return `${list[0]!.split('/').pop()}${list.length > 1 ? ` +${list.length - 1}` : ''}`
}
</script>

<template>
  <div class="adopt">
    <p v-if="error" class="alert">{{ apiError(error).message }}</p>
    <div v-else-if="!stacks" class="muted">Inventaire des stacks…</div>
    <section v-else class="card pad-s">
      <UiListFilter v-model:q="filter.q.value" v-model:status="filter.status.value" :statuses="STATUSES" :count="filter.filtered.value.length" :total="filter.total.value" :active="filter.active.value" placeholder="Stack, service, image, domaine…" @reset="filter.reset" />
      <table class="table">
        <thead><tr><th>Stack</th><th>Services</th><th>Domaines</th><th>État</th><th /></tr></thead>
        <tbody>
          <tr v-if="!filter.filtered.value.length"><td colspan="5" class="muted">{{ stacks.length ? 'Aucune stack ne correspond au filtre' : 'Aucune stack Compose sur cet endpoint' }}</td></tr>
          <tr v-for="s in filter.filtered.value" :key="s.name">
            <td>
              <span class="st-name">
                <strong class="mono" :title="s.composeFile ? composeName(s.composeFile) : undefined">{{ s.name }}</strong>
                <UiBadge v-if="s.infrastructure" tone="warning">{{ s.infrastructure }}</UiBadge>
              </span>
            </td>
            <td class="small">
              <div class="one" :title="s.services.join(', ')">{{ s.services.join(', ') || '—' }}</div>
              <div class="muted mono one" :title="s.images.map(displayImage).join(', ')">{{ s.images.slice(0, 3).map(displayImage).join(', ') }}<template v-if="s.images.length > 3"> +{{ s.images.length - 3 }}</template></div>
            </td>
            <td class="small mono">
              <div v-for="h in s.hosts.slice(0, 3)" :key="h">{{ h }}</div>
              <span v-if="s.hosts.length > 3" class="muted">+{{ s.hosts.length - 3 }}</span>
              <span v-if="!s.hosts.length" class="muted">—</span>
            </td>
            <td><UiBadge :tone="s.running === s.containers && s.containers ? 'success' : s.running ? 'warning' : 'neutral'" dot>{{ s.running }}/{{ s.containers }} en marche</UiBadge></td>
            <td class="act">
              <NuxtLink v-if="s.managedBy" :to="`/projects/${s.managedBy.projectId}`" class="small">{{ s.managedBy.projectName }} ({{ s.managedBy.environment }}) →</NuxtLink>
              <UiButton v-else-if="canAdopt" size="sm" variant="primary" :disabled="!environments.length" @click="start(s)">Reprendre</UiButton>
            </td>
          </tr>
        </tbody>
      </table>
      <div class="foot">
        <span v-if="!environments.length" class="muted small">Associer d'abord un environnement à cet endpoint pour reprendre une stack.</span>
        <span class="spacer" />
        <UiButton variant="ghost" size="sm" :loading="status === 'pending'" @click="refresh()">Actualiser</UiButton>
      </div>
    </section>

    <UiDrawer v-model:open="open" :title="`Reprendre « ${current?.name ?? ''} »`" width="880px">
      <template #subtitle>{{ endpointName }} · rien n'est modifié sur le serveur avant le premier déploiement</template>
      <div v-if="current" class="wizard">
        <form class="grid" @submit.prevent="analyze">
          <UiField label="Nom du projet" for="ad-name" :error="errors.projectName" required>
            <input id="ad-name" v-model="form.projectName" class="input" maxlength="100" @input="slugTouched || (form.slug = slugFromName(form.projectName))">
          </UiField>
          <UiField label="Identifiant" for="ad-slug" :error="errors.slug" required>
            <input id="ad-slug" :value="form.slug" class="input mono" maxlength="63" autocapitalize="none" spellcheck="false" @input="onSlugInput">
          </UiField>
          <UiField label="Environnement" for="ad-env" :error="errors.environmentKey" required>
            <select id="ad-env" v-model="form.environmentKey" class="input">
              <option v-for="e in environments" :key="e.key" :value="e.key">{{ e.name }}</option>
            </select>
          </UiField>
          <UiField label="Description" for="ad-desc">
            <input id="ad-desc" v-model="form.description" class="input" maxlength="1000">
          </UiField>
          <p v-if="errors.stack" class="alert span">{{ errors.stack }}</p>
          <div class="span right">
            <UiButton type="submit" :variant="preview ? 'ghost' : 'primary'" :loading="analyzing" :disabled="!form.projectName || !form.slug || !form.environmentKey">{{ preview ? 'Analyser à nouveau' : 'Analyser la stack' }}</UiButton>
          </div>
        </form>

        <template v-if="preview">
          <div class="summary">
            <div class="s card"><span class="k">Services</span><strong>{{ preview.stack.services.length || preview.analysis.services.length }}</strong></div>
            <div class="s card"><span class="k">Expositions reprises</span><strong>{{ preview.exposures.length }}</strong></div>
            <div class="s card"><span class="k">Variables chiffrées</span><strong>{{ preview.variables.length }}</strong></div>
            <div class="s card" :class="{ bad: blocking.length }"><span class="k">Points bloquants</span><strong>{{ blocking.length }}</strong></div>
          </div>


          <section v-if="notesBy('error').length || notesBy('warning').length" class="block">
            <h3>À traiter</h3>
            <ul class="notes">
              <li v-for="(n, i) in notesBy('error')" :key="`e${i}`" class="error"><CircleAlert :size="15" /><span><strong v-if="n.service" class="mono">{{ n.service }}</strong> {{ n.message }}</span></li>
              <li v-for="(n, i) in notesBy('warning')" :key="`w${i}`" class="warning"><TriangleAlert :size="15" /><span><strong v-if="n.service" class="mono">{{ n.service }}</strong> {{ n.message }}</span></li>
            </ul>
          </section>

          <section class="block">
            <h3>Expositions</h3>
            <ul v-if="preview.exposures.length" class="plain">
              <li v-for="e in preview.exposures" :key="e.service + e.host + (e.pathPrefix ?? '')"><Lock :size="13" /> <span class="mono">https://{{ e.host }}{{ e.pathPrefix ?? '' }}</span> → <span class="mono">{{ e.service }}:{{ e.port }}</span><span v-if="e.middlewares.length" class="muted mono"> · {{ e.middlewares.join(', ') }}</span></li>
            </ul>
            <p v-else class="muted small">Aucune exposition Traefik à reprendre.</p>
            <div v-if="preview.droppedRoutes.length" class="dropped">
              <p class="small"><strong>{{ preview.droppedRoutes.length }} route(s) non convertible(s)</strong> : elles disparaîtront au premier déploiement géré, à recréer à la main.</p>
              <ul class="plain mono small"><li v-for="r in preview.droppedRoutes" :key="r">{{ r }}</li></ul>
              <label class="small"><input v-model="accept" type="checkbox"> J'ai compris que ces routes seront retirées</label>
              <p v-if="errors.acceptDroppedRoutes" class="err small">{{ errors.acceptDroppedRoutes }}</p>
            </div>
          </section>

          <section v-if="preview.variables.length" class="block">
            <h3>Variables importées</h3>
            <p class="muted small"><KeyRound :size="13" /> Valeurs chiffrées comme variables secrètes, jamais affichées. Reclassables ensuite dans le projet.</p>
            <div class="chips"><span v-for="v in preview.variables" :key="v" class="chip mono">{{ v }}</span></div>
          </section>

          <section class="block">
            <div class="b-head">
              <h3>Premier déploiement géré</h3>
              <UiButton v-if="blocking.length && canAdopt" size="sm" variant="primary" @click="openFix()">Lever les {{ blocking.length }} point{{ blocking.length > 1 ? 's' : '' }} bloquant{{ blocking.length > 1 ? 's' : '' }}</UiButton>
            </div>
            <p v-if="!blocking.length" class="muted small">Le Compose converti respecte les politiques de l'endpoint.</p>
            <ul class="notes">
              <li v-for="(i, k) in blocking" :key="`b${k}`" class="error"><CircleAlert :size="15" /><span><strong v-if="i.service" class="mono">{{ i.service }}</strong> {{ i.message }} <button v-if="canAdopt" type="button" class="link fix" @click="openFix(k)">Lever</button></span></li>
              <li v-for="(i, k) in analysisWarnings" :key="`a${k}`" class="warning"><TriangleAlert :size="15" /><span><strong v-if="i.service" class="mono">{{ i.service }}</strong> {{ i.message }}</span></li>
            </ul>
            <p v-if="blocking.length" class="muted small">La reprise reste possible : ces points (politiques de l'endpoint ou Compose) se corrigent avant de déployer.</p>
            <p v-if="approvals.length" class="muted small">{{ approvals.length }} port(s) justifié(s) : justification reprise au premier déploiement.</p>
            <p v-if="droppedPorts.length || droppedMounts.length" class="muted small">Retirés de la reprise : {{ [...droppedPorts.map(p => `port ${p.published}/${p.protocol} (${p.service})`), ...droppedMounts.map(m => `montage ${m.target} (${m.service})`)].join(' ; ') }}</p>
            <p v-if="webExposures.length" class="muted small">Derrière le reverse proxy : {{ webExposures.map(w => `${w.host}${w.pathPrefix ?? ''} → ${w.service}:${w.port} (port ${w.published} retiré)`).join(' ; ') }}</p>
            <AdoptionFixWizard v-if="fixOpen" v-model:open="fixOpen" v-model:approvals="approvals" v-model:web-exposures="webExposures" v-model:dropped-ports="droppedPorts" v-model:dropped-mounts="droppedMounts" :analysis="preview.analysis" :endpoint-id="endpointId" :server-id="serverId" :stack="current!.name" :environment="{ key: form.environmentKey, name: environments.find(e => e.key === form.environmentKey)?.name ?? form.environmentKey }" :start="fixStart" @finish="analyze()" />
          </section>

          <section v-if="notesBy('info').length" class="block">
            <h3>Conversions</h3>
            <ul class="notes">
              <li v-for="(n, i) in notesBy('info')" :key="`i${i}`" class="info"><Info :size="15" /><span><strong v-if="n.service" class="mono">{{ n.service }}</strong> {{ n.message }}</span></li>
            </ul>
          </section>

          <section class="block">
            <button type="button" class="link" @click="showCompose = !showCompose"><FileCode :size="14" /> {{ showCompose ? 'Masquer' : 'Voir' }} le Compose converti</button>
            <pre v-if="showCompose" class="code">{{ preview.composeText }}</pre>
          </section>

          <div class="bar">
            <span class="muted small">Crée le projet, la cible (stack <span class="mono">{{ preview.stack.name }}</span> conservée) et les variables. Le déploiement se lance ensuite depuis le projet.</span>
            <UiButton variant="primary" :loading="adopting" :disabled="preview.droppedRoutes.length > 0 && !accept" @click="adopt">Reprendre en projet</UiButton>
          </div>
        </template>
      </div>
    </UiDrawer>
  </div>
</template>

<style scoped>
.adopt { display: flex; flex-direction: column; gap: var(--space-3); }
.alert { margin: 0; padding: var(--space-3) var(--space-4); border-radius: var(--radius); background: var(--danger-bg); color: var(--danger); }
.pad-s { padding: var(--space-3) var(--space-4); display: flex; flex-direction: column; gap: var(--space-2); }
.table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
.table th { text-align: left; font-size: 11px; text-transform: uppercase; color: var(--text-muted); padding: 4px 8px; border-bottom: 1px solid var(--border); }
.table td { padding: 4px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
.act { text-align: right; white-space: nowrap; }
.small { font-size: 12.5px; }
.b-head { display: flex; justify-content: space-between; align-items: center; gap: var(--space-2); }
.b-head h3 { margin: 0; }
.fix { margin-left: 6px; font-size: 12.5px; font-weight: 550; }
.st-name { display: inline-flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.one { max-width: 520px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.foot { display: flex; align-items: center; gap: var(--space-2); }
.spacer { flex: 1; }
.wizard { display: flex; flex-direction: column; gap: var(--space-4); }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
.span { grid-column: 1 / -1; }
.right { display: flex; justify-content: flex-end; }
.summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: var(--space-2); }
.s { padding: var(--space-3); display: flex; flex-direction: column; }
.s .k { font-size: 12px; color: var(--text-muted); }
.s strong { font-size: 20px; }
.s.bad strong { color: var(--danger); }
.block { display: flex; flex-direction: column; gap: var(--space-2); }
.block h3 { margin: 0; font-size: 14px; }
.notes { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; font-size: 13px; }
.notes li { display: flex; gap: 8px; align-items: flex-start; }
.notes li > svg { flex: none; margin-top: 2px; }
.notes .error > svg { color: var(--danger); }
.notes .warning > svg { color: var(--warning); }
.notes .info > svg { color: var(--text-muted); }
.plain { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
.dropped { border: 1px solid color-mix(in srgb, var(--warning) 45%, var(--border)); background: var(--warning-bg); border-radius: var(--radius); padding: var(--space-3); display: flex; flex-direction: column; gap: 6px; }
.dropped p { margin: 0; }
.chips { display: flex; flex-wrap: wrap; gap: 4px; }
.chip { padding: 1px 8px; border-radius: 999px; background: var(--surface-2); border: 1px solid var(--border); font-size: 12px; }
.link { all: unset; cursor: pointer; color: var(--primary); font-size: 13px; display: inline-flex; gap: 6px; align-items: center; }
.link:focus-visible { outline: 2px solid var(--focus); }
.code { margin: 0; padding: var(--space-3); background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius); font-size: 12px; max-height: 420px; overflow: auto; white-space: pre; }
.bar { display: flex; gap: var(--space-3); align-items: center; justify-content: space-between; position: sticky; bottom: 0; background: var(--surface); padding: var(--space-3) 0; border-top: 1px solid var(--border); }
.err { color: var(--danger); margin: 0; }
@media (max-width: 760px) { .grid, .summary { grid-template-columns: 1fr 1fr; } }
</style>
