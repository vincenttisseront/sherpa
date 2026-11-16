<script setup lang="ts">
/**
 * Éditeur de code (CodeMirror 6) : coloration syntaxique selon le nom du fichier (ou son contenu),
 * numéros de ligne, recherche et remplacement (Ctrl+F), repli, indentation (Tab), historique.
 * Couleurs prises dans les jetons du thème (clair / sombre). Ctrl/Cmd+S déclenche `save`.
 * Chargé à la demande (<LazyUiCodeEditor>) : rien n'est téléchargé tant qu'aucun fichier n'est ouvert.
 */
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, foldGutter, foldKeymap, HighlightStyle, indentOnInput, type LanguageSupport, StreamLanguage, type StreamParser, syntaxHighlighting } from '@codemirror/language'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'

const props = withDefaults(defineProps<{ filename: string, readonly?: boolean, label: string }>(), { readonly: false })
const model = defineModel<string>({ required: true })
const emit = defineEmits<{ save: [], caret: [{ line: number, col: number }] }>()

const host = ref<HTMLElement | null>(null)
let view: EditorView | null = null
const editable = new Compartment()
const language = ref('texte')

/** Langage d'après le nom, puis d'après le contenu (ex. core.conf de Deluge : du JSON). */
async function languageFor(name: string, text: string): Promise<{ label: string, ext: Extension }> {
  const lower = name.toLowerCase()
  const base = lower.split('/').pop() ?? lower
  const ext = base.includes('.') ? base.split('.').pop()! : ''
  const legacy = async (label: string, load: () => Promise<StreamParser<unknown>>) => ({ label, ext: StreamLanguage.define(await load()) })
  const lang = async (label: string, load: () => Promise<LanguageSupport>) => ({ label, ext: await load() })
  if (ext === 'json' || ext === 'jsonc') return lang('JSON', async () => (await import('@codemirror/lang-json')).json())
  if (ext === 'yml' || ext === 'yaml') return lang('YAML', async () => (await import('@codemirror/lang-yaml')).yaml())
  if (['xml', 'html', 'htm', 'svg', 'xsd', 'plist'].includes(ext)) return lang('XML', async () => (await import('@codemirror/lang-xml')).xml())
  if (ext === 'py') return lang('Python', async () => (await import('@codemirror/lang-python')).python())
  if (['js', 'mjs', 'cjs', 'ts'].includes(ext)) return lang(ext === 'ts' ? 'TypeScript' : 'JavaScript', async () => (await import('@codemirror/lang-javascript')).javascript({ typescript: ext === 'ts' }))
  if (ext === 'toml') return legacy('TOML', async () => (await import('@codemirror/legacy-modes/mode/toml')).toml as StreamParser<unknown>)
  if (['sh', 'bash', 'zsh'].includes(ext) || /^(\.bashrc|\.profile)$/.test(base)) return legacy('Shell', async () => (await import('@codemirror/legacy-modes/mode/shell')).shell as StreamParser<unknown>)
  if (base === 'dockerfile' || base.endsWith('.dockerfile')) return legacy('Dockerfile', async () => (await import('@codemirror/legacy-modes/mode/dockerfile')).dockerFile as StreamParser<unknown>)
  if (base.includes('nginx') || (ext === 'conf' && /^\s*(server|location|upstream|http)\s*\{/m.test(text))) return legacy('nginx', async () => (await import('@codemirror/legacy-modes/mode/nginx')).nginx as StreamParser<unknown>)
  // Contenu : JSON ({ ou [), XML (<), YAML (clé: valeur sans section), sinon INI / propriétés.
  const head = text.trimStart().slice(0, 1)
  if (head === '{' || head === '[' && /^\s*\[\s*[{["\d]/.test(text)) return lang('JSON', async () => (await import('@codemirror/lang-json')).json())
  if (head === '<') return lang('XML', async () => (await import('@codemirror/lang-xml')).xml())
  if (['conf', 'ini', 'cfg', 'cnf', 'properties', 'env', 'service', 'desktop'].includes(ext) || base.startsWith('.env') || /^\s*\[[^\]]+\]\s*$/m.test(text)) return legacy('INI', async () => (await import('@codemirror/legacy-modes/mode/properties')).properties as StreamParser<unknown>)
  if (/^[\w.-]+:\s/m.test(text) && !/^\s*[\w.-]+\s*=/m.test(text)) return lang('YAML', async () => (await import('@codemirror/lang-yaml')).yaml())
  if (/^\s*[\w.-]+\s*=/m.test(text)) return legacy('INI', async () => (await import('@codemirror/legacy-modes/mode/properties')).properties as StreamParser<unknown>)
  return { label: 'texte', ext: [] }
}

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword], color: 'var(--primary)', fontWeight: '600' },
  { tag: [t.propertyName, t.attributeName, t.definition(t.variableName)], color: 'var(--info, var(--primary))' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--success)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--warning)' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.meta], color: 'var(--text-muted)', fontStyle: 'italic' },
  { tag: [t.heading, t.typeName, t.className, t.tagName], color: 'var(--danger)', fontWeight: '600' },
  { tag: [t.variableName, t.labelName], color: 'var(--text)' },
  { tag: t.invalid, color: 'var(--danger)', textDecoration: 'underline' },
])

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '12.5px', backgroundColor: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 'var(--radius)' },
  '&.cm-focused': { outline: '2px solid var(--primary)', outlineOffset: '-1px' },
  '.cm-scroller': { fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)', lineHeight: '1.45' },
  '.cm-gutters': { backgroundColor: 'var(--surface-2)', color: 'var(--text-muted)', borderRight: '1px solid var(--border)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--primary) 6%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'color-mix(in srgb, var(--primary) 12%, transparent)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: 'color-mix(in srgb, var(--primary) 25%, transparent) !important' },
  '.cm-cursor': { borderLeftColor: 'var(--text)' },
  '.cm-panels': { backgroundColor: 'var(--surface-2)', color: 'var(--text)' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--warning) 30%, transparent)' },
  '.cm-searchMatch-selected': { backgroundColor: 'color-mix(in srgb, var(--warning) 60%, transparent)' },
})

function caretOf(state: EditorState) {
  const pos = state.selection.main.head
  const line = state.doc.lineAt(pos)
  emit('caret', { line: line.number, col: pos - line.from + 1 })
}

onMounted(async () => {
  const lang = await languageFor(props.filename, model.value)
  language.value = lang.label
  if (!host.value) return
  view = new EditorView({
    parent: host.value,
    state: EditorState.create({
      doc: model.value,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        foldGutter(),
        history(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        search({ top: true }),
        syntaxHighlighting(highlight),
        lang.ext,
        theme,
        editable.of([EditorState.readOnly.of(props.readonly), EditorView.editable.of(!props.readonly)]),
        EditorView.contentAttributes.of({ 'aria-label': props.label, 'aria-multiline': 'true' }),
        keymap.of([
          { key: 'Mod-s', preventDefault: true, run: () => (emit('save'), true) },
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          ...foldKeymap,
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) model.value = u.state.doc.toString()
          if (u.docChanged || u.selectionSet) caretOf(u.state)
        }),
      ],
    }),
  })
})

// Contenu remplacé de l'extérieur (rechargement, enregistrement) : document mis à jour sans boucle.
watch(model, (v) => {
  if (view && v !== view.state.doc.toString()) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v } })
})
watch(() => props.readonly, (ro) => {
  view?.dispatch({ effects: editable.reconfigure([EditorState.readOnly.of(ro), EditorView.editable.of(!ro)]) })
})
onBeforeUnmount(() => view?.destroy())
defineExpose({ language })
</script>

<template>
  <div class="code-editor">
    <div ref="host" class="host" />
    <span class="lang tiny muted" aria-hidden="true">{{ language }}</span>
  </div>
</template>

<style scoped>
.code-editor { position: relative; display: flex; flex-direction: column; min-height: 360px; height: 100%; }
.host { flex: 1; min-height: 0; display: flex; }
.host :deep(.cm-editor) { flex: 1; min-height: 360px; max-height: 70vh; }
.lang { position: absolute; right: 10px; bottom: 6px; pointer-events: none; font-size: 11px; }
</style>
