<script setup lang="ts">
withDefaults(defineProps<{
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost'
  size?: 'sm' | 'md'
  type?: 'button' | 'submit'
  loading?: boolean
  disabled?: boolean
}>(), { variant: 'secondary', size: 'md', type: 'button', loading: false, disabled: false })
</script>

<template>
  <button
    :type="type"
    class="btn"
    :class="[`btn--${variant}`, `btn--${size}`]"
    :disabled="disabled || loading"
    :aria-busy="loading || undefined"
  >
    <span v-if="loading" class="spinner" aria-hidden="true" />
    <slot />
  </button>
</template>

<style scoped>
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: var(--space-2);
  border: 1px solid transparent; border-radius: var(--radius);
  font: inherit; font-weight: 550; cursor: pointer; white-space: nowrap; line-height: 1.2;
  transition: background-color .12s, border-color .12s, color .12s, box-shadow .12s, transform .06s;
}
.btn:active:not(:disabled) { transform: translateY(1px); }
.btn--md { padding: 9px 16px; min-height: 38px; }
.btn--sm { padding: 5px 11px; font-size: 13px; min-height: 30px; }
.btn:disabled { opacity: .55; cursor: not-allowed; }
.btn--primary { background: var(--primary); color: var(--primary-contrast); box-shadow: 0 1px 2px rgb(20 26 43 / 12%), inset 0 1px 0 rgb(255 255 255 / 14%); }
.btn--primary:hover:not(:disabled) { background: var(--primary-hover); box-shadow: 0 4px 12px color-mix(in srgb, var(--primary) 35%, transparent); }
.btn--secondary { background: var(--surface); color: var(--text); border-color: var(--border-strong); box-shadow: 0 1px 2px rgb(20 26 43 / 5%); }
.btn--secondary:hover:not(:disabled) { background: var(--surface-2); border-color: color-mix(in srgb, var(--primary) 30%, var(--border-strong)); }
.btn--danger { background: var(--danger); color: #fff; }
.btn--danger:hover:not(:disabled) { background: var(--danger-hover); }
.btn--ghost { background: transparent; color: var(--text-muted); }
.btn--ghost:hover:not(:disabled) { background: var(--surface-3); color: var(--text); }
.spinner {
  width: 13px; height: 13px; border-radius: 50%;
  border: 2px solid currentColor; border-right-color: transparent;
  animation: spin .7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>
