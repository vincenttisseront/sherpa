import { describe, expect, it } from 'vitest'
import { Redactor, redactObject, redactPatterns } from '../../server/utils/redact'

describe('masquage des secrets', () => {
  it.each([
    ['token GitHub', 'clone with ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'ghp_'],
    ['PAT GitHub', 'token github_pat_11ABCDEFG0123456789_abcdefghijklmnop', 'github_pat_'],
    ['token Portainer', 'X-API-Key: ptr_AbCdEf0123456789xyz=', 'ptr_'],
    ['Bearer', 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig', 'eyJ'],
    ['password=', 'DB password=SuperSecret42 host=db', 'SuperSecret42'],
    ['URL avec identifiants', 'git clone https://user:hunter22@github.com/org/repo', 'hunter22'],
  ])('masque %s', (_label, input, leaked) => {
    const out = redactPatterns(input)
    expect(out).not.toContain(leaked)
    expect(out).toContain('••••••')
  })

  it('masque les valeurs connues, y compris imbriquées', () => {
    const r = new Redactor().add('s3cr3t-value').add('s3cr3t-value-long')
    expect(r.redact('a=s3cr3t-value-long b=s3cr3t-value')).toBe('a=•••••• b=••••••')
  })

  it('ignore les valeurs trop courtes pour être distinctives', () => {
    expect(new Redactor().add('abc').redact('abc def')).toBe('abc def')
  })

  it('masque les clés sensibles d\'un objet', () => {
    const out = redactObject({ url: 'https://p', token: 'x', nested: { clientSecret: 'y', name: 'ok' } })
    expect(out).toEqual({ url: 'https://p', token: '••••••', nested: { clientSecret: '••••••', name: 'ok' } })
  })
})

describe('secrets en ligne de commande et dans les URL', () => {
  it('masque les options de mot de passe et les identifiants d\'URL, tous schémas', async () => {
    const { redactPatterns } = await import('../../server/utils/redact')
    const out = redactPatterns('app --password hunter2 --db-password=s3cr3t --api-key "k e y" --verbose --url postgres://user:hunter2@db/x redis://:hunter2@r:6379')
    expect(out).not.toMatch(/hunter2|s3cr3t|k e y/)
    expect(out).toContain('--verbose')
    expect(out).toContain('postgres://user:••••••@db/x')
  })
  it('masque le jeton des webhooks Watchtower (journaux de Watchtower)', () => {
    const url = 'generic+http://host.docker.internal:3100/api/watchtower/hook/0697624c-23fa-4cc8-bcc2-76b95e128c25/rw7M5W4NHOtENaMi4fKOha04QE3ky0GcgtivqzvLmHA'
    expect(redactPatterns(url)).toBe('generic+http://host.docker.internal:3100/api/watchtower/hook/0697624c-23fa-4cc8-bcc2-76b95e128c25/••••••')
    expect(redactPatterns('/api/watchtower/profile-hook/0697624c-23fa-4cc8-bcc2-76b95e128c25/abcdefghijklmnopqrstuvwxyz')).not.toContain('abcdefghijklmnop')
  })
})

describe('masquage : lignes pathologiques', () => {
  it('traite en temps linéaire une longue suite de « - » (journal d\'un conteneur)', () => {
    const line = `${'-'.repeat(200_000)}x`
    const t0 = performance.now()
    redactPatterns(line)
    expect(performance.now() - t0).toBeLessThan(500)
  })
  it('masque toujours les options de ligne de commande à secret', () => {
    expect(redactPatterns('run --db-password hunter2 --aws-secret-access-key=abc123')).not.toMatch(/hunter2|abc123/)
  })
})
