/**
 * Registre des fonctions d'assistance par Ollama servies par l'unique route
 * `POST /api/ollama/assist/:feature`. Chaque entrée déclare : la permission requise, le schéma strict
 * du corps, la résolution de la ressource (et donc de sa portée de droits), puis l'exécution.
 *
 * Une seule route plutôt qu'une par fonction : les droits, l'audit et le suivi d'avancement sont
 * appliqués au même endroit, et le typage des routes Nitro (`$fetch` typé) ne grossit pas à chaque
 * nouvelle fonction — il atteignait la limite de profondeur de types de TypeScript.
 */
import { z } from 'zod'
import { createError } from 'h3'
import { type AiReportDto, analysisExplainInput, type OllamaFeature, logAnalysisFocus } from '../../shared/schemas/ollama'
import { METRIC_RANGES } from '../../shared/schemas/metrics'
import { remediationSubject } from '../../shared/schemas/remediation'
import type { Permission, PermissionScope } from '../../shared/utils/permissions'
import { portainer } from '../adapters/portainer'
import { schema } from '../db/client'
import { type AuthUser, canOn } from '../utils/auth'
import type { Progress } from '../utils/progress'
import { analyzeContainerMetrics, diagnoseDeploymentFailure, explainAnalysisBlockers, explainProxies, loadVulnerabilityScan, summarizeTechSupport, triageVulnerabilities } from './ai-assist'
import { explainReleaseNotes } from './ai-release-notes'
import { deploymentScope } from './deployments'
import { liveEndpoints } from './live'
import { analyzeLogsWithOllama, deploymentLogLines, deploymentSource } from './log-analysis'
import { getTargetOr404, targetScope } from './projects'
import { connectionFor } from './servers'

/** Ressource résolue : portée de droits, identité pour l'audit, exécution. */
export interface ResolvedAssist {
  scope: PermissionScope
  audit: { targetType: string, targetId: string, serverId?: string | null, environmentId?: string | null, projectId?: string | null }
  run: (progress: Progress) => Promise<AiReportDto>
}

export interface AssistSpec {
  permission: Permission
  input: z.ZodType<{ focus?: string }>
  resolve: (input: never, user: AuthUser) => Promise<ResolvedAssist>
}

/** Associe le type du corps validé à `resolve` sans exposer de `any` au registre. */
function define<S extends z.ZodType<{ focus?: string }>>(spec: { permission: Permission, input: S, resolve: (input: z.infer<S>, user: AuthUser) => Promise<ResolvedAssist> }): AssistSpec {
  return spec as unknown as AssistSpec
}

const containerId = z.string().regex(/^[a-f0-9]{12,64}$/)
const rangeKeys = Object.keys(METRIC_RANGES) as [keyof typeof METRIC_RANGES, ...(keyof typeof METRIC_RANGES)[]]

/** Endpoint visible de l'utilisateur, sinon 404 (comme pour les lectures de la vue en direct). */
async function endpointOf(user: AuthUser, endpointId: string) {
  const [row] = await liveEndpoints(user, endpointId)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Endpoint introuvable' })
  return row
}

const logsInput = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('deployment'),
    deploymentId: z.uuid(),
    levels: z.array(z.enum(schema.logLevel.enumValues)).max(4).optional(),
    phases: z.array(z.enum(schema.logPhase.enumValues)).max(10).optional(),
    service: z.string().max(200).optional(),
    limit: z.number().int().min(20).max(2000).default(1000),
    focus: logAnalysisFocus,
  }),
  z.object({ source: z.literal('container'), endpointId: z.uuid(), containerId, tail: z.number().int().min(10).max(2000).default(300), focus: logAnalysisFocus }),
])

const vulnerabilitiesInput = z.object({
  subject: remediationSubject,
  minSeverity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']).default('HIGH'),
  fixableOnly: z.boolean().default(false),
  lang: z.enum(['fr', 'en']).default('fr'),
  includeContext: z.boolean().default(false),
  focus: logAnalysisFocus,
})

const ASSISTS: Partial<Record<OllamaFeature, AssistSpec>> = {
  logs: define({
    permission: 'logs:read',
    input: logsInput,
    resolve: async (input, user) => {
      if (input.source === 'deployment') {
        const { source: _source, deploymentId, focus, ...filter } = input
        const scope = await deploymentScope(deploymentId)
        return {
          scope,
          audit: { targetType: 'deployment', targetId: deploymentId, ...scope },
          run: async (progress) => {
            await progress.step('Lecture des logs du déploiement', 1, 2)
            const lines = await deploymentLogLines(deploymentId, filter)
            await progress.step('Analyse par le modèle Ollama (peut prendre une minute)', 2, 2)
            return analyzeLogsWithOllama({ lines, source: await deploymentSource(scope), focus })
          },
        }
      }
      const row = await endpointOf(user, input.endpointId)
      const { containerId: cid, tail, focus } = input
      return {
        scope: { serverId: row.server.id },
        audit: { targetType: 'container', targetId: cid, serverId: row.server.id },
        run: async (progress) => {
          await progress.step('Lecture des logs du conteneur', 1, 2)
          const lines = await portainer().containerLogs(await connectionFor(row.server), row.ep.portainerEndpointId, cid, tail)
          await progress.step('Analyse par le modèle Ollama (peut prendre une minute)', 2, 2)
          return analyzeLogsWithOllama({ lines, source: `Conteneur ${cid.slice(0, 12)} (hôte ${row.server.name})`, focus })
        },
      }
    },
  }),
  'deploy-failure': define({
    permission: 'logs:read',
    input: z.object({ deploymentId: z.uuid(), focus: logAnalysisFocus }),
    resolve: async ({ deploymentId, focus }) => {
      const scope = await deploymentScope(deploymentId)
      return { scope, audit: { targetType: 'deployment', targetId: deploymentId, ...scope }, run: progress => diagnoseDeploymentFailure(deploymentId, { focus, progress }) }
    },
  }),
  support: define({
    permission: 'project:read',
    input: z.object({ targetId: z.uuid(), focus: logAnalysisFocus }),
    resolve: async ({ targetId, focus }, user) => {
      const t = await getTargetOr404(targetId)
      const scope = targetScope(t)
      return {
        scope,
        audit: { targetType: 'project_target', targetId, ...scope },
        // Les journaux ne sont joints que si l'utilisateur peut les lire.
        run: progress => summarizeTechSupport(t, { logs: canOn(user, 'logs:read', scope), by: user.email, focus, progress }),
      }
    },
  }),
  metrics: define({
    permission: 'server:read',
    input: z.object({ endpointId: z.uuid(), containerId, range: z.enum(rangeKeys).default('1h'), focus: logAnalysisFocus }),
    resolve: async ({ endpointId, containerId: cid, range, focus }, user) => {
      const row = await endpointOf(user, endpointId)
      return { scope: { serverId: row.server.id }, audit: { targetType: 'container', targetId: cid, serverId: row.server.id }, run: progress => analyzeContainerMetrics(row, cid, range, { focus, progress }) }
    },
  }),
  proxy: define({
    permission: 'server:read',
    input: z.object({ endpointId: z.uuid(), focus: logAnalysisFocus }),
    resolve: async ({ endpointId, focus }, user) => {
      const row = await endpointOf(user, endpointId)
      return { scope: { serverId: row.server.id }, audit: { targetType: 'endpoint', targetId: endpointId, serverId: row.server.id }, run: progress => explainProxies(row, { focus, progress }) }
    },
  }),
  vulnerabilities: define({
    permission: 'server:read',
    input: vulnerabilitiesInput,
    resolve: async ({ subject, focus, ...opts }, user) => {
      const scan = await loadVulnerabilityScan(subject)
      // Même règle que la lecture d'une analyse : l'endpoint doit être visible de l'utilisateur.
      const row = await endpointOf(user, scan.endpointId)
      return {
        scope: { serverId: row.server.id },
        audit: { targetType: `${scan.type}_scan`, targetId: scan.id, serverId: row.server.id },
        run: progress => triageVulnerabilities(scan, { ...opts, focus, progress }),
      }
    },
  }),
  'release-notes': define({
    permission: 'project:read',
    input: z.object({
      targetId: z.uuid(),
      service: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/),
      tag: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/),
      focus: logAnalysisFocus,
    }),
    resolve: async ({ targetId, service, tag, focus }) => {
      const t = await getTargetOr404(targetId)
      const scope = targetScope(t)
      return { scope, audit: { targetType: 'project_target', targetId, ...scope }, run: progress => explainReleaseNotes(t, { service, tag, focus }, progress) }
    },
  }),
  'analysis-blockers': define({
    permission: 'deployment:execute',
    input: analysisExplainInput.extend({ targetId: z.uuid() }),
    resolve: async ({ targetId, ...analysis }) => {
      const t = await getTargetOr404(targetId)
      const scope = targetScope(t)
      return { scope, audit: { targetType: 'project_target', targetId, ...scope }, run: progress => explainAnalysisBlockers(analysis, { stack: t.target.stackName ?? undefined, progress }) }
    },
  }),
}

/** Fonctions servies par la route commune (les autres ont leur propre route). */
export function assistFor(feature: OllamaFeature): AssistSpec {
  const spec = ASSISTS[feature]
  if (!spec) throw createError({ statusCode: 404, statusMessage: 'Fonction inconnue' })
  return spec
}
