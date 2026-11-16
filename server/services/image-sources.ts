/**
 * Images vérifiées avant le déploiement : une image que son registre ne sert pas
 * (tag supprimé, dépôt privé, registre injoignable) est signalée AVANT d'arrêter quoi
 * que ce soit, avec les sources équivalentes réellement disponibles. Le choix d'une
 * autre source est une surcharge d'image de la cible (comme une mise à niveau).
 */
import { createError } from 'h3'
import { eq } from 'drizzle-orm'
import type { ComposeIssue } from '../../shared/schemas/analysis'
import { db, schema } from '../db/client'
import { alternativeImages } from '../lib/image-sources'
import { normalizeImage } from '../lib/compose/image-upgrade'
import { RegistryError, isPublicRegistry, parseImageRef, remoteDigest } from '../lib/registry'
import type { TargetRow } from './projects'

/** null : image servie par son registre (ou non vérifiable : registre privé, image figée). */
async function problemOf(image: string): Promise<string | null> {
  const ref = parseImageRef(image)
  if (!ref || !ref.tag || !isPublicRegistry(ref.registry)) return null
  try {
    await remoteDigest(ref)
    return null
  }
  catch (err) {
    return err instanceof RegistryError ? err.message : 'registre injoignable'
  }
}

export async function availableAlternatives(image: string): Promise<string[]> {
  const list = alternativeImages(image)
  const ok = await Promise.all(list.map(async a => (await problemOf(a)) === null && !!parseImageRef(a) && isPublicRegistry(parseImageRef(a)!.registry)))
  return list.filter((_, i) => ok[i])
}

/** Alertes « image non récupérable » des images des registres (services construits exclus). */
export async function imageSourceIssues(images: Record<string, string>, built: readonly string[]): Promise<ComposeIssue[]> {
  const byImage = new Map<string, string[]>()
  for (const [service, image] of Object.entries(images)) {
    if (built.includes(service) || image.startsWith('platform/')) continue
    byImage.set(image, [...(byImage.get(image) ?? []), service])
  }
  const issues: ComposeIssue[] = []
  await Promise.all([...byImage].map(async ([image, services]) => {
    const problem = await problemOf(image)
    if (!problem) return
    const alternatives = await availableAlternatives(image)
    for (const service of services) {
      issues.push({
        severity: 'warning',
        code: 'image.unavailable',
        service,
        image,
        alternatives,
        message: `Image ${normalizeImage(image)} non récupérable (${problem}) : le déploiement échouera si l'hôte ne peut pas la tirer${alternatives.length ? ' — choisir une autre source ci-dessous' : ' — aucune source équivalente trouvée'}`,
      })
    }
  }))
  return issues
}

/** Autre source choisie pour un service : surcharge d'image de la cible, vérifiée auprès du registre. */
export async function useImageSource(t: TargetRow, input: { service: string, from: string, image: string }, user: { id: string | null, email: string }) {
  if (!alternativeImages(input.from).includes(input.image)) throw createError({ statusCode: 422, statusMessage: `${input.image} n'est pas une source équivalente de ${normalizeImage(input.from)}` })
  const problem = await problemOf(input.image)
  if (problem) throw createError({ statusCode: 422, statusMessage: `${input.image} indisponible : ${problem}` })
  const [cur] = await db().select({ o: schema.projectTargets.composeOverrides }).from(schema.projectTargets).where(eq(schema.projectTargets.id, t.target.id))
  const o = cur?.o ?? {}
  // Surcharge déjà en place (autre source essayée) : l'image d'origine reste celle du Compose.
  const from = o.images?.[input.service]?.image && normalizeImage(o.images[input.service]!.image) === normalizeImage(input.from) ? o.images[input.service]!.from : input.from
  await db().update(schema.projectTargets).set({ composeOverrides: { ...o, images: { ...o.images, [input.service]: { image: input.image, from, at: new Date().toISOString(), by: user.email } } } }).where(eq(schema.projectTargets.id, t.target.id))
  return { service: input.service, from, image: input.image }
}
