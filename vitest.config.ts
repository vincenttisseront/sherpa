import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Alias Nuxt « #shared » pour les modules de app/ testés hors de Nuxt.
  resolve: { alias: { '#shared': fileURLToPath(new URL('./shared', import.meta.url)) } },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
})
