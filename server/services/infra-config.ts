/**
 * Configuration d'infrastructure par endpoint : chemins (§6.4), ports (§10),
 * Traefik et domaines (§11). Validation stricte côté serveur, erreurs
 * restituées champ par champ pour l'interface.
 */
import { and, eq, isNull } from 'drizzle-orm'
import type { FieldErrors, PathConfigInput, PortRuleInput, TraefikConfigInput } from '../../shared/schemas/infra'
import type { Db } from '../db/client'
import { schema } from '../db/client'
import { DEFAULT_FORBIDDEN_PORTS } from '../utils/port-guard'
import { PathViolation, isWithin, normalizeAbsolute, projectLayout, validateRoot } from '../utils/path-guard'

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

const ROOT_FIELDS = ['workingRoot', 'buildRoot', 'tmpRoot', 'runtimeRoot'] as const

/** Valide une configuration de chemins ; renvoie les chemins normalisés ou les erreurs par champ. */
export function validatePathConfig(cfg: PathConfigInput): { ok: true, value: PathConfigInput } | { ok: false, errors: FieldErrors } {
  const errors: FieldErrors = {}
  const forbidden: string[] = []
  cfg.forbiddenPaths.forEach((p, i) => {
    try {
      forbidden.push(normalizeAbsolute(p))
    }
    catch (e) {
      errors[`forbiddenPaths.${i}`] = (e as PathViolation).reason
    }
  })

  const roots: Partial<Record<(typeof ROOT_FIELDS)[number], string>> = {}
  for (const f of ROOT_FIELDS) {
    try {
      roots[f] = validateRoot(cfg[f], forbidden)
    }
    catch (e) {
      errors[f] = e instanceof PathViolation ? e.reason : 'Chemin invalide'
    }
  }

  if (roots.workingRoot && roots.runtimeRoot && (isWithin(roots.runtimeRoot, roots.workingRoot) || isWithin(roots.workingRoot, roots.runtimeRoot))) {
    errors.runtimeRoot = 'Doit être distinct du répertoire de travail (ni parent, ni enfant)'
  }
  // Les données applicatives ne doivent pas pouvoir être purgées avec les fichiers temporaires ou de build.
  for (const f of ['tmpRoot', 'buildRoot'] as const) {
    if (roots[f] && roots.runtimeRoot && (isWithin(roots.runtimeRoot, roots[f]) || isWithin(roots[f], roots.runtimeRoot))) {
      errors.runtimeRoot ??= `Ne doit pas recouvrir ${f === 'tmpRoot' ? 'le répertoire temporaire' : 'le répertoire de build'}`
    }
  }
  // Les releases non plus : le répertoire temporaire est purgé chaque jour (entrées de plus de 24 h),
  // le répertoire de build reçoit des copies de contexte. Ni égaux, ni imbriqués avec la racine de travail.
  for (const f of ['tmpRoot', 'buildRoot'] as const) {
    if (roots[f] && roots.workingRoot && (isWithin(roots.workingRoot, roots[f]) || isWithin(roots[f], roots.workingRoot))) {
      errors[f] ??= `Doit être distinct du répertoire de travail (ni égal, ni parent, ni enfant) : ${f === 'tmpRoot' ? 'son contenu est purgé chaque jour' : 'il reçoit les contextes de build'}`
    }
  }

  if (Object.keys(errors).length) return { ok: false, errors }

  const value = { ...cfg, ...roots, forbiddenPaths: forbidden } as PathConfigInput
  try {
    // Contrôle final : l'arborescence d'un projet fictif doit pouvoir être construite.
    projectLayout(value, 'exemple')
  }
  catch (e) {
    return { ok: false, errors: { workingRoot: e instanceof PathViolation ? e.reason : 'Configuration incohérente' } }
  }
  return { ok: true, value }
}

/**
 * Sur un même endpoint, deux environnements ne doivent partager aucune racine :
 * sinon un projet de staging pourrait écraser ou lire celui de production.
 * Renvoie les erreurs indexées par clé d'environnement puis champ.
 */
export function findCrossEnvironmentOverlaps(configs: Record<string, Pick<PathConfigInput, (typeof ROOT_FIELDS)[number]>>): Record<string, FieldErrors> {
  const errors: Record<string, FieldErrors> = {}
  const entries = Object.entries(configs)
  for (const [envA, a] of entries) {
    for (const [envB, b] of entries) {
      if (envA === envB) continue
      for (const fa of ROOT_FIELDS) {
        for (const fb of ROOT_FIELDS) {
          let pa: string, pb: string
          try {
            pa = normalizeAbsolute(a[fa])
            pb = normalizeAbsolute(b[fb])
          }
          catch {
            continue
          }
          if (isWithin(pa, pb) || isWithin(pb, pa)) {
            (errors[envA] ??= {})[fa] ??= `Recouvre un répertoire de l'environnement ${envB} (${pb})`
          }
        }
      }
    }
  }
  return errors
}

/** Refuse une règle qui tenterait d'autoriser un port interdit par défaut. */
export function validatePortRule(rule: PortRuleInput): string | null {
  if (rule.policy === 'forbidden') return null
  const clash = DEFAULT_FORBIDDEN_PORTS.find(d => d.protocol === rule.protocol && rule.portFrom <= d.portTo && rule.portTo >= d.portFrom)
  return clash ? `La plage ${rule.portFrom}-${rule.portTo} inclut un port toujours interdit (${clash.description})` : null
}

export function validateTraefik(cfg: TraefikConfigInput, knownNetworks: readonly string[]): FieldErrors {
  const errors: FieldErrors = {}
  if (!knownNetworks.includes(cfg.networkName)) errors.networkName = 'Réseau inconnu sur cet endpoint'
  if (cfg.exposure === 'external' && cfg.allowedDomains.length === 0) errors.allowedDomains = 'Une exposition externe exige au moins un domaine autorisé'
  if (cfg.provider === 'nginx' && !cfg.nginxContainer) errors.nginxContainer = 'Conteneur nginx requis (celui qui sert les sites)'
  if (cfg.provider === 'nginx' && !!cfg.nginxSslCertificate !== !!cfg.nginxSslCertificateKey) errors.nginxSslCertificateKey = 'Certificat et clé : les deux, ou aucun (HTTP seul)'
  if (cfg.nginxAcmeEmail && cfg.provider === 'traefik') errors.nginxAcmeEmail = 'Let\'s Encrypt par la console : nginx seulement (Traefik : resolver TLS)'
  if (cfg.nginxAcmeEmail && cfg.provider === 'nginx-proxy' && cfg.letsencrypt) errors.nginxAcmeEmail = 'Déjà assuré par acme-companion : l\'un ou l\'autre'
  return errors
}

// ---------------------------------------------------------------------------
// Écritures
// ---------------------------------------------------------------------------

export async function upsertPathConfig(tx: Tx, endpointId: string, environmentId: string, cfg: PathConfigInput, userId: string | null) {
  const values = { ...cfg, updatedBy: userId }
  await tx.insert(schema.pathConfigs)
    .values({ ...values, endpointId, environmentId })
    .onConflictDoUpdate({ target: [schema.pathConfigs.endpointId, schema.pathConfigs.environmentId], set: values })
}

export async function replacePortRules(tx: Tx, endpointId: string, rules: PortRuleInput[], environmentIdByKey: Map<string, string>) {
  await tx.delete(schema.portRules).where(eq(schema.portRules.endpointId, endpointId))
  if (rules.length === 0) return
  await tx.insert(schema.portRules).values(rules.map(r => ({
    endpointId,
    environmentId: r.environmentKey ? environmentIdByKey.get(r.environmentKey) ?? null : null,
    portFrom: r.portFrom,
    portTo: r.portTo,
    protocol: r.protocol,
    policy: r.policy,
    description: r.description,
  })))
}

/** Configuration Traefik par défaut de l'endpoint (environmentId NULL). */
export async function upsertTraefikConfig(tx: Tx, endpointId: string, cfg: TraefikConfigInput) {
  const where = and(eq(schema.traefikConfigs.endpointId, endpointId), isNull(schema.traefikConfigs.environmentId))
  const [existing] = await tx.select({ id: schema.traefikConfigs.id, acmeDirectory: schema.traefikConfigs.nginxAcmeDirectory }).from(schema.traefikConfigs).where(where)
  // Compte ACME propre à une autorité : recréé quand l'autorité change.
  if (existing) await tx.update(schema.traefikConfigs).set({ ...cfg, ...(existing.acmeDirectory !== cfg.nginxAcmeDirectory ? { nginxAcmeAccountSecretId: null } : {}) }).where(eq(schema.traefikConfigs.id, existing.id))
  else await tx.insert(schema.traefikConfigs).values({ ...cfg, endpointId })
}

export async function setEndpointEnvironments(tx: Tx, endpointId: string, environmentIds: string[]) {
  await tx.delete(schema.endpointEnvironments).where(eq(schema.endpointEnvironments.endpointId, endpointId))
  if (environmentIds.length) {
    await tx.insert(schema.endpointEnvironments).values(environmentIds.map(environmentId => ({ endpointId, environmentId })))
  }
}
