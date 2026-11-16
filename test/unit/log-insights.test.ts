import { describe, expect, it } from 'vitest'
import { analyzeLogs } from '../../shared/utils/log-insights'

describe('analyse des logs', () => {
  it('Deluge : exception libtorrent → fichier d\'état corrompu (cause précise, l\'exception générique masquée)', () => {
    const r = analyzeLogs([
      '[info] Deluge starting',
      'terminate called after throwing an instance of \'libtorrent::system_error\'',
      '  what():  invalid type requested from entry',
    ])
    expect(r.map(i => i.id)).toEqual(['libtorrent-state'])
    expect(r[0]!.fix).toContain('torrents.fastresume')
  })

  it('exception C++ générique : raison « what(): » jointe à l\'exemple', () => {
    const r = analyzeLogs(['terminate called after throwing an instance of \'std::runtime_error\'', '  what():  bad config'])
    expect(r[0]).toMatchObject({ id: 'cpp-terminate', count: 1 })
    expect(r[0]!.sample).toContain('what():  bad config')
  })

  it('varken / InfluxDB : identifiants refusés ; compte et dernière occurrence', () => {
    const r = analyzeLogs([
      'GET /query HTTP/1.1" 401 48',
      'influxdb.exceptions.InfluxDBClientError: 401: {"code":"unauthorized","message":"Unauthorized"}',
      'Traceback (most recent call last):',
      'influxdb.exceptions.InfluxDBClientError: 401: {"code":"unauthorized","message":"Unauthorized"}',
    ])
    const auth = r.find(i => i.id === 'auth')!
    expect(auth.count).toBe(2)
    expect(auth.lastIndex).toBe(3)
    expect(r.some(i => i.id === 'python-traceback')).toBe(true)
  })

  it('causes courantes reconnues, erreurs avant avertissements', () => {
    const r = analyzeLogs([
      'connect ECONNREFUSED 10.0.0.3:5432',
      'mkdir: cannot create directory \'/config/logs\': Permission denied',
      'Error: listen EADDRINUSE: address already in use :::8080',
      'write /data/x: no space left on device',
      'could not translate host name "postgres" to address: Name or service not known',
    ])
    expect(r.map(i => i.id)).toEqual(['dns', 'no-space', 'port-in-use', 'permission', 'conn-refused'])
  })

  it('logs sains : rien', () => {
    expect(analyzeLogs(['Server started on :8080', 'GET / 200'])).toEqual([])
  })
})
