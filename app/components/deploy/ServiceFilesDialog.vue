<script setup lang="ts">
/**
 * Fichiers d'un service : ses montages (volumes, dossiers de l'hôte), navigation dans les dossiers,
 * lecture et modification d'un fichier texte. À l'enregistrement, l'ancienne version est copiée à
 * côté ; le service peut être arrêté pendant l'écriture puis relancé (services qui réécrivent leur
 * configuration à l'arrêt, comme Deluge).
 */
import type { ServiceFileDto, ServiceFileSearchDto, ServiceFilesDto } from '#shared/schemas/service-files'
import { createTwoFilesPatch } from 'diff'
import { formatBytes } from '#shared/utils/format'
import { MAX_PREVIEW_BYTES, archiveOf, imageTypeOf } from '#shared/utils/image-types'
import { ArrowDown, ArrowLeft, ArrowUp, Check, History, Filter, Copy, Download, FileArchive, PackageOpen, Maximize2, Minimize2, Search, File, FileWarning, Folder, FolderInput, KeyRound, FolderOpen, FolderPlus, Link2, Pencil, Plus, RefreshCw, Trash2, Upload, X } from 'lucide-vue-next'

const props = defineProps<{ targetId: string, service: string }>()
const open = defineModel<boolean>('open', { required: true })
const toast = useToast()
const confirm = useConfirm()
const { me } = useAuth()

const base = computed(() => `/api/targets/${props.targetId}/services/${encodeURIComponent(props.service)}`)
const listing = ref<ServiceFilesDto | null>(null)
const listError = ref<string | null>(null)
const loading = ref(false)
const mount = ref<string | null>(null)
const path = ref('')

// Seule la dernière lecture compte (une lecture plus lente d'un autre dossier ne l'écrase pas).
let seq = 0
async function load() {
  const mine = ++seq
  loading.value = true
  listError.value = null
  try {
    const l = await $fetch<ServiceFilesDto>(`${base.value}/files`, { query: { ...(mount.value !== null ? { mount: mount.value } : {}), path: path.value } })
    if (mine !== seq) return
    listing.value = l
    mount.value = listing.value.mount
    if (listing.value.isFile) await openFile('')
  }
  catch (err) {
    if (mine === seq) listError.value = apiError(err).message
  }
  finally {
    if (mine === seq) loading.value = false
  }
}
onMounted(load)

const current = computed(() => listing.value?.mounts.find(m => m.destination === mount.value) ?? null)
const crumbs = computed(() => path.value ? path.value.split('/') : [])
function go(p: string) {
  path.value = p
  file.value = null
  found.value = null
  void load()
}
function chooseMount(destination: string) {
  mount.value = destination
  go('')
}
const join = (a: string, b: string) => (a ? `${a}/${b}` : b)

// Fichier ouvert.
const file = ref<ServiceFileDto | null>(null)
const draft = ref('')
const isNew = ref(false)
const fileLoading = ref(false)
const saving = ref(false)
const stopService = ref(true)
async function openFile(rel: string) {
  fileLoading.value = true
  try {
    file.value = await $fetch<ServiceFileDto>(`${base.value}/file`, { query: { mount: mount.value, path: rel } })
    draft.value = file.value.content ?? ''
    isNew.value = false
    if (!saving.value) saveMsg.value = null
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    fileLoading.value = false
  }
}
const newName = ref('')
function startNew() {
  if (!/^[A-Za-z0-9._-][A-Za-z0-9._ -]{0,127}$/.test(newName.value)) {
    toast.error('Nom de fichier invalide')
    return
  }
  file.value = { path: join(path.value, newName.value), size: 0, mtime: new Date().toISOString(), mode: '0644', uid: 0, gid: 0, content: '', sha256: null, reason: null, writable: true }
  draft.value = ''
  isNew.value = true
  newName.value = ''
}
const dirty = computed(() => !!file.value && (isNew.value || draft.value !== file.value.content))
// État d'enregistrement affiché dans l'éditeur (les notifications ne sont pas visibles en plein écran).
const saveMsg = ref<{ ok: boolean, text: string } | null>(null)
async function save() {
  if (!file.value || mount.value === null || saving.value) return
  saving.value = true
  saveMsg.value = null
  try {
    const r = await $fetch<{ backup: string | null, restarted: boolean }>(`${base.value}/file`, {
      method: 'PUT',
      body: { mount: mount.value, path: file.value.path, content: draft.value, sha256: isNew.value ? null : file.value.sha256, stopService: stopService.value && !!listing.value?.running },
    })
    const text = `Enregistré${r.backup ? ` · ancienne version : ${r.backup}` : ''}${r.restarted ? ` · ${props.service} relancé` : ''}`
    toast.success(text)
    await openFile(file.value.path)
    saveMsg.value = { ok: true, text: `${text} (${fmtTime(new Date().toISOString())})` }
    // Dossier relu en arrière-plan (taille, date) ; ignoré si l'on a changé de dossier entre-temps.
    const mine = ++seq
    void $fetch<ServiceFilesDto>(`${base.value}/files`, { query: { mount: mount.value, path: path.value } }).then((l) => {
      if (mine === seq) listing.value = l
    }).catch(() => {})
  }
  catch (err) {
    toast.error(apiError(err).message)
    saveMsg.value = { ok: false, text: apiError(err).message }
  }
  finally {
    saving.value = false
  }
}

// Plein écran (API du navigateur) sur la zone d'édition ; Échap ou le bouton en sort.
const editorEl = ref<HTMLElement | null>(null)
const fullscreen = ref(false)
function onFullscreenChange() {
  fullscreen.value = !!document.fullscreenElement && document.fullscreenElement === editorEl.value
}
onMounted(() => document.addEventListener('fullscreenchange', onFullscreenChange))
onBeforeUnmount(() => {
  document.removeEventListener('fullscreenchange', onFullscreenChange)
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
})
async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen()
    else await editorEl.value?.requestFullscreen()
  }
  catch {
    toast.error('Plein écran refusé par le navigateur')
  }
}

// Position du curseur, donnée par l'éditeur (Ctrl/Cmd+S et Tab y sont gérés).
const caret = ref({ line: 1, col: 1 })
function back() {
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
  saveMsg.value = null
  file.value = null
  isNew.value = false
  if (listing.value?.isFile) open.value = false
}
// Envoi d'un fichier dans le dossier ouvert (XMLHttpRequest : progression ; jeton CSRF joint à la main).
const picker = ref<HTMLInputElement | null>(null)
const sending = ref<{ name: string, sent: number, total: number } | null>(null)
function send(f: globalThis.File, dir: string, overwrite: boolean): Promise<{ status: number, body: { statusMessage?: string, path?: string, backup?: string | null } }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${base.value}/upload?${new URLSearchParams({ mount: mount.value ?? '', path: dir, name: f.name, overwrite: overwrite ? '1' : '0' })}`)
    xhr.setRequestHeader('content-type', 'application/octet-stream')
    if (me.value?.csrfToken) xhr.setRequestHeader('x-csrf-token', me.value.csrfToken)
    xhr.upload.onprogress = (e) => {
      if (sending.value && e.lengthComputable) sending.value = { ...sending.value, sent: e.loaded, total: e.total }
    }
    xhr.onload = () => {
      let body = {}
      try {
        body = JSON.parse(xhr.responseText)
      }
      catch { /* réponse non JSON */ }
      resolve({ status: xhr.status, body })
    }
    xhr.onerror = () => resolve({ status: 0, body: { statusMessage: 'Envoi interrompu' } })
    xhr.send(f)
  })
}

/** Fichiers à envoyer, avec leur sous-dossier relatif (dossier déposé : arborescence recréée). */
interface Outgoing { file: globalThis.File, sub: string }

/**
 * Envoi de plusieurs fichiers dans un dossier (sous-dossiers créés au besoin). Fichiers déjà
 * présents : une seule question pour l'envoi (tous remplacés, ou tous laissés).
 */
async function uploadFiles(list: Outgoing[], dir: string) {
  if (!list.length) return
  let replace: boolean | null = null
  const done: string[] = []
  const made = new Set<string>()
  try {
    for (const [i, it] of list.entries()) {
      // Sous-dossiers du dossier déposé, créés dans l'ordre (déjà présents : conservés).
      const parts = it.sub ? it.sub.split('/') : []
      for (let k = 0; k < parts.length; k++) {
        const parent = join(dir, parts.slice(0, k).join('/'))
        const key = join(parent, parts[k]!)
        if (made.has(key)) continue
        made.add(key)
        await $fetch(`${base.value}/mkdir`, { method: 'POST', body: { mount: mount.value, path: parent, name: parts[k] } }).catch((err) => {
          if ((err as { statusCode?: number }).statusCode !== 409) throw err
        })
      }
      const target = join(dir, it.sub)
      sending.value = { name: list.length > 1 ? `${it.file.name} (${i + 1}/${list.length})` : it.file.name, sent: 0, total: it.file.size }
      let r = await send(it.file, target, replace === true)
      if (r.status === 409 && replace === null) {
        replace = await confirm(list.length === 1
          ? { title: `Remplacer ${it.file.name}`, message: `${it.file.name} existe déjà dans ce dossier. Le remplacer ? L'ancienne version est copiée à côté (${it.file.name}.console-…bak).`, confirmLabel: 'Remplacer' }
          : { title: 'Remplacer les fichiers déjà présents', message: `${it.file.name} (et peut-être d'autres fichiers de cet envoi) existe déjà. Remplacer tous ceux qui existent ? Leur ancienne version est copiée à côté (.console-…bak) ; sinon ils sont laissés tels quels.`, confirmLabel: 'Remplacer' })
        if (replace) {
          sending.value = { ...sending.value!, sent: 0 }
          r = await send(it.file, target, true)
        }
      }
      if (r.status === 201) done.push(`${r.body.path}${r.body.backup ? ` · ancienne version : ${r.body.backup}` : ''}`)
      else if (r.status !== 409) toast.error(`${it.file.name} : ${r.body.statusMessage ?? `envoi refusé (${r.status})`}`)
    }
    if (done.length === 1) toast.success(`${done[0]!.replace(/ · /, ' envoyé · ')}${done[0]!.includes(' · ') ? '' : ' envoyé'}`)
    else if (done.length) toast.success(`${done.length} fichiers envoyés dans ${current.value?.destination}${dir ? `/${dir}` : ''}`)
    if (done.length || made.size) await load()
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    sending.value = null
  }
}
async function upload(e: Event) {
  const input = e.target as HTMLInputElement
  const files = [...(input.files ?? [])]
  input.value = ''
  await uploadFiles(files.map(file => ({ file, sub: '' })), path.value)
}

// Glisser-déposer.
// - Depuis le poste : fichiers et dossiers (arborescence) envoyés dans le dossier visé.
// - Dans l'explorateur : élément (ou sélection) déplacé sur un dossier ; Alt (Option) pour copier.
const DRAG_TYPE = 'application/x-platform-files'
const dropTarget = ref<string | null>(null)
async function entriesOf(dt: DataTransfer): Promise<Outgoing[]> {
  const roots = [...dt.items].map(i => (i.kind === 'file' ? i.webkitGetAsEntry?.() : null)).filter((e): e is FileSystemEntry => !!e)
  if (!roots.length) return [...dt.files].map(file => ({ file, sub: '' }))
  const out: Outgoing[] = []
  const walk = async (entry: FileSystemEntry, sub: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<globalThis.File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej))
      out.push({ file, sub })
      return
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader()
    const here = sub ? `${sub}/${entry.name}` : entry.name
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej))
      if (!batch.length) break
      for (const child of batch) await walk(child, here)
    }
  }
  for (const r of roots) await walk(r, '')
  return out
}
function dragStart(e: DragEvent, name: string) {
  if (!e.dataTransfer || mount.value === null) return
  const names = selected.value.includes(name) ? [...selected.value] : [name]
  e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ mount: mount.value, paths: names.map(n => join(path.value, n)) }))
  e.dataTransfer.effectAllowed = 'copyMove'
}
function dragOver(e: DragEvent, dest: string) {
  if (!current.value?.writable || !e.dataTransfer) return
  const internal = e.dataTransfer.types.includes(DRAG_TYPE)
  if (!internal && !e.dataTransfer.types.includes('Files')) return
  e.preventDefault()
  e.dataTransfer.dropEffect = internal ? (e.altKey ? 'copy' : 'move') : 'copy'
  dropTarget.value = dest
}
async function drop(e: DragEvent, dest: string) {
  dropTarget.value = null
  if (!current.value?.writable || !e.dataTransfer) return
  e.preventDefault()
  const internal = e.dataTransfer.getData(DRAG_TYPE)
  if (internal) {
    const data = JSON.parse(internal) as { mount: string, paths: string[] }
    if (data.mount !== mount.value) return
    // Déposé sur lui-même ou dans son propre dossier : rien à faire.
    const items = data.paths.filter(p => p !== dest && (p.split('/').slice(0, -1).join('/')) !== dest).map(p => ({ path: p, name: p.split('/').pop()! }))
    if (!items.length) return
    await transfer(items, dest, e.altKey)
    return
  }
  await uploadFiles(await entriesOf(e.dataTransfer), dest)
}

// Suppression : un dossier se confirme en saisissant son nom (son contenu part avec lui).
const deleting = ref<string | null>(null)
async function remove(rel: string, kind: 'dir' | 'file' | 'link' | 'other') {
  const name = rel.split('/').pop() ?? rel
  const full = `${current.value?.destination ?? ''}/${rel}`
  const ok = await confirm(kind === 'dir'
    ? { title: `Supprimer le dossier ${name}`, message: `${full} et tout son contenu sont supprimés définitivement (aucune copie n'est gardée).`, confirmLabel: 'Supprimer', danger: true, requireText: name }
    : { title: `Supprimer ${name}`, message: `${full} est supprimé définitivement (aucune copie n'est gardée)${kind === 'link' ? ' ; seul le lien est supprimé, pas sa cible' : ''}.`, confirmLabel: 'Supprimer', danger: true })
  if (!ok) return
  deleting.value = rel
  try {
    await $fetch(`${base.value}/file`, { method: 'DELETE', query: { mount: mount.value, path: rel, recursive: kind === 'dir' ? '1' : '0' } })
    toast.success(`${full} supprimé`)
    if (file.value?.path === rel) file.value = null
    await load()
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    deleting.value = null
  }
}

// Nouveau dossier (même champ de nom que « Nouveau fichier »).
const creatingDir = ref(false)
async function makeDir() {
  if (!newName.value) return
  creatingDir.value = true
  try {
    const r = await $fetch<{ path: string }>(`${base.value}/mkdir`, { method: 'POST', body: { mount: mount.value, path: path.value, name: newName.value } })
    toast.success(`Dossier ${r.path} créé`)
    newName.value = ''
    await load()
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    creatingDir.value = false
  }
}

// Renommage en place (dans le même dossier).
const renaming = ref<string | null>(null)
const renameTo = ref('')
const renameBusy = ref(false)
// Référence posée dans la boucle des lignes : Vue la fournit sous forme de liste.
const renameInput = ref<HTMLInputElement[] | HTMLInputElement | null>(null)
function startRename(name: string) {
  if (!current.value?.writable) return
  renaming.value = name
  renameTo.value = name
  // Champ prêt à la saisie : nom sélectionné sans son extension (comme un explorateur de fichiers).
  void nextTick(() => {
    const el = Array.isArray(renameInput.value) ? renameInput.value[0] : renameInput.value
    if (!el) return
    el.focus()
    const dot = name.lastIndexOf('.')
    el.setSelectionRange(0, dot > 0 ? dot : name.length)
  })
}

// Clic sur un nom : ouvre ; double-clic : renomme. Sur un montage en écriture, le clic attend
// un court instant qu'un éventuel second clic arrive (sinon le dossier serait déjà ouvert).
let clickTimer: ReturnType<typeof setTimeout> | undefined
function nameClick(e: MouseEvent, open: () => void) {
  clearTimeout(clickTimer)
  if (!current.value?.writable || e.detail === 0) return open()
  if (e.detail > 1) return
  clickTimer = setTimeout(open, 250)
}
function nameDblClick(name: string) {
  clearTimeout(clickTimer)
  startRename(name)
}
onBeforeUnmount(() => clearTimeout(clickTimer))
async function rename() {
  const from = renaming.value
  if (!from || !renameTo.value || renameTo.value === from) {
    renaming.value = null
    return
  }
  renameBusy.value = true
  try {
    const r = await $fetch<{ from: string, to: string }>(`${base.value}/rename`, { method: 'POST', body: { mount: mount.value, path: join(path.value, from), name: renameTo.value } })
    toast.success(`${r.from} renommé en ${r.to.split('/').pop()}`)
    renaming.value = null
    await load()
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    renameBusy.value = false
  }
}

// Déplacement ou copie : l'élément est retenu, on navigue jusqu'au dossier voulu puis « Déplacer ici » / « Copier ici ».
const moving = ref<{ mode: 'move' | 'copy', mount: string, items: { path: string, name: string }[] } | null>(null)
const moveBusy = ref(false)
function startMove(names: string | string[], mode: 'move' | 'copy' = 'move') {
  if (mount.value === null) return
  const list = typeof names === 'string' ? [names] : names
  moving.value = { mode, mount: mount.value, items: list.map(name => ({ path: join(path.value, name), name })) }
}
const movingLabel = computed(() => (moving.value ? (moving.value.items.length === 1 ? moving.value.items[0]!.name : `${moving.value.items.length} éléments`) : ''))
/** Déplacement ou copie de plusieurs éléments vers un dossier (bandeau ou glisser-déposer). */
async function transfer(items: { path: string, name: string }[], toDir: string, copy: boolean): Promise<boolean> {
  moveBusy.value = true
  const done: { from: string, to: string }[] = []
  const failed: string[] = []
  try {
    for (const it of items) {
      try {
        done.push(await $fetch<{ from: string, to: string }>(`${base.value}/${copy ? 'copy' : 'move'}`, { method: 'POST', body: { mount: mount.value, path: it.path, to: toDir } }))
      }
      catch (err) {
        failed.push(`${it.name} : ${apiError(err).message}`)
      }
    }
    if (done.length === 1) toast.success(`${done[0]!.from} ${copy ? 'copié' : 'déplacé'} vers ${done[0]!.to}`)
    else if (done.length) toast.success(`${done.length} éléments ${copy ? 'copiés' : 'déplacés'} vers ${current.value?.destination}${toDir ? `/${toDir}` : ''}`)
    for (const f of failed) toast.error(f)
    if (done.length) {
      clearSelection()
      await load()
    }
    return done.length > 0
  }
  finally {
    moveBusy.value = false
  }
}
async function moveHere() {
  if (!moving.value || moving.value.mount !== mount.value) return
  // Tout a échoué : le bandeau reste (choisir un autre dossier, ou annuler).
  if (await transfer(moving.value.items, path.value, moving.value.mode === 'copy')) moving.value = null
}

// Sélection multiple (dossier ouvert) : actions groupées, chacune passant par l'opération unitaire.
const selected = ref<string[]>([])
function clearSelection() {
  selected.value = []
}
watch([mount, path], clearSelection)
// « Tout sélectionner » : les éléments affichés (filtre rapide compris).
const selectable = computed(() => entries.value.map(e => e.name))
const allSelected = computed({
  get: () => selectable.value.length > 0 && selected.value.length === selectable.value.length,
  set: (v: boolean) => {
    selected.value = v ? [...selectable.value] : []
  },
})
const bulkBusy = ref(false)
async function bulkDelete() {
  const items = (listing.value?.entries ?? []).filter(e => selected.value.includes(e.name))
  if (!items.length) return
  const dirs = items.filter(e => e.kind === 'dir').length
  const ok = await confirm({
    title: `Supprimer ${items.length} élément(s)`,
    message: `${items.map(e => e.name + (e.kind === 'dir' ? '/' : '')).slice(0, 12).join(', ')}${items.length > 12 ? '…' : ''} ${items.length > 1 ? 'sont supprimés' : 'est supprimé'} définitivement${dirs ? `, dont ${dirs} dossier(s) avec tout leur contenu` : ''} (aucune copie n'est gardée).`,
    confirmLabel: 'Supprimer',
    danger: true,
    requireText: dirs ? 'supprimer' : undefined,
  })
  if (!ok) return
  bulkBusy.value = true
  let done = 0
  try {
    for (const e of items) {
      try {
        await $fetch(`${base.value}/file`, { method: 'DELETE', query: { mount: mount.value, path: join(path.value, e.name), recursive: e.kind === 'dir' ? '1' : '0' } })
        done++
      }
      catch (err) {
        toast.error(`${e.name} : ${apiError(err).message}`)
      }
    }
    if (done) toast.success(`${done} élément(s) supprimé(s)`)
    clearSelection()
    await load()
  }
  finally {
    bulkBusy.value = false
  }
}
async function bulkZip() {
  if (!selected.value.length) return
  bulkBusy.value = true
  try {
    const r = await $fetch<{ path: string, size: number }>(`${base.value}/zip`, { method: 'POST', body: { mount: mount.value, paths: selected.value.map(n => join(path.value, n)) } })
    toast.success(`Archive ${r.path} créée (${formatBytes(r.size)})`)
    clearSelection()
    await load()
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    bulkBusy.value = false
  }
}
const bulkZipUrl = computed(() => {
  const q = new URLSearchParams({ mount: mount.value ?? '' })
  for (const n of selected.value) q.append('path', join(path.value, n))
  return `${base.value}/download-zip?${q}`
})

// Droits et propriétaire : mode octal (lecture rwx affichée), uid:gid, récursif pour un dossier.
const perms = ref<{ rel: string, name: string, kind: 'dir' | 'file' | 'link' | 'other', mode: string, uid: string, gid: string, recursive: boolean, initial: { mode: string, uid: string, gid: string } } | null>(null)
const permsBusy = ref(false)
function startPerms(e: { name: string, kind: 'dir' | 'file' | 'link' | 'other', mode: string, uid: number, gid: number }, rel: string) {
  const initial = { mode: e.mode.replace(/^0(?=\d{3}$)/, ''), uid: String(e.uid), gid: String(e.gid) }
  perms.value = { rel, name: e.name, kind: e.kind, ...initial, recursive: false, initial }
}
/** rwxr-xr-x d'un mode octal (null : mode invalide). */
function rwx(mode: string): string | null {
  if (!/^[0-7]{3,4}$/.test(mode)) return null
  return mode.slice(-3).split('').map(d => Number(d)).map(n => `${n & 4 ? 'r' : '-'}${n & 2 ? 'w' : '-'}${n & 1 ? 'x' : '-'}`).join('')
}
async function applyPerms() {
  const p = perms.value
  if (!p) return
  const changed = { mode: p.mode !== p.initial.mode && p.kind !== 'link' ? p.mode : null, uid: p.uid !== p.initial.uid ? Number(p.uid) : null, gid: p.gid !== p.initial.gid ? Number(p.gid) : null }
  if (changed.mode === null && changed.uid === null && changed.gid === null && !p.recursive) {
    perms.value = null
    return
  }
  if (p.recursive) {
    const modeToo = p.mode !== p.initial.mode
    const ok = await confirm({
      title: `Appliquer à tout le contenu de ${p.name}`,
      message: `${current.value?.destination}/${p.rel} et tout ce qu'il contient prennent le propriétaire ${p.uid}:${p.gid}${modeToo ? ` et les droits ${p.mode}. Attention : fichiers et dossiers reçoivent les mêmes droits (un dossier sans « x » n'est plus traversable, un fichier avec « x » devient exécutable)` : ' ; les droits ne changent pas'}.`,
      confirmLabel: 'Appliquer',
      danger: true,
    })
    if (!ok) return
  }
  permsBusy.value = true
  try {
    // Récursif : valeurs saisies appliquées à tout le contenu, même inchangées pour le dossier lui-même.
    const body = p.recursive
      ? { mount: mount.value, path: p.rel, mode: p.mode !== p.initial.mode ? p.mode : null, uid: Number(p.uid), gid: Number(p.gid), recursive: true }
      : { mount: mount.value, path: p.rel, ...changed, recursive: false }
    const r = await $fetch<{ path: string, mode: string, owner: string }>(`${base.value}/permissions`, { method: 'POST', body })
    toast.success(`${r.path} : ${r.mode} ${r.owner}${p.recursive ? ' (contenu compris)' : ''}`)
    perms.value = null
    await load()
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    permsBusy.value = false
  }
}

// Recherche sous le dossier ouvert (sous-dossiers compris) : par nom, ou texte dans le contenu.
const searchQ = ref('')
const searchContent = ref(false)
const searching = ref(false)
const found = ref<ServiceFileSearchDto | null>(null)
async function search() {
  if (searchQ.value.trim().length < 2) return
  searching.value = true
  try {
    found.value = await $fetch<ServiceFileSearchDto>(`${base.value}/search`, { query: { mount: mount.value, path: path.value, q: searchQ.value.trim(), content: searchContent.value ? '1' : '0' } })
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    searching.value = false
  }
}
function openResult(r: { path: string, kind: string }) {
  found.value = null
  if (r.kind === 'dir') go(r.path)
  else {
    path.value = r.path.split('/').slice(0, -1).join('/')
    void load()
    void openFile(r.path)
  }
}

// Aperçu d'une image (servie en ligne par la console, sans exécution possible) : ajustée ou taille réelle.
const isImage = computed(() => !!file.value && !isNew.value && !!imageTypeOf(file.value.path || current.value?.destination || ''))
const previewUrl = computed(() => (file.value ? `${downloadUrl(file.value.path)}&inline=1&v=${encodeURIComponent(file.value.mtime)}` : ''))
const zoom = ref(false)
const dims = ref<string | null>(null)
const imgError = ref(false)
watch(() => file.value?.path, () => {
  zoom.value = false
  dims.value = null
  imgError.value = false
})
function onImgLoad(e: Event) {
  const img = e.target as HTMLImageElement
  dims.value = `${img.naturalWidth} × ${img.naturalHeight} px`
}

// Extraction d'une archive zip / tar dans un nouveau dossier à côté d'elle (rien n'est écrasé).
const extracting = ref<string | null>(null)
async function extract(rel: string) {
  const a = archiveOf(rel)
  if (!a) return
  const dir = `${current.value?.destination ?? ''}${rel.includes('/') ? `/${rel.split('/').slice(0, -1).join('/')}` : ''}`
  if (!(await confirm({ title: `Extraire ${rel.split('/').pop()}`, message: `Le contenu de l'archive est extrait dans un nouveau dossier ${dir}/${a.folder}/ (ou ${a.folder}-2/… s'il existe déjà) : aucun fichier existant n'est remplacé. Propriétaire : celui de ${dir}. La place libre est vérifiée avant.`, confirmLabel: 'Extraire' }))) return
  extracting.value = rel
  try {
    const r = await $fetch<{ path: string, entries: number, bytes: number }>(`${base.value}/extract`, { method: 'POST', body: { mount: mount.value, path: rel } })
    toast.success(`Extrait dans ${r.path} : ${r.entries} élément(s), ${formatBytes(r.bytes)}`)
    file.value = null
    await load()
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    extracting.value = null
  }
}

// Archive zip d'un fichier ou d'un dossier : créée à côté de lui, ou téléchargée (compressée à la volée).
const zipping = ref<string | null>(null)
async function makeZip(rel: string) {
  zipping.value = rel
  try {
    const r = await $fetch<{ path: string, size: number }>(`${base.value}/zip`, { method: 'POST', body: { mount: mount.value, path: rel } })
    toast.success(`Archive ${r.path} créée (${formatBytes(r.size)})`)
    await load()
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    zipping.value = null
  }
}
const zipUrl = (rel: string) => `${base.value}/download-zip?${new URLSearchParams({ mount: mount.value ?? '', path: rel })}`

// Tri des colonnes (dossiers toujours en tête, noms en ordre naturel) ; choix retenu dans ce navigateur.
type SortKey = 'name' | 'size' | 'mtime' | 'mode'
const SORT_STORE = 'service-files.sort'
const sort = ref<{ key: SortKey, dir: 'asc' | 'desc' }>({ key: 'name', dir: 'asc' })
onMounted(() => {
  try {
    const saved = JSON.parse(localStorage.getItem(SORT_STORE) ?? 'null') as typeof sort.value | null
    if (saved && ['name', 'size', 'mtime', 'mode'].includes(saved.key) && ['asc', 'desc'].includes(saved.dir)) sort.value = saved
  }
  catch { /* stockage indisponible : tri par défaut */ }
})
function sortBy(key: SortKey) {
  // Taille et date : du plus grand / plus récent d'abord au premier clic.
  sort.value = sort.value.key === key ? { key, dir: sort.value.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'size' || key === 'mtime' ? 'desc' : 'asc' }
  try {
    localStorage.setItem(SORT_STORE, JSON.stringify(sort.value))
  }
  catch { /* stockage indisponible */ }
}
const collator = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' })
function sorted<T extends { name?: string, path?: string, kind: string, size: number, mtime: string, mode: string }>(list: readonly T[]): T[] {
  const { key, dir } = sort.value
  const sign = dir === 'asc' ? 1 : -1
  const label = (e: T) => e.name ?? e.path ?? ''
  return [...list].sort((a, b) => {
    const dirs = Number(b.kind === 'dir') - Number(a.kind === 'dir')
    if (dirs) return dirs
    const c = key === 'size' ? a.size - b.size : key === 'mtime' ? a.mtime.localeCompare(b.mtime) : key === 'mode' ? a.mode.localeCompare(b.mode) : 0
    return (c || collator.compare(label(a), label(b))) * (c ? sign : key === 'name' ? sign : 1)
  })
}
// Filtre rapide par nom (dossier ouvert, instantané) : « / » pour y aller, Échap pour le vider.
const quick = ref('')
const quickInput = ref<HTMLInputElement | null>(null)
watch(path, () => {
  quick.value = ''
})
const entries = computed(() => {
  const q = quick.value.trim().toLowerCase()
  // Liste d'un autre dossier (chargement en cours après un changement de dossier) : rien d'affiché,
  // pour qu'aucune action ne porte sur un élément de l'ancien dossier avec le nouveau chemin.
  if (!listing.value || listing.value.path !== path.value || listing.value.mount !== mount.value) return []
  const all = sorted(listing.value.entries)
  return q ? all.filter(e => e.name.toLowerCase().includes(q)) : all
})
// Navigation au clavier dans la liste (grille, ligne courante en aria-activedescendant).
const grid = ref<HTMLElement | null>(null)
const active = ref(0)
const gridId = `files-${useId()}`
watch(entries, (list) => {
  if (active.value >= list.length) active.value = Math.max(0, list.length - 1)
})
watch(path, () => {
  active.value = 0
})
function focusRow(i: number) {
  active.value = Math.min(Math.max(0, i), Math.max(0, entries.value.length - 1))
  void nextTick(() => document.getElementById(`${gridId}-${active.value}`)?.scrollIntoView({ block: 'nearest' }))
}
function toggle(name: string, on?: boolean) {
  const has = selected.value.includes(name)
  const want = on ?? !has
  if (want && !has) selected.value = [...selected.value, name]
  else if (!want && has) selected.value = selected.value.filter(n => n !== name)
}
function openEntry(e: { name: string, kind: string }) {
  if (e.kind === 'dir') go(join(path.value, e.name))
  else if (e.kind === 'file') void openFile(join(path.value, e.name))
}
// Saisie de lettres : premier nom qui commence par ce qui a été tapé (en moins d'une seconde).
let typed = ''
let typedAt = 0
function gridKey(e: KeyboardEvent) {
  // Touches des champs et liens de la liste (renommage, cases, noms) : laissées à eux.
  if (e.target !== grid.value) return
  const list = entries.value
  const cur = list[active.value]
  const mod = e.ctrlKey || e.metaKey
  const parent = () => {
    if (path.value) go(crumbs.value.slice(0, -1).join('/'))
  }
  // Toute autre touche que des lettres remet la saisie à zéro.
  if (e.key.length !== 1 || e.key === ' ' || e.key === '/' || mod || e.altKey) typed = ''
  switch (true) {
    case e.key === 'ArrowDown' || e.key === 'ArrowUp': {
      if (e.altKey && e.key === 'ArrowUp') {
        parent()
        break
      }
      const next = active.value + (e.key === 'ArrowDown' ? 1 : -1)
      if (e.shiftKey && cur) toggle(cur.name, true)
      focusRow(next)
      if (e.shiftKey && list[active.value]) toggle(list[active.value]!.name, true)
      break
    }
    case e.key === 'Home':
      focusRow(0)
      break
    case e.key === 'End':
      focusRow(list.length - 1)
      break
    case e.key === 'Enter':
      if (cur) openEntry(cur)
      break
    case e.key === 'Backspace':
      parent()
      break
    case e.key === ' ':
      if (cur) toggle(cur.name)
      break
    case mod && (e.key.toLowerCase() === 'c' || e.key.toLowerCase() === 'x'): {
      if (!current.value?.writable) return
      const names = selected.value.length ? [...selected.value] : cur ? [cur.name] : []
      clipSet(e.key.toLowerCase() === 'c' ? 'copy' : 'cut', names)
      break
    }
    case mod && e.key.toLowerCase() === 'v':
      // Presse-papiers de l'explorateur ; sinon, l'évènement « coller » du navigateur (fichiers du poste).
      if (!clip.value) return
      void paste()
      break
    case mod && e.key.toLowerCase() === 'a':

      selected.value = list.map(x => x.name)
      break
    case e.key === 'Delete':
      if (!current.value?.writable) return
      if (selected.value.length) void bulkDelete()
      else if (cur) void remove(join(path.value, cur.name), cur.kind as 'dir' | 'file' | 'link' | 'other')
      break
    case e.key === 'F2':
      if (cur) startRename(cur.name)
      break
    case e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'): {
      const row = document.getElementById(`${gridId}-${active.value}`)?.getBoundingClientRect()
      if (cur && row) openMenu(row.left + 40, row.bottom - 4, cur as Entry)
      break
    }
    case e.key === 'Escape':
      if (!selected.value.length) return
      clearSelection()
      break
    case e.key.length === 1 && e.key !== '/' && !mod && !e.altKey: {
      const now = Date.now()
      typed = now - typedAt < 1000 ? typed + e.key.toLowerCase() : e.key.toLowerCase()
      typedAt = now
      const i = list.findIndex(x => x.name.toLowerCase().startsWith(typed))
      if (i >= 0) focusRow(i)
      break
    }
    default:
      return
  }
  e.preventDefault()
}
// Après un changement de dossier au clavier, la liste garde le focus.
watch(listing, () => {
  if (document.activeElement === grid.value) focusRow(active.value)
})

function onDialogKey(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null
  const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
  if (e.key === '/' && !typing && !file.value && quickInput.value) {
    e.preventDefault()
    quickInput.value.focus()
  }
}
function quickKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && quick.value) {
    e.preventDefault()
    quick.value = ''
  }
}
const results = computed(() => sorted(found.value?.results ?? []))
const ariaSort = (key: SortKey) => (sort.value.key === key ? (sort.value.dir === 'asc' ? 'ascending' : 'descending') : 'none')

// Presse-papiers de l'explorateur (Ctrl/Cmd+C, X, V) : copier ou couper, puis coller dans un dossier
// du même montage ; conservé en changeant de dossier. Fichiers du poste collés : envoyés.
const clip = ref<{ mode: 'copy' | 'cut', mount: string, items: { path: string, name: string }[] } | null>(null)
function clipSet(mode: 'copy' | 'cut', names: string[]) {
  if (mount.value === null || !names.length) return
  clip.value = { mode, mount: mount.value, items: names.map(n => ({ path: join(path.value, n), name: n })) }
  toast.success(`${names.length === 1 ? names[0] : `${names.length} éléments`} ${mode === 'copy' ? 'copié' : 'coupé'}${names.length > 1 ? 's' : ''} : coller avec Ctrl+V dans le dossier voulu`)
}
const clipLabel = computed(() => (clip.value ? `${clip.value.items.length === 1 ? clip.value.items[0]!.name : `${clip.value.items.length} éléments`} à ${clip.value.mode === 'copy' ? 'copier' : 'déplacer'}` : ''))
async function paste(toDir = path.value) {
  const c = clip.value
  if (!c || !current.value?.writable) return
  if (c.mount !== mount.value) {
    toast.error('Collage dans le même montage seulement (montage d\'origine : ' + c.mount + ')')
    return
  }
  const ok = await transfer(c.items, toDir, c.mode === 'copy')
  // Couper : une fois collé, plus rien à coller (les originaux ont bougé).
  if (ok && c.mode === 'cut') clip.value = null
}
function onPaste(e: ClipboardEvent) {
  const t = e.target as HTMLElement | null
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
  const files = [...(e.clipboardData?.files ?? [])]
  if (!files.length || !current.value?.writable || file.value) return
  e.preventDefault()
  void uploadFiles(files.map(f => ({ file: f, sub: '' })), path.value)
}

// Menu contextuel (clic droit, touche Menu ou Maj+F10) : actions de l'élément, de la sélection ou du dossier.
type Entry = { name: string, kind: 'dir' | 'file' | 'link' | 'other', mode: string, uid: number, gid: number }
interface MenuItem { label: string, run: () => void, danger?: boolean }
const filesEl = ref<HTMLElement | null>(null)
const menuEl = ref<HTMLElement | null>(null)
const menu = ref<{ x: number, y: number, title: string, items: MenuItem[] } | null>(null)
const menuIndex = ref(0)
const newNameInput = ref<HTMLInputElement | null>(null)
function fetchFile(url: string) {
  const a = document.createElement('a')
  a.href = url
  a.download = ''
  a.click()
}
function menuItems(entry: Entry | null): { title: string, items: MenuItem[] } {
  const w = !!current.value?.writable
  const items: MenuItem[] = []
  const add = (ok: boolean, label: string, run: () => void, danger = false) => {
    if (ok) items.push({ label, run, danger })
  }
  // Clic droit sur un élément d'une sélection multiple : actions groupées.
  if (entry && selected.value.length > 1 && selected.value.includes(entry.name)) {
    add(w, 'Copier (presse-papiers)', () => clipSet('copy', [...selected.value]))
    add(w, 'Couper', () => clipSet('cut', [...selected.value]))
    add(true, 'Télécharger en zip', () => fetchFile(bulkZipUrl.value))
    add(w, 'Créer une archive zip', () => void bulkZip())
    add(w, 'Copier…', () => startMove([...selected.value], 'copy'))
    add(w, 'Déplacer…', () => startMove([...selected.value], 'move'))
    add(w, 'Supprimer', () => void bulkDelete(), true)
    return { title: `${selected.value.length} éléments sélectionnés`, items }
  }
  if (entry) {
    const rel = join(path.value, entry.name)
    add(entry.kind === 'dir' || entry.kind === 'file', 'Ouvrir', () => openEntry(entry))
    add(entry.kind === 'file', 'Télécharger', () => fetchFile(downloadUrl(rel)))
    add(entry.kind === 'dir', 'Télécharger en zip', () => fetchFile(zipUrl(rel)))
    add(w && entry.kind === 'file' && !!archiveOf(entry.name), 'Extraire', () => void extract(rel))
    add(w, 'Copier (presse-papiers)', () => clipSet('copy', [entry.name]))
    add(w, 'Couper', () => clipSet('cut', [entry.name]))
    add(w && !!clip.value && entry.kind === 'dir', 'Coller dans ce dossier', () => void paste(rel))
    add(w, 'Renommer', () => startRename(entry.name))
    add(w, 'Copier…', () => startMove(entry.name, 'copy'))
    add(w, 'Déplacer…', () => startMove(entry.name, 'move'))
    add(w, 'Droits et propriétaire…', () => startPerms(entry, rel))
    add(w && (entry.kind === 'dir' || entry.kind === 'file') && !archiveOf(entry.name), 'Créer une archive zip', () => void makeZip(rel))
    add(w, 'Supprimer', () => void remove(rel, entry.kind), true)
    return { title: entry.name, items }
  }
  add(w && !!clip.value, `Coller ici (${clipLabel.value})`, () => void paste())
  add(w, 'Nouveau dossier…', () => void nextTick(() => newNameInput.value?.focus()))
  add(w, 'Envoyer des fichiers…', () => picker.value?.click())
  add(true, 'Télécharger le dossier en zip', () => fetchFile(zipUrl(path.value)))
  add(true, 'Relire le dossier', () => void load())
  return { title: `${current.value?.destination ?? ''}${path.value ? `/${path.value}` : ''}`, items }
}
/** Ouverture à une position de la fenêtre (coordonnées de l'écran ramenées à celles de l'explorateur). */
function openMenu(clientX: number, clientY: number, entry: Entry | null) {
  if (!filesEl.value) return
  const box = filesEl.value.getBoundingClientRect()
  const m = menuItems(entry)
  if (!m.items.length) return
  menu.value = { ...m, x: clientX - box.left, y: clientY - box.top }
  menuIndex.value = 0
  void nextTick(() => {
    const el = menuEl.value
    if (!el) return
    // Gardé dans la fenêtre : décalé vers la gauche ou le haut s'il déborde.
    const r = el.getBoundingClientRect()
    if (menu.value && r.right > window.innerWidth - 8) menu.value.x -= r.right - window.innerWidth + 8
    if (menu.value && r.bottom > window.innerHeight - 8) menu.value.y -= r.bottom - window.innerHeight + 8
    el.focus()
  })
}
function rowMenu(e: MouseEvent, entry: Entry, i: number) {
  e.preventDefault()
  active.value = i
  openMenu(e.clientX, e.clientY, entry)
}
function folderMenu(e: MouseEvent) {
  e.preventDefault()
  openMenu(e.clientX, e.clientY, null)
}
function closeMenu(refocus = true) {
  menu.value = null
  if (refocus) void nextTick(() => grid.value?.focus())
}
function runMenu(i: number) {
  const item = menu.value?.items[i]
  if (!item) return
  closeMenu(false)
  item.run()
}
function menuKey(e: KeyboardEvent) {
  const n = menu.value?.items.length ?? 0
  if (e.key === 'ArrowDown') menuIndex.value = (menuIndex.value + 1) % n
  else if (e.key === 'ArrowUp') menuIndex.value = (menuIndex.value - 1 + n) % n
  else if (e.key === 'Home') menuIndex.value = 0
  else if (e.key === 'End') menuIndex.value = n - 1
  else if (e.key === 'Enter' || e.key === ' ') runMenu(menuIndex.value)
  else if (e.key === 'Escape' || e.key === 'Tab') closeMenu()
  else return
  e.preventDefault()
  e.stopPropagation()
}
// Clic ailleurs : menu fermé.
function outside(e: MouseEvent) {
  if (menu.value && !menuEl.value?.contains(e.target as Node)) closeMenu(false)
}
onMounted(() => document.addEventListener('mousedown', outside, true))
onBeforeUnmount(() => document.removeEventListener('mousedown', outside, true))

// Historique des versions d'un fichier : copies gardées par la console avant chaque modification.
interface Version { name: string, path: string, at: string, size: number }
const versions = ref<Version[] | null>(null)
const showHistory = ref(false)
const compared = ref<{ version: Version, diff: string | null, reason: string | null } | null>(null)
const versionBusy = ref<string | null>(null)
async function loadVersions() {
  if (!file.value || isNew.value) return
  try {
    versions.value = await $fetch<Version[]>(`${base.value}/versions`, { query: { mount: mount.value, path: file.value.path } })
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
}
watch(() => file.value?.path, () => {
  versions.value = null
  compared.value = null
  if (showHistory.value) void loadVersions()
})
async function toggleHistory() {
  showHistory.value = !showHistory.value
  compared.value = null
  if (showHistory.value) await loadVersions()
}
async function compare(v: Version) {
  versionBusy.value = v.name
  try {
    const old = await $fetch<ServiceFileDto>(`${base.value}/file`, { query: { mount: mount.value, path: v.path } })
    const name = file.value!.path.split('/').pop()!
    compared.value = old.content === null || file.value!.content === null
      ? { version: v, diff: null, reason: 'Fichier binaire ou trop volumineux : comparaison impossible (télécharger la version)' }
      : { version: v, diff: createTwoFilesPatch(`${name} (${fmtDateTime(v.at)})`, `${name} (actuel)`, old.content, file.value!.content, '', '', { context: 3 }), reason: null }
    if (compared.value.diff !== null && !/^[+-](?![+-])/m.test(compared.value.diff)) compared.value.reason = 'Identique à la version actuelle'
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    versionBusy.value = null
  }
}
async function restoreVersion(v: Version) {
  if (!file.value) return
  const name = file.value.path.split('/').pop()
  if (!(await confirm({ title: `Restaurer la version du ${fmtDateTime(v.at)}`, message: `${name} reprend son contenu du ${fmtDateTime(v.at)}. La version actuelle est d'abord gardée à son tour (la restauration se défait depuis l'historique).${listing.value?.running && stopService.value ? ` ${props.service} est arrêté pendant l'opération puis relancé.` : ''}`, confirmLabel: 'Restaurer' }))) return
  versionBusy.value = v.name
  try {
    const r = await $fetch<{ path: string, backup: string | null, restarted: boolean }>(`${base.value}/restore`, { method: 'POST', body: { mount: mount.value, path: file.value.path, version: v.name, stopService: stopService.value && !!listing.value?.running } })
    toast.success(`${r.path} restauré (version du ${fmtDateTime(v.at)})${r.restarted ? ` · ${props.service} relancé` : ''}`)
    compared.value = null
    await openFile(file.value.path)
    await loadVersions()
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    versionBusy.value = null
  }
}
async function deleteVersion(v: Version) {
  if (!(await confirm({ title: 'Supprimer cette version', message: `La version du ${fmtDateTime(v.at)} (${v.name}) est supprimée définitivement.`, confirmLabel: 'Supprimer', danger: true }))) return
  versionBusy.value = v.name
  try {
    await $fetch(`${base.value}/file`, { method: 'DELETE', query: { mount: mount.value, path: v.path, recursive: '0' } })
    if (compared.value?.version.name === v.name) compared.value = null
    await loadVersions()
  }
  catch (err) {
    toast.error(apiError(err).message)
  }
  finally {
    versionBusy.value = null
  }
}

/** Lien de téléchargement (flux transmis par la console, session du navigateur). */
const downloadUrl = (rel: string) => `${base.value}/download?${new URLSearchParams({ mount: mount.value ?? '', path: rel })}`
const ICON = { dir: Folder, file: File, link: Link2, other: FileWarning } as const
</script>

<template>
  <UiModal v-model:open="open" :title="`Fichiers de ${service}`" width="980px">
    <div ref="filesEl" class="files" @keydown="onDialogKey" @paste="onPaste">
      <div v-if="menu" ref="menuEl" class="ctx" role="menu" tabindex="-1" :aria-label="`Actions : ${menu.title}`" :style="{ left: `${menu.x}px`, top: `${menu.y}px` }" @keydown="menuKey" @contextmenu.prevent>
        <div class="ctx-title tiny muted mono">{{ menu.title }}</div>
        <button v-for="(it, i) in menu.items" :key="it.label" type="button" role="menuitem" tabindex="-1" class="ctx-item" :class="{ on: i === menuIndex, danger: it.danger }" @mouseenter="menuIndex = i" @click="runMenu(i)">{{ it.label }}</button>
      </div>
      <p v-if="listError" class="alert">{{ listError }}</p>
      <p v-else-if="!listing" class="muted small">Lecture des montages de {{ service }}…</p>
      <template v-else>
        <p v-if="!listing.mounts.length" class="muted small">{{ service }} n'a aucun volume ni dossier de l'hôte monté : ses fichiers sont dans l'image et ne survivent pas à la recréation du conteneur.</p>
        <template v-else>
          <div class="mounts" role="tablist" aria-label="Montages">
            <button v-for="m in listing.mounts" :key="m.destination" type="button" role="tab" :aria-selected="m.destination === mount" :class="{ on: m.destination === mount }" :title="`${m.type === 'volume' ? 'Volume' : 'Dossier de l\'hôte'} ${m.source}`" @click="chooseMount(m.destination)">
              <FolderOpen :size="13" /> <span class="mono">{{ m.destination }}</span>
              <UiBadge v-if="!m.writable" tone="neutral">lecture seule</UiBadge>
            </button>
          </div>
          <p v-if="current" class="muted tiny">{{ current.type === 'volume' ? 'Volume' : 'Dossier de l\'hôte' }} <span class="mono">{{ current.source }}</span> · conteneur {{ listing.container }} {{ listing.running ? '(en marche)' : '(arrêté)' }}</p>

          <!-- Fichier ouvert -->
          <section v-if="file" ref="editorEl" class="editor" :class="{ full: fullscreen }" aria-label="Éditeur de fichier">
            <div class="bar">
              <UiButton size="sm" variant="ghost" @click="back"><ArrowLeft :size="13" /> {{ listing.isFile ? 'Fermer' : 'Dossier' }}</UiButton>
              <span class="mono path">{{ current?.destination }}{{ file.path ? `/${file.path}` : '' }}</span>
              <span class="muted tiny">{{ isNew ? 'nouveau fichier' : `${formatBytes(file.size)} · modifié le ${fmtDateTime(file.mtime)} · ${file.mode} · ${file.uid}:${file.gid}` }}</span>
              <span class="spacer" />
<a v-if="!isNew" :href="downloadUrl(file.path)" download class="dl small" :aria-label="`Télécharger ${file.path || current?.destination}`"><Download :size="13" /> Télécharger</a>
              <UiButton v-if="!isNew && file.path" size="sm" :variant="showHistory ? 'primary' : 'ghost'" :aria-pressed="showHistory" @click="toggleHistory"><History :size="13" /> Historique{{ versions ? ` (${versions.length})` : '' }}</UiButton>
              <UiButton v-if="!isNew && file.path && current?.writable" size="sm" variant="ghost" :loading="deleting === file.path" :aria-label="`Supprimer ${file.path}`" @click="remove(file.path, 'file')"><Trash2 :size="13" /> Supprimer</UiButton>
              <UiButton v-if="!isNew" size="sm" variant="ghost" :loading="fileLoading" aria-label="Recharger le fichier" title="Recharger" @click="openFile(file.path)"><RefreshCw :size="13" /></UiButton>
              <UiButton v-if="file.content !== null || isImage" size="sm" variant="ghost" :aria-label="fullscreen ? 'Quitter le plein écran' : 'Plein écran'" :title="fullscreen ? 'Quitter le plein écran (Échap)' : 'Éditer en plein écran'" @click="toggleFullscreen"><component :is="fullscreen ? Minimize2 : Maximize2" :size="13" /> {{ fullscreen ? 'Quitter le plein écran' : 'Plein écran' }}</UiButton>
            </div>
            <section v-if="showHistory" class="history" aria-label="Historique des versions">
              <p v-if="!versions" class="muted small">Lecture des versions…</p>
              <p v-else-if="!versions.length" class="muted small">Aucune version gardée : la console garde la version précédente à chaque enregistrement, remplacement ou restauration.</p>
              <table v-else class="list">
                <thead><tr><th>Version</th><th class="num">Taille</th><th /></tr></thead>
                <tbody>
                  <tr v-for="v in versions" :key="v.name" :class="{ picked: compared?.version.name === v.name }">
                    <td><span class="small">{{ fmtDateTime(v.at) }}</span> <span class="muted tiny mono">{{ v.name }}</span></td>
                    <td class="num small">{{ formatBytes(v.size) }}</td>
                    <td class="num acts">
                      <UiButton size="sm" variant="ghost" :loading="versionBusy === v.name" :aria-label="`Comparer la version du ${fmtDateTime(v.at)}`" @click="compare(v)">Comparer</UiButton>
                      <UiButton v-if="current?.writable" size="sm" variant="ghost" :aria-label="`Restaurer la version du ${fmtDateTime(v.at)}`" @click="restoreVersion(v)">Restaurer</UiButton>
                      <a :href="downloadUrl(v.path)" download class="dl" :aria-label="`Télécharger la version du ${fmtDateTime(v.at)}`"><Download :size="13" /></a>
                      <UiButton v-if="current?.writable" size="sm" variant="ghost" :aria-label="`Supprimer la version du ${fmtDateTime(v.at)}`" @click="deleteVersion(v)"><Trash2 :size="13" /></UiButton>
                    </td>
                  </tr>
                </tbody>
              </table>
              <div v-if="compared" class="compare" aria-label="Comparaison">
                <p class="small"><strong>Version du {{ fmtDateTime(compared.version.at) }}</strong> → version actuelle <span class="muted tiny">(lignes « - » : retirées depuis, « + » : ajoutées depuis)</span></p>
                <p v-if="compared.reason" class="muted small">{{ compared.reason }}</p>
                <DiffView v-else-if="compared.diff" :diff="compared.diff" />
              </div>
            </section>
            <figure v-if="isImage && file.size <= MAX_PREVIEW_BYTES" class="preview" :class="{ actual: zoom }">
              <img v-if="!imgError" :src="previewUrl" :alt="`Aperçu de ${file.path || current?.destination}`" :title="zoom ? 'Ajuster à la fenêtre' : 'Taille réelle'" @load="onImgLoad" @error="imgError = true" @click="zoom = !zoom">
              <p v-else class="muted small">Aperçu impossible (format non reconnu par le navigateur) : le <a :href="downloadUrl(file.path)" download>télécharger</a>.</p>
              <figcaption class="muted tiny">{{ dims ?? '…' }} · {{ formatBytes(file.size) }} · cliquer sur l'image : {{ zoom ? 'ajuster à la fenêtre' : 'taille réelle' }}</figcaption>
            </figure>
            <p v-else-if="isImage" class="muted small">Image de plus de {{ formatBytes(MAX_PREVIEW_BYTES) }} : la <a :href="downloadUrl(file.path)" download>télécharger</a> pour la voir.</p>
            <p v-if="file.content === null && !isImage" class="muted small">
              {{ archiveOf(file.path) ? 'Archive' : file.reason }} : la <a :href="downloadUrl(file.path)" download>télécharger</a><template v-if="archiveOf(file.path) && current?.writable">, ou <UiButton size="sm" :loading="extracting === file.path" @click="extract(file.path)"><PackageOpen :size="13" /> l'extraire ici</UiButton></template>.
            </p>
            <template v-else>
              <LazyUiCodeEditor :key="`${mount}:${file.path}:${isNew}`" v-model="draft" class="code" :filename="file.path || current?.destination || ''" :readonly="!file.writable" :label="`Contenu de ${file.path || current?.destination}`" @save="dirty && file.writable && save()" @caret="c => caret = c" />
              <div v-if="file.writable" class="save">
                <label v-if="listing.running" class="check small"><input v-model="stopService" type="checkbox"> Arrêter {{ service }} pendant l'enregistrement puis le relancer (recommandé : certains services réécrivent leur configuration à l'arrêt)</label>
                <span class="spacer" />
                <span class="muted tiny mono">L{{ caret.line }}:C{{ caret.col }}{{ dirty ? ' · modifié' : '' }}</span>
                <span v-if="saveMsg" class="tiny" :class="saveMsg.ok ? 'ok' : 'bad'" role="status">{{ saveMsg.text }}</span>
                <UiButton variant="primary" :loading="saving" :disabled="!dirty" title="Ctrl+S / Cmd+S" @click="save">{{ isNew ? 'Créer le fichier' : 'Enregistrer' }}</UiButton>
              </div>
              <p v-else class="muted small">Lecture seule : montage en lecture seule dans le service.</p>
              <p v-if="file.writable && !isNew" class="muted tiny">L'ancienne version est copiée à côté (<span class="mono">{{ file.path.split('/').pop() }}.console-…bak</span>) à chaque enregistrement.</p>
            </template>
          </section>

          <!-- Dossier -->
          <section v-else-if="!listing.isFile" class="dropzone" :class="{ over: dropTarget === path }" aria-label="Contenu du dossier" @contextmenu="folderMenu" @dragover="dragOver($event, path)" @dragleave.self="dropTarget = null" @drop="drop($event, path)">
            <p v-if="dropTarget === path" class="drop-hint small" aria-hidden="true">Déposer ici : {{ current?.destination }}{{ path ? `/${path}` : '' }}</p>
            <div class="bar">
              <nav class="crumbs small" aria-label="Chemin">
                <a href="#" class="mono" :class="{ 'drop-on': dropTarget === '' && path !== '' }" @click.prevent="go('')" @dragover.stop="dragOver($event, '')" @drop.stop="drop($event, '')">{{ current?.destination }}</a>
                <template v-for="(c, i) in crumbs" :key="i"> / <a href="#" class="mono" :class="{ 'drop-on': dropTarget === crumbs.slice(0, i + 1).join('/') && i < crumbs.length - 1 }" @click.prevent="go(crumbs.slice(0, i + 1).join('/'))" @dragover.stop="dragOver($event, crumbs.slice(0, i + 1).join('/'))" @drop.stop="drop($event, crumbs.slice(0, i + 1).join('/'))">{{ c }}</a></template>
              </nav>
              <span class="spacer" />
              <template v-if="current?.writable">
                <input ref="newNameInput" v-model.trim="newName" class="input input-sm mono newname" placeholder="nom du fichier ou du dossier" aria-label="Nom du nouveau fichier ou dossier" @keydown.enter="startNew">
                <UiButton size="sm" :disabled="!newName" @click="startNew"><Plus :size="13" /> Nouveau fichier</UiButton>
                <UiButton size="sm" :disabled="!newName" :loading="creatingDir" @click="makeDir"><FolderPlus :size="13" /> Nouveau dossier</UiButton>
              </template>
              <template v-if="current?.writable">
                <input ref="picker" type="file" multiple class="sr-only" aria-label="Fichier à envoyer" @change="upload">
                <UiButton size="sm" :loading="!!sending" @click="picker?.click()"><Upload :size="13" /> Envoyer un fichier</UiButton>
              </template>
              <a :href="zipUrl(path)" download class="dl small" :aria-label="`Télécharger ${path ? path.split('/').pop() : current?.destination} en zip`"><Download :size="13" /> Zip du dossier</a>
              <UiButton size="sm" variant="ghost" :loading="loading" aria-label="Relire le dossier" title="Relire" @click="load"><RefreshCw :size="13" /></UiButton>
            </div>
            <div v-if="clip" class="clip small" role="status" aria-label="Presse-papiers">
              <span>Presse-papiers : <span class="mono">{{ clipLabel }}</span></span>
              <UiButton v-if="current?.writable && clip.mount === mount" size="sm" variant="primary" :loading="moveBusy" @click="paste()">Coller ici</UiButton>
              <span v-else class="muted tiny">(collage dans {{ clip.mount }} seulement)</span>
              <UiButton size="sm" variant="ghost" @click="clip = null">Vider</UiButton>
            </div>
            <div v-if="selected.length" class="bulk small" role="toolbar" aria-label="Sélection">
              <strong>{{ selected.length }} sélectionné{{ selected.length > 1 ? 's' : '' }}</strong>
              <a :href="bulkZipUrl" download class="dl"><Download :size="13" /> Télécharger en zip</a>
              <template v-if="current?.writable">
                <UiButton size="sm" :loading="bulkBusy" @click="bulkZip"><FileArchive :size="13" /> Créer une archive zip</UiButton>
                <UiButton size="sm" @click="startMove([...selected], 'copy')"><Copy :size="13" /> Copier…</UiButton>
                <UiButton size="sm" @click="startMove([...selected], 'move')"><FolderInput :size="13" /> Déplacer…</UiButton>
                <UiButton size="sm" variant="danger" :loading="bulkBusy" @click="bulkDelete"><Trash2 :size="13" /> Supprimer</UiButton>
              </template>
              <UiButton size="sm" variant="ghost" @click="clearSelection">Désélectionner</UiButton>
            </div>
            <div v-if="perms" class="perms small" role="group" :aria-label="`Droits de ${perms.name}`">
              <strong>Droits de <span class="mono">{{ perms.name || current?.destination }}</span></strong>
              <label v-if="perms.kind !== 'link'">Mode <input v-model.trim="perms.mode" class="input input-sm mono mode" maxlength="4" :aria-label="`Mode de ${perms.name}`"></label>
              <span v-if="perms.kind !== 'link'" class="mono muted" :class="{ bad: !rwx(perms.mode) }">{{ rwx(perms.mode) ?? 'mode invalide' }}</span>
              <label>Propriétaire <input v-model.trim="perms.uid" class="input input-sm mono id" inputmode="numeric" :aria-label="`UID de ${perms.name}`"></label>
              <label>Groupe <input v-model.trim="perms.gid" class="input input-sm mono id" inputmode="numeric" :aria-label="`GID de ${perms.name}`"></label>
              <label v-if="perms.kind === 'dir'" class="check"><input v-model="perms.recursive" type="checkbox"> Appliquer à tout le contenu</label>
              <UiButton size="sm" variant="primary" :loading="permsBusy" :disabled="(perms.kind !== 'link' && !rwx(perms.mode)) || !/^\d+$/.test(perms.uid) || !/^\d+$/.test(perms.gid)" @click="applyPerms">Appliquer</UiButton>
              <UiButton size="sm" variant="ghost" @click="perms = null">Annuler</UiButton>
            </div>
            <div v-if="moving" class="moving small" role="status">
              <span>{{ moving.mode === 'copy' ? 'Copier' : 'Déplacer' }} <span class="mono">{{ movingLabel }}</span> : ouvrir le dossier de destination, puis</span>
              <UiButton size="sm" variant="primary" :loading="moveBusy" :disabled="moving.mount !== mount" @click="moveHere"><component :is="moving.mode === 'copy' ? Copy : FolderInput" :size="13" /> {{ moving.mode === 'copy' ? 'Copier ici' : 'Déplacer ici' }}</UiButton>
              <UiButton size="sm" variant="ghost" @click="moving = null">{{ moving.mode === 'copy' ? 'Annuler la copie' : 'Annuler le déplacement' }}</UiButton>
              <span v-if="moving.mount !== mount" class="muted tiny">(dans le même montage seulement)</span>
            </div>
            <div v-if="sending" class="progress small" role="status">
              Envoi de <span class="mono">{{ sending.name }}</span> : {{ formatBytes(sending.sent) }} / {{ formatBytes(sending.total) }}
              <progress :value="sending.sent" :max="sending.total || 1" />
            </div>
            <div v-if="!found" class="quick">
              <Filter :size="13" class="muted" />
              <input ref="quickInput" v-model="quick" class="input input-sm" type="search" placeholder="Filtrer ce dossier par nom ( / )" aria-label="Filtrer ce dossier par nom" @keydown="quickKey">
              <span v-if="quick.trim()" class="muted tiny" role="status">{{ entries.length }} sur {{ listing.entries.length }}</span>
            </div>
            <form class="search" role="search" aria-label="Rechercher des fichiers" @submit.prevent="search">
              <input v-model="searchQ" class="input input-sm" type="search" minlength="2" :placeholder="searchContent ? 'texte à chercher dans les fichiers' : 'partie du nom'" aria-label="Rechercher sous ce dossier">
              <label class="check small"><input v-model="searchContent" type="checkbox"> dans le contenu</label>
              <UiButton size="sm" type="submit" :loading="searching" :disabled="searchQ.trim().length < 2"><Search :size="13" /> Rechercher</UiButton>
              <span class="muted tiny">sous {{ current?.destination }}{{ path ? `/${path}` : '' }}, sous-dossiers compris</span>
            </form>
            <section v-if="found" aria-label="Résultats de la recherche">
              <div class="bar">
                <strong class="small">{{ found.results.length }}{{ found.truncated ? '+' : '' }} résultat{{ found.results.length > 1 ? 's' : '' }} pour « {{ found.q }} »{{ found.content ? ' dans le contenu' : '' }}</strong>
                <span class="spacer" />
                <UiButton size="sm" variant="ghost" @click="found = null">Effacer la recherche</UiButton>
              </div>
              <table class="list">
                <thead>
                  <tr>
                    <th :aria-sort="ariaSort('name')"><button type="button" class="sort" @click="sortBy('name')">Chemin <component :is="sort.dir === 'asc' ? ArrowUp : ArrowDown" v-if="sort.key === 'name'" :size="11" /></button></th>
                    <th class="num" :aria-sort="ariaSort('size')"><button type="button" class="sort" @click="sortBy('size')">Taille <component :is="sort.dir === 'asc' ? ArrowUp : ArrowDown" v-if="sort.key === 'size'" :size="11" /></button></th>
                    <th class="m-hide" :aria-sort="ariaSort('mtime')"><button type="button" class="sort" @click="sortBy('mtime')">Modifié <component :is="sort.dir === 'asc' ? ArrowUp : ArrowDown" v-if="sort.key === 'mtime'" :size="11" /></button></th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="r in results" :key="r.path">
                    <td>
                      <a v-if="r.kind === 'dir' || r.kind === 'file'" href="#" class="entry" @click.prevent="openResult(r)"><component :is="ICON[r.kind]" :size="14" /> <span class="mono">{{ r.path }}{{ r.kind === 'dir' ? '/' : '' }}</span></a>
                      <span v-else class="entry muted"><component :is="ICON[r.kind]" :size="14" /> <span class="mono">{{ r.path }}</span></span>
                    </td>
                    <td class="num small">{{ r.kind === 'dir' ? '' : formatBytes(r.size) }}</td>
                    <td class="m-hide small muted nowrap">{{ fmtDateTime(r.mtime) }}</td>
                    <td class="num"><a v-if="r.kind === 'file'" :href="downloadUrl(r.path)" download class="dl" :aria-label="`Télécharger ${r.path}`"><Download :size="13" /></a></td>
                  </tr>
                  <tr v-if="!found.results.length"><td colspan="4" class="muted small">Aucun résultat.</td></tr>
                </tbody>
              </table>
              <p v-if="found.truncated" class="muted tiny">Seuls les 500 premiers résultats sont affichés : préciser la recherche.</p>
            </section>
            <table
              v-if="!found"
              ref="grid"
              class="list"
              role="grid"
              tabindex="0"
              aria-label="Contenu du dossier (flèches, Entrée, Retour arrière, Espace, Suppr, F2)"
              :aria-activedescendant="entries.length ? `${gridId}-${active}` : undefined"
              @keydown="gridKey"
            >
              <thead><tr><th class="sel"><input v-model="allSelected" type="checkbox" aria-label="Tout sélectionner" :disabled="!selectable.length"></th><th :aria-sort="ariaSort('name')"><button type="button" class="sort" @click="sortBy('name')">Nom <component :is="sort.dir === 'asc' ? ArrowUp : ArrowDown" v-if="sort.key === 'name'" :size="11" /></button></th>
                  <th class="num" :aria-sort="ariaSort('size')"><button type="button" class="sort" @click="sortBy('size')">Taille <component :is="sort.dir === 'asc' ? ArrowUp : ArrowDown" v-if="sort.key === 'size'" :size="11" /></button></th>
                  <th class="m-hide" :aria-sort="ariaSort('mtime')"><button type="button" class="sort" @click="sortBy('mtime')">Modifié <component :is="sort.dir === 'asc' ? ArrowUp : ArrowDown" v-if="sort.key === 'mtime'" :size="11" /></button></th>
                  <th class="m-hide" :aria-sort="ariaSort('mode')"><button type="button" class="sort" @click="sortBy('mode')">Droits <component :is="sort.dir === 'asc' ? ArrowUp : ArrowDown" v-if="sort.key === 'mode'" :size="11" /></button></th>
                  <th /></tr></thead>
              <tbody>
                <tr v-if="path"><td /><td colspan="5"><a href="#" @click.prevent="go(crumbs.slice(0, -1).join('/'))"><ArrowLeft :size="12" /> ..</a></td></tr>
                <tr
                  v-for="(e, i) in entries"
                  :id="`${gridId}-${i}`"
                  :key="e.name"
                  :aria-selected="selected.includes(e.name)"
                  :class="{ picked: selected.includes(e.name), active: i === active, 'drop-on': e.kind === 'dir' && dropTarget === join(path, e.name) }"
                  :draggable="!!current?.writable"
                  @dragstart="dragStart($event, e.name)"
                  @dragover.stop="dragOver($event, e.kind === 'dir' ? join(path, e.name) : path)"
                  @drop.stop="e.kind === 'dir' ? drop($event, join(path, e.name)) : drop($event, path)"
                  @mousedown="active = i"
                  @contextmenu.stop="rowMenu($event, e, i)"
                >
                  <td class="sel"><input v-model="selected" type="checkbox" :value="e.name" :aria-label="`Sélectionner ${e.name}`"></td>
                  <td v-if="renaming === e.name">
                    <span class="rename">
                      <input ref="renameInput" v-model.trim="renameTo" class="input input-sm mono" :aria-label="`Nouveau nom de ${e.name}`" @keydown.enter="rename" @keydown.esc.prevent="renaming = null">
                      <UiButton size="sm" variant="ghost" :loading="renameBusy" :aria-label="`Valider le renommage de ${e.name}`" @click="rename"><Check :size="13" /></UiButton>
                      <UiButton size="sm" variant="ghost" aria-label="Annuler le renommage" @click="renaming = null"><X :size="13" /></UiButton>
                    </span>
                  </td>
                  <td v-else>
                    <a v-if="e.kind === 'dir'" href="#" class="entry" :title="current?.writable ? 'Double-clic ou F2 : renommer' : undefined" @click.prevent="nameClick($event, () => go(join(path, e.name)))" @dblclick.prevent="nameDblClick(e.name)" @keydown.f2.prevent="startRename(e.name)"><component :is="ICON[e.kind]" :size="14" /> <span class="mono">{{ e.name }}/</span></a>
                    <a v-else-if="e.kind === 'file'" href="#" class="entry" :title="current?.writable ? 'Double-clic ou F2 : renommer' : undefined" @click.prevent="nameClick($event, () => openFile(join(path, e.name)))" @dblclick.prevent="nameDblClick(e.name)" @keydown.f2.prevent="startRename(e.name)"><component :is="ICON[e.kind]" :size="14" /> <span class="mono">{{ e.name }}</span></a>
                    <span v-else class="entry muted" :title="e.kind === 'link' ? 'Lien symbolique' : 'Fichier spécial'" @dblclick="startRename(e.name)"><component :is="ICON[e.kind]" :size="14" /> <span class="mono">{{ e.name }}</span></span>
                  </td>
                  <td class="num small">{{ e.kind === 'dir' ? '' : formatBytes(e.size) }}</td>
                  <td class="m-hide small muted nowrap">{{ fmtDateTime(e.mtime) }}</td>
                  <td class="m-hide small mono muted">{{ e.mode }} {{ e.uid }}:{{ e.gid }}</td>
                  <td class="num acts">
                    <a v-if="e.kind === 'dir'" :href="zipUrl(join(path, e.name))" download class="dl" :title="`Télécharger ${e.name} en zip`" :aria-label="`Télécharger ${e.name} en zip`"><Download :size="13" /></a>
                    <UiButton v-if="current?.writable && (e.kind === 'dir' || e.kind === 'file') && !archiveOf(e.name)" size="sm" variant="ghost" :loading="zipping === join(path, e.name)" :title="`Créer une archive zip de ${e.name} dans ce dossier`" :aria-label="`Créer une archive zip de ${e.name}`" @click="makeZip(join(path, e.name))"><FileArchive :size="13" /></UiButton>
                    <UiButton v-if="current?.writable && e.kind === 'file' && archiveOf(e.name)" size="sm" variant="ghost" :loading="extracting === join(path, e.name)" :title="`Extraire ${e.name} dans un nouveau dossier`" :aria-label="`Extraire ${e.name}`" @click="extract(join(path, e.name))"><PackageOpen :size="13" /></UiButton>
                    <a v-if="e.kind === 'file'" :href="downloadUrl(join(path, e.name))" download class="dl" :title="`Télécharger ${e.name}`" :aria-label="`Télécharger ${e.name}`"><Download :size="13" /></a>
                    <UiButton v-if="current?.writable" size="sm" variant="ghost" :title="`Droits et propriétaire de ${e.name} (${e.mode} ${e.uid}:${e.gid})`" :aria-label="`Droits de ${e.name}`" @click="startPerms(e, join(path, e.name))"><KeyRound :size="13" /></UiButton>
                    <UiButton v-if="current?.writable" size="sm" variant="ghost" :title="`Copier ${e.name}`" :aria-label="`Copier ${e.name}`" @click="startMove(e.name, 'copy')"><Copy :size="13" /></UiButton>
                    <UiButton v-if="current?.writable" size="sm" variant="ghost" :title="`Déplacer ${e.name}`" :aria-label="`Déplacer ${e.name}`" @click="startMove(e.name)"><FolderInput :size="13" /></UiButton>
                    <UiButton v-if="current?.writable" size="sm" variant="ghost" :title="`Renommer ${e.name}`" :aria-label="`Renommer ${e.name}`" @click="startRename(e.name)"><Pencil :size="13" /></UiButton>
                    <UiButton v-if="current?.writable" size="sm" variant="ghost" :loading="deleting === join(path, e.name)" :title="`Supprimer ${e.name}`" :aria-label="`Supprimer ${e.name}`" @click="remove(join(path, e.name), e.kind)"><Trash2 :size="13" /></UiButton>
                  </td>
                </tr>
                <tr v-if="listing.path !== path || listing.mount !== mount"><td /><td colspan="5" class="muted small">Chargement…</td></tr>
                <tr v-else-if="!listing.entries.length"><td /><td colspan="5" class="muted small">Dossier vide.</td></tr>
                <tr v-else-if="!entries.length"><td /><td colspan="5" class="muted small">Aucun élément ne correspond à « {{ quick.trim() }} ».</td></tr>
              </tbody>
            </table>
            <p v-if="listing.truncated" class="muted tiny">Seules les 1000 premières entrées sont affichées.</p>
          </section>
        </template>
      </template>
    </div>
  </UiModal>
</template>

<style scoped>
.ctx { position: absolute; z-index: 30; min-width: 210px; padding: 4px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: 0 8px 24px rgba(0, 0, 0, .18); display: flex; flex-direction: column; outline: none; }
.ctx-title { padding: 4px 8px 6px; border-bottom: 1px solid var(--border); margin-bottom: 4px; max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ctx-item { text-align: left; background: none; border: 0; padding: 6px 10px; border-radius: 4px; font: inherit; font-size: 13px; color: var(--text); cursor: pointer; }
.ctx-item.on { background: color-mix(in srgb, var(--primary) 14%, transparent); }
.ctx-item.danger { color: var(--danger); }
.files { display: flex; flex-direction: column; gap: var(--space-3); min-height: 320px; }
.mounts { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.mounts button { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); color: var(--text); cursor: pointer; font-size: 13px; }
.mounts button.on { border-color: var(--primary); background: var(--primary-bg, var(--surface-2)); }
.bar { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; margin-bottom: var(--space-2); }
.spacer { flex: 1; }
.path { font-size: 13px; overflow-wrap: anywhere; }
.crumbs a { color: var(--primary); text-decoration: none; }
.newname { width: 200px; }
.list { width: 100%; border-collapse: collapse; font-size: 13px; }
.list th { text-align: left; font-weight: 600; color: var(--text-muted); font-size: 12px; padding: 4px 6px; }
.list td { padding: 5px 6px; border-top: 1px solid var(--border); }
.list .num { text-align: right; white-space: nowrap; }
.entry { display: inline-flex; align-items: center; gap: 6px; color: var(--text); text-decoration: none; }
a.entry:hover .mono { text-decoration: underline; }
.editor.full { background: var(--bg, var(--surface)); padding: var(--space-4); display: flex; flex-direction: column; height: 100vh; box-sizing: border-box; overflow: auto; }
.editor.full .code { flex: 1; min-height: 0; }
.editor.full :deep(.cm-editor) { max-height: none; font-size: 13.5px; }
.ok { color: var(--success); }
.preview { margin: 0 0 var(--space-2); display: flex; flex-direction: column; align-items: center; gap: 6px; padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius); background: repeating-conic-gradient(var(--surface-2) 0 25%, var(--surface) 0 50%) 0 0 / 16px 16px; max-height: 70vh; overflow: auto; }
.preview img { max-width: 100%; max-height: 60vh; object-fit: contain; cursor: zoom-in; }
.preview.actual { align-items: flex-start; }
.preview.actual img { max-width: none; max-height: none; cursor: zoom-out; }
.editor.full .preview { max-height: none; flex: 1; }
.editor.full .preview img { max-height: 85vh; }
.code { width: 100%; }
.save { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; margin-top: var(--space-2); }
.perms { display: flex; align-items: center; gap: var(--space-2) var(--space-3); flex-wrap: wrap; padding: 6px 10px; border-radius: var(--radius); background: var(--surface-2); margin-bottom: var(--space-2); }
.perms label { display: inline-flex; align-items: center; gap: 4px; }
.perms .mode { width: 64px; }
.perms .id { width: 80px; }
.bad { color: var(--danger); }
.quick { display: flex; align-items: center; gap: var(--space-2); margin-bottom: var(--space-2); }
.quick .input { width: 260px; }
.search { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; margin-bottom: var(--space-2); }
.search .input { width: 240px; }
.dropzone { position: relative; border: 2px dashed transparent; border-radius: var(--radius); }
.dropzone.over { border-color: var(--primary); background: color-mix(in srgb, var(--primary) 5%, transparent); }
.drop-hint { margin: 0 0 var(--space-2); color: var(--primary); font-weight: 600; }
.list tr.drop-on td { background: color-mix(in srgb, var(--primary) 18%, transparent); }
.crumbs a.drop-on { background: color-mix(in srgb, var(--primary) 18%, transparent); border-radius: 4px; }
.list tr[draggable="true"] { cursor: grab; }
.history { border: 1px solid var(--border); border-radius: var(--radius); padding: var(--space-2) var(--space-3); margin-bottom: var(--space-2); display: flex; flex-direction: column; gap: var(--space-2); max-height: 50vh; overflow: auto; }
.compare p { margin: 0 0 var(--space-2); }
.clip { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; padding: 6px 10px; border-radius: var(--radius); background: var(--surface-2); margin-bottom: var(--space-2); }
.bulk { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; padding: 6px 10px; border-radius: var(--radius); background: color-mix(in srgb, var(--primary) 10%, var(--surface)); margin-bottom: var(--space-2); }
.list .sel { width: 28px; }
.list[role="grid"]:focus { outline: none; }
.list[role="grid"]:focus-visible tr.active td, .list[role="grid"]:focus tr.active td { box-shadow: inset 0 1px 0 var(--primary), inset 0 -1px 0 var(--primary); }
.list[role="grid"]:focus tr.active td:first-child { box-shadow: inset 2px 0 0 var(--primary), inset 0 1px 0 var(--primary), inset 0 -1px 0 var(--primary); }
.sort { display: inline-flex; align-items: center; gap: 3px; background: none; border: 0; padding: 0; font: inherit; color: inherit; cursor: pointer; }
.sort:hover { color: var(--text); }
th.num .sort { margin-left: auto; }
.list tr.picked td { background: color-mix(in srgb, var(--primary) 6%, transparent); }
.moving { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; padding: 6px 10px; border-radius: var(--radius); background: var(--surface-2); margin-bottom: var(--space-2); }
.progress { display: flex; align-items: center; gap: var(--space-2); margin-bottom: var(--space-2); }
.progress progress { flex: 1; max-width: 320px; }
.rename { display: inline-flex; align-items: center; gap: 4px; }
.rename .input { width: 260px; }
.acts { display: flex; justify-content: flex-end; align-items: center; gap: 4px; }
.dl { display: inline-flex; align-items: center; gap: 4px; color: var(--primary); text-decoration: none; }
.tiny { font-size: 11.5px; margin: 0; }
.small { font-size: 12.5px; }
.nowrap { white-space: nowrap; }
.alert { margin: 0; padding: var(--space-2) var(--space-3); border-radius: var(--radius); background: var(--danger-bg); color: var(--danger); }
@media (max-width: 640px) { .m-hide { display: none; } .newname { width: 140px; } }
</style>
