/** Pages réservées aux utilisateurs connectés ; initialisation imposée tant qu'aucun compte n'existe. */
const PUBLIC = ['/login', '/setup']

export default defineNuxtRouteMiddleware(async (to) => {
  const { me, hasAny } = useAuth()
  const isPublic = PUBLIC.includes(to.path) || to.path.startsWith('/invitation/')
  if (me.value?.authenticated) {
    // Double authentification exigée mais pas encore activée : seule la page du compte répond.
    if (me.value.mfaEnrollRequired) return to.path === '/account' ? undefined : navigateTo('/account')
    if (to.path === '/login' || to.path === '/setup') return navigateTo(me.value.onboardingPending ? '/onboarding' : '/')
    // Premier démarrage : l'administrateur arrive sur l'assistant tant qu'il n'est ni terminé ni reporté.
    if (to.path === '/' && me.value.onboardingPending) return navigateTo('/onboarding')
    // Pages réservées : l'API refuse de toute façon, mais l'interface n'affiche pas une page vide.
    const REQUIRED: [string, Parameters<typeof hasAny>[0][]][] = [
      ['/onboarding', ['policy:manage']],
      ['/admin/readiness', ['policy:manage']],
      ['/admin/deploy-policy', ['policy:manage']],
      ['/admin/notifications', ['notification:manage']],
      ['/admin/retention', ['audit:read']],
      ['/admin/dns', ['domain:manage']],
      ['/admin/github', ['policy:manage']],
      ['/admin/ollama', ['policy:manage']],
      ['/admin', ['user:manage', 'group:manage', 'role:manage', 'notification:manage', 'audit:read', 'policy:manage', 'domain:manage']],
      ['/audit', ['audit:read']],
      ['/deployments', ['deployment:read']],
      ['/images', ['deployment:read']],
      ['/servers/new', ['server:manage']],
      ['/containers', ['server:read']],
      ['/projects/new', ['project:create']],
      ['/servers', ['server:read']],
      ['/projects', ['project:read']],
    ]
    const rule = REQUIRED.find(([prefix]) => to.path === prefix || to.path.startsWith(`${prefix}/`))
    if (rule && !rule[1].some(p => hasAny(p))) {
      if (import.meta.client) useToast().error('Accès refusé : droits insuffisants')
      return navigateTo('/')
    }
    return
  }
  if (me.value?.setupRequired && to.path !== '/setup') return navigateTo('/setup')
  if (!isPublic) return navigateTo({ path: '/login', query: to.fullPath !== '/' ? { returnTo: to.fullPath } : {} })
})
