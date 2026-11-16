/**
 * Notes de version avant une mise à niveau d'image : le dépôt GitHub de l'image (label OCI
 * « org.opencontainers.image.source », sinon nom d'un package ghcr.io), les releases entre la version
 * en service et la version cible, puis leur résumé par Ollama. Les appels GitHub passent par le
 * client de `server/lib/github.ts` (API autorisées, jeton réservé à l'appel, jamais renvoyé).
 */
import { eq } from 'drizzle-orm'
import { createError } from 'h3'
import { STATEFUL_IMAGE } from '../../shared/utils/image-version'
import type { AiReportDto } from '../../shared/schemas/ollama'
import { portainer } from '../adapters/portainer'
import { db, schema } from '../db/client'
import { normalizeImage } from '../lib/compose/image-upgrade'
import { GithubError } from '../lib/github'
import { releaseNotesParts, releasesBetween, versionOfTag } from '../lib/release-notes'
import { repositoryFromUrl } from '../lib/remediation'
import { parseImageRef } from '../lib/registry'
import { noProgress, type Progress } from '../utils/progress'
import { runAiReport } from './ai-task'
import { currentRelease } from './image-upgrade'
import type { TargetRow } from './projects'
import { credentialsFor } from './remediation'
import { connectionFor } from './servers'
import { allowedGithubApis, github } from './sources'

interface RepoRef { apiUrl: string, repository: string, origin: 'label' | 'name' }

/** Dépôt GitHub d'une image de registre : label OCI de l'image sur l'hôte, sinon package ghcr.io. */
async function repositoryOfImage(t: TargetRow, image: string): Promise<RepoRef | null> {
  const [server] = await db().select().from(schema.portainerServers).where(eq(schema.portainerServers.id, t.server.id))
  if (server) {
    const label = await portainer().imageConfig(await connectionFor(server), t.endpoint.portainerEndpointId, image)
      .then(c => c?.labels['org.opencontainers.image.source'] ?? null).catch(() => null)
    if (label) {
      for (const apiUrl of allowedGithubApis()) {
        const repository = repositoryFromUrl(label, apiUrl)
        if (repository) return { apiUrl, repository, origin: 'label' }
      }
    }
  }
  const ghcr = /^ghcr\.io\/([^/]+)\/([^:@/]+)/i.exec(image)
  const api = allowedGithubApis()[0]
  return ghcr && api ? { apiUrl: api, repository: `${ghcr[1]}/${ghcr[2]}`, origin: 'name' } : null
}

/** Résumé des notes des releases entre la version en service du service et la version cible. */
export async function explainReleaseNotes(t: TargetRow, input: { service: string, tag: string, focus?: string }, progress: Progress = noProgress): Promise<AiReportDto> {
  await progress.step('Recherche du dépôt GitHub de l\'image', 1, 3)
  const rel = await currentRelease(t)
  const image = (rel.images as Record<string, string>)[input.service]
  if (!image) throw createError({ statusCode: 404, statusMessage: 'Service inconnu de la release active' })
  const ref = parseImageRef(image)
  if (!ref?.tag || !versionOfTag(ref.tag) || !versionOfTag(input.tag)) throw createError({ statusCode: 422, statusMessage: 'Les notes de version supposent un tag versionné avant et après (ex. 1.4.2)' })
  const repo = await repositoryOfImage(t, image)
  if (!repo) throw createError({ statusCode: 422, statusMessage: 'Dépôt GitHub de l\'image inconnu (aucun label « org.opencontainers.image.source », image hors ghcr.io) : les notes de version ne peuvent pas être lues' })

  await progress.step('Lecture des releases GitHub', 2, 3)
  const { token } = await credentialsFor(repo.apiUrl, repo.repository)
  const releases = await github().releaseNotes({ apiUrl: repo.apiUrl, repository: repo.repository, token }, 100).catch((err) => {
    if (err instanceof GithubError) throw createError({ statusCode: err.status === 404 ? 404 : 502, statusMessage: err.status === 404 ? `Dépôt ${repo.repository} introuvable ou sans accès (jeton requis ?)` : err.message })
    throw err
  })
  const between = releasesBetween(releases, ref.tag, input.tag)
  if (!between.length) throw createError({ statusCode: 422, statusMessage: `Aucune release GitHub de ${repo.repository} entre ${ref.tag} et ${input.tag} : pas de notes à lire (tags de release différents des tags d'image ?)` })

  await progress.step('Analyse par le modèle Ollama (peut prendre une minute)', 3, 3)
  const shortImage = normalizeImage(image).replace(/:[^/:]+$/, '')
  return runAiReport({
    feature: 'release-notes',
    header: [`Dépôt ${repo.repository}${repo.origin === 'name' ? ' (déduit du nom de l\'image)' : ''}`],
    parts: releaseNotesParts({ image: shortImage, service: input.service, from: ref.tag, to: input.tag, repository: repo.repository, stateful: STATEFUL_IMAGE.test(normalizeImage(image)), releases: between }),
    focus: input.focus,
  })
}
