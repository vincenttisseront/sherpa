import { describe, expect, it } from 'vitest'
import { migrationItems, parseSizes, sizeScript, volumeLabels } from '../../server/lib/stack-migration'

const from = { projectDir: '/srv/dep/shop', releasesDir: '/srv/dep/shop/releases', runtimeDir: '/srv/data/shop', releaseDir: '/srv/dep/shop/releases/r-0002-aa' }
const to = { runtimeDir: '/opt/data/shop', releaseDir: '/opt/dep/shop/releases/r-0002-aa' }

describe('migration : éléments à copier', () => {
  it('release, données, volumes et dossiers externes ; système et dossiers internes ignorés', () => {
    const { items, ignored } = migrationItems([
      { service: 'db', type: 'volume', source: null, name: 'shop_pg', destination: '/var/lib/postgresql/data', rw: true },
      { service: 'web', type: 'volume', source: null, name: 'shop_pg', destination: '/x', rw: false },
      { service: 'web', type: 'bind', source: '/srv/data/shop/uploads', name: null, destination: '/uploads', rw: true },
      { service: 'db', type: 'bind', source: '/host_mnt/srv/data/shop/pg', name: null, destination: '/pg', rw: true },
      { service: 'web', type: 'bind', source: '/srv/dep/shop/releases/r-0002-aa/source/nginx.conf', name: null, destination: '/etc/nginx.conf', rw: false },
      { service: 'web', type: 'bind', source: '/srv/media/', name: null, destination: '/media', rw: true },
      { service: 'web', type: 'bind', source: '/etc/localtime', name: null, destination: '/etc/localtime', rw: false },
      { service: 'wt', type: 'bind', source: '/var/run/docker.sock', name: null, destination: '/var/run/docker.sock', rw: true },
      { service: 'web', type: 'bind', source: '/srv/dep/shop/shared/backups', name: null, destination: '/b', rw: true },
      { service: 'web', type: 'bind', source: '/srv/dep/shop/releases/r-0001-bb/source', name: null, destination: '/old', rw: false },
    ], from, to)
    expect(items.map(i => [i.id, i.source, i.destination, i.services])).toEqual([
      ['release', from.releaseDir, to.releaseDir, ['web']],
      ['data', from.runtimeDir, to.runtimeDir, ['web', 'db']],
      ['volume:shop_pg', 'shop_pg', 'shop_pg', ['db', 'web']],
      ['bind:/srv/media', '/srv/media', '/srv/media', ['web']],
    ])
    expect(items.find(i => i.id === 'release')!.required).toBe(true)
    expect(ignored.map(i => i.source)).toEqual(['/etc/localtime', '/var/run/docker.sock', '/srv/dep/shop/shared/backups', '/srv/dep/shop/releases/r-0001-bb/source'])
  })

  it('mesure des tailles : dossier, fichier, absent', () => {
    expect(sizeScript(2)).toContain('du -sk /m/1')
    const s = parseSizes(['@@ 0 D 2048', '@@ 1 F 4', '@@ 2 -', 'bruit'])
    expect(s.get(0)).toEqual({ exists: true, isDir: true, bytes: 2048 * 1024 })
    expect(s.get(1)).toEqual({ exists: true, isDir: false, bytes: 4096 })
    expect(s.get(2)).toEqual({ exists: false, isDir: false, bytes: null })
  })

  it('labels d\'un volume recréé : ceux de Compose et de la console seulement', () => {
    expect(volumeLabels({ 'com.docker.compose.project': 'shop', 'com.docker.compose.volume': 'pg', 'other': 'x' })).toEqual({ 'com.docker.compose.project': 'shop', 'com.docker.compose.volume': 'pg' })
  })
})
