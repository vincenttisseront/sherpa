import { describe, expect, it } from 'vitest'
import { decidePending } from '../../server/services/pending'
import type { PendingAction } from '../../shared/schemas/projects'

const at = '2026-10-12T12:00:00.000Z'
const action = (check: PendingAction['check']): PendingAction => ({ title: 'Saisir le mot de passe', detail: null, at, by: 'admin', check })
const deployedAt = (iso: string | null) => async (since: string) => !!iso && iso > since

describe('actions en attente : vérifiées, jamais déclarées', () => {
  it('variable puis déploiement : il faut une nouvelle valeur ET un déploiement réussi après elle', async () => {
    const a = action({ kind: 'variable-deployed', name: 'HARBOR_ADMIN_PASSWORD', via: 'harbor-generator' })
    // Valeur déjà présente avant l'action : ne compte pas.
    expect(await decidePending(a, { changedAt: '2026-10-12T11:00:00.000Z', hasValue: true }, deployedAt('2026-10-12T13:00:00.000Z'))).toMatchObject({ done: false, missing: expect.stringMatching(/n'a pas reçu de nouvelle valeur/) })
    // Déployé AVANT d'avoir saisi le mot de passe : pas fait.
    expect(await decidePending(a, { changedAt: '2026-10-12T14:00:00.000Z', hasValue: true }, deployedAt('2026-10-12T13:00:00.000Z'))).toMatchObject({ done: false, missing: expect.stringMatching(/déploiement réussi à faire ensuite/) })
    // Saisi puis déployé : fait.
    expect(await decidePending(a, { changedAt: '2026-10-12T13:00:00.000Z', hasValue: true }, deployedAt('2026-10-12T13:30:00.000Z'))).toEqual({ done: true, missing: null })
  })

  it('variable seule : valeur vide refusée', async () => {
    const a = action({ kind: 'variable', name: 'SMTP_PASSWORD', via: 'variables' })
    expect((await decidePending(a, { changedAt: '2026-10-12T13:00:00.000Z', hasValue: false }, deployedAt(null))).done).toBe(false)
    expect((await decidePending(a, { changedAt: '2026-10-12T13:00:00.000Z', hasValue: true }, deployedAt(null))).done).toBe(true)
  })

  it('déploiement : seul un déploiement réussi postérieur compte', async () => {
    const a = action({ kind: 'deployed' })
    expect((await decidePending(a, { changedAt: null, hasValue: false }, deployedAt('2026-10-12T11:00:00.000Z'))).done).toBe(false)
    expect((await decidePending(a, { changedAt: null, hasValue: false }, deployedAt('2026-10-12T12:30:00.000Z'))).done).toBe(true)
  })
})
