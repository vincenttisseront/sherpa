/**
 * Génère une PKI de test/développement via openssl : une AC, un certificat
 * serveur (localhost) pour le Runner, un certificat client pour la plateforme,
 * et un certificat client signé par une autre AC (cas de refus).
 * NE PAS utiliser en production : la PKI doit être celle de l'entreprise.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface TestPki {
  caCert: string
  serverCert: string
  serverKey: string
  clientCert: string
  clientKey: string
  /** Certificat client signé par une autre AC (doit être refusé). */
  rogueCert: string
  rogueKey: string
}

/** Validité courte par défaut (tests) ; la PKI de développement est générée pour un an. */
export function generatePki(dir: string, days = 2): TestPki {
  const run = (...args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' })
  const ca = (name: string) => run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', String(days), '-subj', `/CN=${name}`, '-keyout', `${name}.key`, '-out', `${name}.crt`)
  const leaf = (name: string, caName: string, cn: string, ext: string) => {
    writeFileSync(join(dir, `${name}.ext`), ext)
    run('req', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${cn}`, '-keyout', `${name}.key`, '-out', `${name}.csr`)
    run('x509', '-req', '-in', `${name}.csr`, '-CA', `${caName}.crt`, '-CAkey', `${caName}.key`, '-CAcreateserial', '-days', String(days), '-out', `${name}.crt`, '-extfile', `${name}.ext`)
  }
  ca('ca')
  ca('rogue-ca')
  leaf('server', 'ca', 'localhost', 'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n')
  leaf('client', 'ca', 'platform', 'extendedKeyUsage=clientAuth\n')
  leaf('rogue', 'rogue-ca', 'platform', 'extendedKeyUsage=clientAuth\n')
  const r = (f: string) => readFileSync(join(dir, f), 'utf8')
  return {
    caCert: r('ca.crt'),
    serverCert: r('server.crt'),
    serverKey: r('server.key'),
    clientCert: r('client.crt'),
    clientKey: r('client.key'),
    rogueCert: r('rogue.crt'),
    rogueKey: r('rogue.key'),
  }
}
