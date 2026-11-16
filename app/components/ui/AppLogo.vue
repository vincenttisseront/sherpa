<script setup lang="ts">
/** Logo de Sherpa (même dessin que public/favicon.svg) : un conteneur marqué de l'invite de terminal, porté au sommet d'une montagne. */
withDefaults(defineProps<{ size?: number }>(), { size: 38 })
// Identifiant de dégradé propre à chaque instance (plusieurs logos sur une même page).
const gid = `logo-${useId()}`
</script>

<template>
  <svg :width="size" :height="size" viewBox="0 0 64 64" class="app-logo" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient :id="gid" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#4f5bd5" />
        <stop offset=".55" stop-color="#7c5cf0" />
        <stop offset="1" stop-color="#a35cf0" />
      </linearGradient>
    </defs>
    <rect width="64" height="64" rx="15" :fill="`url(#${gid})`" />
    <path d="M34 55 46.5 37.5 59 55Z" fill="#fff" fill-opacity=".5" />
    <path d="M5 55 31 27 57 55Z" fill="#fff" />
    <rect x="19.5" y="8.5" width="23" height="16.5" rx="3.2" fill="#fff" />
    <path d="M25 13.2 29.2 16.8 25 20.4" fill="none" stroke="#4f5bd5" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" />
    <path d="M32 20.6h6.2" fill="none" stroke="#4f5bd5" stroke-width="2.6" stroke-linecap="round" />
  </svg>
</template>

<style scoped>
.app-logo { display: block; flex: none; filter: drop-shadow(0 8px 18px rgb(99 102 241 / 38%)); }
</style>
