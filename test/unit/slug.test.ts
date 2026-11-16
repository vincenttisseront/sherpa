import { describe, expect, it } from 'vitest'
import { slugFromName, slugTyping } from '../../app/utils/slug'

describe('identifiant de projet', () => {
  it('déduit du nom : minuscules, sans accents, tirets', () => {
    expect(slugFromName('Mon Projet Élevé')).toBe('mon-projet-eleve')
    expect(slugFromName('  API  Paiements (v2) ')).toBe('api-paiements-v2')
    expect(slugFromName('x'.repeat(80))).toHaveLength(63)
  })
  it('saisie manuelle mise en minuscules au fil de la frappe', () => {
    expect(slugTyping('MonID')).toBe('monid')
    expect(slugTyping('Mon ')).toBe('mon-')
    expect(slugTyping('-Abc')).toBe('abc')
  })
})
