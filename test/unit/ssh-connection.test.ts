import { describe, expect, it } from 'vitest'
import { serverConnectionInput, serverPatch } from '../../shared/schemas/servers'
import { hostKeyFingerprint, hostKeyType, scanFailure } from '../../server/adapters/ssh/session'
import { computeCapabilities } from '../../server/services/discovery'

const FP = `SHA256:${'A'.repeat(43)}`
const ssh = { transport: 'ssh', host: 'docker-01.interne', port: 22, username: 'deploy', hostKey: FP }

describe('saisie de connexion agent ou SSH', () => {
  it('sans transport : agent Portainer (clients existants)', () => {
    const v = serverConnectionInput.parse({ url: 'https://h:9001/', token: 'x'.repeat(12), tlsVerify: true })
    expect(v).toMatchObject({ transport: 'agent', url: 'https://h:9001' })
  })
  it('SSH par clé : clé privée exigée, socket Docker par défaut', () => {
    expect(serverConnectionInput.safeParse({ ...ssh, auth: 'key' }).success).toBe(false)
    const v = serverConnectionInput.parse({ ...ssh, auth: 'key', privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----' })
    expect(v).toMatchObject({ transport: 'ssh', dockerSocket: '/var/run/docker.sock' })
  })
  it('SSH par mot de passe : mot de passe exigé', () => {
    expect(serverConnectionInput.safeParse({ ...ssh, auth: 'password' }).success).toBe(false)
    expect(serverConnectionInput.safeParse({ ...ssh, auth: 'password', password: 'secret-de-test' }).success).toBe(true)
  })
  it('empreinte de clé d\'hôte et hôte vérifiés', () => {
    expect(serverConnectionInput.safeParse({ ...ssh, hostKey: 'MD5:aa:bb', auth: 'password', password: 'p' }).success).toBe(false)
    expect(serverConnectionInput.safeParse({ ...ssh, host: 'hôte; rm -rf /', auth: 'password', password: 'p' }).success).toBe(false)
    expect(serverConnectionInput.safeParse({ ...ssh, username: 'root;id', auth: 'password', password: 'p' }).success).toBe(false)
    expect(serverPatch.safeParse({ dockerSocket: 'relatif.sock' }).success).toBe(false)
  })
})

describe('clé d\'hôte et capacités SSH', () => {
  it('empreinte OpenSSH (SHA-256 base64 sans remplissage) et type lu dans la clé', () => {
    const key = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 7)])
    expect(hostKeyFingerprint(key)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/)
    expect(hostKeyType(key)).toBe('ssh-ed25519')
  })
  it('capacités : Docker et fichiers par SSH, sans seuils de version d\'agent', () => {
    expect(computeCapabilities('Docker 29.5.2 (SSH)', [{ kind: 'docker_standalone' }])).toEqual({ dockerViaSsh: true, filesViaSftp: true, dockerStandalone: true, dockerSwarm: false, kubernetes: false })
  })
  it('échec de lecture de la clé : cause lisible (boucle locale, refus, nom, délai)', () => {
    expect(scanFailure('localhost', 22, { code: 'ECONNREFUSED' })).toMatch(/host\.docker\.internal/)
    expect(scanFailure('127.0.0.1', 22, null)).toMatch(/conteneur de la console/)
    expect(scanFailure('10.0.0.5', 22, { code: 'ECONNREFUSED' })).toMatch(/^Connexion refusée par 10\.0\.0\.5:22/)
    expect(scanFailure('vm-01', 22, { code: 'ENOTFOUND' })).toMatch(/^Nom vm-01 introuvable/)
    expect(scanFailure('10.0.0.5', 2222, { level: 'client-timeout', message: 'Timed out while waiting for handshake' })).toMatch(/^Délai dépassé vers 10\.0\.0\.5:2222/)
  })
})
