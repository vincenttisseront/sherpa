/** Libellés et tons des statuts de déploiement, communs à toutes les pages. */
export const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Brouillon', VALIDATING: 'Validation', VALIDATION_FAILED: 'Validation échouée', QUEUED: 'En file',
  PREPARING_FILES: 'Préparation des fichiers', BUILDING: 'Build', DEPLOYING: 'Déploiement', HEALTH_CHECKING: 'Healthchecks',
  HEALTHY: 'Sain', DEGRADED: 'Dégradé', FAILED: 'Échec', ROLLING_BACK: 'Rollback en cours', ROLLED_BACK: 'Revenu à la release précédente',
  STOPPED: 'Arrêté', DELETING: 'Suppression', DELETED: 'Supprimé', CANCELLED: 'Annulé',
}
export const ACTION_LABEL: Record<string, string> = { deploy: 'Déploiement', redeploy: 'Redéploiement', stop: 'Arrêt', start: 'Démarrage', restart: 'Redémarrage', delete: 'Suppression', rollback: 'Rollback', migrate: 'Migration' }
export const ACTIVE_STATUS = ['VALIDATING', 'QUEUED', 'PREPARING_FILES', 'BUILDING', 'DEPLOYING', 'HEALTH_CHECKING', 'ROLLING_BACK', 'DELETING']

export function statusTone(s: string | null | undefined): 'success' | 'danger' | 'warning' | 'info' | 'neutral' {
  if (!s) return 'neutral'
  if (s === 'HEALTHY') return 'success'
  if (s === 'FAILED' || s === 'VALIDATION_FAILED') return 'danger'
  if (s === 'DEGRADED' || s === 'ROLLED_BACK') return 'warning'
  if (ACTIVE_STATUS.includes(s)) return 'info'
  return 'neutral'
}

/** Fuseau d'affichage : identique côté serveur (rendu) et navigateur (sinon écarts d'hydratation). */
export const DISPLAY_TZ = 'Europe/Paris'
export const fmtDateTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('fr-FR', { timeZone: DISPLAY_TZ }) : '—')
export const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('fr-FR', { hour12: false, timeZone: DISPLAY_TZ })
export const fmtDate = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString('fr-FR', { timeZone: DISPLAY_TZ }) : '—')

/** Image lisible : « image locale 1b42d1fd9b17 », « postgres:16 (empreinte figée) ». */
export function displayImage(image: string): string {
  if (image.startsWith('sha256:')) return `image locale ${image.slice(7, 19)}`
  const at = image.indexOf('@sha256:')
  return at > 0 ? `${image.slice(0, at)} (empreinte figée)` : image
}

/** Durée relative courte (« il y a 3 min », « dans 2 h »). */
export function fmtRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—'
  const s = Math.round((now - new Date(iso).getTime()) / 1000)
  const a = Math.abs(s)
  const v = a < 45 ? 'quelques secondes' : a < 90 ? '1 min' : a < 3600 ? `${Math.round(a / 60)} min` : a < 86_400 ? `${Math.round(a / 3600)} h` : `${Math.round(a / 86_400)} j`
  return s >= 0 ? `il y a ${v}` : `dans ${v}`
}

export function fmtBytesShort(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  const u = ['o', 'Ko', 'Mo', 'Go', 'To']
  let i = 0
  let v = n
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`
}
