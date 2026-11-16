<script setup lang="ts">
/** Affichage d'un diff unifié (lignes ajoutées / retirées / contexte). */
const props = defineProps<{ diff: string }>()
const lines = computed(() => props.diff.split('\n').filter(l => !l.startsWith('===') && !l.startsWith('Index:')).map(l => ({
  text: l,
  kind: l.startsWith('+++') || l.startsWith('---') ? 'file' : l.startsWith('@@') ? 'hunk' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : 'ctx',
})))
</script>

<template>
  <pre class="diff mono"><span v-for="(l, i) in lines" :key="i" :class="l.kind">{{ l.text }}
</span></pre>
</template>

<style scoped>
.diff { margin: 0; padding: var(--space-3) 0; background: var(--surface-2); border-radius: var(--radius); overflow: auto; max-height: 520px; font-size: 12.5px; line-height: 1.5; }
.diff span { display: block; padding: 0 var(--space-3); white-space: pre; }
.add { background: var(--success-bg); color: var(--success); }
.del { background: var(--danger-bg); color: var(--danger); }
.hunk { color: var(--info); }
.file { color: var(--text-muted); font-weight: 600; }
</style>
