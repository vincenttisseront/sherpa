import { describe, expect, it } from 'vitest'
import { CONSOLE_HOST, isLoopbackHost, urlHost, withConsoleHost } from '../../shared/utils/console-host'

describe('hôte de la console vu depuis ses conteneurs', () => {
  it.each(['localhost', 'LOCALHOST', '127.0.0.1', '127.1.2.3', '::1', '[::1]', '0.0.0.0', ' localhost '])('boucle locale : %s', (h) => {
    expect(isLoopbackHost(h)).toBe(true)
  })
  it.each([CONSOLE_HOST, '10.0.0.5', 'docker-01.interne', 'localhost-01', ''])('hôte joignable ou vide : %s', (h) => {
    expect(isLoopbackHost(h)).toBe(false)
  })
  it('URL de l\'agent : hôte lu, boucle locale remplacée en gardant schéma et port', () => {
    expect(urlHost('https://localhost:9001')).toBe('localhost')
    expect(urlHost('pas une url')).toBe('')
    expect(withConsoleHost('https://127.0.0.1:9001/')).toBe(`https://${CONSOLE_HOST}:9001`)
  })
})
