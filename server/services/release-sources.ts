/**
 * Lectures sur une release enregistrée : fichiers de ses sources (relevés au dépôt de l'archive,
 * sans la rouvrir) et noms publics de son Compose (services, images).
 */
import { eq } from 'drizzle-orm'
import YAML from 'yaml'
import { db, schema } from '../db/client'

/** Fichiers des sources (chemins relatifs à la racine extraite) pour la revalidation. */
export async function releaseSourceFiles(release: { uploadId: string | null, metadata: unknown }): Promise<Set<string>> {
  const entriesOf = async (uploadId: string | null | undefined) => {
    if (!uploadId) return [] as string[]
    const [u] = await db().select({ report: schema.uploads.report }).from(schema.uploads).where(eq(schema.uploads.id, uploadId))
    return ((u?.report as { entries?: string[] } | undefined)?.entries) ?? []
  }
  const gh = (release.metadata as { github?: { stripPrefix?: string | null, submoduleUploads?: { path: string, uploadId: string, stripPrefix: string | null }[] } }).github
  const strip = (list: string[], prefix: string | null | undefined) => (prefix ? list.filter(f => f.startsWith(`${prefix}/`)).map(f => f.slice(prefix.length + 1)) : list)
  const files = new Set(strip(await entriesOf(release.uploadId), gh?.stripPrefix))
  for (const sm of gh?.submoduleUploads ?? []) for (const f of strip(await entriesOf(sm.uploadId), sm.stripPrefix)) files.add(`${sm.path}/${f}`)
  return files
}

/** Noms de services et images (dépôt et référence complète) d'un Compose source. */
export function composeNames(text: string): string[] {
  try {
    const doc = YAML.parse(text) as { services?: Record<string, { image?: unknown }> } | null
    return Object.entries(doc?.services ?? {}).flatMap(([name, svc]) => {
      const image = typeof svc?.image === 'string' ? svc.image : null
      if (!image) return [name]
      const bare = image.split(/[:@]/, 1)[0]!
      return [name, image, bare, bare.split('/').pop()!]
    })
  }
  catch {
    return []
  }
}
