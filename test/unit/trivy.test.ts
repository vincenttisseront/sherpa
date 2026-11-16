import { describe, expect, it } from 'vitest'
import { trivySettingsInput } from '../../shared/schemas/trivy'
import { blockingFindings, newFindings, parseTrivyReport, trivyScript } from '../../server/lib/trivy'

const report = JSON.stringify({
  ArtifactName: 'python:3.12-slim',
  Metadata: { OS: { Family: 'debian', Name: '13.1' }, ImageID: 'sha256:abc' },
  Results: [
    { Target: 'python:3.12-slim (debian 13.1)', Vulnerabilities: [
      { VulnerabilityID: 'CVE-2026-0002', PkgName: 'libssl3', InstalledVersion: '3.0.1', FixedVersion: '3.0.2', Severity: 'HIGH', Title: 'openssl : dépassement', PrimaryURL: 'https://avd.aquasec.com/nvd/cve-2026-0002' },
      { VulnerabilityID: 'CVE-2026-0001', PkgName: 'zlib1g', InstalledVersion: '1.2', Severity: 'CRITICAL' },
      { VulnerabilityID: 'CVE-2026-0003', PkgName: 'bash', InstalledVersion: '5.2', Severity: 'LOW' },
      { VulnerabilityID: 'CVE-2026-0002', PkgName: 'libssl3', InstalledVersion: '3.0.1', FixedVersion: '3.0.2', Severity: 'HIGH' },
    ] },
    { Target: 'usr/local/lib/python3.12/site-packages/pip', Vulnerabilities: null },
    { Target: 'Python', Vulnerabilities: [{ VulnerabilityID: 'GHSA-xxxx', PkgName: 'setuptools', InstalledVersion: '70.0', FixedVersion: '78.1.1', Severity: 'WEIRD' }] },
  ],
})

describe('Trivy', () => {
  it('réglages par défaut : chaque lundi à 03:00, sévérités usuelles', () => {
    expect(trivySettingsInput.parse({})).toMatchObject({ enabled: true, cron: '0 3 * * 1', timezone: 'Europe/Paris', severities: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'], scope: 'managed', image: 'aquasec/trivy:0.67.2', notifyMin: 'CRITICAL' })
    expect(trivySettingsInput.safeParse({ cron: '0 3 * *' }).success).toBe(false)
    expect(trivySettingsInput.safeParse({ image: 'aquasec/trivy' }).success).toBe(false)
  })

  it('script : options, AC supplémentaires, référence d\'image contrôlée', () => {
    const s = trivyScript('ghcr.io/acme/app:1.2', { severities: ['CRITICAL', 'HIGH'], ignoreUnfixed: true, dbRepository: 'registre.interne/trivy-db:2', timeoutMin: 10 })
    expect(s).toContain('--severity CRITICAL,HIGH --timeout 10m --ignore-unfixed --db-repository registre.interne/trivy-db:2 \'ghcr.io/acme/app:1.2\'')
    expect(s).toContain('export SSL_CERT_FILE=/tmp/ca.pem')
    expect(trivyScript({ source: true }, { severities: ['HIGH'], ignoreUnfixed: false, dbRepository: null, timeoutMin: 5 })).toContain('exec trivy fs --quiet --format json --output /tmp/trivy.json --scanners vuln --severity HIGH --timeout 5m \'/src\'')
    expect(() => trivyScript('app; rm -rf /', { severities: ['HIGH'], ignoreUnfixed: false, dbRepository: null, timeoutMin: 5 })).toThrow(/refusée/)
  })

  it('rapport : décompte sans doublon, tri par gravité, système', () => {
    const r = parseTrivyReport(report)
    expect(r).toMatchObject({ os: 'debian 13.1', imageId: 'sha256:abc', fixable: 2, counts: { CRITICAL: 1, HIGH: 1, MEDIUM: 0, LOW: 1, UNKNOWN: 1 } })
    expect(r.findings.map(f => f.id)).toEqual(['CVE-2026-0001', 'CVE-2026-0002', 'CVE-2026-0003', 'GHSA-xxxx'])
    expect(r.targets).toEqual(['python:3.12-slim (debian 13.1)', 'usr/local/lib/python3.12/site-packages/pip', 'Python'])
    expect(r.findings[1]).toMatchObject({ pkg: 'libssl3', fixed: '3.0.2', url: 'https://avd.aquasec.com/nvd/cve-2026-0002', target: 'python:3.12-slim (debian 13.1)' })
  })

  it('blocage au build : seuil et correctif publié', () => {
    const { findings } = parseTrivyReport(report)
    expect(blockingFindings(findings, { buildBlock: 'off', buildBlockFixableOnly: false })).toEqual([])
    expect(blockingFindings(findings, { buildBlock: 'CRITICAL', buildBlockFixableOnly: true })).toEqual([])
    expect(blockingFindings(findings, { buildBlock: 'CRITICAL', buildBlockFixableOnly: false }).map(f => f.id)).toEqual(['CVE-2026-0001'])
    expect(blockingFindings(findings, { buildBlock: 'HIGH', buildBlockFixableOnly: true }).map(f => f.id)).toEqual(['CVE-2026-0002'])
  })

  it('nouvelles vulnérabilités à partir d\'une sévérité', () => {
    const { findings } = parseTrivyReport(report)
    expect(newFindings(null, findings, 'CRITICAL').map(f => f.id)).toEqual(['CVE-2026-0001'])
    expect(newFindings(findings.slice(0, 1), findings, 'HIGH').map(f => f.id)).toEqual(['CVE-2026-0002'])
  })
})
