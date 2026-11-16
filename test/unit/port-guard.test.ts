import { describe, expect, it } from 'vitest'
import { evaluatePort, type PortRuleLike } from '../../server/utils/port-guard'

const rules: PortRuleLike[] = [
  { portFrom: 8000, portTo: 8099, protocol: 'tcp', policy: 'allowed' },
  { portFrom: 8080, portTo: 8080, protocol: 'tcp', policy: 'approval' },
  { portFrom: 3306, portTo: 3306, protocol: 'tcp', policy: 'forbidden', description: 'MySQL' },
]
const base = { containerPort: 80, protocol: 'tcp' as const }

describe('evaluatePort', () => {
  it.each([22, 2375, 2376, 5432, 6379])('interdit %i par défaut', (hostPort) => {
    const d = evaluatePort({ ...base, hostPort, justification: 'justification longue', confirmed: true }, [{ portFrom: 1, portTo: 65535, protocol: 'tcp', policy: 'allowed' }])
    expect(d).toMatchObject({ policy: 'forbidden', accepted: false })
  })

  it('autorise un port de la plage autorisée', () => {
    expect(evaluatePort({ ...base, hostPort: 8001 }, rules)).toMatchObject({ policy: 'allowed', accepted: true })
  })

  it('la validation l\'emporte sur l\'autorisation', () => {
    expect(evaluatePort({ ...base, hostPort: 8080 }, rules)).toMatchObject({ policy: 'approval', accepted: false })
  })

  it('un port sans règle exige justification puis confirmation', () => {
    expect(evaluatePort({ ...base, hostPort: 9500 }, rules).reason).toMatch(/justification/)
    expect(evaluatePort({ ...base, hostPort: 9500, justification: 'Exposition du collecteur syslog' }, rules).reason).toMatch(/confirmation/)
    expect(evaluatePort({ ...base, hostPort: 9500, justification: 'Exposition du collecteur syslog', confirmed: true }, rules)).toMatchObject({ accepted: true })
  })

  it('applique les règles par protocole', () => {
    expect(evaluatePort({ ...base, hostPort: 8001, protocol: 'udp' }, rules).policy).toBe('approval')
  })

  it('rejette les valeurs invalides', () => {
    expect(evaluatePort({ ...base, hostPort: 70000 }, rules).accepted).toBe(false)
    expect(evaluatePort({ ...base, hostPort: 8001, hostIp: '0.0.0.0; rm' }, rules).accepted).toBe(false)
  })
})
