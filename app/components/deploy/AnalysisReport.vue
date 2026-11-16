<script setup lang="ts">
/**
 * Présentation de l'analyse avant déploiement (§9) : alertes, ports publiés,
 * volumes, réseaux, modifications apportées, Compose final et diff.
 * Les ports soumis à validation se justifient et se confirment ici.
 */
import type { AnalysisResult, PortApproval, PortReport } from '#shared/schemas/analysis'
import { type UnpublishRequest, containerPortOf, suggestWebHost, webHint } from '#shared/utils/web-ports'

// proxy : reverse proxy de l'endpoint (null : aucun ; absent : inconnu, section masquée).
const props = defineProps<{ analysis: AnalysisResult, busySource?: string | null, proxy?: { allowedDomains: string[], provider?: string } | null, busyPort?: string | null }>()
const emit = defineEmits<{ 'use-image': [{ service: string, from: string, image: string }], 'exclude-service': [{ service: string, excluded: boolean }], 'suspend-service': [{ service: string, suspended: boolean }], 'unpublish-port': [UnpublishRequest] }>()
const suspendedServices = computed(() => props.analysis.issues.filter(i => i.code === 'service.suspended' && i.service).map(i => i.service!))
const excludedServices = computed(() => props.analysis.issues.filter(i => i.code === 'service.excluded' && i.service).map(i => i.service!))
const toExclude = ref('')
const busySource = computed(() => props.busySource ?? null)
const approvals = defineModel<PortApproval[]>('approvals', { required: true })

const tab = ref('summary')
const tabs = computed(() => [
  { key: 'summary', label: 'Synthèse', badge: props.analysis.issues.filter(i => i.severity === 'error').length || undefined },
  { key: 'final', label: 'Compose final' },
  { key: 'diff', label: 'Diff avec la source' },
])

const errors = computed(() => props.analysis.issues.filter(i => i.severity === 'error'))
const warnings = computed(() => props.analysis.issues.filter(i => i.severity === 'warning'))
const infos = computed(() => props.analysis.issues.filter(i => i.severity === 'info'))
const pendingPorts = computed(() => props.analysis.ports.filter(p => p.policy === 'approval' && p.published !== null))

function approval(service: string, published: number, protocol: 'tcp' | 'udp') {
  return approvals.value.find(a => a.service === service && a.published === published && a.protocol === protocol)
}
function setApproval(service: string, published: number, protocol: 'tcp' | 'udp', patch: Partial<PortApproval>) {
  const cur = approval(service, published, protocol) ?? { service, published, protocol, justification: '', confirmed: false }
  approvals.value = [...approvals.value.filter(a => a !== approval(service, published, protocol)), { ...cur, ...patch }]
}

// Ports web publiés directement sur l'hôte : à placer derrière le reverse proxy (port retiré du Compose déployé).
const portKey = (p: PortReport) => `${p.service}:${p.published}/${p.protocol}`
const webPorts = computed(() => props.analysis.ports.filter(p => p.published !== null && !p.unpublished).map(p => ({ p, hint: webHint(p, props.analysis.images[p.service]) })).filter(x => x.hint))
const exposuresOf = (service: string) => props.analysis.exposures.filter(e => e.service === service)
const hosts = reactive<Record<string, string>>({})
watchEffect(() => {
  for (const { p } of webPorts.value) hosts[portKey(p)] ??= suggestWebHost(p.service, props.analysis.stackName, props.proxy?.allowedDomains ?? [])
})
function unpublish(p: PortReport, withExposure: boolean) {
  emit('unpublish-port', { service: p.service, published: p.published!, protocol: p.protocol, unpublished: true, ...(withExposure ? { exposure: { host: hosts[portKey(p)]!.trim().toLowerCase(), port: containerPortOf(p) } } : {}) })
}
const republish = (p: PortReport) => emit('unpublish-port', { service: p.service, published: p.published!, protocol: p.protocol, unpublished: false })

const POLICY = { allowed: { label: 'Autorisé', tone: 'success' }, approval: { label: 'Validation', tone: 'warning' }, forbidden: { label: 'Interdit', tone: 'danger' }, internal: { label: 'Interne', tone: 'neutral' } } as const
const NET = { allowed: { label: 'Autorisé', tone: 'success' }, created: { label: 'Créé par la stack', tone: 'info' }, refused: { label: 'Refusé', tone: 'danger' } } as const
</script>

<template>
  <div class="report">
    <div class="verdict" :class="analysis.ok ? 'ok' : 'ko'">
      <strong>{{ analysis.ok ? 'Compose conforme' : `${errors.length} point(s) bloquant(s)` }}</strong>
      <span class="muted">Stack <code>{{ analysis.stackName }}</code> · {{ analysis.services.length }} service(s) · {{ analysis.builds.length }} build(s) sur le serveur cible</span>
    </div>

    <UiTabs v-model="tab" :tabs="tabs" />

    <div v-if="tab === 'summary'" class="stack">
      <section v-if="errors.length" class="issues">
        <h3>À corriger</h3>
        <ul><li v-for="(i, k) in errors" :key="k" class="err"><span v-if="i.service" class="svc">{{ i.service }}</span>{{ i.message }}</li></ul>
      </section>

      <section v-if="proxy !== undefined && webPorts.length" class="web-ports">
        <h3>Services web publiés directement sur l'hôte</h3>
        <p class="muted small">Ces ports ouvrent le service sur l'hôte en plus (ou à la place) du reverse proxy. Pour n'y accéder que par son domaine, retirer le port publié : il n'est plus ouvert sur l'hôte à ce déploiement ni aux suivants.</p>
        <p v-if="!proxy" class="small warn">Aucun reverse proxy configuré pour cet endpoint (fiche du serveur › Traefik) : le port ne peut pas encore être remplacé par une exposition web.</p>
        <div v-for="{ p, hint } in webPorts" :key="portKey(p)" class="web-port card">
          <span class="small"><strong>{{ p.service }}</strong> · port <code>{{ p.hostIp ? `${p.hostIp}:` : '' }}{{ p.published }}/{{ p.protocol }}</code> → {{ containerPortOf(p) }} du conteneur<span v-if="hint?.startsWith('image')" class="muted"> ({{ hint }})</span></span>
          <template v-if="exposuresOf(p.service).length">
            <span class="muted small">exposé : <a v-for="e in exposuresOf(p.service)" :key="e.url" :href="e.url" target="_blank" rel="noopener" class="url">{{ e.url }}</a></span>
            <UiButton size="sm" :loading="busyPort === portKey(p)" :aria-label="`Reverse proxy uniquement pour ${p.service} port ${p.published}`" @click="unpublish(p, false)">Reverse proxy uniquement</UiButton>
          </template>
          <template v-else-if="proxy">
            <input v-model="hosts[portKey(p)]" class="input mono host" :aria-label="`Domaine de ${p.service}`" spellcheck="false">
            <UiButton size="sm" variant="primary" :loading="busyPort === portKey(p)" :disabled="!hosts[portKey(p)]?.trim()" :aria-label="`Exposer ${p.service} et ne plus publier le port ${p.published}`" @click="unpublish(p, true)">Exposer et ne plus publier</UiButton>
          </template>
        </div>
      </section>

      <section v-if="pendingPorts.length" class="approvals">
        <h3>Ports soumis à validation</h3>
        <p class="muted small">Ces ports ne sont couverts par aucune règle autorisée de l'endpoint : justifier et confirmer explicitement chaque exposition.</p>
        <div v-for="p in pendingPorts" :key="`${p.service}:${p.published}:${p.protocol}`" class="approval card">
          <div class="approval-head">
            <span><strong>{{ p.service }}</strong> · port <code>{{ p.hostIp ?? '0.0.0.0' }}:{{ p.published }}/{{ p.protocol }}</code> <UiBadge :tone="p.accepted ? 'success' : 'warning'">{{ p.accepted ? 'validé' : 'à valider' }}</UiBadge></span>
            <UiButton v-if="!p.accepted" size="sm" variant="ghost" @click="emit('exclude-service', { service: p.service, excluded: true })">Ne pas gérer {{ p.service }}</UiButton>
          </div>
          <UiField :label="`Justification (${p.service}:${p.published})`" :for="`j-${p.service}-${p.published}`">
            <input :id="`j-${p.service}-${p.published}`" class="input" maxlength="500" placeholder="Pourquoi ce port doit-il être exposé ?" :value="approval(p.service, p.published!, p.protocol)?.justification ?? ''" @input="setApproval(p.service, p.published!, p.protocol, { justification: ($event.target as HTMLInputElement).value })">
          </UiField>
          <label class="check"><input type="checkbox" :checked="approval(p.service, p.published!, p.protocol)?.confirmed ?? false" @change="setApproval(p.service, p.published!, p.protocol, { confirmed: ($event.target as HTMLInputElement).checked })"> Je confirme l'exposition de ce port</label>
        </div>
      </section>

      <section class="excluded">
        <h3>Services gérés par la console</h3>
        <p class="muted small">Un service peut rester hors de la console (ex. le Traefik d'une stack reprise) : retiré de la stack déployée, son conteneur est détaché de la stack au déploiement et continue de tourner tel quel, sans être arrêté ni mis à jour par la console.</p>
        <ul v-if="excludedServices.length" class="plain">
          <li v-for="svc in excludedServices" :key="svc">
            <strong>{{ svc }}</strong> <UiBadge tone="neutral">non géré</UiBadge>
            <UiButton size="sm" variant="ghost" @click="emit('exclude-service', { service: svc, excluded: false })">Réintégrer</UiButton>
          </li>
        </ul>
        <ul v-if="suspendedServices.length" class="plain">
          <li v-for="svc in suspendedServices" :key="svc">
            <strong>{{ svc }}</strong> <UiBadge tone="warning">suspendu</UiBadge>
            <UiButton size="sm" variant="ghost" @click="emit('suspend-service', { service: svc, suspended: false })">Reprendre dans ce déploiement</UiButton>
          </li>
        </ul>
        <div v-if="analysis.services.length > 1" class="exclude-row">
          <label class="sr-only" for="exclude-svc">Service à ne pas gérer</label>
          <select id="exclude-svc" v-model="toExclude" class="input">
            <option value="">Choisir un service à ne pas gérer…</option>
            <option v-for="svc in analysis.services" :key="svc" :value="svc">{{ svc }}</option>
          </select>
          <UiButton size="sm" :disabled="!toExclude" @click="emit('exclude-service', { service: toExclude, excluded: true }); toExclude = ''">Ne pas gérer ce service</UiButton>
        </div>
      </section>

      <section v-if="warnings.length" class="issues">
        <h3>Alertes</h3>
        <ul>
          <li v-for="(i, k) in warnings" :key="k" class="warn">
            <span v-if="i.service" class="svc">{{ i.service }}</span>{{ i.message }}
            <span v-if="i.alternatives?.length && i.service && i.image" class="sources">
              <UiButton v-for="alt in i.alternatives" :key="alt" size="sm" :loading="busySource === `${i.service}:${alt}`" :disabled="busySource !== null" @click="emit('use-image', { service: i.service!, from: i.image!, image: alt })">
                Utiliser {{ alt }}
              </UiButton>
            </span>
          </li>
        </ul>
      </section>

      <section v-if="analysis.exposures?.length">
        <h3>Exposition web (Traefik)</h3>
        <ul class="plain">
          <li v-for="e in analysis.exposures" :key="e.router" :class="{ refused: !e.accepted }">
            <code>{{ e.url }}</code> → <strong>{{ e.service }}</strong>:{{ e.port }}
            <UiBadge :tone="e.accepted ? 'success' : 'danger'">{{ e.accepted ? 'valide' : 'refusé' }}</UiBadge>
            <div class="muted small">{{ e.reason }} · routeur <code>{{ e.router }}</code></div>
          </li>
        </ul>
      </section>

      <div class="grid">
        <section>
          <h3>Ports publiés</h3>
          <p v-if="!analysis.ports.length" class="muted small">Aucun port publié sur l'hôte.</p>
          <table v-else>
            <thead class="sr-only"><tr><th>Service</th><th>Port</th><th>Exposition</th></tr></thead>
            <tbody>
              <tr v-for="(p, k) in analysis.ports" :key="k">
                <td>{{ p.service }}</td>
                <td class="mono">{{ p.hostIp ? `${p.hostIp}:` : '' }}{{ p.published ?? '?' }}/{{ p.protocol }}</td>
                <td v-if="p.unpublished"><UiBadge tone="info" :title="p.reason">Non publié · reverse proxy</UiBadge> <UiButton v-if="proxy !== undefined" size="sm" variant="ghost" :loading="busyPort === portKey(p)" :aria-label="`Publier de nouveau ${p.service} port ${p.published}`" @click="republish(p)">Republier</UiButton></td>
                <td v-else><UiBadge :tone="POLICY[p.policy].tone">{{ POLICY[p.policy].label }}</UiBadge></td>
              </tr>
            </tbody>
          </table>
        </section>
        <section>
          <h3>Volumes</h3>
          <p v-if="!analysis.mounts.length" class="muted small">Aucun volume.</p>
          <ul v-else class="plain">
            <li v-for="(m, k) in analysis.mounts" :key="k" :class="{ refused: !m.accepted }">
              <strong>{{ m.service }}</strong> <code>{{ m.effectiveSource ?? '(anonyme)' }}</code> → <code>{{ m.target }}</code>{{ m.readOnly ? ' (lecture seule)' : '' }}
              <div class="muted small">{{ m.reason }}</div>
            </li>
          </ul>
        </section>
        <section>
          <h3>Réseaux</h3>
          <ul class="plain">
            <li v-for="n in analysis.networks" :key="n.name"><code>{{ n.name }}</code> <UiBadge :tone="NET[n.status].tone">{{ NET[n.status].label }}</UiBadge></li>
          </ul>
        </section>
        <section>
          <h3>Variables</h3>
          <p v-if="!analysis.variables.length" class="muted small">Aucune variable utilisée.</p>
          <ul v-else class="plain">
            <li v-for="v in analysis.variables" :key="v.name">
              <code>{{ v.name }}</code>
              <UiBadge v-if="v.secret" tone="info">secrète</UiBadge>
              <UiBadge v-else-if="!v.provided && !v.hasDefault" tone="danger">manquante</UiBadge>
              <UiBadge v-else-if="!v.provided" tone="neutral">défaut</UiBadge>
            </li>
          </ul>
        </section>
      </div>

      <section v-if="analysis.changes.length">
        <h3>Modifications apportées par la plateforme</h3>
        <ul class="changes"><li v-for="(c, k) in analysis.changes" :key="k"><span v-if="c.service" class="svc">{{ c.service }}</span>{{ c.message }}</li></ul>
      </section>

      <details v-if="infos.length">
        <summary class="muted">{{ infos.length }} information(s)</summary>
        <ul class="plain"><li v-for="(i, k) in infos" :key="k" class="small"><span v-if="i.service" class="svc">{{ i.service }}</span>{{ i.message }}</li></ul>
      </details>
    </div>

    <div v-else-if="tab === 'final'">
      <pre v-if="analysis.finalYaml" class="yaml mono">{{ analysis.finalYaml }}</pre>
      <p v-else class="muted">Le Compose final n'est généré qu'une fois tous les points bloquants corrigés.</p>
    </div>
    <div v-else>
      <DiffView v-if="analysis.diff" :diff="analysis.diff" />
      <p v-else class="muted">Diff indisponible tant que le Compose n'est pas conforme.</p>
    </div>
  </div>
</template>

<style scoped>
.web-ports { display: flex; flex-direction: column; gap: 6px; }
.web-ports p { margin: 0; }
.web-port { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); padding: var(--space-2) var(--space-3); box-shadow: none; }
.web-port .host { width: 280px; max-width: 100%; }
.web-port .url { margin-right: 6px; }
.report { display: flex; flex-direction: column; gap: var(--space-3); }
.verdict { display: flex; flex-direction: column; gap: 2px; padding: var(--space-3) var(--space-4); border-radius: var(--radius); }
.verdict.ok { background: var(--success-bg); color: var(--success); }
.verdict.ko { background: var(--danger-bg); color: var(--danger); }
.stack { display: flex; flex-direction: column; gap: var(--space-4); }
h3 { margin: 0 0 var(--space-2); font-size: 14px; }
.small { font-size: 12.5px; margin: 0; }
.approval-head { display: flex; justify-content: space-between; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.exclude-row { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.exclude-row select { max-width: 320px; }
.sources { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-top: 4px; }
.issues ul, .changes { margin: 0; padding-left: var(--space-5); display: flex; flex-direction: column; gap: 4px; }
.err { color: var(--danger); }
.warn { color: var(--warning); }
.svc { display: inline-block; font-family: var(--font-mono); font-size: 12px; background: var(--surface-2); color: var(--text); border-radius: var(--radius-sm); padding: 0 6px; margin-right: 6px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: var(--space-4); }
table { border-collapse: collapse; width: 100%; }
td { padding: 3px 6px 3px 0; }
.plain { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.plain code, td code { word-break: break-all; }
.refused { color: var(--danger); }
.approvals { display: flex; flex-direction: column; gap: var(--space-2); }
.approval { padding: var(--space-3) var(--space-4); display: flex; flex-direction: column; gap: var(--space-2); box-shadow: none; }
.check { display: flex; gap: var(--space-2); align-items: center; }
.yaml { margin: 0; padding: var(--space-3); background: var(--surface-2); border-radius: var(--radius); max-height: 520px; overflow: auto; font-size: 12.5px; }
</style>
