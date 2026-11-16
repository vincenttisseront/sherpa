/**
 * Terminal dans un conteneur (docker exec -it) : sessions tenues côté serveur, reliées au navigateur par un flux SSE
 * (sortie) et des requêtes POST (saisie, taille). Sans WebSocket : l'authentification, le CSRF et les limites de
 * débit habituels s'appliquent à chaque échange, et tout proxy HTTP passe.
 *
 * - Une session appartient à la personne qui l'a ouverte (et à elle seule) ; droit dédié `container:exec`.
 * - Limites : 3 sessions par personne, 20 au total ; fermeture après 15 min sans saisie, ou 2 h au plus.
 * - La sortie récente (256 Kio) est conservée pour une reconnexion du flux (Last-Event-ID).
 * - La saisie n'est jamais journalisée (mots de passe) ; l'ouverture et la fermeture le sont, avec les volumes échangés.
 * Les sessions vivent dans ce processus : un seul processus applicatif par instance (reconnexion impossible ailleurs).
 */
import { randomBytes } from 'node:crypto'
import type { ExecSession } from '../adapters/portainer/types'
import { audit } from '../utils/audit'

export const EXEC_MAX_PER_USER = 3
export const EXEC_MAX_TOTAL = 20
export const EXEC_IDLE_MS = 15 * 60_000
export const EXEC_MAX_MS = 2 * 3600_000
const REPLAY_BYTES = 256 * 1024

export type ExecListener = (event: { type: 'data', offset: number, data: Buffer } | { type: 'exit', reason: string }) => void

export interface ExecInfo {
  userId: string
  userEmail: string
  ip: string | null
  serverId: string
  serverName: string
  containerId: string
  containerName: string
  shell: string
  projectId: string | null
}

interface Live {
  id: string
  info: ExecInfo
  session: ExecSession
  openedAt: number
  lastActivity: number
  bytesIn: number
  bytesOut: number
  /** Position (en octets) du premier octet conservé ; `chunks` couvre [base, total). */
  base: number
  total: number
  chunks: Buffer[]
  listeners: Set<ExecListener>
  closed: string | null
  idle: NodeJS.Timeout
}

const sessions = new Map<string, Live>()

const countFor = (userId: string) => [...sessions.values()].filter(s => s.info.userId === userId && !s.closed).length

export function openedSessions() {
  return [...sessions.values()].filter(s => !s.closed).length
}

export function assertQuota(userId: string) {
  if (countFor(userId) >= EXEC_MAX_PER_USER) throw Object.assign(new Error(`Trois terminaux ouverts au plus par personne : en fermer un`), { statusCode: 429 })
  if (openedSessions() >= EXEC_MAX_TOTAL) throw Object.assign(new Error('Trop de terminaux ouverts sur la plateforme : réessayer plus tard'), { statusCode: 429 })
}

export async function registerExec(session: ExecSession, info: ExecInfo): Promise<string> {
  const id = randomBytes(18).toString('base64url')
  const now = Date.now()
  const live: Live = {
    id, info, session, openedAt: now, lastActivity: now, bytesIn: 0, bytesOut: 0, base: 0, total: 0, chunks: [], listeners: new Set(), closed: null,
    idle: setInterval(() => {
      const t = Date.now()
      if (t - live.lastActivity > EXEC_IDLE_MS) void closeExec(id, 'inactivité')
      else if (t - live.openedAt > EXEC_MAX_MS) void closeExec(id, 'durée maximale')
    }, 15_000),
  }
  sessions.set(id, live)
  session.stream.on('data', (buf: Buffer) => {
    live.bytesOut += buf.length
    live.chunks.push(buf)
    const offset = live.total
    live.total += buf.length
    // Mémoire bornée : on retire les plus anciens morceaux.
    while (live.total - live.base > REPLAY_BYTES && live.chunks.length > 1) live.base += live.chunks.shift()!.length
    for (const l of live.listeners) l({ type: 'data', offset, data: buf })
  })
  session.stream.on('close', () => void closeExec(id, 'session terminée'))
  session.stream.on('error', () => void closeExec(id, 'erreur de connexion'))
  await audit({
    actorUserId: info.userId, actorLabel: info.userEmail, action: 'container.exec_open', targetType: 'container', targetId: info.containerId, serverId: info.serverId, projectId: info.projectId ?? undefined, outcome: 'success', ip: info.ip ?? undefined,
    details: { server: info.serverName, container: info.containerName, shell: info.shell, session: id.slice(0, 8) },
  })
  return id
}

/** Session de la personne connectée (jamais celle d'une autre). */
export function getExec(id: string, userId: string): Live | null {
  const s = sessions.get(id)
  return s && s.info.userId === userId ? s : null
}

export function touch(s: Live) {
  s.lastActivity = Date.now()
}

export function writeExec(s: Live, data: Buffer) {
  if (s.closed) throw Object.assign(new Error('Session terminée'), { statusCode: 410 })
  touch(s)
  s.bytesIn += data.length
  s.session.stream.write(data)
}

/** Octets à rejouer à partir de `offset` (reconnexion) : tout ce qui est conservé si l'offset est trop ancien. */
export function replay(s: Live, offset: number): { offset: number, data: Buffer } | null {
  if (offset >= s.total) return null
  const all = Buffer.concat(s.chunks)
  const from = Math.max(offset, s.base)
  return { offset: from, data: all.subarray(from - s.base) }
}

export function subscribe(s: Live, l: ExecListener): () => void {
  s.listeners.add(l)
  touch(s)
  return () => {
    s.listeners.delete(l)
  }
}

export async function closeExec(id: string, reason: string) {
  const s = sessions.get(id)
  if (!s || s.closed) return
  s.closed = reason
  clearInterval(s.idle)
  s.session.close()
  for (const l of s.listeners) l({ type: 'exit', reason })
  s.listeners.clear()
  // Les derniers octets restent lisibles brièvement (le flux peut se reconnecter après la fin).
  setTimeout(() => sessions.delete(id), 60_000).unref()
  await audit({
    actorUserId: s.info.userId, actorLabel: s.info.userEmail, action: 'container.exec_close', targetType: 'container', targetId: s.info.containerId, serverId: s.info.serverId, projectId: s.info.projectId ?? undefined, outcome: 'success', ip: s.info.ip ?? undefined,
    details: { server: s.info.serverName, container: s.info.containerName, session: id.slice(0, 8), reason, seconds: Math.round((Date.now() - s.openedAt) / 1000), bytesIn: s.bytesIn, bytesOut: s.bytesOut },
  }).catch(() => undefined)
}

/** Ferme toutes les sessions d'une personne (suspension, déconnexion forcée). */
export async function closeUserExecs(userId: string, reason: string) {
  for (const s of [...sessions.values()]) if (s.info.userId === userId) await closeExec(s.id, reason)
}

export type { Live as ExecLive }
