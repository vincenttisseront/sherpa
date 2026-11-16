<script setup lang="ts">
/** En-tête de page : icône, titre, phrase d'explication, onglets de section, actions. */
import type { Component } from 'vue'
import { Activity, FolderKanban, FolderPlus, LayoutDashboard, RefreshCcw, Rocket, ScrollText, Server, ServerCog, Settings, Sparkles, UserRound } from 'lucide-vue-next'

const props = defineProps<{ title: string, subtitle?: string, icon?: Component | string, back?: { to: string, label: string } }>()
/** Icônes par nom : évite un import dans chaque page. */
const ICONS: Record<string, Component> = { activity: Activity, dashboard: LayoutDashboard, folder: FolderKanban, 'folder-plus': FolderPlus, rocket: Rocket, refresh: RefreshCcw, server: Server, 'server-cog': ServerCog, scroll: ScrollText, settings: Settings, sparkles: Sparkles, user: UserRound }
const iconComponent = computed(() => (typeof props.icon === 'string' ? ICONS[props.icon] : props.icon))
</script>

<template>
  <header class="ph">
    <div class="row">
      <div class="lead">
        <!-- Retour sur la ligne du titre, comme un fil d'Ariane. -->
        <NuxtLink v-if="back" :to="back.to" class="back">← {{ back.label }}<span class="sep" aria-hidden="true">/</span></NuxtLink>
        <span v-if="iconComponent" class="ico" aria-hidden="true"><component :is="iconComponent" :size="16" :stroke-width="2" /></span>
        <div>
          <h1>{{ title }}</h1>
          <p v-if="subtitle || $slots.subtitle" class="sub"><slot name="subtitle">{{ subtitle }}</slot></p>
        </div>
        <!-- Navigation de section (onglets) sur la ligne du titre. -->
        <slot name="nav" />
      </div>
      <div v-if="$slots.default" class="actions"><slot /></div>
    </div>
  </header>
</template>

<style scoped>
.ph { margin-bottom: var(--space-3); display: flex; flex-direction: column; gap: 4px; }
.ph h1 { font-size: 20px; }
.back { font-size: 13px; color: var(--text-muted); white-space: nowrap; margin-right: calc(-1 * var(--space-1, 4px)); }
.sep { margin-left: var(--space-3); color: var(--border-strong); }
.back:hover { color: var(--primary); }
.row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); flex-wrap: wrap; }
.lead { display: flex; align-items: center; gap: var(--space-3); min-width: 0; flex-wrap: wrap; }
.ico { width: 32px; height: 32px; border-radius: 9px; display: grid; place-items: center; flex-shrink: 0; color: var(--primary); background: var(--primary-soft); border: 1px solid color-mix(in srgb, var(--primary) 15%, transparent); }
.sub { margin: 1px 0 0; font-size: 13px; color: var(--text-muted); max-width: 820px; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.actions { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; margin-left: auto; }
/* Actions d'en-tête au format compact. */
.actions :deep(.btn--md) { padding: 5px 13px; min-height: 32px; font-size: 13px; }
</style>
