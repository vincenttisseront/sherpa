<script setup lang="ts">
import type { PathConfigInput } from '#shared/schemas/infra'

const props = defineProps<{ errors?: Record<string, string> }>()
const model = defineModel<PathConfigInput>({ required: true })
const uid = useId()
const err = (f: string) => props.errors?.[f] ?? null
const advanced = ref(false)

const ROOTS = [
  { key: 'workingRoot', label: 'Répertoire de travail', hint: 'Sources, Compose générés, releases' },
  { key: 'buildRoot', label: 'Répertoire de build', hint: 'Contextes de build Docker' },
  { key: 'tmpRoot', label: 'Répertoire temporaire', hint: 'Archives, extraction ; purgé après traitement' },
  { key: 'runtimeRoot', label: 'Données runtime', hint: 'Volumes persistants des conteneurs ; séparé du travail' },
] as const

const num = (v: string) => (v === '' ? null : Number(v))
</script>

<template>
  <div class="path-form">
    <div class="grid">
      <UiField v-for="r in ROOTS" :key="r.key" :label="r.label" :for="`${uid}-${r.key}`" :hint="r.hint" :error="err(r.key)" required>
        <input :id="`${uid}-${r.key}`" v-model.trim="model[r.key]" class="input mono" spellcheck="false">
      </UiField>
    </div>

    <p class="muted preview">
      Projet « exemple » → <code>{{ model.workingRoot.replace(/\/+$/, '') }}/exemple/releases/&lt;release&gt;/</code>
    </p>

    <div class="grid">
      <UiField label="Releases conservées" :for="`${uid}-rel`" :error="err('releasesToKeep')">
        <input :id="`${uid}-rel`" v-model.number="model.releasesToKeep" class="input" type="number" min="1" max="100">
      </UiField>
      <UiField label="Espace disque minimum (Mo)" :for="`${uid}-disk`" hint="Marge gardée libre sur le disque avant chaque déploiement, en plus de 3 × la taille de l'archive" :error="err('minFreeDiskMb')">
        <input :id="`${uid}-disk`" v-model.number="model.minFreeDiskMb" class="input" type="number" min="0">
      </UiField>
      <UiField label="Taille max. d'un projet (Mo)" :for="`${uid}-size`" :error="err('maxProjectSizeMb')">
        <input :id="`${uid}-size`" v-model.number="model.maxProjectSizeMb" class="input" type="number" min="1">
      </UiField>
      <UiField label="Rétention (jours)" :for="`${uid}-ret`" :error="err('retentionDays')">
        <input :id="`${uid}-ret`" v-model.number="model.retentionDays" class="input" type="number" min="1">
      </UiField>
    </div>

    <UiSwitch v-model="model.autoCreate" label="Créer automatiquement les répertoires manquants" />

    <UiButton variant="ghost" size="sm" class="adv-toggle" :aria-expanded="advanced" @click="advanced = !advanced">
      {{ advanced ? '▾' : '▸' }} Permissions et chemins interdits
    </UiButton>
    <div v-if="advanced" class="grid">
      <UiField label="Mode des répertoires" :for="`${uid}-mode`" hint="Octal, ex. 0750" :error="err('dirMode')">
        <input :id="`${uid}-mode`" v-model.trim="model.dirMode" class="input mono">
      </UiField>
      <UiField label="Propriétaire (UID)" :for="`${uid}-uid`" :error="err('ownerUid')">
        <input :id="`${uid}-uid`" :value="model.ownerUid ?? ''" class="input" type="number" min="0" placeholder="Utilisateur du Runner" @input="model.ownerUid = num(($event.target as HTMLInputElement).value)">
      </UiField>
      <UiField label="Groupe (GID)" :for="`${uid}-gid`" :error="err('groupGid')">
        <input :id="`${uid}-gid`" :value="model.groupGid ?? ''" class="input" type="number" min="0" @input="model.groupGid = num(($event.target as HTMLInputElement).value)">
      </UiField>
      <UiField class="span-all" label="Chemins interdits supplémentaires" :for="`${uid}-forb`" hint="Les répertoires système sont toujours interdits">
        <UiTagInput :id="`${uid}-forb`" v-model="model.forbiddenPaths" placeholder="/srv/legacy" :validate="v => v.startsWith('/') ? null : 'Chemin absolu attendu'" />
      </UiField>
      <span v-for="(m, k) in errors" v-show="String(k).startsWith('forbiddenPaths.')" :key="k" class="error-text">{{ m }}</span>
    </div>
  </div>
</template>

<style scoped>
.path-form { display: flex; flex-direction: column; gap: var(--space-3); }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: var(--space-2) var(--space-4); }
.span-all { grid-column: 1 / -1; }
.preview { margin: 0; font-size: 12.5px; word-break: break-all; }
.adv-toggle { align-self: flex-start; }
.error-text { color: var(--danger); font-size: 12px; }
</style>
