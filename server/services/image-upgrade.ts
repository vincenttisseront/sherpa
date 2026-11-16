/**
 * Mise à niveau des images d'une cible déployée, quelle que soit sa source :
 * - plan : pour chaque service, origine de l'image dans le Compose (littérale, variable,
 *   ancre, build), versions plus récentes de même forme, nouvelle empreinte du même tag ;
 * - application : nouvelles images en surcharge de la cible (contrôlées à l'analyse),
 *   redéploiement de la release active avec retour automatique aux images précédentes
 *   si le déploiement ou les healthchecks échouent ; build propre en option.
 */
import { createError } from 'h3'
import { eq } from 'drizzle-orm'
import type { ImageUpgradePlan, ServiceUpgrade, UpgradeInput } from '../../shared/schemas/image-upgrade'
import { MAJOR_NEEDS_MIGRATION, STATEFUL_IMAGE, latestVersion, newerVersions, parseTag, versionCandidates } from '../../shared/utils/image-version'
import { db, schema } from '../db/client'
import type { DeploymentOptions } from '../db/schema'
import { type ImageOverride, imageOrigins, normalizeImage, patchComposeImages, sameImage } from '../lib/compose/image-upgrade'
import { PG_IMAGE } from '../lib/pg-migration'
import { RegistryError, type ImageRef, listTags, parseImageRef, remoteDigest } from '../lib/registry'
import { createLifecycleAction } from './deploy-requests'
import { dataMounts } from './volume-backup'
import { targetFreshness } from './image-freshness'
import type { TargetRow } from './projects'

const TAGS_TTL_MS = 30 * 60_000
const tagsCache = new Map<string, { at: number, value: Promise<string[]> }>()

/** Versions publiées d'un dépôt (liste complète, mise en cache 30 min). */
export function tagsOf(ref: ImageRef): Promise<string[]> {
  const key = `${ref.registry}/${ref.repository}`
  const hit = tagsCache.get(key)
  if (hit && Date.now() - hit.at < TAGS_TTL_MS) return hit.value
  const value = listTags(ref, 20_000)
  tagsCache.set(key, { at: Date.now(), value })
  value.catch(() => tagsCache.delete(key))
  return value
}

/** Même référence avec un autre tag (registre et dépôt tels qu'écrits) ; empreinte retirée. */
export function withTag(image: string, tag: string): string {
  const noDigest = image.split('@')[0]!
  const slash = noDigest.lastIndexOf('/')
  const colon = noDigest.lastIndexOf(':')
  const repo = colon > slash ? noDigest.slice(0, colon) : noDigest
  return `${repo}:${tag}`
}

/**
 * Version publiée sous le même contenu qu'un tag flottant (latest, stable…) : la plus récente des
 * versions dont l'empreinte est celle du tag (25 premières comparées). null si rien ne correspond.
 */
async function sameAsFloating(ref: ImageRef, tags: readonly string[], floating: string): Promise<string | null> {
  if (!tags.includes(floating)) return null
  const target = await remoteDigest({ ...ref, tag: floating, digest: null }).catch(() => null)
  if (!target) return null
  for (const tag of versionCandidates(tags).slice(0, 25)) {
    if (await remoteDigest({ ...ref, tag, digest: null }).catch(() => null) === target) return tag
  }
  return null
}

export async function currentRelease(t: TargetRow) {
  if (!t.target.currentReleaseId) throw createError({ statusCode: 409, statusMessage: 'Aucune release active : déployer d\'abord la cible' })
  const [rel] = await db().select().from(schema.releases).where(eq(schema.releases.id, t.target.currentReleaseId))
  if (!rel) throw createError({ statusCode: 409, statusMessage: 'Release active introuvable' })
  return rel
}

export async function upgradePlan(t: TargetRow, opts: { refresh?: boolean } = {}): Promise<ImageUpgradePlan> {
  const rel = await currentRelease(t)
  const images = rel.images as Record<string, string>
  const origins = rel.composeSource ? imageOrigins(rel.composeSource) : {}
  const overrides = (t.target.composeOverrides?.images ?? {}) as Record<string, ImageOverride>
  const fresh = await targetFreshness(t.target.id, opts.refresh).catch(() => null)

  const services: ServiceUpgrade[] = await Promise.all(Object.entries(images).sort(([a], [b]) => a.localeCompare(b)).map(async ([service, image]): Promise<ServiceUpgrade> => {
    const o = origins[service]
    const ov = overrides[service]
    const f = fresh?.services.find(s => s.service === service)
    const pg = t.target.composeOverrides?.pgData?.[service]
    const base: ServiceUpgrade = {
      migrated: pg ? { major: pg.major, path: pg.path, at: pg.at, oldPgdata: pg.old?.pgdata ?? null, oldRemovedAt: pg.old?.removedAt ?? null, backupDir: pg.backupDir ?? null } : null,
      service,
      image: normalizeImage(image),
      origin: o?.build ? 'build' : o?.variable ? 'variable' : o?.inherited ? 'anchor' : o?.raw ? 'literal' : 'unknown',
      variable: o?.variable?.name ?? null,
      override: ov ? { image: normalizeImage(ov.image), from: normalizeImage(ov.from), at: ov.at, by: ov.by } : null,
      kind: 'version',
      tag: null,
      sameTagUpdate: f?.state === 'outdated',
      compatible: null,
      major: null,
      stateful: STATEFUL_IMAGE.test(normalizeImage(image)),
      note: null,
    }
    if (image.startsWith('platform/')) return { ...base, kind: 'build', note: 'Construite par la plateforme : un build propre récupère les images de base (FROM) ; leur version se change dans le Dockerfile.' }
    const ref = parseImageRef(image)
    if (!ref) return { ...base, kind: 'unknown', note: 'Référence d\'image illisible' }
    base.tag = ref.tag
    // Version à figer pour une image absente ou flottante : celle que l'éditeur publie aujourd'hui sous
    // le tag flottant (même empreinte que « latest », ou que le tag suivi), sinon la plus haute publiée.
    const pinOf = async (tags: string[] | null, reason: 'absent' | 'floating') => {
      if (!tags) return null
      let tag = await sameAsFloating(ref, tags, reason === 'floating' && ref.tag ? ref.tag : 'latest')
      tag ??= latestVersion(tags)
      return tag && tag !== ref.tag ? { tag, image: normalizeImage(withTag(image, tag)), reason } : null
    }
    if (!ref.tag || !parseTag(ref.tag) || f?.state === 'local') {
      const tags = await tagsOf(ref).catch(() => null)
      const published = !!tags?.includes(ref.tag ?? 'latest')
      if (!published || f?.state === 'local') {
        const pin = await pinOf(tags, 'absent')
        return {
          ...base,
          kind: 'local',
          pin,
          note: pin
            ? `Image absente du registre : figer sur ${pin.tag}, la dernière version publiée (saut de version inconnu : sauvegarde des données et retour automatique en cas d'échec).`
            : 'Image absente du registre (construite ou importée sur l\'hôte) : pas de version à proposer.',
        }
      }
      const pin = await pinOf(tags, 'floating')
      return { ...base, kind: 'floating', pin, note: `Tag sans version (${ref.tag ?? 'latest'}) : seule la nouvelle publication du même tag est récupérable ; figer une version${pin ? ` (${pin.tag})` : ''} est recommandé.` }
    }
    try {
      const tags = await tagsOf(ref)
      // Tag versionné retiré du registre (ou jamais publié) : même proposition qu'une image absente.
      if (!ref.digest && !tags.includes(ref.tag)) {
        const pin = await pinOf(tags, 'absent')
        return { ...base, kind: 'local', pin, note: pin ? `Image absente du registre : figer sur ${pin.tag}, la dernière version publiée (saut de version inconnu : sauvegarde des données et retour automatique en cas d'échec).` : 'Image absente du registre (construite ou importée sur l\'hôte) : pas de version à proposer.' }
      }
      const v = newerVersions(ref.tag, tags)
      // Majeure d'une base qui ne relit pas ses anciennes données : signalée, jamais proposée.
      const blockedMajor = v?.major && MAJOR_NEEDS_MIGRATION.test(normalizeImage(image)) ? v.major.tag : null
      const notes = [
        ref.digest ? 'Figée par empreinte : la nouvelle version sera figée par sa propre empreinte.' : null,
        blockedMajor ? `Version majeure ${blockedMajor} publiée : changer l'image ne suffit pas, les données existantes doivent être migrées${PG_IMAGE.test(normalizeImage(image)) ? ' (bouton « Migrer les données »)' : ''}.` : null,
      ].filter(Boolean)
      return {
        ...base,
        kind: ref.digest ? 'digest' : 'version',
        compatible: v?.compatible ? { ...v.compatible, image: normalizeImage(withTag(image, v.compatible.tag)) } : null,
        major: v?.major && !blockedMajor ? { ...v.major, image: normalizeImage(withTag(image, v.major.tag)) } : null,
        migration: blockedMajor && PG_IMAGE.test(normalizeImage(image)) ? { tag: blockedMajor, image: normalizeImage(withTag(image, blockedMajor)) } : null,
        note: notes.length ? notes.join(' ') : null,
      }
    }
    catch (err) {
      return { ...base, kind: 'unknown', note: err instanceof RegistryError ? err.message : `Versions illisibles : ${(err as Error).message.slice(0, 120)}` }
    }
  }))

  // Services qui partagent la même image d'origine (ancre, variable) : mis à niveau ensemble.
  for (const s of services) {
    const raw = origins[s.service]?.raw
    s.linked = raw ? services.filter(x => x.service !== s.service && origins[x.service]?.raw === raw && sameImage(x.image, s.image)).map(x => x.service) : []
  }
  return {
    targetId: t.target.id,
    releaseNumber: rel.number,
    sourceKind: rel.sourceKind,
    checkedAt: new Date().toISOString(),
    services,
    hasBuilds: services.some(s => s.kind === 'build'),
    overridesPending: Object.keys(overrides).length > 0,
  }
}

/** Compose source avec les images mises à niveau (à reporter dans le dépôt ou l'archive). */
export async function upgradedCompose(t: TargetRow) {
  const rel = await currentRelease(t)
  const overrides = (t.target.composeOverrides?.images ?? {}) as Record<string, ImageOverride>
  const changes = Object.entries(overrides).map(([service, o]) => ({ service, from: o.from, to: o.image }))
  return { composePath: rel.composePath ?? 'compose.yml', ...patchComposeImages(rel.composeSource ?? '', changes) }
}

/**
 * Mise à niveau réussie : images reportées dans le Compose source de la release (archive, Compose
 * saisi, stack reprise), et surcharges devenues inutiles retirées. Un dépôt GitHub n'est jamais
 * modifié : la surcharge reste, et le Compose à reporter est proposé (upgradedCompose).
 * Renvoie les services reportés et ceux à changer à la main (variable, build…).
 */
export async function bakeImageOverrides(targetId: string, releaseId: string): Promise<{ changed: string[], manual: { service: string, reason: string }[] }> {
  const [rel] = await db().select().from(schema.releases).where(eq(schema.releases.id, releaseId))
  const [t] = await db().select({ o: schema.projectTargets.composeOverrides }).from(schema.projectTargets).where(eq(schema.projectTargets.id, targetId))
  const overrides = (t?.o.images ?? {}) as Record<string, ImageOverride>
  if (!rel?.composeSource || rel.sourceKind !== 'zip' || !Object.keys(overrides).length) return { changed: [], manual: [] }
  const patch = patchComposeImages(rel.composeSource, Object.entries(overrides).map(([service, o]) => ({ service, from: o.from, to: o.image })))
  if (!patch.changed.length) return { changed: [], manual: patch.manual }
  await db().update(schema.releases).set({ composeSource: patch.composeText }).where(eq(schema.releases.id, releaseId))
  const rest = Object.fromEntries(Object.entries(overrides).filter(([service]) => !patch.changed.includes(service)))
  await db().update(schema.projectTargets).set({ composeOverrides: { ...t!.o, images: rest } }).where(eq(schema.projectTargets.id, targetId))
  return { changed: patch.changed, manual: patch.manual }
}

/**
 * Surcharges antérieures au report automatique : écrites dans le Compose de la release active
 * de chaque cible (images en service). Sans effet une fois faites (surcharges retirées).
 */
export async function bakeAllImageOverrides(): Promise<{ targets: number, services: number }> {
  const rows = await db().select({ id: schema.projectTargets.id, releaseId: schema.projectTargets.currentReleaseId, o: schema.projectTargets.composeOverrides }).from(schema.projectTargets)
  let targets = 0
  let services = 0
  for (const r of rows) {
    if (!r.releaseId || !Object.keys(r.o.images ?? {}).length) continue
    const b = await bakeImageOverrides(r.id, r.releaseId).catch(() => ({ changed: [] as string[] }))
    if (b.changed.length) {
      targets++
      services += b.changed.length
    }
  }
  return { targets, services }
}

export async function applyUpgrade(t: TargetRow, input: UpgradeInput, user: { id: string | null, email: string }, idempotencyKey: string): Promise<{ deploymentId: string, services: { service: string, from: string, to: string }[] }> {
  const rel = await currentRelease(t)
  const plan = await upgradePlan(t)
  let overrides = { ...((t.target.composeOverrides?.images ?? {}) as Record<string, ImageOverride>) }
  const images = rel.images as Record<string, string>
  const changes: { service: string, from: string, to: string }[] = []
  const errors: Record<string, string> = {}

  // Choix étendus aux services liés (même ancre ou variable) : une seule version pour tous.
  const wanted = new Map<string, string>()
  for (const c of input.services) {
    wanted.set(c.service, c.tag)
    for (const l of plan.services.find(s => s.service === c.service)?.linked ?? []) if (!wanted.has(l)) wanted.set(l, c.tag)
  }

  for (const [service, tag] of wanted) {
    const s = plan.services.find(x => x.service === service)
    const current = images[service]
    if (!s || !current) {
      errors[service] = 'Service inconnu dans la release active'
      continue
    }
    const allowed = [s.compatible, s.major, s.pin].filter(Boolean).map(x => x!.tag)
    // Version demandée : une des versions plus récentes de même forme publiées (revérifiée au registre).
    const ref = parseImageRef(current)
    let ok = allowed.includes(tag)
    if (!ok && ref?.tag && (s.kind === 'version' || s.kind === 'digest')) {
      const v = newerVersions(ref.tag, [tag])
      ok = !!v && (v.compatible?.tag === tag || v.major?.tag === tag) && (await tagsOf(ref).catch(() => [] as string[])).includes(tag)
    }
    if (!ok) {
      errors[service] = `${tag} : version non proposée pour ${s.image} (plus récente, même forme, publiée)`
      continue
    }
    // Version figée (image absente ou flottante) : saut de version inconnu, traité comme une majeure.
    const pinned = s.pin?.tag === tag
    if (pinned && (s.stateful || MAJOR_NEEDS_MIGRATION.test(s.image)) && !input.confirmMajorData) {
      errors[service] = `${s.service} : passage de ${s.image} à ${tag}, saut de version inconnu sur un service à données — confirmation requise (sauvegarde faite, migration des données vérifiée)`
      continue
    }
    const level = ref?.tag ? newerVersions(ref.tag, [tag]) : null
    if (level?.major?.tag === tag && MAJOR_NEEDS_MIGRATION.test(s.image)) {
      errors[service] = `${s.service} : nouvelle version majeure de ${s.image} — les données existantes doivent être migrées (pg_upgrade ou sauvegarde/restauration), un changement d'image les rendrait illisibles`
      continue
    }
    if (level?.major?.tag === tag && s.stateful && !input.confirmMajorData) {
      errors[service] = `${s.service} : nouvelle version majeure d'un service à données (migration possible) — confirmation requise`
      continue
    }
    let next = withTag(current, tag)
    if (ref!.digest) next = `${next}@${await remoteDigest(parseImageRef(next)!)}`
    const from = overrides[service]?.from ?? current
    // Retour à la version du Compose : la surcharge n'a plus lieu d'être.
    if (sameImage(next, from)) overrides = Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== service))
    else overrides[service] = { image: next, from, at: new Date().toISOString(), by: user.email }
    changes.push({ service, from: normalizeImage(current), to: normalizeImage(next) })
  }
  // Retour à l'image du Compose : surcharge retirée (et celles des services liés).
  const resets = new Set<string>()
  for (const service of input.reset ?? []) {
    resets.add(service)
    for (const l of plan.services.find(s => s.service === service)?.linked ?? []) resets.add(l)
  }
  for (const service of resets) {
    const ov = overrides[service]
    if (!ov) {
      if ((input.reset ?? []).includes(service)) errors[service] = `${service} : aucune mise à niveau à retirer`
      continue
    }
    if (wanted.has(service)) {
      errors[service] = `${service} : mise à niveau et retour demandés ensemble`
      continue
    }
    overrides = Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== service))
    changes.push({ service, from: normalizeImage(images[service] ?? ov.image), to: normalizeImage(ov.from) })
  }
  if (Object.keys(errors).length) throw createError({ statusCode: 422, statusMessage: Object.values(errors).join(' ; '), data: { errors } })
  if (!changes.length && !input.refresh && !input.cleanBuild) throw createError({ statusCode: 422, statusMessage: 'Aucune mise à niveau demandée' })

  // Services à données concernés, et versions figées (saut inconnu) : volumes relevés pour une copie à froid.
  const statefulChanged = changes.map(c => c.service).filter((sv) => {
    const p = plan.services.find(x => x.service === sv)
    return p?.stateful || (!!p?.pin && wanted.get(sv) === p.pin.tag)
  })
  const backup = input.backup && statefulChanged.length ? { services: await dataMounts(t, statefulChanged) } : undefined
  // Image absente du registre gardée par un autre service : pas de récupération forcée (elle échouerait),
  // les nouvelles versions demandées sont tout de même récupérées puisqu'absentes de l'hôte.
  const keepsAbsent = plan.services.some(s => s.pin?.reason === 'absent' && !wanted.has(s.service))
  const options: DeploymentOptions = {
    cleanBuild: input.cleanBuild,
    ...(keepsAbsent ? { noPull: true } : {}),
    ...(changes.length
      ? { upgrade: { services: changes, previousImages: (t.target.composeOverrides?.images ?? {}) as Record<string, ImageOverride>, previousComposeFinal: rel.composeFinal, previousReleaseImages: images, ...(backup?.services.length ? { backup } : {}) } }
      : {}),
  }
  // Surcharges écrites avant la mise en file : l'analyse du redéploiement les applique (restaurées en cas d'échec).
  await db().update(schema.projectTargets).set({ composeOverrides: { ...(t.target.composeOverrides ?? {}), images: overrides } }).where(eq(schema.projectTargets.id, t.target.id))
  try {
    const deploymentId = await createLifecycleAction(t, 'redeploy', user.id, idempotencyKey, options)
    return { deploymentId, services: changes }
  }
  catch (err) {
    await db().update(schema.projectTargets).set({ composeOverrides: { ...(t.target.composeOverrides ?? {}), images: options.upgrade?.previousImages ?? overrides } }).where(eq(schema.projectTargets.id, t.target.id))
    throw err
  }
}
