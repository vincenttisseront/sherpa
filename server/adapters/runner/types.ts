/**
 * Contrat du Target Runner (§4).
 *
 * Le Runner n'expose AUCUNE commande arbitraire : uniquement les actions
 * ci-dessous, chacune avec un schéma strict. Tout chemin reçu est revalidé
 * côté Runner (après realpath) contre les racines déclarées pour l'endpoint.
 *
 * Transport prévu (voir docs/spikes.md) : HTTPS + mTLS, requêtes signées
 * (HMAC, horodatage, nonce) pour l'anti-rejeu, audit local côté Runner.
 */
import { z } from 'zod'

const absPath = z.string().startsWith('/').max(1024)

export const runnerActions = {
  checkDir: z.object({ path: absPath }),
  ensureDir: z.object({ path: absPath, mode: z.string().regex(/^0[0-7]{3}$/), uid: z.number().int().optional(), gid: z.number().int().optional(), /** Répertoire propre à la plateforme : repris s'il existe fermé au compte (hôte SSH). Ignoré par le Runner HTTP. */ claim: z.boolean().optional() }),
  uploadFile: z.object({ path: absPath, sizeBytes: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  extractArchive: z.object({
    archivePath: absPath,
    destination: absPath,
    format: z.enum(['zip']),
    maxFiles: z.number().int().positive(),
    maxTotalBytes: z.number().int().positive(),
    timeoutSec: z.number().int().positive().max(600),
    allowSymlinks: z.literal(false),
    stripPrefix: z.string().regex(/^[A-Za-z0-9._-]{1,200}$/).optional(),
  }),
  hashTree: z.object({ path: absPath }),
  prepareBuildContext: z.object({ sourceDir: absPath, contextDir: absPath, subdirectory: z.string().max(512).optional(), maxContextBytes: z.number().int().positive() }),
  build: z.object({
    contextDir: absPath,
    dockerfile: z.string().min(1).max(512),
    imageTag: z.string().regex(/^platform\/[a-z0-9][a-z0-9._-]*:[A-Za-z0-9._-]{1,128}$/, 'Tag d\'image de la plateforme attendu (platform/…)'),
    buildArgs: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(4096)).refine(o => Object.keys(o).length <= 50, '50 arguments maximum'),
    labels: z.record(z.string().max(200), z.string().max(500)).default({}),
    target: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/).nullable().default(null),
    timeoutSec: z.number().int().positive().max(3600),
    cpuQuota: z.number().positive().optional(),
    memoryMb: z.number().int().positive().optional(),
    maxLogBytes: z.number().int().positive(),
    /** Build propre : images de base (FROM) récupérées à nouveau, sans cache des couches. */
    pull: z.boolean().default(false),
    noCache: z.boolean().default(false),
  }),
  diskUsage: z.object({ path: absPath }),
  writeFile: z.object({ path: absPath, content: z.string().max(1_000_000), mode: z.string().regex(/^0[0-7]{3}$/).default('0640') }),
  cleanup: z.object({ path: absPath, olderThanSec: z.number().int().min(0).optional() }),
  pathExists: z.object({ path: absPath }),
  removeImages: z.object({ tags: z.array(z.string()).min(1).max(50) }),
} as const

export type RunnerAction = keyof typeof runnerActions
export type RunnerInput<A extends RunnerAction> = z.infer<(typeof runnerActions)[A]>

export interface DirInfo { exists: boolean, writable: boolean, isDirectory: boolean }
export interface DiskInfo { totalBytes: number, freeBytes: number }
export interface ExtractResult { files: number, directories: number, totalBytes: number, composeFiles: string[], dockerfiles: string[], rootFolder: string | null }
export interface BuildResult { imageId: string, imageTag: string, durationMs: number, contextBytes: number }
export interface RemoveImagesResult { removed: string[], missing: string[], failed: { tag: string, reason: string }[] }

export interface RunnerHealth {
  version: string
  actions: RunnerAction[]
  /** Racines autorisées déclarées localement sur l'hôte : seule source de vérité côté Runner. */
  roots: string[]
  hostname: string
}

export interface RunnerLogLine { ts: string, stream: 'stdout' | 'stderr', line: string }

/** Contexte transmis à chaque appel, pour l'audit côté Runner. */
export interface RunnerCallContext {
  requestId: string
  actor: string
  deploymentId?: string
}

export interface TargetRunner {
  health(): Promise<RunnerHealth>
  checkDir(ctx: RunnerCallContext, input: RunnerInput<'checkDir'>): Promise<DirInfo>
  ensureDir(ctx: RunnerCallContext, input: RunnerInput<'ensureDir'>): Promise<void>
  uploadFile(ctx: RunnerCallContext, input: RunnerInput<'uploadFile'>, data: AsyncIterable<Uint8Array>): Promise<void>
  extractArchive(ctx: RunnerCallContext, input: RunnerInput<'extractArchive'>): Promise<ExtractResult>
  hashTree(ctx: RunnerCallContext, input: RunnerInput<'hashTree'>): Promise<{ sha256: string, files: number }>
  prepareBuildContext(ctx: RunnerCallContext, input: RunnerInput<'prepareBuildContext'>): Promise<{ sizeBytes: number }>
  /** Le build émet ses logs au fil de l'eau via onLog. */
  build(ctx: RunnerCallContext, input: RunnerInput<'build'>, onLog: (l: RunnerLogLine) => void): Promise<BuildResult>
  diskUsage(ctx: RunnerCallContext, input: RunnerInput<'diskUsage'>): Promise<DiskInfo>
  /** Fichier texte généré par la plateforme (metadata.json, compose.yml). */
  writeFile(ctx: RunnerCallContext, input: RunnerInput<'writeFile'>): Promise<{ sha256: string }>
  pathExists(ctx: RunnerCallContext, input: RunnerInput<'pathExists'>): Promise<{ exists: boolean }>
  removeImages(ctx: RunnerCallContext, input: RunnerInput<'removeImages'>): Promise<RemoveImagesResult>
  cleanup(ctx: RunnerCallContext, input: RunnerInput<'cleanup'>): Promise<{ removedBytes: number }>
}

/** Valide une entrée avant envoi : les schémas sont la liste blanche. */
export function validateRunnerInput<A extends RunnerAction>(action: A, input: unknown): RunnerInput<A> {
  return runnerActions[action].parse(input) as RunnerInput<A>
}
