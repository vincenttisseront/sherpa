import { describe, expect, it } from 'vitest'
import { accessStats, clfTime, parseAccessLine, parseErrorLine } from '../../shared/utils/access-log'
import { nginxLogFormatConfig, nginxSiteConfig } from '../../server/lib/proxy/nginx-sites'

describe('journal d\'accès nginx', () => {
  it('format de la console : domaine, durées, amont', () => {
    const e = parseAccessLine('{"platform":1,"time":"2026-10-30T10:00:01+01:00","host":"App.ex.fr","remote":"10.0.0.5","method":"GET","uri":"/api/x?y=1","proto":"HTTP/1.1","scheme":"https","status":502,"bytes":157,"duration":0.051,"upstream":"172.18.0.4:3000","upstreamStatus":"502","upstreamTime":"0.020, 0.030","referer":"","agent":"curl/8"}')
    expect(e).toMatchObject({ time: '2026-10-30T09:00:01.000Z', host: 'app.ex.fr', method: 'GET', path: '/api/x?y=1', status: 502, bytes: 157, duration: 0.051, upstream: '172.18.0.4:3000', upstreamTime: 0.05, referer: null, agent: 'curl/8', format: 'console' })
  })

  it('nginx-proxy (vhost, préfixe forego) et combined', () => {
    expect(parseAccessLine('nginx.1    | wiki.ex.fr 10.0.0.9 - - [30/Oct/2026:10:00:00 +0000] "POST /login HTTP/2.0" 302 0 "-" "Mozilla/5.0" "172.18.0.7:3000"'))
      .toMatchObject({ host: 'wiki.ex.fr', remote: '10.0.0.9', method: 'POST', path: '/login', status: 302, upstream: '172.18.0.7:3000', format: 'vhost', time: '2026-10-30T10:00:00.000Z' })
    expect(parseAccessLine('10.0.0.9 - - [30/Oct/2026:10:00:00 +0100] "GET / HTTP/1.1" 200 615 "-" "curl/8" "-"'))
      .toMatchObject({ host: null, remote: '10.0.0.9', status: 200, bytes: 615, format: 'combined', time: '2026-10-30T09:00:00.000Z' })
    expect(parseAccessLine('/docker-entrypoint.sh: Configuration complete; ready for start up')).toBeNull()
    expect(clfTime('xx')).toBeNull()
  })

  it('lignes d\'erreur de nginx', () => {
    expect(parseErrorLine('2026/10/30 10:00:00 [error] 29#29: *7 connect() failed (111: Connection refused) while connecting to upstream, client: 10.0.0.5, server: app.ex.fr, request: "GET / HTTP/1.1", host: "app.ex.fr"'))
      .toMatchObject({ level: 'error', host: 'app.ex.fr', message: expect.stringContaining('connect() failed') })
  })

  it('statistiques : statuts, centiles, domaines, chemins, minutes', () => {
    const line = (host: string, status: number, d: number, min: number, path = '/') => parseAccessLine(JSON.stringify({ platform: 1, time: `2026-10-30T10:0${min}:00Z`, host, remote: '10.0.0.1', method: 'GET', uri: path, status, bytes: 100, duration: d, upstream: '-', upstreamTime: '-' }))!
    const s = accessStats([line('a.ex.fr', 200, 0.01, 0), line('a.ex.fr', 500, 0.5, 0, '/x?q=1'), line('b.ex.fr', 404, 0.02, 1), line('a.ex.fr', 200, 0.03, 1)])
    expect(s).toMatchObject({ requests: 4, bytes: 400, p50: 0.03, p95: 0.5, status: { '2xx': 2, '4xx': 1, '5xx': 1 } })
    expect(s.hosts[0]).toMatchObject({ host: 'a.ex.fr', requests: 3, errors: 1 })
    expect(s.paths).toContainEqual({ path: 'a.ex.fr/x', requests: 1, errors: 1 })
    expect(s.perMinute).toEqual([{ minute: '2026-10-30T10:00:00.000Z', requests: 2, errors: 1 }, { minute: '2026-10-30T10:01:00.000Z', requests: 2, errors: 0 }])
  })

  it('sites : journal au format de la console, désactivé ou hérité', () => {
    const exp = [{ service: 'web', host: 'a.ex.fr', port: 80, pathPrefix: null }]
    const base = { redirectToHttps: false, sslCertificate: null, sslCertificateKey: null }
    expect(nginxSiteConfig('s', 'o', exp, { ...base, accessLog: 'json' })).toContain('access_log /dev/stdout platform_json;')
    expect(nginxSiteConfig('s', 'o', exp, { ...base, accessLog: 'off' })).toContain('access_log off;')
    expect(nginxSiteConfig('s', 'o', exp, { ...base, accessLog: 'default' })).not.toContain('access_log')
    const fmt = nginxLogFormatConfig()
    expect(fmt).toMatch(/^log_format platform_json escape=json '\{"platform":1,/m)
    // Une ligne produite par ce format est relue.
    const sample = /escape=json '(.*)';/.exec(fmt)![1]!.replace(/\$\w+/g, m => ({ $status: '200', $body_bytes_sent: '12', $request_time: '0.004' } as Record<string, string>)[m] ?? 'x')
    expect(parseAccessLine(sample)).toMatchObject({ status: 200, bytes: 12, duration: 0.004, format: 'console' })
  })
})
