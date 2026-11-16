<script setup lang="ts">
// Thème choisi appliqué avant le premier rendu (script en ligne autorisé par empreinte dans la CSP).
useHead({
  titleTemplate: t => (t && t !== 'Sherpa' ? `${t} · Sherpa` : 'Sherpa'),
  script: [{ innerHTML: THEME_BOOT_SCRIPT, tagPosition: 'head' }],
  meta: [{ name: 'theme-color', content: '#0f1630' }],
})
</script>

<template>
  <!-- Changement de page : barre d'avancement en haut de la fenêtre. -->
  <NuxtLoadingIndicator color="linear-gradient(90deg, #4f5bd5, #a35cf0)" :height="3" />
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
  <UiConfirmHost />
  <UiToastHost />
  <UiActivityHost />
</template>
