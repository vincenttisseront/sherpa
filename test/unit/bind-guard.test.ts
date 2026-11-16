import { describe, expect, it } from 'vitest'
import { evaluateBind, validateVolumeRulePath, type VolumeRuleLike } from '../../server/utils/bind-guard'

const rules: VolumeRuleLike[] = [
  { hostPath: '/srv/shared/certs', mode: 'ro', environmentId: null, projectId: null, enabled: true },
  { hostPath: '/data/uploads', mode: 'rw', environmentId: 'prod', projectId: null, enabled: true },
  { hostPath: '/data/legacy', mode: 'rw', environmentId: null, projectId: null, enabled: false },
  { hostPath: '/data/billing', mode: 'rw', environmentId: null, projectId: 'p-billing', enabled: true },
]
const base = { environmentId: 'prod', projectId: 'p-app', mode: 'ro' as const, projectRuntimeDir: '/srv/apps-data/production/app', workingRoots: ['/srv/deployments/production', '/srv/builds/production', '/srv/tmp/production'] }

describe('evaluateBind', () => {
  it('autorise un sous-chemin d\'une règle en lecture seule', () => {
    expect(evaluateBind({ ...base, hostPath: '/srv/shared/certs/app.pem' }, rules).allowed).toBe(true)
  })
  it('refuse l\'écriture sur une règle en lecture seule', () => {
    expect(evaluateBind({ ...base, hostPath: '/srv/shared/certs', mode: 'rw' }, rules).reason).toMatch(/lecture seule/)
  })
  it('respecte la portée environnement', () => {
    expect(evaluateBind({ ...base, hostPath: '/data/uploads', mode: 'rw' }, rules).allowed).toBe(true)
    expect(evaluateBind({ ...base, environmentId: 'dev', hostPath: '/data/uploads' }, rules).allowed).toBe(false)
  })
  it('respecte la portée projet', () => {
    expect(evaluateBind({ ...base, hostPath: '/data/billing' }, rules).allowed).toBe(false)
    expect(evaluateBind({ ...base, projectId: 'p-billing', hostPath: '/data/billing' }, rules).allowed).toBe(true)
  })
  it('ignore les règles désactivées', () => {
    expect(evaluateBind({ ...base, hostPath: '/data/legacy' }, rules).allowed).toBe(false)
  })
  it('autorise toujours le répertoire runtime du projet', () => {
    expect(evaluateBind({ ...base, hostPath: '/srv/apps-data/production/app/pg', mode: 'rw' }, []).allowed).toBe(true)
    expect(evaluateBind({ ...base, hostPath: '/srv/apps-data/production/other', mode: 'rw' }, []).allowed).toBe(false)
  })
  it.each(['/var/run/docker.sock', '/run/docker.sock', '/etc/passwd', '/', '/srv/shared/certs/../../../etc', '/home/u/agent.sock'])('refuse %s', (p) => {
    expect(evaluateBind({ ...base, hostPath: p }, [{ hostPath: '/home', mode: 'rw', environmentId: null, projectId: null, enabled: true }]).allowed).toBe(false)
  })
  it('refuse de monter les sources et releases', () => {
    expect(evaluateBind({ ...base, hostPath: '/srv/deployments/production/app' }, [{ hostPath: '/srv', mode: 'rw', environmentId: null, projectId: null, enabled: true }]).reason).toMatch(/travail/)
  })
})

describe('validateVolumeRulePath', () => {
  it('refuse les règles trop larges ou dangereuses', () => {
    expect(validateVolumeRulePath('/data', [])).toMatch(/dossier partagé/)
    expect(validateVolumeRulePath('/tools', [])).toBeNull()
    expect(validateVolumeRulePath('/var/lib/docker/volumes', [])).toMatch(/système/)
    expect(validateVolumeRulePath('/srv/deployments', ['/srv/deployments/production'])).toMatch(/Recouvre/)
    expect(validateVolumeRulePath('/srv/shared/certs', ['/srv/deployments/production'])).toBeNull()
  })
})
