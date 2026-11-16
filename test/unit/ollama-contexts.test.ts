/**
 * Contextes des fonctions d'assistance Ollama (fonctions pures) : ce qui part vers le modèle pour
 * un déploiement en échec, un rapport tech support, un historique de ressources et des proxies.
 */
import { describe, expect, it } from 'vitest'
import { analysisExplainInput } from '../../shared/schemas/ollama'
import { analysisParts, deploymentParts, diagnosticLines, DIGEST_MAX_EVENTS, digestNarrative, digestParts, metricsParts, plainNarrative, proxyParts, seriesStats, supportParts, supportWeight, vulnerabilityParts } from '../../server/lib/ollama/contexts'
import type { DeploymentDetailDto } from '../../shared/schemas/deployments'
import { groupFindings } from '../../server/lib/remediation'
import type { Finding } from '../../shared/schemas/trivy'
import type { TargetDiagnostic } from '../../shared/schemas/diagnostic'
import type { MetricPoint, MetricsDto } from '../../shared/schemas/metrics'
import type { ProxyMapDto } from '../../shared/schemas/proxy-map'

const text = (parts: { lines: readonly string[] }[]): string => parts.flatMap(p => p.lines).join('\n')

describe('déploiement en échec', () => {
  const detail = {
    project: { id: 'p', name: 'Billing' },
    environment: { name: 'prod', isProduction: true },
    server: { name: 'hote-1' },
    action: 'deploy',
    status: 'FAILED',
    failedFrom: 'HEALTH_CHECKING',
    error: 'Healthcheck en échec',
    startedAt: '2026-11-16T09:00:00.000Z',
    finishedAt: '2026-11-16T09:03:00.000Z',
    statusDurations: { PULLING: 12, HEALTH_CHECKING: 120 },
    statusDetails: { HEALTH_CHECKING: { message: 'web : unhealthy', level: 'error' } },
    release: { number: 7, sourceKind: 'github' },
    options: { skipBuild: false, cleanBuild: true, noPull: false, upgrade: false },
  } as unknown as DeploymentDetailDto

  it('met les faits, les étapes et le journal, avec le poids le plus fort sur le journal', () => {
    const parts = deploymentParts(detail, null, ['ligne 1', 'ligne 2'])
    expect(parts.map(p => p.title)).toEqual(['Déploiement', 'Dernier message de chaque étape', 'Journal du déploiement'])
    const out = text(parts)
    expect(out).toContain('Billing')
    expect(out).toContain('(production)')
    expect(out).toContain('Échec depuis le statut : HEALTH_CHECKING')
    expect(out).toContain('PULLING 12 s, HEALTH_CHECKING 120 s')
    expect(out).toContain('Options : cleanBuild')
    expect(out).toContain('[HEALTH_CHECKING] error : web : unhealthy')
    expect(parts.at(-1)).toMatchObject({ weight: 4, lines: ['ligne 1', 'ligne 2'] })
  })

  it('ajoute l\'état réel de la stack quand un diagnostic est disponible', () => {
    const diagnostic = {
      summary: { severity: 'error', title: 'Un service est arrêté', detail: null },
      services: [{
        service: 'web', state: 'exited', health: 'unhealthy', exitCode: 137, oomKilled: true, restartCount: 4, image: 'ghcr.io/x/web:1',
        findings: [{ severity: 'error', title: 'Tué par manque de mémoire', detail: 'limite de 256 Mio' }],
        healthLog: [{ exitCode: 1, output: 'connection refused' }],
        notableLogs: ['panic: out of memory'],
      }],
    } as unknown as TargetDiagnostic
    const parts = deploymentParts(detail, diagnostic, [])
    expect(parts.map(p => p.title)).toContain('État réel de la stack sur l\'hôte')
    const lines = diagnosticLines(diagnostic)
    expect(lines[0]).toBe('Synthèse : [error] Un service est arrêté')
    expect(lines.join('\n')).toContain('tué par manque de mémoire (OOM)')
    expect(lines.join('\n')).toContain('healthcheck (code 1) : connection refused')
    expect(lines).toContain('  | panic: out of memory')
  })
})

describe('rapport tech support', () => {
  it('découpe le rapport par section et pondère l\'état avant la configuration', () => {
    const report = [
      '=== Cible ============',
      'projet: Billing',
      '=== Journal du dernier déploiement ====',
      'ERROR boom',
      '=== Compose final ====',
      'services:',
      '=== Autre ====',
      'x',
    ].join('\n')
    const parts = supportParts(report)
    expect(parts.map(p => [p.title, p.weight])).toEqual([['Cible', 3], ['Journal du dernier déploiement', 3], ['Compose final', 0.4], ['Autre', 1]])
  })

  it.each([
    ['Diagnostic', 3],
    ['Conteneurs', 2],
    ['Déploiements récents', 2],
    ['Configuration : variables', 0.4],
    ['Réseaux', 1],
  ])('poids de « %s » : %s', (title, weight) => {
    expect(supportWeight(title)).toBe(weight)
  })
})

describe('séries de ressources', () => {
  it('rend null pour une série vide', () => {
    expect(seriesStats([])).toBeNull()
  })

  it('calcule min, moyenne, max et tendance', () => {
    expect(seriesStats([10, 10, 10, 50, 50, 50, 90, 90, 90])).toMatchObject({ min: 10, max: 90, avg: 50, first: 10, last: 90, trend: 'en hausse' })
    expect(seriesStats([90, 90, 90, 50, 50, 50, 10, 10, 10])?.trend).toBe('en baisse')
    expect(seriesStats([40, 41, 40, 42, 41, 40])?.trend).toBe('stable')
  })

  it('ne confond pas une petite variation avec une tendance', () => {
    expect(seriesStats([2, 2, 3, 3, 4, 4])?.trend).toBe('stable')
  })
})

describe('historique des ressources', () => {
  const point = (i: number, over: Partial<MetricPoint> = {}): MetricPoint => ({
    t: new Date(Date.UTC(2026, 10, 16, 8, i)).toISOString(), cpu: 20, memory: 100 * 1_048_576, memoryLimit: 256 * 1_048_576, restarts: 0, ...over,
  })

  it('résume CPU, mémoire en % de la limite et redémarrages gagnés', () => {
    const dto = {
      range: '1h', container: 'web', tracked: true, alerts: [],
      points: [point(0), point(1, { cpu: 95, restarts: 1 }), point(2, { restarts: 3 })],
    } as unknown as MetricsDto
    const parts = metricsParts({ dto, deployments: [{ at: '2026-11-16T08:01:00.000Z', action: 'deploy', status: 'FAILED' }] })
    const out = text(parts)
    expect(out).toContain('Conteneur : web · Période : 1h · 3 relevés')
    expect(out).toContain('limite de 256 Mio')
    expect(out).toContain('Redémarrages sur la période : 3 (compteur de 0 à 3)')
    expect(out).toContain('2026-11-16T08:01Z deploy → FAILED')
    expect(parts.find(p => p.title === 'Relevés (heure UTC)')?.lines).toHaveLength(3)
  })

  it('espace les relevés pour ne pas dépasser une soixantaine de lignes', () => {
    const points = Array.from({ length: 1000 }, (_, i) => point(i % 60, { t: new Date(Date.UTC(2026, 10, 1) + i * 60_000).toISOString() }))
    const dto = { range: '7d', container: 'web', tracked: true, alerts: [], points } as unknown as MetricsDto
    const series = metricsParts({ dto, deployments: [] }).find(p => p.title === 'Relevés (heure UTC)')!
    expect(series.lines.length).toBeLessThanOrEqual(70)
    expect(series.lines.at(-1)).toContain('2026-11-01')
  })

  it('indique l\'absence de relevé sans planter', () => {
    const dto = { range: '1h', container: 'web', tracked: true, alerts: [], points: [] } as unknown as MetricsDto
    const out = text(metricsParts({ dto, deployments: [] }))
    expect(out).toContain('CPU : aucun relevé')
    expect(out).toContain('Mémoire : aucun relevé')
  })
})

describe('reverse proxies', () => {
  const map = {
    topology: {
      proxies: [{
        kind: 'traefik', version: '3.1', networks: ['edge'], hostPorts: [{ host: 443, container: 443, protocol: 'tcp' }],
        container: { id: 'abc', name: 'traefik', image: 'traefik:3.1', running: true },
        traefik: { entrypoints: [{ name: 'websecure', address: ':443' }], certResolvers: [{ name: 'le' }] },
        warnings: ['API non protégée'],
      }],
      routes: [{
        router: 'billing@docker', kind: 'http', provider: 'docker', hosts: ['billing.example.com'], pathPrefix: null, entrypoints: ['websecure'],
        tls: true, certResolver: 'le', redirectsToHttps: false, middlewares: [], container: { name: 'billing-web' }, targetPort: 8080, targetUrl: null,
        network: 'edge', reattach: null, warnings: [],
      }],
      warnings: [],
    },
    certificates: [{ host: 'billing.example.com', proxyId: 'abc', state: 'error', issuer: null, notAfter: null, staging: false, error: 'rate limited' }],
    resolvers: [{ name: 'le', challenge: 'http', dnsProvider: null, certificates: 1, error: null }],
    acmeErrors: [{ at: '2026-11-16T07:00:00Z', domains: ['billing.example.com'], message: 'too many failed authorizations' }],
    containers: [{ id: 'zzz', name: 'db', project: null, hostPorts: [{ host: 5432, container: 5432, protocol: 'tcp' }] }],
  } as unknown as ProxyMapDto

  it('décrit proxies, routes, certificats, erreurs ACME et ports hors proxy', () => {
    const parts = proxyParts(map)
    const out = text(parts)
    expect(out).toContain('traefik « traefik » (image traefik:3.1, en marche)')
    expect(out).toContain('résolveurs ACME : le')
    expect(out).toContain('! API non protégée')
    expect(out).toContain('billing@docker (http, docker) | hôtes billing.example.com')
    expect(out).toContain('→ billing-web:8080 via edge')
    expect(out).toContain('billing.example.com : error, erreur : rate limited')
    expect(out).toContain('too many failed authorizations')
    expect(out).toContain('db : 5432→5432/tcp')
  })

  it('ne rend que des sections nommées, les vides étant ignorées plus tard par le tassement', () => {
    expect(proxyParts(map).map(p => p.title)).toContain('Routes')
  })
})

describe('blocages de l\'analyse Compose', () => {
  const raw = {
    ok: false,
    issues: [
      { severity: 'info', code: 'service.excluded', service: 'cache', message: 'Service exclu' },
      { severity: 'error', code: 'port.forbidden', service: 'db', message: 'Le port 5432 ne peut pas être publié' },
      { severity: 'warning', code: 'image.latest', service: 'web', message: 'Image sans version', image: 'nginx' },
    ],
    ports: [
      { service: 'db', entry: '5432:5432', published: 5432, protocol: 'tcp', policy: 'forbidden', accepted: false, reason: 'Port réservé aux bases de données' },
      { service: 'web', entry: '8080:80', published: 8080, protocol: 'tcp', policy: 'allowed', accepted: true, reason: 'Plage autorisée' },
    ],
    mounts: [{ service: 'web', type: 'bind', source: '/etc', target: '/host-etc', readOnly: false, accepted: false, reason: 'Hors liste blanche des volumes' }],
    networks: [{ name: 'host', external: true, status: 'refused', reason: 'Réseau non autorisé' }],
    exposures: [{ service: 'web', host: 'app.interdit.test', port: 80, router: 'web@docker', accepted: false, reason: 'Domaine hors des domaines autorisés' }],
    // Champs qui ne doivent JAMAIS atteindre le modèle :
    sourceYaml: 'services:\n  db:\n    environment:\n      POSTGRES_PASSWORD: sup3r-s3cret',
    finalYaml: 'password: sup3r-s3cret',
    variables: [{ name: 'DB_PASSWORD', value: 'sup3r-s3cret' }],
  }

  it('ne garde que la liste blanche : ni Compose source ou final, ni variables', () => {
    const parsed = analysisExplainInput.parse(raw)
    expect(Object.keys(parsed).sort()).toEqual(['exposures', 'issues', 'mounts', 'networks', 'ok', 'ports'])
    const sent = text(analysisParts(parsed))
    expect(sent).not.toContain('sup3r-s3cret')
    expect(sent).not.toContain('POSTGRES_PASSWORD')
    expect(sent).not.toContain('DB_PASSWORD')
  })

  it('range les erreurs avant les avertissements et ne détaille que ce qui est refusé', () => {
    const parts = analysisParts(analysisExplainInput.parse(raw))
    const issues = parts.find(p => p.title === 'Constats de l\'analyse')!.lines
    expect(issues.map(l => l.slice(0, 9))).toEqual(['[error] p', '[warning]', '[info] se'])
    expect(text(parts)).toContain('Port réservé aux bases de données')
    expect(text(parts)).not.toContain('Plage autorisée')
    expect(text(parts)).toContain('Hors liste blanche des volumes')
    expect(text(parts)).toContain('Réseau non autorisé')
    expect(text(parts)).toContain('Domaine hors des domaines autorisés')
    expect(parts[0]!.lines[0]).toBe('Compose non conforme : 1 erreur(s), 1 avertissement(s)')
  })

  it('refuse des champs hors bornes', () => {
    expect(analysisExplainInput.safeParse({ ...raw, issues: [{ severity: 'error', code: 'x', message: 'm'.repeat(601) }] }).success).toBe(false)
    expect(analysisExplainInput.safeParse({ ...raw, ports: [{ ...raw.ports[0], published: 70_000 }] }).success).toBe(false)
    expect(analysisExplainInput.safeParse({ ...raw, issues: Array.from({ length: 151 }, () => raw.issues[0]) }).success).toBe(false)
  })
})

describe('vulnérabilités Trivy', () => {
  const f = (id: string, pkg: string, installed: string, fixed: string | null, severity: Finding['severity'], target = 'debian 12'): Finding => ({ id, pkg, installed, fixed, severity, title: `titre secret de ${id}`, url: `https://avd.example/${id}`, target, class: 'os-pkgs' })
  const findings = [
    f('CVE-2026-0001', 'openssl', '3.0.1', '3.0.9', 'CRITICAL'),
    f('CVE-2026-0002', 'openssl', '3.0.1', '3.0.12', 'HIGH'),
    f('CVE-2026-0003', 'zlib', '1.2.1', null, 'HIGH'),
    f('CVE-2026-0004', 'curl', '8.0.0', '8.1.0', 'LOW'),
  ]
  const ctx = (over: Partial<Parameters<typeof vulnerabilityParts>[0]> = {}) => ({
    type: 'image' as const, name: 'ghcr.io/acme/app:1.4', os: 'debian 12', scannedAt: '2026-11-16T03:00:00.000Z',
    counts: { CRITICAL: 1, HIGH: 2, MEDIUM: 0, LOW: 1, UNKNOWN: 0 }, fixable: 3,
    groups: groupFindings(findings, { minSeverity: 'HIGH', fixableOnly: false }),
    selection: { minSeverity: 'HIGH', fixableOnly: false }, usedBy: [], ...over,
  })

  it('regroupe par paquet avec la version corrigée minimale la plus haute et signale l\'absence de correctif', () => {
    const parts = vulnerabilityParts(ctx())
    const pk = parts.find(p => p.title.startsWith('Paquets'))!
    expect(pk.weight).toBe(4)
    expect(pk.lines[0]).toContain('openssl 3.0.1 → 3.0.12 · paquet système · sévérité max CRITICAL · 2 vulnérabilité(s) : CVE-2026-0001 (CRITICAL), CVE-2026-0002 (HIGH)')
    expect(pk.lines[1]).toContain('zlib 1.2.1 → aucun correctif publié')
    expect(text(parts)).not.toContain('curl')
    expect(parts[0]!.lines[1]).toContain('CRITICAL 1, HIGH 2, MEDIUM 0, LOW 1, UNKNOWN 0')
  })

  it('n\'envoie ni titre de vulnérabilité ni lien, et le contexte interne seulement s\'il est fourni', () => {
    expect(text(vulnerabilityParts(ctx()))).not.toContain('titre secret')
    expect(text(vulnerabilityParts(ctx()))).not.toContain('avd.example')
    expect(vulnerabilityParts(ctx()).map(p => p.title)).not.toContain('Utilisé par')
    const withCtx = vulnerabilityParts(ctx({ usedBy: [{ label: 'Billing (prod)', services: ['web'] }] }))
    expect(text(withCtx)).toContain('Billing (prod) (services web)')
  })

  it('borne le nombre de paquets et de CVE par paquet', () => {
    const many = Array.from({ length: 200 }, (_, i) => f(`CVE-2026-${1000 + i}`, `pkg${i}`, '1.0.0', '1.0.1', 'HIGH'))
    const groups = groupFindings(many, { minSeverity: 'HIGH', fixableOnly: false })
    const lines = vulnerabilityParts(ctx({ groups })).find(p => p.title.startsWith('Paquets'))!.lines
    expect(lines).toHaveLength(121)
    expect(lines.at(-1)).toContain('80 paquet(s) moins graves non listés')
    const same = Array.from({ length: 10 }, (_, i) => f(`CVE-2026-${2000 + i}`, 'big', '1.0.0', '1.0.1', 'HIGH'))
    const one = vulnerabilityParts(ctx({ groups: groupFindings(same, { minSeverity: 'HIGH', fixableOnly: false }) })).find(p => p.title.startsWith('Paquets'))!.lines[0]!
    expect(one).toContain('10 vulnérabilité(s)')
    expect(one).toContain('… +4')
  })
})

describe('résumé périodique', () => {
  const ev = (event: string, severity: string, title: string, min: number) => ({ event, severity, title, createdAt: new Date(Date.UTC(2026, 10, 10, 7, 0) - min * 60_000) })
  const label = (e: string) => `L:${e}`

  it('décomptes en en-tête, évènements par gravité, graves d\'abord et plus fortement pondérés', () => {
    const { header, parts } = digestParts([ev('deployment.succeeded', 'info', 'Billing déployé', 5), ev('deployment.failed', 'error', 'Billing en échec', 30), ev('resource.alert', 'warning', 'Mémoire haute', 10), ev('deployment.failed', 'error', 'Portail en échec', 20)], label)
    expect(header[0]).toBe('4 évènement(s) : 2 erreur(s), 1 alerte(s), 1 information(s)')
    expect(header[1]).toBe('Par type : L:deployment.failed 2, L:deployment.succeeded 1, L:resource.alert 1')
    expect(parts.map(p => p.title)).toEqual(['Évènements (erreur)', 'Évènements (alerte)', 'Évènements (information)'])
    expect(parts[0]!.lines).toEqual(['2026-11-10T06:40Z · L:deployment.failed · Portail en échec', '2026-11-10T06:30Z · L:deployment.failed · Billing en échec'])
    expect(parts[0]!.weight).toBeGreaterThan(parts[2]!.weight!)
  })

  it('borne le nombre d\'évènements transmis, les plus graves conservés', () => {
    const many = [...Array.from({ length: 300 }, (_, i) => ev('deployment.succeeded', 'info', `ok ${i}`, i)), ev('deployment.failed', 'error', 'échec', 1)]
    const { header, parts } = digestParts(many, label)
    expect(header[0]).toContain('301 évènement(s)')
    expect(parts.flatMap(p => p.lines)).toHaveLength(DIGEST_MAX_EVENTS)
    expect(parts[0]!.title).toBe('Évènements (erreur)')
  })

  it('ne garde que du texte brut : balises, liens et mentions de masse retirés', () => {
    const t = plainNarrative('Voir <https://evil.example/x> et https://evil.example/y <!channel> @channel <script>alert(1)</script> **gras** ok')
    expect(t).not.toMatch(/https?:|<|>|@channel/)
    expect(t).toContain('[lien retiré]')
    expect(t).toContain('ok')
  })

  it('synthèse puis points à surveiller, bornés', () => {
    expect(digestNarrative({ summary: ' Deux échecs sur Billing. ', actions: ['Relancer Billing', '', 'Lire les logs'] })).toBe('Deux échecs sur Billing.\nÀ surveiller :\n• Relancer Billing\n• Lire les logs')
    expect(digestNarrative({ summary: 'Calme.', actions: [] })).toBe('Calme.')
    expect(digestNarrative({ summary: 'x'.repeat(5000), actions: [] }, 100)).toHaveLength(100)
    expect(digestNarrative({ summary: 'a', actions: Array.from({ length: 9 }, (_, i) => `étape ${i}`) }).match(/•/g)).toHaveLength(5)
  })
})
