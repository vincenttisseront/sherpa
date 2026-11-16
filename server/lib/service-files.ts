/**
 * Explorateur des fichiers d'un service : chemins relatifs à un montage du conteneur (volume ou
 * dossier de l'hôte), scripts busybox exécutés dans un conteneur ponctuel qui monte ce seul
 * montage en /m, et lecture de leur sortie. Fonctions pures (aucune E/S).
 */

export const MAX_ENTRIES = 1000
export const MAX_TEXT_BYTES = 1024 * 1024

export type FileKind = 'dir' | 'file' | 'link' | 'other'
export interface FileEntry { name: string, kind: FileKind, size: number, mtime: number, mode: string, uid: number, gid: number }

const SYSTEM = ['/proc', '/sys', '/dev', '/run', '/var/run', '/var/lib/docker']

/** Montage montrable : ni socket, ni chemin système de l'hôte. */
export function browsableMount(m: { type: string, source: string | null, name: string | null, destination: string }): boolean {
  if (m.type !== 'volume' && m.type !== 'bind') return false
  const src = m.type === 'volume' ? m.name : m.source
  if (!src) return false
  if (m.type === 'bind' && (src.endsWith('.sock') || src === '/' || SYSTEM.some(s => src === s || src.startsWith(`${s}/`)))) return false
  return !m.destination.endsWith('.sock')
}

export class FilePathError extends Error {}

/** Chemin relatif au montage, normalisé ; '' pour sa racine. Refuse toute sortie du montage. */
export function safeRelPath(input: string): string {
  if (input.length > 1024 || /[\0\n\r]/.test(input)) throw new FilePathError('Chemin invalide')
  const parts = input.split('/').filter(p => p && p !== '.')
  if (parts.some(p => p === '..')) throw new FilePathError('Chemin hors du montage')
  return parts.join('/')
}

const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
export const target = (rel: string) => (rel ? `/m/${rel}` : '/m')

const STAT = '%F|%s|%Y|%a|%u|%g|%n'

/** Fichier où le script de liste écrit son résultat (le journal d'un conteneur ponctuel est tronqué). */
export const LIST_OUTPUT = '/tmp/list'

/**
 * Contenu d'un dossier (ou le fichier lui-même si le montage est un fichier) : une ligne stat par
 * entrée, écrites dans LIST_OUTPUT (un dossier de centaines de fichiers dépasserait le journal).
 */
export function listScript(rel: string): string {
  const t = sh(target(rel))
  return [
    `t=${t}`,
    `o=${LIST_OUTPUT}`,
    'if [ -d "$t" ]; then echo "@@DIR" > "$o"; find "$t" -mindepth 1 -maxdepth 1 | head -n ' + (MAX_ENTRIES + 1) + ' | while IFS= read -r f; do stat -c \'' + STAT + '\' "$f"; done >> "$o"',
    'elif [ -e "$t" ] || [ -L "$t" ]; then echo "@@FILE" > "$o"; stat -c \'' + STAT + '\' "$t" >> "$o"',
    'else echo "@@NONE" > "$o"; fi',
  ].join('\n')
}

/** Renommage dans le même dossier (fichier, dossier ou lien lui-même) ; refusé si le nouveau nom existe. */
export function renameScript(rel: string, newName: string): string {
  return [
    `t=${sh(target(rel))}`,
    `n="$(dirname "$t")"/${sh(newName)}`,
    'if [ ! -e "$t" ] && [ ! -L "$t" ]; then echo "@@NONE"; exit 0; fi',
    'if [ -e "$n" ] || [ -L "$n" ]; then echo "@@EXISTS"; exit 0; fi',
    'mv "$t" "$n" && echo "@@OK"',
  ].join('\n')
}

/** Déplacement dans un autre dossier du même montage (nom conservé) ; jamais un dossier dans lui-même. */
export function moveScript(rel: string, destDirRel: string): string {
  return [
    `t=${sh(target(rel))}`,
    `d=${sh(target(destDirRel))}`,
    'n="$d/$(basename "$t")"',
    'if [ ! -e "$t" ] && [ ! -L "$t" ]; then echo "@@NONE"; exit 0; fi',
    'if [ ! -d "$d" ] || [ -L "$d" ]; then echo "@@NODIR"; exit 0; fi',
    'case "$d/" in "$t/"*) echo "@@INTO"; exit 0 ;; esac',
    'if [ "$(dirname "$t")" = "$d" ]; then echo "@@SAME"; exit 0; fi',
    'if [ -e "$n" ] || [ -L "$n" ]; then echo "@@EXISTS"; exit 0; fi',
    'mv "$t" "$n" && echo "@@OK"',
  ].join('\n')
}

/**
 * Copie dans un dossier du même montage (contenu des dossiers compris ; propriétaires, droits et
 * dates conservés). Dans le même dossier : nom suffixé « .copie », « .copie-2 »… Jamais un dossier
 * dans lui-même.
 */
export function copyScript(rel: string, destDirRel: string): string {
  return [
    `t=${sh(target(rel))}`,
    `d=${sh(target(destDirRel))}`,
    'b="$(basename "$t")"',
    'n="$d/$b"',
    'if [ ! -e "$t" ] && [ ! -L "$t" ]; then echo "@@NONE"; exit 0; fi',
    'if [ ! -d "$d" ] || [ -L "$d" ]; then echo "@@NODIR"; exit 0; fi',
    'case "$d/" in "$t/"*) echo "@@INTO"; exit 0 ;; esac',
    'if [ "$(dirname "$t")" = "$d" ]; then n="$d/$b.copie"; i=2; while [ -e "$n" ] || [ -L "$n" ]; do n="$d/$b.copie-$i"; i=$((i+1)); done',
    'elif [ -e "$n" ] || [ -L "$n" ]; then echo "@@EXISTS"; exit 0; fi',
    'cp -a "$t" "$n" && echo "@@OK $(basename "$n")"',
  ].join('\n')
}

export interface PermissionChange { mode: string | null, uid: number | null, gid: number | null, recursive: boolean }

/** Mode octal accepté : 3 ou 4 chiffres (bits spéciaux setuid/setgid refusés, sticky permis). */
export function validMode(mode: string): boolean {
  return /^[0-7]{3}$/.test(mode) || /^[01][0-7]{3}$/.test(mode)
}

/** Droits (chmod) et propriétaire (chown) ; un lien : son propriétaire seulement (chown -h), jamais sa cible. */
export function permissionsScript(rel: string, c: PermissionChange): string {
  const r = c.recursive ? ' -R' : ''
  // « uid », « :gid » ou « uid:gid » (jamais « uid: », interprété différemment selon les chown).
  const owner = c.uid !== null && c.gid !== null ? `${c.uid}:${c.gid}` : c.uid !== null ? `${c.uid}` : c.gid !== null ? `:${c.gid}` : null
  return [
    'set -e',
    `t=${sh(target(rel))}`,
    'if [ ! -e "$t" ] && [ ! -L "$t" ]; then echo "@@NONE"; exit 0; fi',
    `if [ -L "$t" ]; then ${c.mode !== null ? 'echo "@@LINKMODE"; exit 0' : `chown -h ${sh(owner!)} "$t"`}; else`,
    ...(owner !== null ? [`  chown${r} ${sh(owner)} "$t"`] : []),
    ...(c.mode !== null ? [`  chmod${r} ${c.mode} "$t"`] : []),
    'fi',
    `echo "@@OK $(stat -c '%a %u:%g' "$t")"`,
  ].join('\n')
}

/** Nouveau dossier : propriétaire du dossier parent, droits 0755. */
export function mkdirScript(parentRel: string, name: string): string {
  return [
    `d=${sh(target(parentRel))}`,
    `n="$d"/${sh(name)}`,
    'if [ ! -d "$d" ] || [ -L "$d" ]; then echo "@@NODIR"; exit 0; fi',
    'if [ -e "$n" ] || [ -L "$n" ]; then echo "@@EXISTS"; exit 0; fi',
    'mkdir "$n" && chown "$(stat -c %u:%g "$d")" "$n" && chmod 0755 "$n" && echo "@@OK"',
  ].join('\n')
}

export const MAX_RESULTS = 500
export const SEARCH_TIMEOUT_S = 50

/** Motif de nom « contient » pour find -iname (caractères spéciaux du motif neutralisés). */
export function nameGlob(q: string): string {
  return `*${q.replace(/[\\*?[\]]/g, c => `\\${c}`)}*`
}

/**
 * Recherche sous un dossier (sous-dossiers compris) : par nom (contient, sans casse) ou par contenu
 * (texte exact, sans casse). Résultats (stat) écrits dans LIST_OUTPUT, bornés en nombre et en durée.
 */
export function searchScript(rel: string, q: string, content: boolean): string {
  const find = content
    ? `timeout ${SEARCH_TIMEOUT_S} grep -rlFi -- ${sh(q)} "$d" 2>/dev/null`
    : `timeout ${SEARCH_TIMEOUT_S} find "$d" -mindepth 1 -iname ${sh(nameGlob(q))} 2>/dev/null`
  return [
    `d=${sh(target(rel))}`,
    `o=${LIST_OUTPUT}`,
    'if [ ! -d "$d" ] || [ -L "$d" ]; then echo "@@NONE" > "$o"; exit 0; fi',
    'echo "@@DIR" > "$o"',
    `${find} | head -n ${MAX_RESULTS + 1} | while IFS= read -r f; do stat -c '${STAT}' "$f"; done >> "$o"`,
  ].join('\n')
}

/** Résultats : chemin relatif au montage (le %n de stat commence par /m/). */
export function parseSearch(text: string): { state: 'dir' | 'none', results: (FileEntry & { path: string })[], truncated: boolean } {
  const lines = text.split('\n')
  const state = lines.includes('@@NONE') ? 'none' : 'dir'
  const results = lines.map((l) => {
    const e = parseStat(l)
    const full = l.match(/\|(\/m\/.+)$/)?.[1]
    return e && full ? { ...e, path: full.slice(3) } : null
  }).filter((e): e is FileEntry & { path: string } => !!e)
  return { state, results: results.slice(0, MAX_RESULTS), truncated: results.length > MAX_RESULTS }
}

/** Marge laissée libre (disque du montage et du conteneur) par une extraction. */
export const EXTRACT_MARGIN_BYTES = 64 * 1024 * 1024

/**
 * Extraction d'une archive (zip ; tar, gz, bz2, xz détectés) dans un NOUVEAU dossier à côté d'elle
 * (« nom », « nom-2 »…) : taille décompressée comparée à la place libre, extraction dans le
 * conteneur ponctuel (un lien piégé de l'archive ne peut viser que lui), copie sans suivre les liens
 * dans le montage, propriétaire du dossier parent.
 */
export function extractScript(rel: string, kind: 'zip' | 'tar', folder: string): string {
  const total = kind === 'zip'
    ? 'unzip -l "$a" 2>/dev/null | tail -n 1 | awk \'{print $1+0}\''
    : 'tar -tvf "$a" 2>/dev/null | awk \'{s+=$3} END {print s+0}\''
  const unpack = kind === 'zip' ? 'unzip -q -o "$a" -d "$x"' : 'tar -xf "$a" -C "$x"'
  return [
    `a=${sh(target(rel))}`,
    'd="$(dirname "$a")"',
    'if [ -L "$a" ] || [ ! -f "$a" ]; then echo "@@NOTFILE"; exit 0; fi',
    `total=$(${total})`,
    'if [ -z "$total" ]; then echo "@@BADARCHIVE"; exit 0; fi',
    'freem=$(df -Pk "$d" | awk \'NR==2 {print $4*1024}\')',
    'freet=$(df -Pk /tmp | awk \'NR==2 {print $4*1024}\')',
    `if [ "$total" -gt $((freem - ${EXTRACT_MARGIN_BYTES})) ] || [ "$total" -gt $((freet - ${EXTRACT_MARGIN_BYTES})) ]; then echo "@@NOSPACE $total $freem $freet"; exit 0; fi`,
    `n="$d"/${sh(folder)}; i=2`,
    `while [ -e "$n" ] || [ -L "$n" ]; do n="$d"/${sh(folder)}-$i; i=$((i+1)); done`,
    'x="$(mktemp -d)"',
    `${unpack} 2>/tmp/extract.err || { echo "@@BADARCHIVE $(grep -v "removing leading" /tmp/extract.err | tail -n 1)"; exit 0; }`,
    'mkdir "$n"',
    'cp -a "$x"/. "$n"/ || { echo "@@COPYFAILED"; exit 0; }',
    'chown -hR "$(stat -c %u:%g "$d")" "$n"',
    'echo "@@OK $(basename "$n") $(find "$n" -mindepth 1 | wc -l) $total"',
  ].join('\n')
}

/** Nom d'une version gardée d'un fichier (copie faite par la console avant chaque modification). */
export const VERSION_RE = /\.console-(\d{8})-(\d{6})\.bak$/

export function isVersionOf(fileName: string, versionName: string): boolean {
  return versionName.startsWith(`${fileName}.console-`) && VERSION_RE.test(versionName) && versionName.length === fileName.length + '.console-YYYYMMDD-HHMMSS.bak'.length
}

/** Date d'une version d'après son nom (UTC). */
export function versionDate(versionName: string): Date | null {
  const m = VERSION_RE.exec(versionName)
  if (!m) return null
  const [d, t] = [m[1]!, m[2]!]
  return new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +t.slice(0, 2), +t.slice(2, 4), +t.slice(4, 6)))
}

/** Versions gardées d'un fichier (même dossier) : une ligne stat par version, dans LIST_OUTPUT. */
export function versionsScript(rel: string): string {
  const t = target(rel)
  const dir = t.slice(0, t.lastIndexOf('/')) || '/m'
  const base = t.slice(t.lastIndexOf('/') + 1)
  return [
    `d=${sh(dir)}`,
    `o=${LIST_OUTPUT}`,
    'echo "@@DIR" > "$o"',
    `find "$d" -maxdepth 1 -type f -name ${sh(`${base.replace(/[\\*?[\]]/g, c => `\\${c}`)}.console-*.bak`)} | head -n ${MAX_ENTRIES} | while IFS= read -r f; do stat -c '${STAT}' "$f"; done >> "$o"`,
  ].join('\n')
}

/**
 * Restauration d'une version : la version actuelle est d'abord gardée à son tour (restauration
 * réversible), puis le fichier est réécrit en place avec le contenu de la version (propriétaire,
 * droits et inode conservés).
 */
export function restoreVersionScript(rel: string, versionName: string, suffix: string): string {
  const t = target(rel)
  return [
    'set -e',
    `t=${sh(t)}`,
    `v="$(dirname "$t")"/${sh(versionName)}`,
    'if [ -L "$v" ] || [ ! -f "$v" ]; then echo "@@NONE"; exit 0; fi',
    'if [ -L "$t" ]; then echo "@@LINK"; exit 0; fi',
    `if [ -f "$t" ]; then cp -p "$t" "$t${suffix}"; echo "@@BACKUP"; cat "$v" > "$t"; else cp -p "$v" "$t"; fi`,
    'echo "@@OK"',
  ].join('\n')
}

/** Suppression : lien (lui-même), fichier, dossier vide, ou dossier et son contenu si `recursive`. */
export function deleteScript(rel: string, recursive: boolean): string {
  const t = sh(target(rel))
  return [
    `t=${t}`,
    'if [ -L "$t" ]; then rm -f "$t"',
    `elif [ -d "$t" ]; then ${recursive ? 'rm -rf "$t"' : 'rmdir "$t" 2>/dev/null || { echo "@@NOTEMPTY"; exit 0; }'}`,
    'elif [ -e "$t" ]; then rm -f "$t"',
    'else echo "@@NONE"; exit 0; fi',
    'if [ -e "$t" ] || [ -L "$t" ]; then echo "@@FAILED"; else echo "@@OK"; fi',
  ].join('\n')
}

function kindOf(f: string): FileKind {
  if (f === 'directory') return 'dir'
  if (f === 'regular file' || f === 'regular empty file') return 'file'
  if (f === 'symbolic link') return 'link'
  return 'other'
}

export function parseStat(line: string): FileEntry | null {
  const m = line.match(/^([^|]+)\|(\d+)\|(\d+)\|([0-7]+)\|(\d+)\|(\d+)\|(.+)$/)
  if (!m) return null
  return { kind: kindOf(m[1]!), size: Number(m[2]), mtime: Number(m[3]), mode: m[4]!.padStart(4, '0'), uid: Number(m[5]), gid: Number(m[6]), name: m[7]!.split('/').pop()! }
}

export function parseList(lines: readonly string[]): { state: 'dir' | 'file' | 'none', entries: FileEntry[], truncated: boolean } {
  const head = lines.find(l => l.startsWith('@@'))
  const state = head === '@@DIR' ? 'dir' : head === '@@FILE' ? 'file' : 'none'
  const entries = lines.map(parseStat).filter((e): e is FileEntry => !!e)
  const truncated = entries.length > MAX_ENTRIES
  return {
    state,
    entries: entries.slice(0, MAX_ENTRIES).sort((a, b) => Number(b.kind === 'dir') - Number(a.kind === 'dir') || a.name.localeCompare(b.name)),
    truncated,
  }
}

/** Nature et taille d'un fichier, sans le lire (téléchargement). */
export function statScript(rel: string): string {
  const t = sh(target(rel))
  return `t=${t}\nif [ -L "$t" ]; then echo "@@LINK"; elif [ ! -f "$t" ]; then echo "@@NOTFILE"; else stat -c '${STAT}' "$t"; fi`
}

export const MAX_UPLOAD_BYTES = 2 * 1024 ** 3

/** Nom d'un fichier envoyé : un seul élément de chemin, sans caractère de contrôle. */
export function safeFileName(name: string): string {
  const n = name.trim()
  if (!n || n === '.' || n === '..' || n.length > 255 || /[/\0\n\r\\]/.test(n)) throw new FilePathError('Nom de fichier invalide')
  return n
}

/** Avant un envoi : dossier présent (propriétaire relevé), fichier de même nom (remplaçable ou non). */
export function uploadCheckScript(dirRel: string, fileRel: string): string {
  return [
    `d=${sh(target(dirRel))}`,
    `t=${sh(target(fileRel))}`,
    'if [ ! -d "$d" ] || [ -L "$d" ]; then echo "@@NODIR"; exit 0; fi',
    'echo "@@OWNER $(stat -c %u:%g "$d")"',
    'if [ -L "$t" ]; then echo "@@LINK"; elif [ -d "$t" ]; then echo "@@ISDIR"; elif [ -e "$t" ]; then echo "@@EXISTS"; fi',
  ].join('\n')
}

/** Copie de l'ancienne version avant de la remplacer par un envoi. */
export function backupScript(fileRel: string, suffix: string): string {
  const t = sh(target(fileRel))
  return `set -e\nt=${t}\ncp -p "$t" "$t${suffix}"\necho "@@BACKUP"`
}

/** Nom proposé au téléchargement : sans guillemets ni caractères de contrôle. */
export function downloadName(name: string): string {
  return name.replace(/["\\\r\n\0]/g, '_').slice(0, 200) || 'fichier'
}

/** Contrôle et lecture d'un fichier : stat puis copie dans /tmp/out (relevée ensuite), sans le suivre hors du montage. */
export function readScript(rel: string): string {
  const t = sh(target(rel))
  return `t=${t}\nif [ -L "$t" ]; then echo "@@LINK"; exit 0; fi\nif [ ! -f "$t" ]; then echo "@@NOTFILE"; exit 0; fi\nstat -c '${STAT}' "$t"\nif [ "$(stat -c %s "$t")" -le ${MAX_TEXT_BYTES} ]; then cp "$t" /tmp/out; fi`
}

/**
 * Écriture : contenu déposé en /tmp/new, empreinte du fichier actuel comparée à celle lue par
 * l'utilisateur (modification entre-temps : refus), copie de l'ancien à côté, puis réécriture en
 * place (propriétaire, droits et inode conservés). Nouveau fichier : propriétaire du dossier.
 */
export function writeScript(rel: string, expectedSha256: string | null, backupSuffix: string): string {
  const t = sh(target(rel))
  return [
    'set -e',
    `t=${t}`,
    'if [ -L "$t" ]; then echo "@@LINK"; exit 0; fi',
    'if [ -e "$t" ] && [ ! -f "$t" ]; then echo "@@NOTFILE"; exit 0; fi',
    expectedSha256 !== null
      ? `if [ ! -f "$t" ] || [ "$(sha256sum "$t" | cut -d' ' -f1)" != ${sh(expectedSha256)} ]; then echo "@@CHANGED"; exit 0; fi`
      : 'if [ -e "$t" ]; then echo "@@EXISTS"; exit 0; fi',
    'if [ -f "$t" ]; then',
    // Fichier monté seul (/m) : pas de dossier où poser la copie.
    `  if [ "$t" != /m ]; then cp -p "$t" "$t${backupSuffix}"; echo "@@BACKUP"; fi`,
    '  cat /tmp/new > "$t"',
    'else',
    '  cat /tmp/new > "$t"',
    '  chown "$(stat -c %u:%g "$(dirname "$t")")" "$t"',
    '  chmod 0644 "$t"',
    'fi',
    'echo "@@OK"',
  ].join('\n')
}

/** Suffixe de la copie de l'ancienne version : <fichier>.console-AAAAMMJJ-HHMMSS.bak */
export function backupSuffix(at: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `.console-${at.getUTCFullYear()}${p(at.getUTCMonth() + 1)}${p(at.getUTCDate())}-${p(at.getUTCHours())}${p(at.getUTCMinutes())}${p(at.getUTCSeconds())}.bak`
}
