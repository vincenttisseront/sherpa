import { describe, expect, it } from 'vitest'
import { FilePathError, backupSuffix, browsableMount, listScript, parseList, safeRelPath, writeScript } from '../../server/lib/service-files'

describe('explorateur des fichiers d\'un service', () => {
  it('chemins relatifs normalisés, jamais hors du montage', () => {
    expect(safeRelPath('')).toBe('')
    expect(safeRelPath('/core.conf')).toBe('core.conf')
    expect(safeRelPath('./plugins//x/')).toBe('plugins/x')
    expect(() => safeRelPath('../etc/passwd')).toThrow(FilePathError)
    expect(() => safeRelPath('a/../../b')).toThrow(FilePathError)
    expect(() => safeRelPath('a\nb')).toThrow(FilePathError)
  })

  it('montages montrables : volumes et dossiers, pas les sockets ni le système', () => {
    expect(browsableMount({ type: 'bind', source: '/srv/deluge/config', name: null, destination: '/config' })).toBe(true)
    expect(browsableMount({ type: 'volume', source: '/var/lib/docker/volumes/x/_data', name: 'x', destination: '/data' })).toBe(true)
    expect(browsableMount({ type: 'bind', source: '/var/run/docker.sock', name: null, destination: '/var/run/docker.sock' })).toBe(false)
    expect(browsableMount({ type: 'bind', source: '/proc', name: null, destination: '/host/proc' })).toBe(false)
    expect(browsableMount({ type: 'tmpfs', source: null, name: null, destination: '/tmp' })).toBe(false)
  })

  it('scripts : chemin échappé pour le shell', () => {
    expect(listScript("a'b")).toContain(`t='/m/a'\\''b'`)
    expect(writeScript('core.conf', 'abc', '.bak')).toContain(`!= 'abc'`)
    expect(writeScript('new.conf', null, '.bak')).toContain('@@EXISTS')
  })

  it('lecture d\'un dossier : dossiers d\'abord, types, droits', () => {
    const r = parseList(['@@DIR', 'regular file|120|1761700000|644|911|911|/m/core.conf', 'directory|4096|1761700000|755|911|911|/m/plugins', 'symbolic link|8|1761700000|777|0|0|/m/lien', 'bruit'])
    expect(r.state).toBe('dir')
    expect(r.entries.map(e => [e.name, e.kind, e.mode])).toEqual([['plugins', 'dir', '0755'], ['core.conf', 'file', '0644'], ['lien', 'link', '0777']])
    expect(r.entries[1]).toMatchObject({ size: 120, uid: 911, gid: 911 })
  })

  it('copie de l\'ancienne version horodatée', () => {
    expect(backupSuffix(new Date('2026-10-29T11:05:09Z'))).toBe('.console-20261029-110509.bak')
  })
})

describe('téléchargement', () => {
  it('nom proposé sans guillemets ni caractères de contrôle', async () => {
    const { downloadName } = await import('../../server/lib/service-files')
    expect(downloadName('core"x.conf')).toBe('core_x.conf')
    expect(downloadName('')).toBe('fichier')
  })
})

describe('envoi', () => {
  it('nom de fichier : un seul élément de chemin', async () => {
    const { safeFileName, uploadCheckScript } = await import('../../server/lib/service-files')
    expect(safeFileName(' up.bin ')).toBe('up.bin')
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'a\nb', 'x'.repeat(256)]) expect(() => safeFileName(bad)).toThrow(FilePathError)
    expect(uploadCheckScript('sous', 'sous/up.bin')).toContain(`t='/m/sous/up.bin'`)
  })
})

describe('suppression et liste', () => {
  it('liste écrite dans un fichier (journal tronqué), suppression d\'un dossier non vide sur demande seulement', async () => {
    const { LIST_OUTPUT, deleteScript, listScript } = await import('../../server/lib/service-files')
    expect(listScript('state')).toContain(`o=${LIST_OUTPUT}`)
    expect(deleteScript('state', false)).toContain('rmdir')
    expect(deleteScript('state', false)).not.toContain('rm -rf')
    expect(deleteScript('state', true)).toContain('rm -rf "$t"')
  })
})

describe('déplacement', () => {
  it('jamais un dossier dans lui-même, ni par-dessus un nom pris', async () => {
    const { moveScript } = await import('../../server/lib/service-files')
    const s = moveScript('plugins', 'plugins/sous')
    expect(s).toContain(`t='/m/plugins'`)
    expect(s).toContain(`d='/m/plugins/sous'`)
    expect(s).toContain('@@INTO')
    expect(s).toContain('@@EXISTS')
  })
})

describe('copie', () => {
  it('propriétaires conservés, suffixe dans le même dossier, jamais un dossier dans lui-même', async () => {
    const { copyScript } = await import('../../server/lib/service-files')
    const s = copyScript('plugins', '')
    expect(s).toContain('cp -a "$t" "$n"')
    expect(s).toContain('.copie')
    expect(s).toContain('@@INTO')
  })
})

describe('droits', () => {
  it('mode octal sans setuid/setgid ; propriétaire jamais « uid: » ; lien : propriétaire seul', async () => {
    const { permissionsScript, validMode } = await import('../../server/lib/service-files')
    expect(['644', '0755', '1777'].every(validMode)).toBe(true)
    expect(['4755', '2755', '999', '75', 'abc'].some(validMode)).toBe(false)
    expect(permissionsScript('a', { mode: null, uid: 1000, gid: null, recursive: false })).toContain(`chown '1000' "$t"`)
    expect(permissionsScript('a', { mode: null, uid: null, gid: 50, recursive: true })).toContain(`chown -R ':50' "$t"`)
    expect(permissionsScript('a', { mode: '640', uid: 1, gid: 2, recursive: false })).toContain('chmod 640 "$t"')
    expect(permissionsScript('a', { mode: '640', uid: null, gid: null, recursive: false })).toContain('@@LINKMODE')
  })
})

describe('recherche', () => {
  it('motif de nom neutralisé, résultats relatifs au montage', async () => {
    const { nameGlob, parseSearch, searchScript } = await import('../../server/lib/service-files')
    expect(nameGlob('a*b[1]?')).toBe('*a\\*b\\[1\\]\\?*')
    expect(searchScript('', 'x', true)).toContain('grep -rlFi -- \'x\'')
    const r = parseSearch('@@DIR\nregular file|10|1761700000|644|0|0|/m/plugins/up2.bin\ndirectory|4096|1761700000|755|0|0|/m/plugins')
    expect(r.results.map(e => [e.path, e.kind])).toEqual([['plugins/up2.bin', 'file'], ['plugins', 'dir']])
  })
})

describe('aperçu des images', () => {
  it('type d\'après l\'extension, rien pour un autre fichier', async () => {
    const { imageTypeOf } = await import('../../shared/utils/image-types')
    expect(imageTypeOf('/config/Logo.PNG')).toBe('image/png')
    expect(imageTypeOf('a/b.svg')).toBe('image/svg+xml')
    expect(imageTypeOf('core.conf')).toBeNull()
    expect(imageTypeOf('png')).toBeNull()
  })
})

describe('extraction', () => {
  it('archives reconnues et dossier d\'extraction ; extraction hors du montage puis copie sans suivre les liens', async () => {
    const { archiveOf } = await import('../../shared/utils/image-types')
    const { extractScript } = await import('../../server/lib/service-files')
    expect(archiveOf('a/app-1.2.zip')).toEqual({ kind: 'zip', folder: 'app-1.2' })
    expect(archiveOf('backup.tar.gz')).toEqual({ kind: 'tar', folder: 'backup' })
    expect(archiveOf('x.TXZ')).toEqual({ kind: 'tar', folder: 'x' })
    expect(archiveOf('core.conf')).toBeNull()
    const s = extractScript('backup.tar.gz', 'tar', 'backup')
    expect(s).toContain('x="$(mktemp -d)"')
    expect(s).toContain('cp -a "$x"/. "$n"/')
    expect(s).toContain('chown -hR')
    expect(s).toContain('@@NOSPACE')
  })
})
