/**
 * Migration d'une stack vers un autre serveur : ce qu'il faut copier, déduit des montages des
 * conteneurs de la stack sur le serveur d'origine. Fonctions pures (embarquées sans E/S).
 *
 * - release : dossier de la release active (toujours copié : les fichiers montés depuis les
 *   sources ou générés y sont, et la cible réutilise l'extraction au lieu de l'archive) ;
 * - data : dossier des données du projet (binds relatifs, volumes stockés en dossiers) ;
 * - volume : chaque volume nommé (même nom sur la cible : la stack garde son nom) ;
 * - bind : dossier monté hors du projet, recopié au même chemin sur la cible.
 * Les montages système (fuseau horaire, sockets, /proc…) ne sont jamais copiés.
 */
import type { MigrationItem } from '../../shared/schemas/migration'
import { trimTrailingSlashes } from '../../shared/utils/trim'

export interface StackMount {
  service: string
  type: string
  /** Chemin de l'hôte (bind) ; null pour un volume. */
  source: string | null
  /** Nom du volume (type volume). */
  name: string | null
  destination: string
  rw: boolean
}

export interface MigrationLayout {
  projectDir: string
  releasesDir: string
  runtimeDir: string
  releaseDir: string
}

const SYSTEM = ['/proc', '/sys', '/dev', '/run', '/var/run', '/var/lib/docker', '/etc', '/usr', '/boot', '/lib', '/bin', '/sbin']

const within = (p: string, dir: string) => p === dir || p.startsWith(`${trimTrailingSlashes(dir)}/`)

export type PlanItem = Omit<MigrationItem, 'sizeBytes' | 'isFile' | 'note'>

/** Éléments à copier et montages ignorés (avec la raison). */
export function migrationItems(mounts: readonly StackMount[], from: MigrationLayout, to: Pick<MigrationLayout, 'runtimeDir' | 'releaseDir'>): { items: PlanItem[], ignored: { source: string, service: string, reason: string }[] } {
  const items = new Map<string, PlanItem>()
  const ignored: { source: string, service: string, reason: string }[] = []
  const add = (item: Omit<PlanItem, 'services'>, service: string | null) => {
    const cur = items.get(item.id) ?? { ...item, services: [] }
    if (service && !cur.services.includes(service)) cur.services.push(service)
    items.set(item.id, cur)
  }
  add({ id: 'release', kind: 'release', label: 'Release active (sources et fichiers générés)', source: from.releaseDir, destination: to.releaseDir, required: true, selected: true }, null)
  add({ id: 'data', kind: 'data', label: 'Données du projet', source: from.runtimeDir, destination: to.runtimeDir, required: false, selected: true }, null)

  for (const m of mounts) {
    if (m.type === 'volume' && m.name) {
      add({ id: `volume:${m.name}`, kind: 'volume', label: `Volume ${m.name}`, source: m.name, destination: m.name, required: false, selected: true }, m.service)
      continue
    }
    if (m.type !== 'bind' || !m.source) continue
    // Docker Desktop présente les dossiers partagés de la machine sous /host_mnt.
    const src = trimTrailingSlashes(m.source.replace(/^\/host_mnt(?=\/)/, '')) || '/'
    if (src.endsWith('.sock') || src === '/' || SYSTEM.some(s => within(src, s))) {
      ignored.push({ source: src, service: m.service, reason: 'chemin système de l\'hôte (présent sur la cible)' })
      continue
    }
    if (within(src, from.releaseDir)) {
      add({ ...items.get('release')! }, m.service)
      continue
    }
    if (within(src, from.runtimeDir)) {
      add({ ...items.get('data')! }, m.service)
      continue
    }
    if (within(src, from.releasesDir)) {
      ignored.push({ source: src, service: m.service, reason: 'release qui n\'est plus la release active' })
      continue
    }
    if (within(src, from.projectDir)) {
      ignored.push({ source: src, service: m.service, reason: 'dossier interne de la console (sauvegardes, fichiers partagés)' })
      continue
    }
    add({ id: `bind:${src}`, kind: 'bind', label: `Dossier ${src}`, source: src, destination: src, required: false, selected: true }, m.service)
  }
  return { items: [...items.values()], ignored }
}

/** Script de mesure (busybox) : chaque élément monté en /m/<i>. Sortie « @@ i D|F kio » ou « @@ i - ». */
export function sizeScript(count: number): string {
  const lines = []
  for (let i = 0; i < count; i++) {
    lines.push(`if [ -d /m/${i} ]; then echo "@@ ${i} D $(du -sk /m/${i} 2>/dev/null | cut -f1)"; elif [ -e /m/${i} ]; then echo "@@ ${i} F $(du -sk /m/${i} 2>/dev/null | cut -f1)"; else echo "@@ ${i} -"; fi`)
  }
  return lines.join('\n')
}

export function parseSizes(lines: readonly string[]): Map<number, { exists: boolean, isDir: boolean, bytes: number | null }> {
  const out = new Map<number, { exists: boolean, isDir: boolean, bytes: number | null }>()
  for (const l of lines) {
    const m = l.trim().match(/^@@ (\d+) (?:(D|F) (\d*)|-)$/)
    if (!m) continue
    out.set(Number(m[1]), m[2] ? { exists: true, isDir: m[2] === 'D', bytes: m[3] ? Number(m[3]) * 1024 : null } : { exists: false, isDir: false, bytes: null })
  }
  return out
}

/** Labels d'un volume recréé sur la cible : ceux de Compose, pour qu'il le reconnaisse comme le sien. */
export function volumeLabels(labels: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(labels).filter(([k]) => k.startsWith('com.docker.compose.') || k.startsWith('platform.')))
}

/** Montage « source:/m[:ro] » d'un élément dans un conteneur porteur. */
export const holderBind = (source: string, readOnly: boolean) => `${source}:/m${readOnly ? ':ro' : ''}`
