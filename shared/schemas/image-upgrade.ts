/** Mise à niveau des images d'une cible (plan et demande). */
import { z } from 'zod'
import type { UpgradeLevel } from '../utils/image-version'

export interface ServiceUpgrade {
  service: string
  /** Image en service d'après la release active (abrégée). */
  image: string
  /** Où le Compose déclare l'image. */
  origin: 'literal' | 'variable' | 'anchor' | 'build' | 'unknown'
  variable: string | null
  /** Mise à niveau déjà appliquée par la plateforme. */
  override: { image: string, from: string, at: string, by: string | null } | null
  /** version : tag versionné ; digest : figé par empreinte ; floating : latest… ; build ; local ; unknown. */
  kind: 'version' | 'digest' | 'floating' | 'build' | 'local' | 'unknown'
  tag: string | null
  /** Le même tag a été republié (nouvelle empreinte). */
  sameTagUpdate: boolean
  /** Plus récente dans la même version majeure. */
  compatible: { tag: string, level: UpgradeLevel, image: string } | null
  /** Nouvelle version majeure. */
  major: { tag: string, level: UpgradeLevel, image: string } | null
  /** Service à données : une version majeure peut demander une migration. */
  stateful: boolean
  /** Majeure non proposée en mise à niveau mais accessible par migration des données (PostgreSQL). */
  migration?: { tag: string, image: string } | null
  /** Migration PostgreSQL réalisée : ancien cluster conservé jusqu'à sa suppression. */
  migrated?: { major: number, path: string, at: string, oldPgdata: string | null, oldRemovedAt: string | null, backupDir: string | null } | null
  note: string | null
  /**
   * Image absente du registre, ou sur un tag sans version : version fixe proposée, la dernière
   * publiée (saut de version inconnu : sauvegarde des données et retour automatique).
   */
  pin?: { tag: string, image: string, reason: 'absent' | 'floating' } | null
  /** Services qui partagent cette image (ancre, variable) : mis à niveau ensemble. */
  linked?: string[]
}

export interface ImageUpgradePlan {
  targetId: string
  releaseNumber: number
  sourceKind: string
  checkedAt: string
  services: ServiceUpgrade[]
  hasBuilds: boolean
  /** Des images mises à niveau s'appliquent déjà (à reporter dans la source). */
  overridesPending: boolean
}

export const upgradeInput = z.object({
  services: z.array(z.object({
    service: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/),
    tag: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/, 'Tag invalide'),
  })).max(50).default([]),
  /** Services ramenés à l'image déclarée par le Compose (mise à niveau retirée). */
  reset: z.array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/)).max(50).default([]),
  /** Récupérer aussi les nouvelles publications des tags inchangés. */
  refresh: z.boolean().default(true),
  /** Reconstruire proprement les services construits (images de base récupérées, sans cache). */
  cleanBuild: z.boolean().default(false),
  /** Version majeure d'un service à données confirmée (migration de données). */
  confirmMajorData: z.boolean().default(false),
  /** Copie à froid des volumes des services à données avant la mise à niveau (restaurée en cas de retour). */
  backup: z.boolean().default(true),
})
export type UpgradeInput = z.infer<typeof upgradeInput>
