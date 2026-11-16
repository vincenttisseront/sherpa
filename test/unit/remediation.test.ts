import { describe, expect, it } from 'vitest'
import type { Finding } from '../../shared/schemas/trivy'
import { compareVersions, groupFindings, minimalFix, newIssueUrl, parseIssueUrl, patchDockerfileOsUpgrade, patchRequirements, repositoryFromUrl, requestBody, requestTitle, webUrlOf } from '../../server/lib/remediation'
import { imageRefKey, imageSubjectKey } from '../../shared/schemas/remediation'

const f = (o: Partial<Finding> & Pick<Finding, 'id' | 'pkg' | 'installed' | 'severity'>): Finding => ({ fixed: null, title: null, url: null, target: 'python:3.12-slim (debian 13.7)', ...o })

const findings: Finding[] = [
  f({ id: 'CVE-2026-1', pkg: 'libssl3', installed: '3.0.1-1', fixed: '3.0.1-2', severity: 'HIGH', url: 'https://avd.aquasec.com/nvd/cve-2026-1', class: 'os-pkgs' }),
  f({ id: 'CVE-2026-2', pkg: 'libssl3', installed: '3.0.1-1', fixed: '3.0.1-3', severity: 'CRITICAL', class: 'os-pkgs' }),
  f({ id: 'CVE-2026-3', pkg: 'ncurses-bin', installed: '6.5', severity: 'HIGH' }),
  f({ id: 'CVE-2018-18074', pkg: 'requests', installed: '2.19.0', fixed: '2.20.0', severity: 'HIGH', target: 'requirements.txt', class: 'lang-pkgs', type: 'pip' }),
  f({ id: 'CVE-2023-32681', pkg: 'requests', installed: '2.19.0', fixed: '2.31.0', severity: 'MEDIUM', target: 'requirements.txt', class: 'lang-pkgs', type: 'pip' }),
  f({ id: 'CVE-2024-1', pkg: 'jinja2', installed: '2.10', fixed: '2.11.3, 3.1.4', severity: 'LOW', target: 'Python' }),
]

describe('demandes de correction : versions et regroupement', () => {
  it('compare les versions et choisit la plus petite version corrigée au-dessus de l\'installée', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1)
    expect(compareVersions('2.0.0-1+deb12u2', '2.0.0-1+deb12u1')).toBe(1)
    expect(compareVersions('v2.31.0', '2.31.0')).toBe(0)
    expect(minimalFix('2.20.0, 2.31.0', '2.19.0')).toBe('2.20.0')
    expect(minimalFix('2.11.3, 3.1.4', '3.0.0')).toBe('3.1.4')
    expect(minimalFix(null, '1')).toBeNull()
  })

  it('regroupe par paquet : sévérité la plus haute, version qui corrige tout, système ou application', () => {
    const g = groupFindings(findings, { minSeverity: 'MEDIUM', fixableOnly: true })
    expect(g.map(x => [x.pkg, x.kind, x.severity, x.fixed, x.vulns.map(v => v.id)])).toEqual([
      ['libssl3', 'os', 'CRITICAL', '3.0.1-3', ['CVE-2026-2', 'CVE-2026-1']],
      ['requests', 'lang', 'HIGH', '2.31.0', ['CVE-2018-18074', 'CVE-2023-32681']],
    ])
    expect(groupFindings(findings, { minSeverity: 'HIGH', fixableOnly: false }).map(x => x.pkg)).toEqual(['libssl3', 'ncurses-bin', 'requests'])
    expect(groupFindings(findings, { minSeverity: 'LOW', fixableOnly: true }).find(x => x.pkg === 'jinja2')).toMatchObject({ kind: 'lang', fixed: '2.11.3' })
  })
})

describe('demandes de correction : modifications de fichiers', () => {
  it('monte les versions épinglées des requirements (sans jamais descendre)', () => {
    const text = '# deps\nRequests[socks] == 2.19.0  # http\nflask==3.0.0\njinja2>=2.10\nurllib3==2.5.0 ; python_version >= "3.8"\n'
    const r = patchRequirements(text, new Map([['requests', '2.31.0'], ['Flask', '2.0.0'], ['jinja2', '3.1.4'], ['urllib3', '2.6.0']]))
    expect(r.text).toBe('# deps\nRequests[socks] == 2.31.0  # http\nflask==3.0.0\njinja2>=2.10\nurllib3==2.6.0 ; python_version >= "3.8"\n')
    expect(r.changed).toEqual([{ pkg: 'Requests', from: '2.19.0', to: '2.31.0' }, { pkg: 'urllib3', from: '2.5.0', to: '2.6.0' }])
  })

  it('met à jour les paquets système après le dernier FROM, une seule fois', () => {
    const df = 'FROM node:22 AS build\nRUN npm ci\nFROM python:3.12-slim\nUSER app\nCMD ["python"]\n'
    const p = patchDockerfileOsUpgrade(df, 'apt')!
    expect(p.from).toBe('python:3.12-slim')
    expect(p.text.split('\n').slice(2, 6)).toEqual(['FROM python:3.12-slim', '# Correctifs de sécurité des paquets système (demande de correction de la console de déploiement)', 'RUN apt-get update && apt-get upgrade -y --no-install-recommends && rm -rf /var/lib/apt/lists/*', 'USER app'])
    expect(patchDockerfileOsUpgrade(p.text, 'apt')).toBeNull()
    expect(patchDockerfileOsUpgrade('FROM alpine:3.20\n', 'apk')!.text).toContain('RUN apk upgrade --no-cache')
    expect(patchDockerfileOsUpgrade('# rien\n', 'apt')).toBeNull()
  })
})

describe('demandes de correction : dépôt et liens', () => {
  it('dépôt déclaré par l\'image, lien d\'issue ou de PR, interface web', () => {
    expect(webUrlOf('https://api.github.com')).toBe('https://github.com')
    expect(webUrlOf('https://ghe.interne/api/v3')).toBe('https://ghe.interne')
    expect(repositoryFromUrl('https://github.com/Acme/app.git', 'https://api.github.com')).toBe('Acme/app')
    expect(repositoryFromUrl('https://github.com/acme/app/tree/main/docker', 'https://api.github.com')).toBe('acme/app')
    expect(repositoryFromUrl('https://gitlab.com/acme/app', 'https://api.github.com')).toBeNull()
    expect(parseIssueUrl('https://github.com/acme/app/pull/42/files', 'https://api.github.com')).toEqual({ repository: 'acme/app', number: 42, kind: 'pr' })
    expect(parseIssueUrl('https://github.com/acme/app/issues/7', 'https://api.github.com')).toEqual({ repository: 'acme/app', number: 7, kind: 'issue' })
    expect(imageRefKey('platform/shop-web:r-0003-abc')).toBe('platform/shop-web')
    expect(imageSubjectKey('ep', 'python:3.12-slim')).toBe('image:ep:python:3.12-slim')
    const url = newIssueUrl('https://api.github.com', 'acme/app', 'Titre', 'x'.repeat(10_000), 100)
    expect(url.startsWith('https://github.com/acme/app/issues/new?title=Titre&body=')).toBe(true)
    expect(decodeURIComponent(url.split('body=')[1]!)).toHaveLength(103)
  })
})

describe('demandes de correction : texte', () => {
  const groups = groupFindings(findings, { minSeverity: 'HIGH', fixableOnly: false })
  const base = {
    mode: 'pr' as const,
    subject: { kind: 'image' as const, name: 'platform/shop-web:r-0003-abc', os: 'debian 13.7', scannedAt: '2026-10-30T10:00:00Z', scanner: 'aquasec/trivy:0.67.2' },
    counts: { CRITICAL: 1, HIGH: 3, MEDIUM: 1, LOW: 1, UNKNOWN: 0 },
    fixable: 4,
    selection: { minSeverity: 'HIGH' as const, fixableOnly: false },
    groups,
    baseImage: 'python:3.12-slim',
    osFamily: 'apt' as const,
    changes: [{ path: 'requirements.txt', summary: 'requests 2.19.0 → 2.31.0' }, { path: 'Dockerfile', summary: 'mise à jour des paquets système après `FROM python:3.12-slim`' }],
    context: [],
  }

  it('français : titre, tableaux, correction proposée, modifications de la PR', () => {
    expect(requestTitle({ ...base, lang: 'fr' })).toBe('Sécurité : corriger 4 vulnérabilité(s) critique(s) et haute(s) de l\'image platform/shop-web:r-0003-abc')
    const b = requestBody({ ...base, lang: 'fr' })
    expect(b).toContain('## Vulnérabilités à corriger dans l\'image `platform/shop-web:r-0003-abc`')
    expect(b).toContain('**1 critique(s)**, **3 haute(s)**, 1 moyenne(s), 1 basse(s)')
    expect(b).toContain('### Paquets du système (debian 13.7)')
    expect(b).toContain('| libssl3 | 3.0.1-1 | 3.0.1-3 | Critique | CVE-2026-2, [CVE-2026-1](https://avd.aquasec.com/nvd/cve-2026-1) |')
    expect(b).toContain('| ncurses-bin | 6.5 | _pas encore_ | Haute | CVE-2026-3 |')
    expect(b).toContain('| requirements.txt | requests | 2.19.0 | 2.20.0 | Haute |')
    expect(b).toContain('RUN apt-get update && apt-get upgrade -y --no-install-recommends && rm -rf /var/lib/apt/lists/*')
    expect(b).toContain('- `requests` 2.19.0 → **2.20.0** (requirements.txt)')
    expect(b).toContain('- 1 vulnérabilité(s) n\'ont pas encore de correctif publié')
    expect(b).toContain('### Modifications de cette PR')
    expect(b).not.toContain('### Contexte')
  })

  it('anglais, issue, contexte interne seulement si demandé', () => {
    const b = requestBody({ ...base, lang: 'en', mode: 'issue', context: ['Server: srv1'] })
    expect(requestTitle({ ...base, lang: 'en' })).toBe('Security: fix 4 critical/high vulnerabilities in image platform/shop-web:r-0003-abc')
    expect(b).toContain('### OS packages (debian 13.7)')
    expect(b).toContain('| Package | Installed | Fixed in | Severity | Vulnerabilities |')
    expect(b).not.toContain('### Changes in this PR')
    expect(b).toContain('### Context\n\n- Server: srv1')
  })
})
