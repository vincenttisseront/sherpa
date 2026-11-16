/**
 * Préparation des fichiers d'une release sur le serveur cible (§6, §8 étapes 2 à 4) :
 * contrôle de l'espace disque, création de l'arborescence, dépôt de l'archive
 * dans tmp/, extraction dans releases/<id>/source, empreinte, metadata.json,
 * nettoyage du temporaire. Rejouable : une extraction déjà faite et intacte
 * (même empreinte) est réutilisée.
 */
import type { Readable } from 'node:stream'
import type { RunnerCallContext, TargetRunner } from '../adapters/runner'
import type { ExtractResult } from '../adapters/runner/types'
import { type ProjectLayout, assertInsideProject, isWithin, projectLayout, validateRelativeEntry } from '../utils/path-guard'
import type { LogLevel } from './logs'
import { formatBytes } from '../../shared/utils/format'

export interface PathConfigRow {
  workingRoot: string
  buildRoot: string
  tmpRoot: string
  runtimeRoot: string
  forbiddenPaths: string[]
  autoCreate: boolean
  dirMode: string
  ownerUid: number | null
  groupGid: number | null
  minFreeDiskMb: number
  maxProjectSizeMb: number
}

export interface PrepareInput {
  runner: TargetRunner
  ctx: RunnerCallContext
  log: (message: string, level?: LogLevel) => Promise<void>
  paths: PathConfigRow
  projectSlug: string
  /** Chemin racine choisi pour le projet (null : racines par défaut). */
  projectPath?: string | null
  releaseSlug: string
  archive: { sizeBytes: number, sha256: string, open: () => Promise<Readable> }
  /** Empreinte de l'arborescence d'une tentative précédente, pour la reprise. */
  previousTreeSha256?: string | null
  maxFiles: number
  extractTimeoutSec: number
  createdAt: Date
  environmentKey: string
  /** Dossier racine de l'archive à retirer (archives GitHub). */
  stripPrefix?: string | null
  /** Archives annexes extraites dans les sources (sous-modules), chemin relatif à la racine des sources. */
  extraArchives?: { path: string, sizeBytes: number, sha256: string, stripPrefix?: string | null, open: () => Promise<Readable> }[]
}

export interface PrepareResult {
  layout: ProjectLayout
  releaseDir: string
  sourceDir: string
  treeSha256: string
  files: number
  extract: ExtractResult | null
  reused: boolean
}

const MB = 1024 * 1024
const fmt = formatBytes

/**
 * Racines (créées seulement si la configuration l'autorise) et arborescence du projet et de la
 * release : préparées avant l'extraction, ou avant d'y copier une release (migration).
 */
export async function ensureProjectDirs(i: Pick<PrepareInput, 'runner' | 'ctx' | 'log' | 'paths' | 'projectSlug' | 'projectPath' | 'releaseSlug'>): Promise<void> {
  const { runner, ctx, log, paths } = i
  const layout = projectLayout(paths, i.projectSlug, i.projectPath)
  const rel = layout.release(i.releaseSlug)
  const dirOpts = { mode: paths.dirMode, ...(paths.ownerUid !== null ? { uid: paths.ownerUid } : {}), ...(paths.groupGid !== null ? { gid: paths.groupGid } : {}) }
  // Racines (créées seulement si la configuration l'autorise)
  for (const root of [paths.workingRoot, paths.tmpRoot, paths.buildRoot, paths.runtimeRoot]) {
    const info = await runner.checkDir(ctx, { path: root })
    if (info.exists && info.writable) continue
    if (!paths.autoCreate) throw new Error(`Répertoire ${root} ${info.exists ? 'non accessible en écriture' : 'absent'} et création automatique désactivée`)
    // Absent, ou présent mais fermé au compte (hôte SSH : repris avec les droits du moteur Docker).
    await runner.ensureDir(ctx, { path: root, ...dirOpts })
    await log(info.exists ? `Répertoire racine rendu accessible : ${root}` : `Répertoire racine créé : ${root}`)
  }

  // Arborescence du projet. Répertoires propres à la plateforme (releases, shared, tmp, build ; projet
  // et données s'ils sont sous les racines par défaut) : repris s'ils existent fermés au compte (hôte SSH).
  // Chemin de projet choisi (dossier existant de l'utilisateur) : jamais repris, seuls ses sous-dossiers.
  const own = !i.projectPath
  const dirs: [string, boolean][] = [[layout.projectDir, own], [layout.releasesDir, true], [layout.sharedDir, true], [layout.tmpDir, true], [layout.buildDir, true], [layout.runtimeDir, own], [rel.dir, true]]
  const report: string[] = []
  for (const [d, claim] of dirs) {
    const path = assertInsideProject(d, layout)
    const before = await runner.checkDir(ctx, { path })
    try {
      await runner.ensureDir(ctx, { path, ...dirOpts, ...(claim ? { claim: true } : {}) })
    }
    catch (err) {
      await log(`Répertoire ${path} : échec (${before.exists ? `présent${before.writable ? '' : ', fermé en écriture'}` : 'absent'}) — ${(err as Error).message}`, 'error')
      throw err
    }
    const after = before.exists && before.writable ? before : await runner.checkDir(ctx, { path })
    report.push(`${path} ${!before.exists ? 'créé' : !before.writable && after.writable ? 'repris' : after.writable ? 'présent' : 'présent (lecture seule)'}`)
  }
  await log(`Arborescence prête : ${report.join(' · ')}`)

}

export async function prepareReleaseFiles(i: PrepareInput): Promise<PrepareResult> {
  const { runner, ctx, log, paths } = i
  const layout = projectLayout(paths, i.projectSlug, i.projectPath)
  const rel = layout.release(i.releaseSlug)

  // 1. Taille du projet
  if (i.archive.sizeBytes > paths.maxProjectSizeMb * MB) {
    throw new Error(`Archive de ${fmt(i.archive.sizeBytes)} : supérieure à la taille maximale d'un projet (${paths.maxProjectSizeMb} Mo)`)
  }

  // Configuration antérieure à la validation : racine temporaire ou de build confondue avec les releases.
  for (const f of ['tmpRoot', 'buildRoot'] as const) {
    if (isWithin(paths[f], paths.workingRoot) || isWithin(paths.workingRoot, paths[f])) {
      await log(`Répertoire ${f === 'tmpRoot' ? 'temporaire' : 'de build'} (${paths[f]}) confondu avec le répertoire de travail (${paths.workingRoot}) : le corriger dans l'onglet Chemins (ex. ${paths.workingRoot}_${f === 'tmpRoot' ? 'tmp' : 'build'}) ; la purge quotidienne des fichiers temporaires est suspendue en attendant`, 'warn')
    }
  }

  await ensureProjectDirs(i)

  // 3. Espace disque : minimum configuré + archive + décompression estimée
  const disk = await runner.diskUsage(ctx, { path: paths.workingRoot })
  const needed = paths.minFreeDiskMb * MB + i.archive.sizeBytes * 3
  await log(`Espace disque libre : ${fmt(disk.freeBytes)} (requis : ${fmt(needed)})`)
  if (disk.freeBytes < needed) throw new Error(`Espace disque insuffisant sur ${paths.workingRoot} : ${fmt(disk.freeBytes)} libres, ${fmt(needed)} requis (marge de ${fmt(paths.minFreeDiskMb * MB)} réglable dans l'onglet Chemins du serveur, « Espace disque minimum », + 3 × l'archive de ${fmt(i.archive.sizeBytes)})`)

  // 5. Reprise : extraction précédente intacte ?
  if ((await runner.pathExists(ctx, { path: rel.sourceDir })).exists) {
    const h = await runner.hashTree(ctx, { path: rel.sourceDir })
    if (i.previousTreeSha256 && h.sha256 === i.previousTreeSha256) {
      await log(`Sources déjà extraites et intactes (${h.files} fichiers) : réutilisation`)
      return { layout, releaseDir: rel.dir, sourceDir: rel.sourceDir, treeSha256: h.sha256, files: h.files, extract: null, reused: true }
    }
    await log('Extraction précédente incomplète ou modifiée : suppression et nouvelle extraction', 'warn')
    await runner.cleanup(ctx, { path: assertInsideProject(rel.sourceDir, layout) })
  }

  // 6. Dépôt de l'archive dans le répertoire temporaire du projet
  const archivePath = assertInsideProject(`${layout.tmpDir}/${i.releaseSlug}.zip`, layout)
  if ((await runner.pathExists(ctx, { path: archivePath })).exists) await runner.cleanup(ctx, { path: archivePath })
  try {
    const t0 = Date.now()
    await log(`Transfert de l'archive (${fmt(i.archive.sizeBytes)}, sha256 ${i.archive.sha256.slice(0, 12)}…)`)
    await runner.uploadFile(ctx, { path: archivePath, sizeBytes: i.archive.sizeBytes, sha256: i.archive.sha256 }, await i.archive.open())
    await log(`Archive transférée et vérifiée en ${Date.now() - t0} ms`)

    // 7. Extraction contrôlée
    const t1 = Date.now()
    const x = await runner.extractArchive(ctx, {
      archivePath,
      destination: rel.sourceDir,
      format: 'zip',
      maxFiles: i.maxFiles,
      maxTotalBytes: paths.maxProjectSizeMb * MB,
      timeoutSec: i.extractTimeoutSec,
      allowSymlinks: false,
      ...(i.stripPrefix ? { stripPrefix: i.stripPrefix } : {}),
    })
    await log(`Extraction : ${x.files} fichiers, ${x.directories} répertoires, ${fmt(x.totalBytes)} en ${Date.now() - t1} ms`)
    if (x.composeFiles.length) await log(`Compose détecté : ${x.composeFiles.join(', ')}`)
    else await log('Aucun fichier Compose détecté à la racine des sources', 'warn')
    if (x.dockerfiles.length) await log(`Dockerfile détecté : ${x.dockerfiles.join(', ')}`)

    // 7 bis. Sous-modules, chacun dans son répertoire des sources.
    for (const [n, extra] of (i.extraArchives ?? []).entries()) {
      const sub = validateRelativeEntry(extra.path)
      const extraPath = assertInsideProject(`${layout.tmpDir}/${i.releaseSlug}-sub-${n + 1}.zip`, layout)
      try {
        await runner.uploadFile(ctx, { path: extraPath, sizeBytes: extra.sizeBytes, sha256: extra.sha256 }, await extra.open())
        const sx = await runner.extractArchive(ctx, {
          archivePath: extraPath,
          destination: assertInsideProject(`${rel.sourceDir}/${sub}`, layout),
          format: 'zip',
          maxFiles: i.maxFiles,
          maxTotalBytes: paths.maxProjectSizeMb * MB,
          timeoutSec: i.extractTimeoutSec,
          allowSymlinks: false,
          ...(extra.stripPrefix ? { stripPrefix: extra.stripPrefix } : {}),
        })
        await log(`Sous-module ${sub} : ${sx.files} fichiers extraits`)
      }
      finally {
        await runner.cleanup(ctx, { path: extraPath }).catch(() => {})
      }
    }

    // 8. Empreinte et métadonnées
    const h = await runner.hashTree(ctx, { path: rel.sourceDir })
    await runner.writeFile(ctx, {
      path: rel.metadataFile,
      mode: '0640',
      content: `${JSON.stringify({
        release: i.releaseSlug,
        project: i.projectSlug,
        environment: i.environmentKey,
        createdAt: i.createdAt.toISOString(),
        archiveSha256: i.archive.sha256,
        sourceTreeSha256: h.sha256,
        files: h.files,
        composeFiles: x.composeFiles,
        dockerfiles: x.dockerfiles,
      }, null, 2)}\n`,
    })
    await log(`Empreinte des sources : ${h.sha256}`)
    return { layout, releaseDir: rel.dir, sourceDir: rel.sourceDir, treeSha256: h.sha256, files: h.files, extract: x, reused: false }
  }
  finally {
    // 9. Nettoyage du temporaire, y compris en cas d'échec.
    await runner.cleanup(ctx, { path: archivePath }).then(
      r => (r.removedBytes ? log(`Fichier temporaire supprimé (${fmt(r.removedBytes)})`) : undefined),
      err => log(`Nettoyage du fichier temporaire impossible : ${err instanceof Error ? err.message : err}`, 'warn'),
    )
  }
}

/** Supprime les répertoires de releases obsolètes (rétention), jamais hors du projet. */
export async function removeReleaseDirs(runner: TargetRunner, ctx: RunnerCallContext, layout: ProjectLayout, releaseSlugs: string[]): Promise<number> {
  let bytes = 0
  for (const slug of releaseSlugs) {
    const dir = assertInsideProject(layout.release(slug).dir, layout)
    bytes += (await runner.cleanup(ctx, { path: dir })).removedBytes
  }
  return bytes
}
