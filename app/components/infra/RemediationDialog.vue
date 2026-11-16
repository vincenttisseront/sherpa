<script setup lang="ts">
/**
 * Demande de correction d'une image ou d'un code source analysé : dépôt GitHub détecté (ou saisi),
 * texte prêt à publier (issue ou PR), modifications proposées pour la PR, création par l'API ou
 * ouverture pré-remplie sur GitHub, suivi d'une demande déjà ouverte.
 */
import { REMEDIATION_STATE_LABEL, type RemediationDraft, type RemediationRequestDto, type RemediationSubject } from '#shared/schemas/remediation'
import { Copy, ExternalLink, GitPullRequest, Github, RefreshCw, TriangleAlert } from 'lucide-vue-next'

const props = defineProps<{ subject: RemediationSubject, label: string }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ created: [request: RemediationRequestDto] }>()
const toast = useToast()

const minSeverity = ref<'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'>('HIGH')
const fixableOnly = ref(true)
const lang = ref<'fr' | 'en'>('fr')
const includeContext = ref(false)
const kind = ref<'issue' | 'pr'>('pr')
const repository = ref('')
const draft = ref<RemediationDraft | null>(null)
const title = ref('')
const body = ref('')
const edited = ref(false)
const paths = ref<string[]>([])
const token = ref('')
const showToken = ref(false)
const loading = ref(false)
const creating = ref(false)
const error = ref<string | null>(null)
const created = ref<RemediationRequestDto | null>(null)
const trackUrl = ref('')
const tracking = ref(false)

async function load(regenerate = true) {
  loading.value = true
  error.value = null
  try {
    const d = await $fetch<RemediationDraft>('/api/vulnerabilities/remediation/draft', {
      method: 'POST',
      body: { subject: props.subject, minSeverity: minSeverity.value, fixableOnly: fixableOnly.value, lang: lang.value, includeContext: includeContext.value, kind: kind.value, repository: repository.value.trim() || null },
    })
    draft.value = d
    if (!repository.value && d.repository) repository.value = d.repository
    kind.value = d.kind
    paths.value = d.pr.changes.map(c => c.path)
    if (regenerate || !edited.value) {
      title.value = d.title
      body.value = d.body
      edited.value = false
    }
  }
  catch (err) {
    error.value = apiError(err).message
  }
  finally {
    loading.value = false
  }
}
watch(open, (o) => {
  if (!o) return
  created.value = null
  repository.value = ''
  edited.value = false
  token.value = ''
  void load()
}, { immediate: true })
// Options : texte régénéré (sauf s'il a été modifié à la main).
let timer: ReturnType<typeof setTimeout> | undefined
watch([minSeverity, fixableOnly, lang, includeContext, kind], () => {
  clearTimeout(timer)
  timer = setTimeout(() => void load(false), 250)
})
onBeforeUnmount(() => clearTimeout(timer))

const ORIGIN = { project: 'source GitHub du projet', label: 'label OCI de l\'image (org.opencontainers.image.source)', package: 'package d\'un connecteur GitHub', manual: 'saisi' } as const
const SEVERITY = { CRITICAL: 'Critiques', HIGH: 'Critiques et hautes', MEDIUM: 'Critiques à moyennes', LOW: 'Toutes' } as const
const canCreate = computed(() => !!draft.value?.repository && !!title.value.trim() && !!body.value.trim() && (!!draft.value.token || !!token.value.trim()) && (kind.value === 'issue' || paths.value.length > 0))

async function copy() {
  await navigator.clipboard.writeText(`${title.value}\n\n${body.value}`).then(() => toast.success('Titre et texte copiés'), () => toast.error('Copie impossible'))
}
async function openOnGithub() {
  if (!draft.value?.repository) return
  // L'adresse a une longueur limitée : texte complet copié pour le coller au besoin.
  const short = body.value.length > 6000
  if (short) await navigator.clipboard.writeText(body.value).catch(() => {})
  const text = short ? `${body.value.slice(0, 6000)}\n\n…` : body.value
  window.open(`${draft.value.webUrl}/${draft.value.repository}/issues/new?title=${encodeURIComponent(title.value)}&body=${encodeURIComponent(text)}`, '_blank', 'noopener')
  if (short) toast.info('Texte complet copié : le coller dans l\'issue (l\'adresse en porte un extrait)')
}
async function create() {
  creating.value = true
  try {
    const r = await $fetch<RemediationRequestDto>('/api/vulnerabilities/remediation', {
      method: 'POST',
      body: { subject: props.subject, minSeverity: minSeverity.value, fixableOnly: fixableOnly.value, lang: lang.value, includeContext: includeContext.value, kind: kind.value, repository: repository.value.trim() || null, title: title.value, body: body.value, paths: paths.value, token: token.value.trim() || null },
    })
    created.value = r
    token.value = ''
    toast.success(`${r.kind === 'pr' ? 'PR' : 'Issue'} #${r.number} ouverte sur ${r.repository}`)
    emit('created', r)
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    creating.value = false
  }
}
async function track() {
  tracking.value = true
  try {
    const r = await $fetch<RemediationRequestDto>('/api/vulnerabilities/remediation/track', { method: 'POST', body: { subject: props.subject, url: trackUrl.value.trim() } })
    toast.success(`${r.repository}#${r.number} suivie`)
    trackUrl.value = ''
    emit('created', r)
    await load(false)
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    tracking.value = false
  }
}
const STATE_TONE = { open: 'info', closed: 'neutral', merged: 'success', resolved: 'success' } as const
</script>

<template>
  <UiModal v-model:open="open" :title="`Demande de correction — ${label}`" width="900px">
    <div class="rem">
      <p v-if="error" class="alert" role="alert">{{ error }}</p>
      <div v-else-if="!draft" class="muted">Préparation de la demande…</div>
      <template v-else-if="created">
        <p class="ok"><GitPullRequest :size="16" /> {{ created.kind === 'pr' ? 'PR' : 'Issue' }} <strong>#{{ created.number }}</strong> ouverte sur {{ created.repository }} : la console la suit (état GitHub, puis résolution à la prochaine analyse).</p>
        <a :href="created.url" target="_blank" rel="noopener" class="link">{{ created.url }} <ExternalLink :size="12" /></a>
        <div class="foot"><UiButton variant="primary" @click="open = false">Fermer</UiButton></div>
      </template>
      <template v-else>
        <div class="grid">
          <UiField label="Dépôt GitHub" for="rem-repo" :hint="draft.repositoryOrigin ? `Détecté : ${ORIGIN[draft.repositoryOrigin]}` : 'Dépôt non détecté : le saisir (org/dépôt)'">
            <div class="repo">
              <input id="rem-repo" v-model.trim="repository" class="input mono" placeholder="org/dépôt" @change="load(false)">
              <a v-if="draft.repositoryUrl" :href="draft.repositoryUrl" target="_blank" rel="noopener" :aria-label="`Ouvrir ${draft.repository}`"><Github :size="16" /></a>
            </div>
          </UiField>
          <UiField label="Vulnérabilités" for="rem-sev">
            <select id="rem-sev" v-model="minSeverity" class="input"><option v-for="(l, k) in SEVERITY" :key="k" :value="k">{{ l }}</option></select>
          </UiField>
          <UiField label="Langue du texte" for="rem-lang">
            <select id="rem-lang" v-model="lang" class="input"><option value="fr">Français</option><option value="en">English</option></select>
          </UiField>
        </div>
        <div class="checks">
          <label class="small"><input v-model="fixableOnly" type="checkbox"> Seulement celles qui ont un correctif publié</label>
          <label class="small"><input v-model="includeContext" type="checkbox"> Inclure le contexte interne (serveur, projets, lien vers la console)</label>
          <span class="muted small">{{ draft.packages }} paquet(s), {{ draft.vulnerabilities }} vulnérabilité(s)</span>
          <UiButton v-if="loading" size="sm" variant="ghost" loading>…</UiButton>
        </div>
        <p v-if="draft.visibility === 'public'" class="warn small"><TriangleAlert :size="13" /> Dépôt public : la demande sera visible de tous{{ includeContext ? ', contexte interne compris' : '' }}. Pour un signalement privé, préférer un avis de sécurité du dépôt.</p>
        <p v-if="draft.repositoryError" class="warn small"><TriangleAlert :size="13" /> {{ draft.repositoryError }}</p>

        <div class="kind" role="radiogroup" aria-label="Type de demande">
          <label :class="{ on: kind === 'pr', off: !draft.pr.available }"><input v-model="kind" type="radio" value="pr" :disabled="!draft.pr.available"> <GitPullRequest :size="14" /> Pull request avec les corrections</label>
          <label :class="{ on: kind === 'issue' }"><input v-model="kind" type="radio" value="issue"> Issue</label>
        </div>
        <p v-if="!draft.pr.available && draft.pr.reason" class="muted small">PR : {{ draft.pr.reason }}</p>
        <div v-if="kind === 'pr' && draft.pr.changes.length" class="changes">
          <span class="small">Modifications (branche créée depuis <span class="mono">{{ draft.pr.base }}</span>) :</span>
          <label v-for="c in draft.pr.changes" :key="c.path" class="small"><input v-model="paths" type="checkbox" :value="c.path"> <span class="mono">{{ c.path }}</span> — {{ c.summary }}</label>
        </div>

        <UiField label="Titre" for="rem-title"><input id="rem-title" v-model="title" class="input" maxlength="250" @input="edited = true"></UiField>
        <UiField label="Texte (Markdown)" for="rem-body">
          <textarea id="rem-body" v-model="body" class="input mono body" rows="16" spellcheck="false" @input="edited = true" />
        </UiField>
        <div v-if="edited" class="small muted">Texte modifié à la main : il n'est plus régénéré. <a href="#" @click.prevent="load(true)"><RefreshCw :size="11" /> Régénérer</a></div>

        <div class="token small">
          <span v-if="draft.token">Création avec le jeton du {{ draft.token }}.</span>
          <span v-else class="muted">Aucun jeton connu pour ce dépôt : saisir un jeton pour cette demande, ou l'ouvrir sur GitHub.</span>
          <a href="#" @click.prevent="showToken = !showToken">{{ showToken ? 'Masquer' : 'Utiliser un autre jeton' }}</a>
        </div>
        <UiField v-if="showToken || !draft.token" label="Jeton pour cette demande (non conservé)" for="rem-token" hint="Issues en écriture ; pour une PR, Contents et Pull requests en écriture">
          <input id="rem-token" v-model="token" class="input mono" type="password" autocomplete="off">
        </UiField>

        <div class="foot">
          <UiButton variant="ghost" @click="copy"><Copy :size="14" /> Copier le texte</UiButton>
          <UiButton v-if="kind === 'issue' && draft.repository" variant="ghost" @click="openOnGithub"><ExternalLink :size="14" /> Ouvrir sur GitHub</UiButton>
          <UiButton variant="primary" :disabled="!canCreate" :loading="creating" @click="create">{{ kind === 'pr' ? 'Créer la PR' : 'Créer l\'issue' }}</UiButton>
        </div>

        <section class="track">
          <h4>Demandes de correction de {{ draft.subjectLabel }}</h4>
          <ul v-if="draft.requests.length" class="reqs">
            <li v-for="r in draft.requests" :key="r.id">
              <UiBadge :tone="STATE_TONE[r.state]">{{ r.kind === 'pr' ? 'PR' : 'Issue' }} {{ REMEDIATION_STATE_LABEL[r.state] }}</UiBadge>
              <a :href="r.url" target="_blank" rel="noopener" class="mono">{{ r.repository }}#{{ r.number }}</a>
              <span class="small">{{ r.title }}</span>
              <span class="muted small">{{ fmtRelative(r.createdAt) }}{{ r.createdBy ? ` · ${r.createdBy}` : '' }}</span>
            </li>
          </ul>
          <p v-else class="muted small">Aucune demande suivie.</p>
          <div class="row">
            <input v-model.trim="trackUrl" class="input sm grow" placeholder="Suivre une issue ou une PR déjà ouverte : lien GitHub" aria-label="Lien d'une issue ou d'une PR à suivre">
            <UiButton size="sm" :disabled="!trackUrl" :loading="tracking" @click="track">Suivre</UiButton>
          </div>
        </section>
      </template>
    </div>
  </UiModal>
</template>

<style scoped>
.rem { display: flex; flex-direction: column; gap: var(--space-2); }
.grid { display: grid; grid-template-columns: 2fr 1fr 1fr; gap: var(--space-2); }
.repo { display: flex; gap: 6px; align-items: center; }
.repo .input { flex: 1; }
.checks { display: flex; flex-wrap: wrap; gap: 4px 16px; align-items: center; }
.small { font-size: 12.5px; margin: 0; }
.warn { color: var(--warning); display: flex; gap: 6px; align-items: baseline; }
.ok { display: flex; gap: 6px; align-items: center; margin: 0; }
.alert { margin: 0; padding: var(--space-2) var(--space-3); border-radius: var(--radius); background: var(--danger-bg); color: var(--danger); }
.kind { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.kind label { display: inline-flex; gap: 6px; align-items: center; padding: 6px 10px; border: 1px solid var(--border); border-radius: var(--radius); cursor: pointer; font-size: 13px; }
.kind label.on { border-color: var(--primary); box-shadow: 0 0 0 1px var(--primary); }
.kind label.off { opacity: .55; cursor: not-allowed; }
.changes { display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-2); }
.body { font-size: 12px; line-height: 1.45; min-height: 260px; }
.token { display: flex; gap: 10px; flex-wrap: wrap; align-items: baseline; }
.foot { display: flex; justify-content: flex-end; gap: var(--space-2); flex-wrap: wrap; }
.track { border-top: 1px solid var(--border); padding-top: var(--space-2); display: flex; flex-direction: column; gap: var(--space-2); }
.track h4 { margin: 0; font-size: 13px; color: var(--text-muted); }
.reqs { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.reqs li { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.row { display: flex; gap: var(--space-2); }
.grow { flex: 1; }
.link { font-size: 13px; }
@media (max-width: 760px) { .grid { grid-template-columns: 1fr; } }
</style>
