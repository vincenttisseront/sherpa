/**
 * Avant tout : charge l'utilisateur connecté, puis équipe fetch (donc $fetch,
 * useFetch et les appels directs, quel que soit l'import utilisé) pour
 * - joindre le jeton CSRF de la session à toute requête modifiante vers l'API ;
 * - renvoyer vers la page de connexion quand la session a expiré.
 */
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export default defineNuxtPlugin({
  name: 'auth',
  enforce: 'pre',
  async setup() {
    const { me, refresh } = useAuth()
    await refresh()

    if (import.meta.client) {
      const nativeFetch = window.fetch.bind(window)
      window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request ? input : null
        const url = new URL(req ? req.url : String(input), window.location.href)
        const method = (init?.method ?? req?.method ?? 'GET').toUpperCase()
        const api = url.origin === window.location.origin && url.pathname.startsWith('/api/')
        const token = me.value?.csrfToken
        if (api && UNSAFE.has(method) && token) {
          const headers = new Headers(init?.headers ?? req?.headers)
          headers.set('x-csrf-token', token)
          if (req && !init) input = new Request(req, { headers })
          else init = { ...init, headers }
        }
        // Suivi des opérations : libellé, étape publiée par le serveur, durée.
        const label = api ? activityLabel(method, url.pathname) : null
        let res: Response
        if (label) {
          // getRandomValues existe aussi hors contexte sécurisé (contrairement à randomUUID).
          const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('')
          const headers = new Headers(init?.headers ?? (req && !init ? req.headers : undefined))
          headers.set('x-progress-id', id)
          if (req && !init) input = new Request(req, { headers })
          else init = { ...init, headers }
          const activity = useActivity()
          activity.start(id, label)
          const reveal = setTimeout(() => activity.update(id, { visible: true }), 350)
          let polling = true
          const poll = async () => {
            // Première lecture rapide : même une opération courte montre son étape.
            for (let i = 0; polling; i++) {
              await new Promise(r => setTimeout(r, i === 0 ? 200 : 500))
              if (!polling) break
              const p = await nativeFetch(`/api/progress/${id}`).then(r => (r.ok ? r.json() : null)).catch(() => null) as { label: string, current: number | null, total: number | null, done: string[] } | null
              if (p && polling) activity.update(id, { step: p.label, current: p.current, total: p.total, done: p.done })
            }
          }
          void poll()
          try {
            res = await nativeFetch(input, init)
            activity.finish(id, res.ok ? 'success' : 'error')
          }
          catch (err) {
            activity.finish(id, 'error')
            throw err
          }
          finally {
            polling = false
            clearTimeout(reveal)
          }
        }
        else {
          res = await nativeFetch(input, init)
        }
        if (api && res.status === 401 && !url.pathname.startsWith('/api/auth/')) {
          me.value = { authenticated: false }
          await navigateTo(`/login?returnTo=${encodeURIComponent(useRoute().fullPath)}`)
        }
        return res
      }
    }
  },
})
