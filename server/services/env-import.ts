/**
 * Import des env_file d'un Compose en variables de la cible : valeurs lues dans
 * les sources (archive ou commit GitHub), chiffrées, secrètes si leur nom
 * l'évoque. Les variables déjà définies sont conservées sauf demande contraire.
 */
import { randomBytes } from 'node:crypto'
import { createError } from 'h3'
import { envFileVarNames, looksSecret } from '../lib/compose/env-files'
import { readZipEntry } from '../lib/zip'
import { type EnvImportResult, MAX_ENV_FILE, collectEnvFiles } from './env-files'
import { MAX_COMPOSE_READ, type TargetRow, setTargetVariables, sourceFromUpload, targetVariables } from './projects'
import { getProjectSource, github, githubCredentials, githubErrorToHttp, repoComposePath } from './sources'
import { getUpload } from './uploads'

interface ImportOptions {
  overwrite: boolean
  /**
   * Nouvelles valeurs aléatoires pour les secrets non vides (les valeurs d'exemple d'un dépôt
   * sont publiques). Des secrets de même valeur d'origine reçoivent la même nouvelle valeur :
   * un mot de passe partagé entre deux services (ex. DB_PASSWORD / POSTGRES_PASSWORD) reste cohérent.
   */
  regenerateSecrets: boolean
}
export type EnvImportInput =
  | ({ source: 'upload', uploadId: string, composePath: string } & ImportOptions)
  | ({ source: 'github', refType: 'branch' | 'tag' | 'commit', ref: string } & ImportOptions)

export async function importEnvFiles(t: TargetRow, input: EnvImportInput): Promise<EnvImportResult> {
  let found
  if (input.source === 'upload') {
    const upload = await getUpload(input.uploadId)
    if (!upload) throw createError({ statusCode: 404, statusMessage: 'Archive introuvable' })
    const src = await sourceFromUpload(upload, input.composePath)
    found = await collectEnvFiles(src.composeText, src.composePath, src.files, p => readZipEntry(upload.storagePath, p, MAX_ENV_FILE))
  }
  else {
    const s = await getProjectSource(t.project.id)
    if (!s || s.kind !== 'github') throw createError({ statusCode: 422, statusMessage: 'Le projet n\'a pas de source GitHub' })
    try {
      const src = await githubCredentials(s)
      const gh = github()
      const commit = await gh.resolve(src, input.refType, input.ref)
      const tree = await gh.tree(src, commit.sha)
      const files = new Set(tree.entries.filter(e => e.type === 'blob').map(e => e.path))
      const composePath = repoComposePath(s)
      const composeText = await gh.file(src, commit.sha, composePath, MAX_COMPOSE_READ)
      found = await collectEnvFiles(composeText, composePath, files, p => gh.file(src, commit.sha, p, MAX_ENV_FILE))
    }
    catch (err) {
      githubErrorToHttp(err)
    }
  }
  if (!found.order.length) throw createError({ statusCode: 422, statusMessage: 'Aucun fichier env_file de ce Compose n\'est présent dans les sources' })

  const names = envFileVarNames(found.order.map(p => ({ path: p, keys: found.keys[p]! })))
  const current = await targetVariables(t.target)
  const next = new Map<string, { value: string | null, secret: boolean }>()
  for (const [name, v] of Object.entries(current)) next.set(name, { value: null, secret: v.secret })
  const imported: EnvImportResult['imported'] = []
  const kept: string[] = []
  const regenerated = new Map<string, string>()
  const fresh = (original: string) => {
    let v = regenerated.get(original)
    if (!v) {
      v = randomBytes(48).toString('base64url')
      regenerated.set(original, v)
    }
    return v
  }
  for (const file of found.order) {
    for (const { key, value } of found.values[file]!) {
      const name = names.get(file)!.get(key)!
      if (current[name] && !input.overwrite) {
        kept.push(name)
        continue
      }
      if (imported.some(i => i.name === name)) continue
      const secret = looksSecret(key)
      const regen = secret && input.regenerateSecrets && value !== ''
      next.set(name, { value: regen ? fresh(value) : value, secret })
      imported.push({ name, secret, file, regenerated: regen })
    }
  }
  await setTargetVariables(t.target.id, [...next.entries()].map(([name, v]) => ({ name, secret: v.secret, ...(v.value === null ? {} : { value: v.value }) })))
  return { imported, kept: [...new Set(kept)], files: found.order }
}
