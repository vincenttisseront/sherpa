/**
 * Import d'une archive depuis les releases GitHub (page /releases d'un dépôt) :
 * fichier attaché (.zip, .tar.gz, .tgz, .tar) ou code source du tag. Tous les
 * fichiers d'une release sont listés ; ceux qui ne peuvent pas être importés
 * (signatures, sommes de contrôle, binaires, archives trop volumineuses) le sont
 * avec la raison. L'archive
 * téléchargée suit ensuite le circuit des archives déposées (conversion en ZIP,
 * inspection, analyse, déploiement). Le jeton éventuel n'est utilisé que pour
 * l'appel, ou repris de la source GitHub du projet pour ce même dépôt.
 */
import { eq } from 'drizzle-orm'
import { createError } from 'h3'
import { db, schema } from '../db/client'
import { parseRepoUrl } from '../../shared/utils/github-url'
import { type GithubRelease, type GithubSource, GithubError, normalizeApiUrl } from '../lib/github'
import type { ArchiveFormat } from '../lib/tar'
import { env } from '../utils/env'
import { type Progress, noProgress } from '../utils/progress'
import { allowedGithubApis, getProjectSource, github, githubCredentials } from './sources'
import { type StoredUpload, storeUpload } from './uploads'

export interface ReleaseFile {
  /** Clé stable : « asset:<id> » ou « source:<format> ». */
  key: string
  kind: 'asset' | 'source'
  assetId: number | null
  name: string
  sizeBytes: number | null
  /** Format d'archive reconnu d'après le nom ; null pour les autres fichiers. */
  format: ArchiveFormat | null
  role: 'archive' | 'signature' | 'checksum' | 'other'
  importable: boolean
  /** Raison si le fichier ne peut pas être importé. */
  reason: string | null
}

export interface ReleaseView {
  tag: string
  name: string | null
  prerelease: boolean
  publishedAt: string | null
  htmlUrl: string
  /** Tous les fichiers de la release (attachés puis code source du tag), importables ou non. */
  files: ReleaseFile[]
}

export interface ReleasesResult {
  needsToken: boolean
  message: string | null
  apiUrl: string
  repository: string
  auth: 'token' | 'stored' | 'none'
  releases: ReleaseView[]
  /** Choix déduits de l'URL (tag, fichier). */
  selected: { tag: string | null, archiveKey: string | null }
}

export function archiveFormat(name: string): ArchiveFormat | null {
  if (/\.zip$/i.test(name)) return 'zip'
  if (/\.(tar\.gz|tgz)$/i.test(name)) return 'tar.gz'
  if (/\.tar$/i.test(name)) return 'tar'
  return null
}

const SIGNATURE_RE = /\.(asc|sig|sigstore\.json|pem|cert|crt|bundle)$/i
const CHECKSUM_RE = /(^|[._-])(md5|sha1|sha256|sha512)(sums?)?([._-]|$)|^checksums?(\.txt)?$|\.(md5|sha1|sha256|sha512)$/i

/** Nature d'un fichier de release d'après son nom. */
export function fileRole(name: string): ReleaseFile['role'] {
  if (SIGNATURE_RE.test(name)) return 'signature'
  if (CHECKSUM_RE.test(name)) return 'checksum'
  return archiveFormat(name) ? 'archive' : 'other'
}

const fmtMb = (n: number) => `${Math.round(n / 1024 / 1024)} Mo`

export function releaseView(r: GithubRelease, repository: string, maxBytes = env().UPLOAD_MAX_MB * 1024 * 1024): ReleaseView {
  const base = `${repository.split('/')[1]}-${r.tag.replace(/^v(?=\d)/, '')}`
  const assets: ReleaseFile[] = r.assets.map((a) => {
    const role = fileRole(a.name)
    const format = role === 'archive' ? archiveFormat(a.name) : null
    const reason = role === 'signature'
      ? 'Signature'
      : role === 'checksum'
        ? 'Sommes de contrôle'
        : !format
            ? 'Pas une archive (.zip, .tar.gz, .tgz, .tar)'
            : a.size > maxBytes ? `Au-delà de la limite d'import (${fmtMb(maxBytes)})` : null
    return { key: `asset:${a.id}`, kind: 'asset', assetId: a.id, name: a.name, sizeBytes: a.size, format, role, importable: !reason, reason }
  })
  // Fichiers importables d'abord, puis les autres archives, puis le reste (signatures, sommes de contrôle…).
  assets.sort((a, b) => Number(b.importable) - Number(a.importable) || (a.role === 'archive' ? 0 : 1) - (b.role === 'archive' ? 0 : 1) || a.name.localeCompare(b.name))
  return {
    tag: r.tag,
    name: r.name,
    prerelease: r.prerelease,
    publishedAt: r.publishedAt,
    htmlUrl: r.htmlUrl,
    files: [
      ...assets,
      { key: 'source:tar.gz', kind: 'source', assetId: null, name: `${base}.tar.gz`, sizeBytes: null, format: 'tar.gz', role: 'archive', importable: true, reason: null },
      { key: 'source:zip', kind: 'source', assetId: null, name: `${base}.zip`, sizeBytes: null, format: 'zip', role: 'archive', importable: true, reason: null },
    ],
  }
}

export async function sourceFor(projectId: string, apiUrlRaw: string, repository: string, token: string | null | undefined): Promise<{ src: GithubSource, auth: ReleasesResult['auth'] }> {
  const apiUrl = normalizeApiUrl(apiUrlRaw)
  if (!allowedGithubApis().includes(apiUrl)) throw createError({ statusCode: 422, statusMessage: `Instance GitHub non autorisée : ${apiUrl}`, data: { errors: { url: 'Instance GitHub non autorisée par l\'administrateur' } } })
  if (token) return { src: { apiUrl, repository, token }, auth: 'token' }
  // Jeton déjà enregistré pour ce même dépôt (source GitHub du projet).
  const s = await getProjectSource(projectId)
  if (s?.kind === 'github' && s.repository?.toLowerCase() === repository.toLowerCase() && s.tokenSecretId && normalizeApiUrl(s.apiUrl) === apiUrl) {
    const stored = (await githubCredentials(s)).token
    if (stored) return { src: { apiUrl, repository, token: stored }, auth: 'stored' }
  }
  return { src: { apiUrl, repository, token: null }, auth: 'none' }
}

const unprocessable = (err: unknown) => (err instanceof GithubError ? createError({ statusCode: 422, statusMessage: err.message }) : err)

export async function listReleaseArchives(projectId: string, input: { url: string, token?: string | null }): Promise<ReleasesResult> {
  const parsed = parseRepoUrl(input.url)
  if (!parsed) throw createError({ statusCode: 422, statusMessage: 'URL GitHub non reconnue', data: { errors: { url: 'Ex. https://github.com/organisation/depot/releases' } } })
  const { src, auth } = await sourceFor(projectId, parsed.apiUrl, parsed.repository, input.token)
  const gh = github()
  const base = { apiUrl: src.apiUrl, repository: parsed.repository, auth, releases: [], selected: { tag: null, archiveKey: null } }
  let list: GithubRelease[]
  try {
    list = await gh.releases(src, 20)
  }
  catch (err) {
    if (err instanceof GithubError && ['not_found', 'auth', 'sso', 'rate_limit'].includes(err.kind)) return { ...base, needsToken: !src.token || err.kind !== 'not_found', message: err.message }
    throw unprocessable(err)
  }
  // Tag désigné par l'URL mais absent des plus récentes : ajouté en tête.
  const wanted = parsed.release?.tag ?? null
  if (wanted && !list.some(r => r.tag === wanted)) {
    try {
      list.unshift(await gh.release(src, wanted))
    }
    catch (err) {
      throw err instanceof GithubError && err.kind === 'not_found' ? createError({ statusCode: 422, statusMessage: `Aucune release pour le tag « ${wanted} »` }) : unprocessable(err)
    }
  }
  const releases = list.map(r => releaseView(r, parsed.repository))
  if (!releases.length) return { ...base, needsToken: false, message: 'Aucune release publiée sur ce dépôt : utiliser la source « Dépôt GitHub » (branche ou tag) à la place.' }

  const tag = wanted ?? releases.find(r => !r.prerelease)?.tag ?? releases[0]!.tag
  const rel = releases.find(r => r.tag === tag)!
  const named = parsed.release?.asset ? rel.files.find(f => f.kind === 'asset' && f.name === parsed.release!.asset) : undefined
  let message: string | null = null
  if (parsed.release?.asset && !named) message = `« ${parsed.release.asset} » ne figure pas dans la release ${tag}`
  else if (named && !named.importable) message = `« ${named.name} » ne peut pas être importé : ${named.reason}`
  // Par défaut : le fichier désigné, sinon la première archive attachée importable, sinon le code source en tar.gz.
  const archiveKey = (named?.importable ? named.key : null) ?? rel.files.find(f => f.kind === 'asset' && f.importable)?.key ?? 'source:tar.gz'
  return { ...base, needsToken: false, message, releases, selected: { tag, archiveKey } }
}

export interface ReleaseImportInput {
  apiUrl: string
  repository: string
  tag: string
  archiveKey: string
  token?: string | null
}

export async function importReleaseArchive(projectId: string, input: ReleaseImportInput, userId: string | null, progress: Progress = noProgress): Promise<StoredUpload & { release: { repository: string, tag: string, archive: string, htmlUrl: string } }> {
  const { src } = await sourceFor(projectId, input.apiUrl, input.repository, input.token)
  const gh = github()
  await progress.step(`Release ${input.tag} de ${input.repository}`)
  let release: ReleaseView
  try {
    release = releaseView(await gh.release(src, input.tag), input.repository)
  }
  catch (err) {
    throw unprocessable(err)
  }
  // Le fichier doit appartenir à cette release : aucun identifiant arbitraire n'est téléchargé.
  const archive = release.files.find(a => a.key === input.archiveKey)
  if (!archive) throw createError({ statusCode: 422, statusMessage: 'Fichier introuvable dans cette release' })
  if (!archive.importable) throw createError({ statusCode: archive.sizeBytes && archive.format ? 413 : 422, statusMessage: `${archive.name} : ${archive.reason}` })

  await progress.step(`Téléchargement de ${archive.name} depuis GitHub`)
  let stream
  try {
    if (archive.kind === 'asset') stream = await gh.releaseAsset(src, archive.assetId!)
    else if (archive.format === 'tar.gz') stream = await gh.tarball(src, input.tag)
    else stream = await gh.zipball(src, (await gh.resolve(src, 'tag', input.tag)).sha)
  }
  catch (err) {
    throw unprocessable(err)
  }
  const stored = await storeUpload(stream, archive.name, userId, progress)
  // Provenance retenue sur l'archive puis sur la release : reconstruction possible sur une release suivante.
  const githubRelease = { apiUrl: src.apiUrl, repository: input.repository, tag: input.tag, archiveKey: archive.key, archiveName: archive.name }
  await db().update(schema.uploads).set({ report: { ...stored.report, githubRelease } }).where(eq(schema.uploads.id, stored.id))
  return { ...stored, report: { ...stored.report, githubRelease }, release: { repository: input.repository, tag: input.tag, archive: archive.name, htmlUrl: release.htmlUrl } }
}
