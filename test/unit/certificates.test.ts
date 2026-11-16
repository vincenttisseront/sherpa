import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import YAML from 'yaml'
import { CertificateRejected, certificateCovers, parseCertificateBundle } from '../../server/lib/proxy/certificates'
import { managedTraefikArgs, managedTraefikCompose, tlsDynamicConfig } from '../../server/lib/proxy/managed'
import { managedProxyConfig } from '../../shared/schemas/managed-proxy'

// Certificats de test générés localement (openssl), jamais des certificats réels.
const dir = mkdtempSync(join(tmpdir(), 'cert-test-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
function selfSigned(name: string, opts: { days?: number, bits?: number, san?: string } = {}) {
  const key = join(dir, `${name}.key`)
  const crt = join(dir, `${name}.crt`)
  execFileSync('openssl', ['req', '-x509', '-newkey', `rsa:${opts.bits ?? 2048}`, '-nodes', '-keyout', key, '-out', crt, '-days', String(opts.days ?? 90), '-subj', `/CN=${name}`, ...(opts.san ? ['-addext', `subjectAltName=${opts.san}`] : [])], { stdio: 'ignore' })
  return { cert: readFileSync(crt, 'utf8'), key: readFileSync(key, 'utf8') }
}

describe('certificats importés', () => {
  const ok = selfSigned('app.example.org', { san: 'DNS:app.example.org,DNS:*.apps.example.org' })
  const other = selfSigned('other.example.org')

  it('extrait domaines, émetteur, expiration ; signale l\'auto-signé', () => {
    const p = parseCertificateBundle(ok.cert, ok.key)
    expect(p.domains).toEqual(['app.example.org', '*.apps.example.org'])
    expect(p.selfSigned).toBe(true)
    expect(p.keyType).toBe('RSA 2048')
    expect(p.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(p.warnings.join(' ')).toMatch(/auto-signé/)
  })

  it('refuse une clé qui ne correspond pas, une clé dans le champ certificat, une clé RSA faible', () => {
    expect(() => parseCertificateBundle(ok.cert, other.key)).toThrow(/ne correspond pas/)
    expect(() => parseCertificateBundle(`${ok.cert}\n${ok.key}`, ok.key)).toThrow(/contient une clé privée/)
    const weak = selfSigned('weak.example.org', { bits: 1024 })
    expect(() => parseCertificateBundle(weak.cert, weak.key)).toThrow(CertificateRejected)
    expect(() => parseCertificateBundle('pas un certificat', ok.key)).toThrow(/Aucun certificat PEM/)
  })

  it('refuse un certificat expiré', () => {
    expect(() => parseCertificateBundle(ok.cert, ok.key, Date.now() + 400 * 864e5)).toThrow(/expiré/)
  })

  it('couverture : nom exact ou joker d\'un seul niveau', () => {
    const d = ['app.example.org', '*.apps.example.org']
    expect(certificateCovers(d, 'app.example.org')).toBe(true)
    expect(certificateCovers(d, 'x.apps.example.org')).toBe(true)
    expect(certificateCovers(d, 'a.b.apps.example.org')).toBe(false)
    expect(certificateCovers(d, 'example.org')).toBe(false)
  })

  it('Compose du Traefik géré : fournisseur fichier, certificat en config et clé en secret, valeurs par l\'environnement', () => {
    const c = managedProxyConfig.parse({ networks: ['platform-edge'], acme: { enabled: false } })
    const certs = [{ key: 'abc123', isDefault: true }]
    expect(managedTraefikArgs(c, certs)).toContain('--providers.file.directory=/etc/traefik/dynamic')
    const doc = YAML.parse(managedTraefikCompose(c, [], certs))
    expect(doc.services.traefik.secrets).toEqual([{ source: 'key_abc123', target: 'tls_abc123.key', mode: 0o400 }])
    expect(doc.secrets.key_abc123).toEqual({ environment: 'PLATFORM_TLS_KEY_ABC123' })
    expect(doc.configs.cert_abc123.content).toBe('${PLATFORM_TLS_CERT_ABC123}')
    const tls = YAML.parse(tlsDynamicConfig(certs))
    expect(tls.tls.certificates[0]).toEqual({ certFile: '/etc/traefik/certs/abc123.crt', keyFile: '/run/secrets/tls_abc123.key' })
    expect(tls.tls.stores.default.defaultCertificate.certFile).toBe('/etc/traefik/certs/abc123.crt')
    // Aucune valeur de clé dans le Compose.
    expect(managedTraefikCompose(c, [], certs)).not.toMatch(/PRIVATE KEY/)
  })
})
