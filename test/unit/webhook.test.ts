import { describe, expect, it } from 'vitest'
import { type WebhookTargetInfo, githubStateOf, parseEvent, selectTargets, signatureOf, skipRequested, verifySignature } from '../../server/lib/webhook'

const SECRET = 'a'.repeat(64)
const T = (environment: string, o: Partial<WebhookTargetInfo> = {}): WebhookTargetInfo => ({ targetId: `t-${environment}`, environment, enabled: true, branch: null, ...o })
const push = (branch: string | null, o: Record<string, unknown> = {}) => parseEvent('push', { ref: branch ? `refs/heads/${branch}` : 'refs/tags/v1', after: 'b'.repeat(40), repository: { full_name: 'Acme/App' }, head_commit: { message: 'fix' }, ...o })

describe('signature', () => {
  it('acceptée seulement avec le bon secret et le bon corps', () => {
    const body = '{"zen":"ok"}'
    const sig = signatureOf(SECRET, body)
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/)
    expect(verifySignature(SECRET, body, sig)).toBe(true)
    expect(verifySignature(SECRET, `${body} `, sig)).toBe(false)
    expect(verifySignature('b'.repeat(64), body, sig)).toBe(false)
  })
  it('refuse les en-têtes absents ou mal formés', () => {
    expect(verifySignature(SECRET, 'x', undefined)).toBe(false)
    expect(verifySignature(SECRET, 'x', 'sha1=abcd')).toBe(false)
    expect(verifySignature(SECRET, 'x', 'sha256=zz')).toBe(false)
    expect(verifySignature(SECRET, 'x', '')).toBe(false)
  })
})

describe('parseEvent', () => {
  it('push : branche, commit, suppression', () => {
    expect(push('main')).toMatchObject({ kind: 'push', branch: 'main', sha: 'b'.repeat(40), deleted: false, repository: 'Acme/App' })
    expect(push('feature/x/y')).toMatchObject({ branch: 'feature/x/y' })
    expect(push(null)).toMatchObject({ branch: null })
    expect(push('main', { deleted: true })).toMatchObject({ deleted: true })
    expect(push('main', { after: '0'.repeat(40) })).toMatchObject({ deleted: true })
  })
  it('release, ping et évènements inconnus ; charge utile quelconque sans erreur', () => {
    expect(parseEvent('release', { action: 'published', release: { tag_name: 'v2', prerelease: false }, repository: { full_name: 'a/b' } })).toMatchObject({ kind: 'release', tag: 'v2', prerelease: false })
    expect(parseEvent('ping', {})).toEqual({ kind: 'ping' })
    expect(parseEvent('issues', {})).toEqual({ kind: 'other', name: 'issues' })
    expect(parseEvent('push', null)).toMatchObject({ kind: 'push', branch: null, repository: '' })
    expect(parseEvent('push', 'texte')).toMatchObject({ kind: 'push' })
  })
})

describe('selectTargets', () => {
  const source = { repository: 'acme/app', refType: 'branch' as const, ref: 'main' }
  it('branche → environnements : celle de la source par défaut, ou la leur', () => {
    const targets = [T('production'), T('staging', { branch: 'develop' }), T('dev', { enabled: false, branch: 'develop' })]
    expect(selectTargets(push('main'), source, targets)).toMatchObject({ action: 'deploy', targets: [{ environment: 'production' }], branch: 'main' })
    expect(selectTargets(push('develop'), source, targets)).toMatchObject({ action: 'deploy', targets: [{ environment: 'staging' }] })
    expect(selectTargets(push('feature/x'), source, targets)).toMatchObject({ action: 'ignore', reason: expect.stringContaining('feature/x') })
  })
  it('dépôt comparé sans tenir compte de la casse, autre dépôt refusé', () => {
    expect(selectTargets(push('main'), source, [T('production')]).action).toBe('deploy')
    expect(selectTargets(push('main', { repository: { full_name: 'autre/app' } }), source, [T('production')])).toMatchObject({ action: 'ignore', reason: expect.stringContaining('différent') })
  })
  it('ignorés : tag poussé, branche supprimée, [skip deploy], aucun environnement activé, évènement non géré', () => {
    expect(selectTargets(push(null), source, [T('production')])).toMatchObject({ action: 'ignore', reason: expect.stringContaining('tag') })
    expect(selectTargets(push('main', { deleted: true }), source, [T('production')])).toMatchObject({ action: 'ignore' })
    expect(selectTargets(push('main', { head_commit: { message: 'wip [skip deploy]' } }), source, [T('production')])).toMatchObject({ action: 'ignore', reason: expect.stringContaining('skip deploy') })
    expect(selectTargets(push('main'), source, [T('production', { enabled: false })])).toMatchObject({ action: 'ignore', reason: expect.stringContaining('activé') })
    expect(selectTargets(parseEvent('issues', {}), source, [T('production')])).toMatchObject({ action: 'ignore' })
    expect(selectTargets(push('main'), null, [T('production')])).toMatchObject({ action: 'ignore' })
  })
  it('release : environnements qui suivent les tags, publiée et stable seulement', () => {
    const tagSource = { repository: 'acme/app', refType: 'tag' as const, ref: 'v1' }
    const rel = (o: Record<string, unknown> = {}) => parseEvent('release', { action: 'published', release: { tag_name: 'v2', prerelease: false, draft: false, ...o }, repository: { full_name: 'acme/app' } })
    expect(selectTargets(rel(), tagSource, [T('production'), T('staging', { branch: 'develop' })])).toMatchObject({ action: 'deploy', targets: [{ environment: 'production' }], branch: null })
    expect(selectTargets(rel({ prerelease: true }), tagSource, [T('production')]).action).toBe('ignore')
    expect(selectTargets(rel({ draft: true }), tagSource, [T('production')]).action).toBe('ignore')
    expect(selectTargets(rel(), source, [T('production')]).action).toBe('ignore')
    expect(selectTargets(parseEvent('release', { action: 'created', release: {}, repository: { full_name: 'acme/app' } }), tagSource, [T('production')]).action).toBe('ignore')
  })
  it('ping : réponse directe', () => {
    expect(selectTargets(parseEvent('ping', {}), source, [])).toEqual({ action: 'pong' })
  })
  it('source par tag : un environnement peut tout de même suivre une branche', () => {
    const tagSource = { repository: 'acme/app', refType: 'tag' as const, ref: 'v1' }
    expect(selectTargets(push('develop'), tagSource, [T('staging', { branch: 'develop' }), T('production')])).toMatchObject({ action: 'deploy', targets: [{ environment: 'staging' }] })
  })
})

describe('divers', () => {
  it('[skip deploy] et variantes', () => {
    expect(['[skip deploy]', 'x [SKIP DEPLOY]', '[no deploy]', '[skip cd]'].every(skipRequested)).toBe(true)
    expect(skipRequested('deploy [skip ci] ?')).toBe(false)
  })
  it('états GitHub', () => {
    expect(githubStateOf('HEALTHY')?.state).toBe('success')
    expect(githubStateOf('BUILDING')?.state).toBe('in_progress')
    expect(githubStateOf('QUEUED')?.state).toBe('queued')
    expect(['FAILED', 'ROLLED_BACK', 'DEGRADED', 'VALIDATION_FAILED'].map(s => githubStateOf(s)?.state)).toEqual(['failure', 'failure', 'failure', 'failure'])
    expect(githubStateOf('CANCELLED')?.state).toBe('error')
    expect(githubStateOf('STOPPED')).toBeNull()
  })
})
