<script setup lang="ts">
/**
 * Assistant de création d'un projet et de sa première cible : identité, hôte et
 * environnement, emplacement sur l'hôte (chemin choisi, volumes en dossiers),
 * réseau du reverse proxy. Tout est créé en une transaction ; le déploiement se
 * fait ensuite depuis la fiche projet.
 */
import type { DeployOption } from '#shared/schemas/projects'
import { FolderTree, Lock, Network } from 'lucide-vue-next'
import { trimTrailingSlashes } from '#shared/utils/trim'

useHead({ title: 'Nouveau projet' })
const toast = useToast()
const { data: options } = await useFetch<DeployOption[]>('/api/deploy-options', { default: () => [] })

const STEPS = [
  { key: 'project', label: 'Projet' },
  { key: 'target', label: 'Hôte et environnement' },
  { key: 'location', label: 'Emplacement sur l\'hôte' },
  { key: 'proxy', label: 'Reverse proxy' },
  { key: 'summary', label: 'Récapitulatif' },
] as const
type StepKey = (typeof STEPS)[number]['key']
const step = ref(0)
const reached = ref(0)
const stepKey = computed<StepKey>(() => STEPS[step.value]!.key)

const form = reactive({
  name: '', slug: '', description: '', endpointId: '', environmentKey: '',
  pathMode: 'custom' as 'default' | 'custom', projectPath: '', pathTouched: false, volumesAsFolders: true,
  proxyNetwork: '',
})
const slugTouched = ref(false)
const errors = ref<Record<string, string>>({})
const busy = ref(false)

// L'identifiant suit le nom tant qu'il n'a pas été saisi à la main ; vidé, il le suit de nouveau au prochain changement du nom.
watch(() => form.name, (n) => {
  if (slugTouched.value) return
  form.slug = slugFromName(n)
})
function onSlugInput(e: Event) {
  const el = e.target as HTMLInputElement
  slugTouched.value = el.value !== ''
  // Saisie libre normalisée au fil de la frappe (un tiret final reste possible pendant la saisie).
  form.slug = slugTyping(el.value)
  el.value = form.slug
}

const endpoint = computed(() => options.value.find(o => o.endpointId === form.endpointId))
const environments = computed(() => endpoint.value?.environments ?? [])
const env = computed(() => environments.value.find(e => e.key === form.environmentKey))
watch(() => form.endpointId, () => {
  form.environmentKey = environments.value.find(e => e.pathsConfigured)?.key ?? ''
  form.proxyNetwork = ''
})

// Chemin proposé : <runtimeRoot>/<projet>, tant qu'il n'a pas été saisi à la main.
const suggestedPath = computed(() => (env.value?.roots && form.slug ? `${trimTrailingSlashes(env.value.roots.runtimeRoot)}/${form.slug}` : ''))
watch(suggestedPath, (p) => {
  if (!form.pathTouched) form.projectPath = p
}, { immediate: true })
const cleanPath = computed(() => trimTrailingSlashes(form.projectPath.trim()))
const layout = computed(() => {
  const r = env.value?.roots
  if (!r || !form.slug) return null
  if (form.pathMode === 'default') return { releases: `${r.workingRoot}/${form.slug}/releases`, data: `${r.runtimeRoot}/${form.slug}` }
  return cleanPath.value ? { releases: `${cleanPath.value}/releases`, data: `${cleanPath.value}/data` } : null
})
const pathProblem = computed(() => {
  if (form.pathMode === 'default') return null
  const p = cleanPath.value
  const r = env.value?.roots
  if (!p.startsWith('/')) return 'Chemin absolu attendu'
  if (/(^|\/)\.\.?(\/|$)/.test(p)) return 'Segments . et .. interdits'
  if (r && ![r.workingRoot, r.runtimeRoot].some(root => p.startsWith(`${trimTrailingSlashes(root)}/`))) return `Doit se trouver sous ${r.runtimeRoot} ou ${r.workingRoot}`
  return null
})

const proxyNetworks = computed(() => endpoint.value?.proxyNetworks ?? [])
const defaultNetwork = computed(() => proxyNetworks.value.find(n => n.default)?.name ?? null)

const stepBlocker = computed<string | null>(() => {
  switch (stepKey.value) {
    case 'project':
      if (form.name.trim().length < 2) return 'Nom requis'
      if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(form.slug)) return 'Identifiant invalide'
      return null
    case 'target':
      return !form.endpointId || !form.environmentKey ? 'Choisir l\'hôte et l\'environnement' : null
    case 'location':
      return pathProblem.value
    default:
      return null
  }
})
function go(i: number) {
  step.value = i
  reached.value = Math.max(reached.value, i)
}
function next() {
  if (!stepBlocker.value) go(step.value + 1)
}
const STEP_OF_FIELD: Record<string, StepKey> = { slug: 'project', name: 'project', endpointId: 'target', environmentKey: 'target', projectPath: 'location', proxyNetwork: 'proxy' }

async function create() {
  busy.value = true
  errors.value = {}
  try {
    const p = await $fetch<{ id: string }>('/api/projects', {
      method: 'POST',
      body: {
        name: form.name.trim(),
        slug: form.slug,
        description: form.description.trim() || null,
        target: {
          endpointId: form.endpointId,
          environmentKey: form.environmentKey,
          projectPath: form.pathMode === 'custom' ? cleanPath.value : null,
          volumesAsFolders: form.pathMode === 'custom' && form.volumesAsFolders,
          proxyNetwork: form.proxyNetwork || null,
        },
      },
    })
    toast.success(`Projet « ${form.name} » créé`)
    await navigateTo(`/projects/${p.id}?deploy=1`)
  }
  catch (err) {
    const e = apiError(err)
    errors.value = Object.fromEntries(Object.entries(e.errors).map(([k, v]) => [k.replace(/^target\./, ''), v]))
    const field = Object.keys(errors.value).find(f => STEP_OF_FIELD[f])
    if (field) go(STEPS.findIndex(s => s.key === STEP_OF_FIELD[field]))
    toast.error(Object.values(errors.value)[0] ?? e.message)
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <div>
    <UiPageHeader title="Nouveau projet" icon="folder-plus" :back="{ to: '/projects', label: 'Projets' }" />
    <div class="wizard">
      <aside class="card side"><UiStepper :steps="[...STEPS]" :current="step" :reached="reached" @go="go" /></aside>
      <form class="card main" @submit.prevent="stepKey === 'summary' ? create() : next()">
        <header class="main-head">
          <span class="muted small">Étape {{ step + 1 }} sur {{ STEPS.length }}</span>
          <h2>{{ STEPS[step]!.label }}</h2>
        </header>

        <div class="body">
          <!-- 1. Projet -->
          <template v-if="stepKey === 'project'">
            <UiField label="Nom" for="p-name" :error="errors.name" required>
              <input id="p-name" v-model="form.name" class="input" maxlength="100" autofocus>
            </UiField>
            <UiField label="Identifiant" for="p-slug" hint="Utilisé dans les chemins, la stack et les images : minuscules, chiffres, tirets" :error="errors.slug" required>
              <input id="p-slug" :value="form.slug" class="input mono" maxlength="63" autocapitalize="none" spellcheck="false" @input="onSlugInput">
            </UiField>
            <UiField label="Description" for="p-desc">
              <textarea id="p-desc" v-model="form.description" class="input" rows="2" maxlength="1000" />
            </UiField>
          </template>

          <!-- 2. Hôte et environnement -->
          <template v-else-if="stepKey === 'target'">
            <p v-if="!options.length" class="alert">Aucun endpoint activé : ajouter et configurer un serveur d'abord.</p>
            <UiField v-else label="Serveur / endpoint" for="p-ep" :error="errors.endpointId" required>
              <select id="p-ep" v-model="form.endpointId" class="input">
                <option value="" disabled>Choisir…</option>
                <option v-for="o in options" :key="o.endpointId" :value="o.endpointId">{{ o.serverName }} / {{ o.endpointName }}{{ o.runner.status !== 'online' ? ' — Runner non vérifié' : '' }}</option>
              </select>
            </UiField>
            <div v-if="endpoint" class="envs" role="radiogroup" aria-label="Environnement">
              <label v-for="e in environments" :key="e.key" class="env" :class="{ on: form.environmentKey === e.key, disabled: !e.pathsConfigured }">
                <input v-model="form.environmentKey" type="radio" name="env" :value="e.key" :disabled="!e.pathsConfigured">
                {{ e.name }} <UiBadge v-if="e.isProduction" tone="danger">prod</UiBadge>
                <span v-if="!e.pathsConfigured" class="muted small">chemins non configurés</span>
              </label>
            </div>
            <p v-if="endpoint && endpoint.runner.status !== 'online'" class="alert warn">Le Target Runner de cet endpoint n'a pas été vérifié : lancer le diagnostic depuis la fiche du serveur.</p>
            <p v-if="errors.environmentKey" class="error-text">{{ errors.environmentKey }}</p>
          </template>

          <!-- 3. Emplacement -->
          <template v-else-if="stepKey === 'location'">
            <div class="choices" role="radiogroup" aria-label="Emplacement">
              <label class="choice card" :class="{ on: form.pathMode === 'custom' }">
                <input v-model="form.pathMode" type="radio" value="custom">
                <strong>Chemin choisi</strong>
                <span class="muted small">Un dossier pour le projet : ses releases et ses données au même endroit.</span>
              </label>
              <label class="choice card" :class="{ on: form.pathMode === 'default' }">
                <input v-model="form.pathMode" type="radio" value="default">
                <strong>Racines de l'environnement</strong>
                <span class="muted small">Releases sous la racine de travail, données sous la racine runtime.</span>
              </label>
            </div>
            <template v-if="form.pathMode === 'custom'">
              <UiField label="Chemin du projet sur l'hôte" for="p-path" :error="errors.projectPath ?? pathProblem" :hint="env?.roots ? `Sous ${env.roots.runtimeRoot} ou ${env.roots.workingRoot}` : undefined" required>
                <input id="p-path" v-model="form.projectPath" class="input mono" spellcheck="false" @input="form.pathTouched = true">
              </UiField>
              <UiSwitch v-model="form.volumesAsFolders" label="Stocker les volumes du Compose dans le dossier du projet" />
              <p class="muted small">Chaque volume nommé (ex. la base de données) devient un dossier sous <code>data/</code>, sauvegardable avec le reste du projet. Chemin et stockage sont fixés au premier déploiement.</p>
            </template>
            <div v-if="layout" class="layout">
              <FolderTree :size="16" />
              <dl>
                <dt>Releases</dt><dd class="mono">{{ layout.releases }}</dd>
                <dt>Données</dt><dd class="mono">{{ layout.data }}<template v-if="form.pathMode === 'custom' && form.volumesAsFolders">/&lt;volume&gt;</template></dd>
              </dl>
            </div>
          </template>

          <!-- 4. Reverse proxy -->
          <template v-else-if="stepKey === 'proxy'">
            <UiField label="Réseau du reverse proxy" for="p-net" :error="errors.proxyNetwork" hint="Réseau partagé avec Traefik, auquel les services exposés du projet sont raccordés">
              <select id="p-net" v-model="form.proxyNetwork" class="input">
                <option value="">{{ defaultNetwork ? `Réseau par défaut de l'endpoint (${defaultNetwork})` : 'Aucun (Traefik non configuré)' }}</option>
                <option v-for="n in proxyNetworks.filter(x => !x.default)" :key="n.name" :value="n.name">{{ n.name }}{{ n.managed ? ' — Traefik géré' : n.role === 'traefik' ? ' — rôle Traefik' : '' }}</option>
              </select>
            </UiField>
            <div v-if="endpoint?.managedProxy" class="note ok">
              <Lock :size="15" />
              <span>Traefik géré par la plateforme sur cet endpoint<template v-if="endpoint.managedProxy.acme"> : certificats ACME automatiques pour les domaines exposés</template>.</span>
            </div>
            <div v-else class="note">
              <Network :size="15" />
              <span>Pas de Traefik géré sur cet endpoint. Le configurer, avec ACME, depuis la fiche du serveur, onglet « Traefik et domaines ».</span>
            </div>
            <p class="muted small">Les domaines exposés se déclarent ensuite au déploiement (« Exposition web »).</p>
          </template>

          <!-- 5. Récapitulatif -->
          <template v-else>
            <dl class="recap">
              <dt>Projet</dt><dd>{{ form.name }} <span class="mono muted">{{ form.slug }}</span></dd>
              <dt>Cible</dt><dd>{{ endpoint?.serverName }} / {{ endpoint?.endpointName }} · {{ env?.name }}</dd>
              <dt>Releases</dt><dd class="mono">{{ layout?.releases }}</dd>
              <dt>Données</dt><dd class="mono">{{ layout?.data }}<span v-if="form.pathMode === 'custom' && form.volumesAsFolders" class="muted"> (volumes en dossiers)</span></dd>
              <dt>Reverse proxy</dt><dd class="mono">{{ form.proxyNetwork || defaultNetwork || '—' }}</dd>
            </dl>
          </template>
        </div>

        <footer class="foot">
          <UiButton v-if="step > 0" @click="go(step - 1)">Précédent</UiButton>
          <span class="spacer" />
          <span v-if="stepBlocker" class="muted small">{{ stepBlocker }}</span>
          <UiButton v-if="stepKey !== 'summary'" type="submit" variant="primary" :disabled="!!stepBlocker">Suivant</UiButton>
          <UiButton v-else type="submit" variant="primary" :loading="busy">Créer et passer au déploiement</UiButton>
        </footer>
      </form>
    </div>
  </div>
</template>

<style scoped>
.wizard { display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: var(--space-4); align-items: start; max-width: 1040px; }
.side { padding: var(--space-3); }
.main { display: flex; flex-direction: column; }
.main-head { padding: var(--space-4) var(--space-5); border-bottom: 1px solid var(--border); }
.main-head h2 { margin: 2px 0 0; }
.body { padding: var(--space-5); display: flex; flex-direction: column; gap: var(--space-4); }
.foot { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-3) var(--space-5); border-top: 1px solid var(--border); }
.spacer { flex: 1; }
.small { font-size: 12.5px; }
.envs { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.env { display: inline-flex; align-items: center; gap: var(--space-2); padding: 6px 12px; border: 1px solid var(--border); border-radius: var(--radius); cursor: pointer; }
.env.on { border-color: var(--primary); background: var(--info-bg); }
.env.disabled { opacity: .6; cursor: not-allowed; }
.choices { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
.choice { display: flex; flex-direction: column; gap: 4px; padding: var(--space-3) var(--space-4); cursor: pointer; position: relative; }
.choice input { position: absolute; opacity: 0; pointer-events: none; }
.choice.on { border-color: var(--primary); box-shadow: 0 0 0 1px var(--primary); }
.choice:focus-within { outline: 2px solid var(--focus); }
.layout { display: flex; gap: var(--space-3); align-items: flex-start; padding: var(--space-3) var(--space-4); border: 1px dashed var(--border); border-radius: var(--radius); background: var(--surface-2); }
.layout dl, .recap { display: grid; grid-template-columns: 120px 1fr; gap: 4px var(--space-3); margin: 0; font-size: 13px; }
.layout dt, .recap dt { color: var(--text-muted); }
.layout dd, .recap dd { margin: 0; word-break: break-all; }
.note { display: flex; gap: 8px; align-items: flex-start; font-size: 13px; padding: var(--space-3) var(--space-4); border-radius: var(--radius); background: var(--surface-2); }
.note.ok { background: var(--success-bg); color: var(--success); }
.alert { margin: 0; padding: var(--space-3) var(--space-4); border-radius: var(--radius); background: var(--danger-bg); color: var(--danger); }
.alert.warn { background: var(--warning-bg); color: var(--warning); }
.error-text { color: var(--danger); margin: 0; }
@media (max-width: 860px) { .wizard, .choices { grid-template-columns: 1fr; } }
</style>
