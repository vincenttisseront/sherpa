import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { contentSecurityPolicy, inlineScriptHashes } from '../../server/utils/security-headers'

const h = (s: string) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`

describe('CSP à empreintes', () => {
  it('ne retient que les scripts en ligne exécutables', () => {
    const html = `<script type="importmap">{"imports":{}}</script>
<script type="module" src="/_nuxt/a.js"></script>
<script>window.__NUXT__={}</script>
<script type="application/json" id="__NUXT_DATA__">[1,2]</script>
<script>window.__NUXT__={}</script>`
    expect(inlineScriptHashes(html).sort()).toEqual([h('{"imports":{}}'), h('window.__NUXT__={}')].sort())
  })
  it('politique stricte : pas de unsafe-inline pour les scripts, pas d\'iframe, pas d\'objet', () => {
    const csp = contentSecurityPolicy([h('x')])
    expect(csp).toContain(`script-src 'self' ${h('x')}`)
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/)
    expect(csp).toContain('frame-ancestors \'none\'')
    expect(csp).toContain('object-src \'none\'')
  })
})
