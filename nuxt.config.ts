// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2026-10-01',
  devtools: { enabled: true },
  modules: ['@nuxt/eslint'],
  css: ['~/assets/css/main.css'],
  // Noms de composants sans préfixe de dossier (components/infra/TraefikForm.vue → <TraefikForm>).
  components: [{ path: '~/components', pathPrefix: false }],
  app: {
    head: {
      htmlAttrs: { lang: 'fr' },
      title: 'Sherpa',
      link: [
        { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
        { rel: 'icon', href: '/favicon.ico', sizes: '48x48' },
        { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' },
      ],
      meta: [{ name: 'theme-color', content: '#4f5bd5' }],
    },
  },
  nitro: {
    // Génère /_openapi.json et /_scalar à partir des routes Nitro (contrats API).
    experimental: { openAPI: true },
    openAPI: {
      meta: { title: 'Portainer Platform API', version: '0.1.0' },
      production: false,
    },
  },
  typescript: { strict: true },
})
