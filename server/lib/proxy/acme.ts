/**
 * État ACME du Traefik géré : certificats présents dans acme.json et erreurs
 * récentes des logs. Seuls des domaines, émetteurs, dates et messages sont
 * extraits : les clés privées du stockage ACME ne sont jamais conservées.
 */
import { X509Certificate } from 'node:crypto'
import { redactPatterns } from '../../utils/redact'

export interface AcmeCertificate { domains: string[], issuer: string, notAfter: string, staging: boolean }
export interface AcmeStore { accountRegistered: boolean, certificates: AcmeCertificate[] }

/** Lecture du stockage ACME de Traefik (format v2/v3 : { <résolveur>: { Account, Certificates } }). */
export function parseAcmeStore(text: string, resolver: string): AcmeStore {
  let raw: Record<string, { Account?: { Registration?: unknown } | null, Certificates?: { domain?: { main?: string, sans?: string[] | null }, certificate?: string }[] | null }>
  try {
    raw = JSON.parse(text)
  }
  catch {
    return { accountRegistered: false, certificates: [] }
  }
  const r = raw?.[resolver]
  const certificates: AcmeCertificate[] = []
  for (const c of r?.Certificates ?? []) {
    const domains = [c.domain?.main, ...(c.domain?.sans ?? [])].filter((d): d is string => !!d).map(d => d.toLowerCase())
    if (!c.certificate) continue
    try {
      const pem = Buffer.from(c.certificate, 'base64').toString('utf8')
      const first = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(pem)?.[0]
      if (!first) continue
      const x = new X509Certificate(first)
      const issuer = x.issuer.split('\n').find(l => l.startsWith('CN=') || l.startsWith('O='))?.replace(/^(CN|O)=/, '') ?? x.issuer
      certificates.push({ domains, issuer, notAfter: new Date(x.validTo).toISOString(), staging: /staging|fake|\(STAGING\)/i.test(x.issuer) })
    }
    catch {
      // Certificat illisible : ignoré.
    }
  }
  return { accountRegistered: !!r?.Account?.Registration, certificates }
}

export interface AcmeLogError { at: string | null, domains: string[], message: string }

// eslint-disable-next-line no-control-regex
const ANSI = /\u001B\[[0-9;]*m/g

/** Erreurs ACME récentes dans les logs de Traefik (niveau ERR/WRN), message résumé et masqué. */
export function parseAcmeLogs(lines: readonly string[]): AcmeLogError[] {
  const out: AcmeLogError[] = []
  for (const raw of lines) {
    const line = raw.replace(ANSI, '')
    // Lignes ACME uniquement : un « certificate » isolé peut venir d'autre chose (vérification de version…).
    if (!/\b(ERR|WRN|error|level=error)\b/.test(line) || !/acme|certresolver|providerName=[\w.-]*\.acme/i.test(line)) continue
    const at = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)/.exec(line)?.[1] ?? null
    // domains=["a.example.org","b.example.org"] (v3) ou domains=[a.example.org b.example.org].
    const list = /domains?=\[([^\]]*)\]/.exec(line)?.[1] ?? /domain=("?)([^\s"]+)\1/.exec(line)?.[2] ?? ''
    const domains = [...new Set(list.split(/[\s,]+/).map(d => d.replace(/"/g, '').toLowerCase()).filter(d => /^[a-z0-9*.-]+\.[a-z0-9-]+$/.test(d)))]
    const err = /error="((?:[^"\\]|\\.)*)"/.exec(line)?.[1] ?? line.replace(/^.*?(ERR|WRN)\s*/, '')
    out.push({ at, domains, message: redactPatterns(err.replace(/\\"/g, '"').replace(/\s+/g, ' ').trim()).slice(0, 400) })
  }
  return out
}

/** Le certificat couvre-t-il l'hôte (nom exact ou joker d'un niveau) ? */
export function covers(cert: AcmeCertificate, host: string): boolean {
  const h = host.toLowerCase()
  return cert.domains.some(d => d === h || (d.startsWith('*.') && h.endsWith(d.slice(1)) && !h.slice(0, -d.length + 1).includes('.')))
}

export type DomainAcmeState = 'valid' | 'expiring' | 'expired' | 'error' | 'pending'

export function domainState(host: string, certs: readonly AcmeCertificate[], errors: readonly AcmeLogError[], now = Date.now()): { state: DomainAcmeState, certificate: AcmeCertificate | null, error: string | null } {
  const cert = certs.filter(c => covers(c, host)).sort((a, b) => b.notAfter.localeCompare(a.notAfter))[0] ?? null
  const lastError = [...errors].reverse().find(e => e.domains.includes(host.toLowerCase())) ?? null
  if (cert) {
    const left = new Date(cert.notAfter).getTime() - now
    const state: DomainAcmeState = left <= 0 ? 'expired' : left < 21 * 864e5 ? 'expiring' : 'valid'
    return { state, certificate: cert, error: state === 'valid' ? null : lastError?.message ?? null }
  }
  return { state: lastError ? 'error' : 'pending', certificate: null, error: lastError?.message ?? null }
}
