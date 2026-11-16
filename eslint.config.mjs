import withNuxt from './.nuxt/eslint.config.mjs'

export default withNuxt({
  rules: {
    // Pas de popups natifs : utiliser useConfirm() / useToast().
    'no-alert': 'error',
    'no-restricted-globals': ['error', 'confirm', 'alert', 'prompt'],
  },
})
