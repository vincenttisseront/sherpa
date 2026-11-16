<script setup lang="ts">
/** Quatre sources distinctes (§12) : configuration, dernier déploiement, dernière mise à jour d'image, politique. */
import { MODE_LABEL, type TargetProvenance, UPDATE_KIND_LABEL } from '#shared/schemas/watchtower'

defineProps<{ provenance: TargetProvenance }>()
</script>

<template>
  <div class="prov">
    <div class="cell">
      <span class="k">Configuration</span>
      <template v-if="provenance.config">
        <span v-if="provenance.config.kind === 'github'">Git <code>{{ provenance.config.repository }}</code> @ <code>{{ provenance.config.commit?.slice(0, 12) }}</code></span>
        <span v-else>Archive ZIP <code>{{ provenance.config.archiveSha256?.slice(0, 12) ?? '—' }}</code></span>
        <span class="muted">Release #{{ provenance.config.release }}</span>
      </template>
      <span v-else class="muted">Aucune release active</span>
    </div>
    <div class="cell">
      <span class="k">Dernier déploiement plateforme</span>
      <template v-if="provenance.lastDeployment">
        <NuxtLink :to="`/deployments/${provenance.lastDeployment.id}`">{{ ACTION_LABEL[provenance.lastDeployment.action] }}{{ provenance.lastDeployment.release ? ` #${provenance.lastDeployment.release}` : '' }}</NuxtLink>
        <span class="muted">{{ fmtDateTime(provenance.lastDeployment.at) }} · {{ provenance.lastDeployment.by ?? 'système' }}</span>
      </template>
      <span v-else class="muted">—</span>
    </div>
    <div class="cell">
      <span class="k">Dernière mise à jour d'image</span>
      <template v-if="provenance.lastImageUpdate">
        <span>{{ provenance.lastImageUpdate.service }} — {{ UPDATE_KIND_LABEL[provenance.lastImageUpdate.kind] }}</span>
        <span class="muted">{{ fmtDateTime(provenance.lastImageUpdate.at) }}</span>
      </template>
      <span v-else class="muted">Aucune hors déploiement</span>
    </div>
    <div class="cell">
      <span class="k">Politique Watchtower</span>
      <span v-if="provenance.policy.enabled && provenance.policy.mode">
        {{ MODE_LABEL[provenance.policy.mode] }}
        <UiBadge v-if="provenance.policy.paused" tone="warning">en pause</UiBadge>
      </span>
      <span v-else class="muted">Désactivé</span>
      <UiBadge v-if="provenance.policy.pending" tone="info">modification non appliquée</UiBadge>
    </div>
    <p v-if="provenance.driftedServices.length" class="drift" role="status">
      L'exécution diffère du dernier déploiement : {{ provenance.driftedServices.join(', ') }}
      {{ provenance.config?.kind === 'github' ? '— les images ne correspondent plus au commit Git déployé.' : '— images mises à jour hors de la plateforme.' }}
    </p>
  </div>
</template>

<style scoped>
.prov { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: var(--space-2) var(--space-3); }
.cell { display: flex; flex-direction: column; gap: 2px; font-size: 13px; min-width: 0; overflow-wrap: anywhere; }
.k { font-size: 11px; text-transform: uppercase; letter-spacing: .03em; color: var(--text-muted); }
.drift { grid-column: 1 / -1; margin: 0; padding: var(--space-2) var(--space-3); border-radius: var(--radius); background: var(--warning-bg); color: var(--warning); font-size: 13px; }
</style>
