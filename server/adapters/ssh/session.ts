/**
 * Sessions SSH vers les hôtes (transport alternatif à l'agent Portainer).
 *
 * - Une session par hôte et identité, partagée par l'API Docker, `docker compose`
 *   et le système de fichiers (SFTP) ; fermée après inactivité ou en cas d'erreur.
 * - La clé d'hôte est vérifiée à chaque connexion contre l'empreinte confirmée
 *   (SHA-256) : sans empreinte, ou avec une autre clé, la connexion est refusée.
 * - L'API Docker passe par un relais local (socket Unix privé, répertoire 0700) :
 *   chaque connexion entrante ouvre un canal vers le socket Docker de l'hôte
 *   (redirection de socket OpenSSH), sinon `docker system dial-stdio`.
 * - Mot de passe, clé privée et phrase de passe ne sont jamais journalisés.
 */
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { type Server, type Socket, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { Client, type ClientChannel, type ConnectConfig, type SFTPWrapper } from 'ssh2'
import { CONSOLE_HOST, isLoopbackHost } from '../../../shared/utils/console-host'
import { redactPatterns } from '../../utils/redact'
import { PortainerError, type SshConnection } from '../portainer/types'

const READY_TIMEOUT_MS = 15_000
const IDLE_CLOSE_MS = 10 * 60_000

/** Empreinte OpenSSH d'une clé publique d'hôte : « SHA256:<base64 sans remplissage> ». */
export function hostKeyFingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
}

/** Type de clé lu dans le format filaire SSH (chaîne préfixée par sa longueur). */
export function hostKeyType(key: Buffer): string {
  if (key.length < 4) return 'inconnu'
  const len = key.readUInt32BE(0)
  return key.subarray(4, 4 + len).toString('ascii') || 'inconnu'
}

export class SshHostKeyMismatch extends PortainerError {
  constructor(public readonly presented: string, expected: string | null) {
    super(expected
      ? `Clé d'hôte SSH inattendue (${presented}) : elle ne correspond pas à l'empreinte confirmée. Possible interception ou hôte réinstallé ; confirmer la nouvelle empreinte seulement après vérification.`
      : `Clé d'hôte SSH non confirmée (${presented}) : confirmer son empreinte avant toute connexion.`, 'tls')
    this.name = 'SshHostKeyMismatch'
  }
}

function classifySsh(err: unknown, presented: string | null, expected: string | null): PortainerError {
  if (err instanceof PortainerError) return err
  const e = err as { level?: string, code?: string, message?: string }
  if (presented && presented !== expected) return new SshHostKeyMismatch(presented, expected)
  if (e.level === 'client-authentication') return new PortainerError('Authentification SSH refusée : vérifier l\'utilisateur, le mot de passe ou la clé', 'auth', 401)
  if (e.level === 'client-timeout' || /timed out/i.test(e.message ?? '')) return new PortainerError('Délai dépassé pendant la connexion SSH', 'timeout')
  if (/passphrase|encrypted private key|Cannot parse privateKey/i.test(e.message ?? '')) return new PortainerError('Clé privée illisible : vérifier la clé et sa phrase de passe', 'auth')
  return new PortainerError(`Erreur SSH : ${redactPatterns(e.code || e.message || 'inconnue').slice(0, 200)}`, 'network')
}

function connectConfig(ssh: SshConnection, verify: (fingerprint: string) => boolean): ConnectConfig {
  return {
    host: ssh.host,
    port: ssh.port,
    username: ssh.username,
    ...(ssh.privateKey ? { privateKey: ssh.privateKey, ...(ssh.passphrase ? { passphrase: ssh.passphrase } : {}) } : { password: ssh.password }),
    readyTimeout: READY_TIMEOUT_MS,
    keepaliveInterval: 15_000,
    keepaliveCountMax: 3,
    // Aucune authentification interactive ni agent SSH local : uniquement les secrets fournis.
    tryKeyboard: false,
    hostVerifier: (key: Buffer) => verify(hostKeyFingerprint(key)),
  }
}

/** Cause lisible d'un échec de lecture de la clé d'hôte (la console tourne dans un conteneur). */
export function scanFailure(host: string, port: number, err: { code?: string, level?: string, message?: string } | null): string {
  const where = `${host}:${port}`
  if (isLoopbackHost(host)) return `${where} désigne le conteneur de la console, pas son hôte : utiliser ${CONSOLE_HOST} (hôte de la console) ou l'adresse IP de l'hôte`
  if (err?.code === 'ECONNREFUSED') return `Connexion refusée par ${where} : sshd n'écoute pas sur ce port, ou un pare-feu rejette la console`
  if (err?.code === 'ENOTFOUND' || err?.code === 'EAI_AGAIN') return `Nom ${host} introuvable depuis la console : utiliser son adresse IP ou un nom connu du DNS des conteneurs`
  if (err?.code === 'EHOSTUNREACH' || err?.code === 'ENETUNREACH') return `${where} injoignable depuis la console (route ou réseau)`
  if (err?.level === 'client-timeout' || err?.code === 'ETIMEDOUT' || /timed out/i.test(err?.message ?? '')) return `Délai dépassé vers ${where} : pare-feu filtrant (autoriser les réseaux Docker de la console vers le port SSH)`
  return `Aucune clé d'hôte SSH reçue de ${where}${err ? ` (${redactPatterns(err.code || err.message || '').slice(0, 120)})` : ''}`
}

/** Lit la clé d'hôte présentée, sans s'authentifier (étape de confirmation de l'empreinte). */
export function scanHostKey(host: string, port: number): Promise<{ fingerprint: string, keyType: string }> {
  return new Promise((resolve, reject) => {
    const client = new Client()
    let found: { fingerprint: string, keyType: string } | null = null
    type Failure = { code?: string, level?: string, message?: string }
    let failure: Failure | null = null
    const done = () => {
      client.end()
      if (found) resolve(found)
      else reject(new PortainerError(scanFailure(host, port, failure), 'network'))
    }
    client.on('error', (err) => {
      failure ??= err as Failure
      done()
    })
    client.on('close', done)
    client.connect({
      host, port, username: 'platform-hostkey-scan', readyTimeout: READY_TIMEOUT_MS,
      hostVerifier: (key: Buffer) => {
        found = { fingerprint: hostKeyFingerprint(key), keyType: hostKeyType(key) }
        return false
      },
    })
  })
}

interface Session {
  client: Client
  socketPath: string
  relay: Server
  dir: string
  lastUsed: number
  timer: NodeJS.Timeout
  sftp: Promise<SFTPWrapper> | null
}

const sessions = new Map<string, Promise<Session>>()

const keyOf = (ssh: SshConnection) => createHash('sha256').update(JSON.stringify([ssh.host, ssh.port, ssh.username, ssh.password ?? '', ssh.privateKey ?? '', ssh.passphrase ?? '', ssh.hostKey ?? '', ssh.dockerSocket])).digest('hex')

/** Canal vers le socket Docker de l'hôte : redirection de socket, sinon `docker system dial-stdio`. */
function openDocker(client: Client, socket: string): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    client.openssh_forwardOutStreamLocal(socket, (err, ch) => {
      if (!err) return resolve(ch)
      client.exec('docker system dial-stdio', (err2, ch2: ClientChannel) => {
        if (err2) return reject(new PortainerError(`Socket Docker de l'hôte inaccessible (${socket}) : redirection SSH refusée et docker system dial-stdio indisponible`, 'unsupported'))
        resolve(ch2)
      })
    })
  })
}

/** Canaux Docker ouverts en même temps dans une session SSH. */
const MAX_CHANNELS = 8

/** Ouverture du canal, retentée brièvement (refus passager du serveur SSH sous charge). */
async function openDockerRetry(client: Client, socket: string): Promise<Duplex> {
  for (let i = 0; ; i++) {
    try {
      return await openDocker(client, socket)
    }
    catch (err) {
      if (i >= 4) throw err
      await new Promise(r => setTimeout(r, 200 * 2 ** i))
    }
  }
}

async function open(ssh: SshConnection, key: string): Promise<Session> {
  let presented: string | null = null
  const client = new Client()
  await new Promise<void>((resolve, reject) => {
    client.once('ready', resolve)
    client.once('error', err => reject(classifySsh(err, presented, ssh.hostKey)))
    client.connect(connectConfig(ssh, (fp) => {
      presented = fp
      return !!ssh.hostKey && fp === ssh.hostKey
    }))
  })

  const dir = await mkdtemp(join(tmpdir(), 'pp-ssh-'))
  const socketPath = join(dir, 'docker.sock')
  const session = {} as Session
  // Canaux simultanés bornés (sshd limite les sessions par connexion, MaxSessions = 10 par défaut) :
  // les connexions en excès attendent leur tour au lieu d'être coupées (« EOF » côté docker compose).
  let active = 0
  const waiting: (() => void)[] = []
  const acquire = () => (active < MAX_CHANNELS ? (active++, Promise.resolve()) : new Promise<void>(r => waiting.push(() => { active++; r() })))
  const release = () => {
    active--
    waiting.shift()?.()
  }
  const relay = createServer((local: Socket) => {
    session.lastUsed = Date.now()
    let released = false
    const done = () => {
      if (!released) {
        released = true
        release()
      }
    }
    local.on('close', done)
    local.on('error', () => {})
    void acquire().then(async () => {
      if (local.destroyed) return done()
      const remote = await openDockerRetry(client, ssh.dockerSocket).catch(() => null)
      if (!remote || local.destroyed) {
        remote?.destroy()
        local.destroy()
        return done()
      }
      local.pipe(remote).pipe(local)
      remote.on('error', () => local.destroy())
      remote.on('close', () => local.destroy())
      local.on('close', () => remote.destroy())
    })
  })
  await new Promise<void>((resolve, reject) => {
    relay.once('error', reject)
    relay.listen(socketPath, resolve)
  })
  Object.assign(session, { client, socketPath, relay, dir, lastUsed: Date.now(), sftp: null })

  const close = () => {
    if (sessions.get(key) && session.client === client) sessions.delete(key)
    clearInterval(session.timer)
    relay.close()
    client.end()
    void rm(dir, { recursive: true, force: true }).catch(() => {})
  }
  session.timer = setInterval(() => {
    if (Date.now() - session.lastUsed > IDLE_CLOSE_MS) close()
  }, 60_000)
  session.timer.unref()
  client.on('close', close)
  client.on('error', close)
  return session
}

async function session(ssh: SshConnection): Promise<Session> {
  const key = keyOf(ssh)
  let s = sessions.get(key)
  if (!s) {
    s = open(ssh, key)
    sessions.set(key, s)
    s.catch(() => sessions.delete(key))
  }
  const ready = await s
  ready.lastUsed = Date.now()
  return ready
}

/** Socket Unix local relayé vers le socket Docker de l'hôte. */
export async function sshDockerSocket(ssh: SshConnection): Promise<string> {
  return (await session(ssh)).socketPath
}

/** Session SFTP (partagée) de l'hôte. */
export async function sshSftp(ssh: SshConnection): Promise<SFTPWrapper> {
  const s = await session(ssh)
  if (!s.sftp) {
    s.sftp = new Promise<SFTPWrapper>((resolve, reject) => s.client.sftp((err, sftp) => (err ? reject(new PortainerError(`SFTP indisponible sur l'hôte : ${redactPatterns(err.message)}`, 'unsupported')) : resolve(sftp))))
    s.sftp.then(sftp => sftp.on('close', () => { s.sftp = null }), () => { s.sftp = null })
  }
  return s.sftp
}

/** Ferme toutes les sessions (arrêt du processus, tests). */
export async function closeSshSessions(): Promise<void> {
  const all = [...sessions.values()]
  sessions.clear()
  for (const p of all) {
    const s = await p.catch(() => null)
    if (!s) continue
    clearInterval(s.timer)
    s.relay.close()
    s.client.end()
    await rm(s.dir, { recursive: true, force: true }).catch(() => {})
  }
}
