import { z } from 'zod'
import { scheduleInput } from './deploy-gate'
import { environmentKey, slug, tableQuery } from './common'
import { trimChars } from '../utils/trim'

export const projectCreateInput = z.object({
  slug,
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(1000).nullable().default(null),
})

const placement = {
  /** Chemin racine du projet sur l'hôte (releases/ et data/) ; null : racines par défaut. */
  projectPath: z.string().trim().min(2).max(1024).startsWith('/', 'Chemin absolu attendu').nullable(),
  /** Volumes nommés stockés en dossiers sous data/. */
  volumesAsFolders: z.boolean(),
  /** Réseau du reverse proxy ; null : celui de la configuration Traefik de l'endpoint. */
  proxyNetwork: z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/, 'Nom de réseau invalide').nullable(),
}

/** Réglage du healthcheck d'un service pour cette cible (secondes). Absent : valeur du Compose. */
export const healthcheckOverride = z.object({
  startPeriodSec: z.number().int().min(0).max(3600).optional(),
  intervalSec: z.number().int().min(1).max(600).optional(),
  timeoutSec: z.number().int().min(1).max(600).optional(),
  retries: z.number().int().min(1).max(100).optional(),
})
export type HealthcheckOverride = z.infer<typeof healthcheckOverride>

/** Ajustements du Compose propres à la cible, appliqués à chaque release. */
export const composeOverrides = z.object({
  healthchecks: z.record(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/, 'Nom de service invalide'), healthcheckOverride).refine(r => Object.keys(r).length <= 50, 'Trop de services').default({}),
  /**
   * Images mises à niveau par la plateforme (service → nouvelle image), appliquées si le
   * Compose déclare toujours l'image d'origine. Écrites seulement par la mise à niveau.
   */
  images: z.record(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/), z.object({ image: z.string().max(512), from: z.string().max(512), at: z.string(), by: z.string().nullable() })).default({}),
  /**
   * Données PostgreSQL migrées vers une nouvelle version majeure (service → PGDATA du nouveau
   * cluster, sous-dossier du même volume). Écrites seulement par la migration PostgreSQL.
   */
  pgData: z.record(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/), z.object({
    path: z.string().regex(/^\/[A-Za-z0-9._/-]{1,255}$/),
    major: z.number().int(),
    at: z.string(),
    by: z.string().nullable(),
    /** Ancien cluster, conservé jusqu'à sa suppression explicite après validation. */
    old: z.object({ pgdata: z.string(), mountSource: z.string(), mountPath: z.string(), removedAt: z.string().nullable().default(null) }).nullable().optional(),
    /** Sauvegarde de la migration sur l'hôte (supprimable avec l'ancien cluster). */
    backupDir: z.string().nullable().optional(),
  })).default({}),
  /**
   * Services non gérés par la console (ex. Traefik d'une stack reprise) : retirés du Compose
   * déployé ; leur conteneur, détaché de la stack au déploiement, continue de tourner tel quel.
   */
  excludedServices: z.record(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/), z.object({ at: z.string(), by: z.string().nullable() })).default({}),
  /** Services suspendus : gardés dans la source, retirés de la stack (ni démarrés ni contrôlés) jusqu'à leur reprise. */
  suspendedServices: z.record(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/), z.object({ at: z.string(), by: z.string().nullable() })).default({}),
  /** Ports publiés retirés du Compose déployé : service joint uniquement par le reverse proxy (exposition web). */
  unpublishedPorts: z.array(z.object({
    service: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/),
    published: z.number().int().min(1).max(65535),
    protocol: z.enum(['tcp', 'udp']),
    at: z.string(),
    by: z.string().nullable(),
  })).max(100).default([]),
})
export type ComposeOverrides = z.infer<typeof composeOverrides>

/**
 * Condition qui prouve qu'une action en attente est faite (jamais une simple déclaration) :
 * - variable : la variable a reçu une nouvelle valeur après la création de l'action ;
 * - variable-deployed : idem, puis un déploiement réussi a suivi ce changement ;
 * - deployed : un déploiement réussi a eu lieu après la création de l'action.
 * via : formulaire où la saisie se fait (lien direct) ; par défaut, l'onglet Variables.
 */
export const pendingCheck = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('variable'), name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/), via: z.enum(['variables', 'harbor-generator']).default('variables') }),
  z.object({ kind: z.literal('variable-deployed'), name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/), via: z.enum(['variables', 'harbor-generator']).default('variables') }),
  z.object({ kind: z.literal('deployed') }),
])
export type PendingCheck = z.infer<typeof pendingCheck>
/** État vérifié d'une action en attente : lien vers la saisie et ce qui manque encore. */
export interface PendingStatus { done: boolean, missing: string | null, link: string }
export interface PendingAction { title: string, detail: string | null, at: string, by: string | null, check: PendingCheck }

export const targetCreateInput = z.object({
  endpointId: z.uuid(),
  environmentKey,
  projectPath: placement.projectPath.default(null),
  volumesAsFolders: placement.volumesAsFolders.default(false),
  proxyNetwork: placement.proxyNetwork.default(null),
})

/** Création d'un projet, avec sa première cible dans la même transaction. */
export const projectWithTargetInput = projectCreateInput.extend({ target: targetCreateInput.optional() })

export const targetPatch = z.object({
  projectPath: placement.projectPath.optional(),
  volumesAsFolders: placement.volumesAsFolders.optional(),
  proxyNetwork: placement.proxyNetwork.optional(),
  autoRollback: z.boolean().optional(),
  healthTimeoutSec: z.number().int().min(10).max(1800).optional(),
  composeOverrides: composeOverrides.optional(),
  /** Action restant à faire (affichée « En attente ») ; null pour la retirer. */
  pendingAction: z.object({
    title: z.string().trim().min(3).max(200),
    detail: z.string().trim().max(1000).nullable().default(null),
    check: pendingCheck,
  }).nullable().optional(),
})

export const variablesInput = z.array(z.object({
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/, 'Nom de variable invalide'),
  value: z.string().max(16_384).nullable().optional(),
  secret: z.boolean().default(false),
  /** Services dont l'environnement reçoit la variable (« * » : tous). */
  inject: z.array(z.string().regex(/^(\*|[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62})$/, 'Service invalide')).max(50).optional(),
})).max(200).refine(v => new Set(v.map(x => x.name)).size === v.length, 'Variables en double')

export const portApprovalInput = z.object({
  service: z.string().max(100),
  published: z.number().int().min(1).max(65535),
  protocol: z.enum(['tcp', 'udp']),
  justification: z.string().trim().max(500),
  confirmed: z.boolean(),
})

export const deployInput = z.object({
  uploadId: z.uuid(),
  composePath: z.string().min(1).max(512),
  portApprovals: z.array(portApprovalInput).max(100).default([]),
  schedule: scheduleInput,
})

export const lifecycleInput = z.object({ action: z.enum(['stop', 'start', 'restart', 'delete', 'redeploy']), schedule: scheduleInput })

export const projectListQuery = tableQuery.extend({
  /** Projets ayant une cible dans cet environnement. */
  environmentId: z.uuid().optional(),
  /** Statut de la dernière opération. */
  lastStatus: z.string().regex(/^[A-Z_]+$/).max(30).optional(),
  /** Projets archivés : exclus par défaut, inclus (all) ou seuls (only). */
  archived: z.enum(['all', 'only']).optional(),
})

export const projectArchiveInput = z.object({ archived: z.boolean() })

export interface DeployOption {
  endpointId: string
  endpointName: string
  serverId: string
  serverName: string
  /** Racines configurées par environnement (proposition et contrôle du chemin du projet). */
  environments: { id: string, key: string, name: string, isProduction: boolean, pathsConfigured: boolean, roots: { workingRoot: string, runtimeRoot: string } | null }[]
  runner: { status: string, build: boolean | null }
  /** Réseaux utilisables par le reverse proxy (autorisés) ; `default` : celui de la configuration Traefik. */
  proxyNetworks: { name: string, role: string, managed: boolean, default: boolean }[]
  /** Traefik géré par la plateforme sur cet endpoint (appliqué). */
  managedProxy: { acme: boolean, resolver: string | null } | null
}

export interface TargetSummary {
  id: string
  environment: { id: string, key: string, name: string, isProduction: boolean }
  server: { id: string, name: string }
  endpoint: { id: string, name: string }
  stackName: string | null
  projectPath: string | null
  volumesAsFolders: boolean
  proxyNetwork: string | null
  /** Dossiers effectifs sur l'hôte (calculés). */
  layout: { projectDir: string, releasesDir: string, dataDir: string } | null
  autoRollback: boolean
  healthTimeoutSec: number
  composeOverrides: ComposeOverrides
  pendingAction: (PendingAction & { status: PendingStatus }) | null
  /** Stack reprise de l'existant. */
  adoption: { at: string, stack: string, exposures: number, variables: number } | null
  /** Ancienne stack laissée arrêtée sur le serveur d'origine après une migration (null : aucune, ou nettoyée). */
  migratedFrom: { serverName: string, endpointName: string, stackName: string, at: string, volumes: string[], dataDir: string | null } | null
  /** Reconstruction automatique à chaque nouvelle version. */
  autoRebuild: { enabled: boolean } | null
  currentRelease: { id: string, number: number, slug: string | null, activatedAt: string | null } | null
  lastDeployment: { id: string, action: string, status: string, createdAt: string, finishedAt: string | null } | null
  /** État réel (santé constatée des conteneurs, sinon dernière opération) et services en difficulté. */
  state: import('../utils/target-state').RuntimeState
  failing: string[]
  healthCheckedAt: string | null
}

export interface ProjectDto {
  id: string
  slug: string
  name: string
  description: string | null
  createdAt: string
  /** Archivé : masqué des listes et du tableau de bord, plus déployable. */
  archivedAt: string | null
  targets: TargetSummary[]
}

export interface ProjectListItem {
  id: string
  slug: string
  name: string
  targetCount: number
  lastStatus: string | null
  lastDeployedAt: string | null
  createdAt: string
  archivedAt: string | null
}

export interface DeploymentListItem {
  id: string
  action: string
  status: string
  releaseNumber: number | null
  requestedBy: string | null
  createdAt: string
  finishedAt: string | null
  error: string | null
}

export const sourceInput = z.object({
  kind: z.enum(['zip', 'github']),
  apiUrl: z.url({ protocol: /^https?$/ }).default('https://api.github.com'),
  repository: z.string().trim().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/, 'Format attendu : organisation/depot').nullable().default(null),
  refType: z.enum(['branch', 'tag', 'commit']).nullable().default(null),
  ref: z.string().trim().max(250).nullable().default(null),
  subdirectory: z.string().trim().max(512).nullable().default(null).transform(v => (v ? trimChars(v, '/') : '') || null),
  composePath: z.string().trim().min(1).max(512).default('compose.yml'),
  submodules: z.boolean().default(false),
  /** Absent : inchangé ; null : supprimé. */
  token: z.string().min(10).max(500).nullable().optional(),
}).superRefine((v, ctx) => {
  if (v.kind !== 'github') return
  if (!v.repository) ctx.addIssue({ code: 'custom', path: ['repository'], message: 'Dépôt requis' })
  if (!v.refType || !v.ref) ctx.addIssue({ code: 'custom', path: ['ref'], message: 'Branche, tag ou commit requis' })
})

export const exposureInput = z.object({
  service: z.string().min(1).max(100),
  host: z.string().trim().toLowerCase().min(3).max(253),
  port: z.number().int().min(1).max(65535),
  pathPrefix: z.string().trim().max(200).nullable().default(null).transform(v => v || null),
  middlewares: z.array(z.string().max(100)).max(10).default([]),
})
export const exposuresInput = z.array(exposureInput).max(20)

export const githubAnalyzeInput = z.object({
  refType: z.enum(['branch', 'tag', 'commit']).optional(),
  ref: z.string().trim().max(250).optional(),
  commitSha: z.string().regex(/^[0-9a-f]{40}$/).optional(),
  portApprovals: z.array(portApprovalInput).max(100).default([]),
  exposures: exposuresInput.optional(),
  schedule: scheduleInput,
})
