/**
 * Commande d'installation d'un hôte cible, à exécuter dans son terminal : agent Portainer seul,
 * agent et Target Runner (racines, certificats, clé HMAC demandée à l'écran, conteneur durci), ou
 * connexion SSH sans agent ni Runner (utilisateur, accès au socket, clé autorisée, empreinte d'hôte).
 * Profils de type d'hôte : socket et dossier des volumes du moteur, utilisateur, racines par défaut.
 */

// Certificat de l'agent auto-signé et régénéré à chaque démarrage : vérification désactivée par défaut côté console.
export const AGENT_IMAGE = 'portainer/agent:2.27.4'
export const DEFAULT_RUNNER_IMAGE = 'sherpa-runner:latest'
export const RUNNER_PORT = 8443

export const HOST_PROFILES = {
  docker: {
    label: 'Docker (Linux)',
    hint: 'Moteur Docker standard (Debian, Ubuntu, RHEL…), exécuté en root.',
    cli: 'docker', socket: '/var/run/docker.sock', volumes: '/var/lib/docker/volumes', base: '/srv', user: 'deploy', runnerDir: '/opt/platform-runner',
  },
  rootless: {
    label: 'Docker rootless',
    hint: 'Moteur Docker d\'un utilisateur sans droits root : commande lancée sous cet utilisateur, racines dans son dossier personnel.',
    cli: 'docker', socket: '$XDG_RUNTIME_DIR/docker.sock', volumes: '$HOME/.local/share/docker/volumes', base: '$HOME/platform', user: null, runnerDir: '$HOME/.platform-runner',
  },
  podman: {
    label: 'Podman (root)',
    hint: 'Podman en root avec son socket compatible Docker (podman.socket activé par la commande). L\'agent demande --privileged.',
    cli: 'podman', socket: '/run/podman/podman.sock', volumes: '/var/lib/containers/storage/volumes', base: '/srv', user: 'deploy', runnerDir: '/opt/platform-runner',
  },
  synology: {
    label: 'Synology DSM (Container Manager)',
    hint: 'NAS Synology : volumes dans /volume1/@docker, racines sur le volume 1. L\'utilisateur du Runner se crée dans DSM.',
    cli: 'docker', socket: '/var/run/docker.sock', volumes: '/volume1/@docker/volumes', base: '/volume1/platform', user: 'deploy', runnerDir: '$BASE/.runner',
  },
  custom: {
    label: 'Docker, racine personnalisée',
    hint: 'Moteur Docker dont le data-root a été déplacé (daemon.json) : indiquer le dossier des volumes.',
    cli: 'docker', socket: '/var/run/docker.sock', volumes: '/data/docker/volumes', base: '/srv', user: 'deploy', runnerDir: '/opt/platform-runner',
  },
} as const
export type HostProfileKey = keyof typeof HOST_PROFILES

export interface HostInstallOptions {
  profile: HostProfileKey
  components: 'agent' | 'agent-runner' | 'ssh'
  /** Secret de l'agent (sans objet en SSH). */
  agentSecret: string
  /** Dossier des volumes du moteur (profil « racine personnalisée »). */
  volumesDir?: string
  runner?: {
    image: string
    /** Utilisateur propriétaire des racines (sans objet en rootless). */
    user: string
    /** Dossier parent des racines (deployments, builds, tmp, apps-data). */
    base: string
    /** IP d'administration où le Runner écoute (vide : adresse principale de l'hôte). */
    bindIp: string
    /** Nom de l'hôte dans l'URL du Runner (vide : nom complet de l'hôte). */
    name: string
    cert: { mode: 'self-signed' } | { mode: 'files', cert: string, key: string }
    /** AC du certificat client de la console (fichier sur l'hôte). */
    platformCa: string
  }
  ssh?: {
    /** Utilisateur de la console sur l'hôte (sans objet en rootless : utilisateur courant). */
    user: string
    /** Dossier parent des chemins de travail (deployments, builds, tmp, apps-data). */
    base: string
    /** Clé générée sur l'hôte (privée affichée une fois), ou clé publique fournie. */
    key: { mode: 'generate' } | { mode: 'public', publicKey: string }
  }
}

const PUBLIC_KEY_RE = /^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/]+={0,3}(?: [\w.@+-]{1,100})?$/

export const RUNNER_ROOT_DIRS = ['deployments', 'builds', 'tmp', 'apps-data'] as const

// Chemins : absolus ou relatifs à $HOME / $XDG_RUNTIME_DIR, sans espace ni caractère interprété par le shell.
const PATH_RE = /^(?:\/|\$HOME\/|\$XDG_RUNTIME_DIR\/)[\w.@/-]*$/
const IMAGE_RE = /^[a-z0-9][\w.\-/:@]{0,254}$/i
const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/
const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/
const HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)*$/i

/** Erreurs de saisie par champ (vide : commande générable). */
export function hostInstallErrors(o: HostInstallOptions): Record<string, string> {
  const e: Record<string, string> = {}
  if (o.components !== 'ssh' && !/^[\w-]{16,128}$/.test(o.agentSecret)) e.agentSecret = 'Secret de 16 à 128 caractères (lettres, chiffres, - et _)'
  const ssh = o.ssh
  if (o.components === 'ssh' && ssh) {
    if (o.profile !== 'rootless' && !USER_RE.test(ssh.user)) e.user = 'Nom d\'utilisateur invalide'
    if (!PATH_RE.test(ssh.base) || ssh.base === '/') e.base = 'Chemin absolu sans espace, autre que /'
    if (ssh.key.mode === 'public' && !PUBLIC_KEY_RE.test(ssh.key.publicKey.trim())) e.publicKey = 'Clé publique OpenSSH attendue (ssh-ed25519 AAAA… commentaire)'
  }
  if (o.profile === 'custom' && !PATH_RE.test(o.volumesDir ?? '')) e.volumesDir = 'Chemin absolu attendu, sans espace'
  const r = o.runner
  if (o.components === 'agent-runner' && r) {
    if (!IMAGE_RE.test(r.image)) e.image = 'Référence d\'image invalide'
    if (o.profile !== 'rootless' && !USER_RE.test(r.user)) e.user = 'Nom d\'utilisateur invalide'
    if (!PATH_RE.test(r.base) || r.base === '/') e.base = 'Chemin absolu sans espace, autre que / (les racines sont créées dessous)'
    if (r.bindIp && !IPV4_RE.test(r.bindIp)) e.bindIp = 'Adresse IPv4 attendue'
    if (r.name && !HOST_RE.test(r.name)) e.name = 'Nom d\'hôte invalide'
    if (r.cert.mode === 'files') {
      if (!PATH_RE.test(r.cert.cert)) e.cert = 'Chemin absolu attendu'
      if (!PATH_RE.test(r.cert.key)) e.key = 'Chemin absolu attendu'
    }
    if (!PATH_RE.test(r.platformCa)) e.platformCa = 'Chemin absolu attendu'
  }
  return e
}

/** Valeur insérée entre guillemets doubles : les champs validés ne contiennent que $HOME ou $XDG_RUNTIME_DIR à interpréter. */
const dq = (v: string) => `"${v}"`
const sq = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`

function agentRun(o: HostInstallOptions, indent = ''): string[] {
  const p = HOST_PROFILES[o.profile]
  const volumes = o.profile === 'custom' ? o.volumesDir! : p.volumes
  return [
    `${indent}${p.cli} rm -f portainer_agent >/dev/null 2>&1 || true`,
    `${indent}${p.cli} run -d --name portainer_agent --restart=always${o.profile === 'podman' ? ' --privileged' : ''} -p 9001:9001 \\`,
    `${indent}  -e AGENT_SECRET=${sq(o.agentSecret)} \\`,
    `${indent}  -v ${dq(`${p.socket}:/var/run/docker.sock`)} \\`,
    `${indent}  -v ${dq(`${volumes}:/var/lib/docker/volumes`)} \\`,
    `${indent}  ${AGENT_IMAGE}`,
  ]
}

/** Commande complète pour le profil et les composants choisis. */
export function hostInstallCommand(o: HostInstallOptions): string {
  const p = HOST_PROFILES[o.profile]
  const podmanSetup = o.profile === 'podman' ? ['systemctl enable --now podman.socket podman-restart.service'] : []
  if (o.components === 'ssh') return sshCommand(o)
  if (o.components === 'agent' || !o.runner) {
    return [
      `# ${p.label} : agent Portainer (${o.profile === 'rootless' ? 'sous l\'utilisateur du moteur rootless' : 'en root ou membre du groupe docker'}).`,
      '# Un agent déjà installé est recréé avec ce secret. N\'ouvrir le port 9001 qu\'à la console.',
      ...podmanSetup,
      ...agentRun(o),
    ].join('\n')
  }
  const r = o.runner
  const rootless = o.profile === 'rootless'
  const rootsMounts = RUNNER_ROOT_DIRS.map(d => `  -v "$BASE/${d}:$BASE/${d}" \\`)
  const script = [
    'set -euo pipefail',
    `# ${p.label} : agent Portainer et Target Runner (voir docs/runner.md).`,
    `CLI=${p.cli}`,
    `SOCKET=${dq(p.socket)}`,
    `BASE=${dq(r.base)}`,
    `RUNNER_DIR=${dq(p.runnerDir)}`,
    `RUNNER_IMAGE=${sq(r.image)}`,
    ...(rootless ? [] : [`RUNNER_USER=${sq(r.user)}`]),
    `RUNNER_NAME=${r.name ? sq(r.name) : '"$(hostname -f 2>/dev/null || hostname)"'}`,
    `BIND_IP=${r.bindIp ? sq(r.bindIp) : '"$(ip -4 -o route get 1.1.1.1 2>/dev/null | sed -n \'s/.* src \\([0-9.]*\\).*/\\1/p\')"'}`,
    `[ -n "$BIND_IP" ] || { echo "Adresse d'administration introuvable : la renseigner dans la console (IP d'écoute du Runner)" >&2; exit 1; }`,
    `ROOTS="${RUNNER_ROOT_DIRS.map(d => `$BASE/${d}`).join(',')}"`,
    '',
    'echo "== 1/4 Agent Portainer"',
    ...podmanSetup,
    ...agentRun(o),
    '',
    'echo "== 2/4 Racines du Runner"',
    ...(rootless
      ? [
          '# Rootless : l\'utilisateur 0 du conteneur est l\'utilisateur courant de l\'hôte, sans privilège.',
          'RUNNER_UID=0',
          'RUNNER_GID=0',
        ]
      : [
          'if ! id "$RUNNER_USER" >/dev/null 2>&1; then',
          '  if command -v useradd >/dev/null 2>&1; then useradd --system --no-create-home --shell "$(command -v nologin || echo /bin/false)" "$RUNNER_USER"',
          '  else echo "Créer l\'utilisateur $RUNNER_USER (DSM : Panneau de configuration › Utilisateur et groupe), puis relancer" >&2; exit 1; fi',
          'fi',
          'RUNNER_UID=$(id -u "$RUNNER_USER")',
          'RUNNER_GID=$(id -g "$RUNNER_USER")',
        ]),
    `for d in ${RUNNER_ROOT_DIRS.join(' ')}; do mkdir -p "$BASE/$d"; done`,
    ...(rootless ? [] : [`for d in ${RUNNER_ROOT_DIRS.join(' ')}; do chown "$RUNNER_UID:$RUNNER_GID" "$BASE/$d"; done`]),
    'mkdir -p "$RUNNER_DIR/secrets" && chmod 700 "$RUNNER_DIR/secrets"',
    '',
    'echo "== 3/4 Certificats (mTLS)"',
    ...(r.cert.mode === 'self-signed'
      ? [
          'if [ ! -s "$RUNNER_DIR/secrets/runner.crt" ]; then',
          '  openssl req -x509 -newkey rsa:3072 -nodes -days 825 -subj "/CN=$RUNNER_NAME" \\',
          '    -addext "subjectAltName=DNS:$RUNNER_NAME,IP:$BIND_IP" -addext "extendedKeyUsage=serverAuth" \\',
          '    -keyout "$RUNNER_DIR/secrets/runner.key" -out "$RUNNER_DIR/secrets/runner.crt" 2>/dev/null',
          'fi',
          'echo "Certificat auto-signé du Runner, à coller dans « AC du certificat » (fiche du serveur › Runner) :"',
          'cat "$RUNNER_DIR/secrets/runner.crt"',
        ]
      : [
          `install -m 0400 ${dq(r.cert.cert)} "$RUNNER_DIR/secrets/runner.crt"`,
          `install -m 0400 ${dq(r.cert.key)} "$RUNNER_DIR/secrets/runner.key"`,
        ]),
    `PLATFORM_CA=${dq(r.platformCa)}`,
    '[ -s "$PLATFORM_CA" ] || { echo "AC des certificats clients de la console introuvable : $PLATFORM_CA" >&2; exit 1; }',
    'install -m 0400 "$PLATFORM_CA" "$RUNNER_DIR/secrets/platform-ca.crt"',
    '',
    'echo "== 4/4 Clé HMAC et démarrage du Runner"',
    'if [ ! -s "$RUNNER_DIR/secrets/hmac.key" ]; then',
    '  echo "Dans la console : ajouter ce serveur (https://$RUNNER_NAME:9001, AGENT_SECRET de la commande),"',
    `  echo "puis fiche du serveur › Runner : URL https://$RUNNER_NAME:${RUNNER_PORT}, enregistrer."`,
    '  printf "Clé HMAC affichée une seule fois par la console : "',
    '  IFS= read -rs HMAC </dev/tty; echo',
    '  [ -n "$HMAC" ] || { echo "Clé vide" >&2; exit 1; }',
    '  printf "%s" "$HMAC" > "$RUNNER_DIR/secrets/hmac.key"',
    '  unset HMAC',
    'fi',
    ...(rootless ? [] : ['chown "$RUNNER_UID:$RUNNER_GID" "$RUNNER_DIR"/secrets/*']),
    'chmod 0400 "$RUNNER_DIR"/secrets/*',
    'echo "Empreinte de la clé : $(tr -d \'\\n\' < "$RUNNER_DIR/secrets/hmac.key" | sha256sum | cut -c1-16) (identique à celle de la console)"',
    '$CLI image inspect "$RUNNER_IMAGE" >/dev/null 2>&1 || $CLI pull "$RUNNER_IMAGE" \\',
    '  || { echo "Image $RUNNER_IMAGE introuvable : la publier sur un registre joignable ou la charger (docker load)" >&2; exit 1; }',
    '$CLI rm -f platform-runner >/dev/null 2>&1 || true',
    '$CLI run -d --name platform-runner --restart unless-stopped \\',
    `  --user "$RUNNER_UID:$RUNNER_GID"${rootless ? '' : ' --group-add "$(stat -c %g "$SOCKET")"'} \\`,
    `  -e NODE_ENV=production -e RUNNER_PORT=${RUNNER_PORT} -e RUNNER_ROOTS="$ROOTS" \\`,
    '  -e RUNNER_HMAC_KEY_FILE=/run/secrets/runner_hmac -e RUNNER_TLS_CERT_FILE=/run/secrets/runner_cert \\',
    '  -e RUNNER_TLS_KEY_FILE=/run/secrets/runner_key -e RUNNER_CLIENT_CA_FILE=/run/secrets/platform_ca \\',
    '  -v "$RUNNER_DIR/secrets/hmac.key:/run/secrets/runner_hmac:ro" \\',
    '  -v "$RUNNER_DIR/secrets/runner.crt:/run/secrets/runner_cert:ro" \\',
    '  -v "$RUNNER_DIR/secrets/runner.key:/run/secrets/runner_key:ro" \\',
    '  -v "$RUNNER_DIR/secrets/platform-ca.crt:/run/secrets/platform_ca:ro" \\',
    '  -v "$SOCKET:/var/run/docker.sock" \\',
    ...rootsMounts,
    `  -p "$BIND_IP:${RUNNER_PORT}:${RUNNER_PORT}" \\`,
    '  --read-only --cap-drop ALL --security-opt no-new-privileges:true \\',
    '  --log-driver json-file --log-opt max-size=20m --log-opt max-file=5 \\',
    '  "$RUNNER_IMAGE"',
    'echo "Terminé. Dans la console : fiche du serveur › Runner › Lancer le diagnostic."',
  ]
  return [
    `# ${p.label} : agent Portainer et Target Runner. ${rootless ? 'À lancer sous l\'utilisateur du moteur rootless.' : 'Demande les droits root (sudo).'}`,
    '# La clé HMAC du Runner est demandée à l\'écran, une fois le serveur ajouté dans la console.',
    `${rootless ? 'bash' : 'sudo bash'} <<'INSTALL'`,
    ...script,
    'INSTALL',
  ].join('\n')
}

/** Connexion SSH : utilisateur et accès au socket, clé autorisée, chemins de travail, sshd, empreinte de la clé d'hôte. */
function sshCommand(o: HostInstallOptions): string {
  const p = HOST_PROFILES[o.profile]
  const s = o.ssh!
  const rootless = o.profile === 'rootless'
  const owner = rootless ? '"$(id -un)"' : '"$SSH_USER"'
  const script = [
    'set -euo pipefail',
    `# ${p.label} : connexion SSH de la console, sans agent ni Runner.`,
    `SOCKET=${dq(p.socket)}`,
    `BASE=${dq(s.base)}`,
    ...(rootless ? ['SSH_USER="$(id -un)"'] : [`SSH_USER=${sq(s.user)}`]),
    ...(s.key.mode === 'public' ? [`PUBKEY=${sq(s.key.publicKey.trim())}`] : []),
    '',
    'echo "== 1/4 Utilisateur et accès au moteur"',
    ...(rootless
      ? [
          '# Rootless : le moteur appartient à l\'utilisateur courant ; il doit tourner hors session (linger).',
          'loginctl enable-linger "$SSH_USER" 2>/dev/null || echo "Activer le maintien du moteur hors session : sudo loginctl enable-linger $SSH_USER"',
        ]
      : [
          'if ! id "$SSH_USER" >/dev/null 2>&1; then',
          '  if command -v useradd >/dev/null 2>&1; then',
          '    useradd --create-home --shell /bin/sh "$SSH_USER"',
          '    # Sans mot de passe utilisable mais non verrouillé (« ! » : refusé par sshd sans PAM même avec une clé).',
          '    usermod -p "*" "$SSH_USER"',
          '  else echo "Créer l\'utilisateur $SSH_USER (DSM : Panneau de configuration › Utilisateur et groupe, accès SSH autorisé), puis relancer" >&2; exit 1; fi',
          'fi',
          ...(o.profile === 'podman'
            ? [
                '# Podman : socket ouvert au groupe podman (le compte y accède sans être root).',
                'groupadd -f podman',
                'mkdir -p /etc/systemd/system/podman.socket.d',
                'printf "[Socket]\\nSocketGroup=podman\\nSocketMode=0660\\n" > /etc/systemd/system/podman.socket.d/platform.conf',
                'systemctl daemon-reload && systemctl enable --now podman.socket && systemctl restart podman.socket',
              ]
            : []),
          'SOCK_GROUP=$(stat -c %G "$SOCKET")',
          '[ "$SOCK_GROUP" != root ] || { echo "Le socket $SOCKET appartient au groupe root : créer un groupe dédié (ex. docker) pour le socket, puis relancer" >&2; exit 1; }',
          'if command -v usermod >/dev/null 2>&1; then usermod -aG "$SOCK_GROUP" "$SSH_USER"',
          'else echo "Ajouter $SSH_USER au groupe $SOCK_GROUP (DSM : Utilisateur et groupe), puis relancer" >&2; fi',
          'echo "Accès au socket par le groupe $SOCK_GROUP : équivalent à un accès root sur l\'hôte."',
        ]),
    '',
    'echo "== 2/4 Clé SSH de la console"',
    'HOME_DIR=$(getent passwd "$SSH_USER" | cut -d: -f6)',
    'install -d -m 700 "$HOME_DIR/.ssh"',
    'touch "$HOME_DIR/.ssh/authorized_keys" && chmod 600 "$HOME_DIR/.ssh/authorized_keys"',
    ...(s.key.mode === 'generate'
      ? [
          'KEY_DIR=$(mktemp -d)',
          'ssh-keygen -q -t ed25519 -N "" -C "console-plateforme@$(hostname)" -f "$KEY_DIR/id"',
          '# Relance : la clé précédemment générée pour la console est remplacée.',
          'sed -i "/ console-plateforme@/d" "$HOME_DIR/.ssh/authorized_keys"',
          'cat "$KEY_DIR/id.pub" >> "$HOME_DIR/.ssh/authorized_keys"',
          'echo "Clé privée à coller dans l\'assistant (Ajouter un serveur › SSH › Clé privée), affichée une seule fois :"',
          'cat "$KEY_DIR/id"',
          'rm -rf "$KEY_DIR"',
        ]
      : ['grep -qxF "$PUBKEY" "$HOME_DIR/.ssh/authorized_keys" || echo "$PUBKEY" >> "$HOME_DIR/.ssh/authorized_keys"']),
    ...(rootless ? [] : ['chown -R "$SSH_USER:$(id -gn "$SSH_USER")" "$HOME_DIR/.ssh"']),
    '',
    'echo "== 3/4 Chemins de travail"',
    `for d in ${RUNNER_ROOT_DIRS.join(' ')}; do mkdir -p "$BASE/$d"; done`,
    ...(rootless ? [] : [`for d in ${RUNNER_ROOT_DIRS.join(' ')}; do chown ${owner} "$BASE/$d"; done`]),
    'echo "Chemins de l\'endpoint (onglet Chemins de la console) à placer sous $BASE"',
    '',
    'echo "== 4/4 sshd et clé d\'hôte"',
    '# Redirection du socket limitée par sshd : repli de la console sur « docker system dial-stdio » (CLI docker de l\'hôte).',
    'if sshd -T 2>/dev/null | grep -qiE "^(allowstreamlocalforwarding no|allowtcpforwarding no|disableforwarding yes)$"; then',
    '  if command -v docker >/dev/null 2>&1; then echo "Redirection de socket limitée par sshd : la console passera par docker system dial-stdio"',
    '  else echo "Redirection de socket limitée par sshd et CLI docker absente : autoriser AllowStreamLocalForwarding et AllowTcpForwarding dans sshd_config, ou installer la CLI docker" >&2; fi',
    'fi',
    'echo "Socket Docker à indiquer dans l\'assistant : $SOCKET"',
    'echo "Empreintes de la clé d\'hôte, à comparer avec celle lue par l\'assistant :"',
    'for f in /etc/ssh/ssh_host_ed25519_key.pub /etc/ssh/ssh_host_ecdsa_key.pub /etc/ssh/ssh_host_rsa_key.pub; do [ -f "$f" ] && ssh-keygen -lf "$f"; done',
    'echo "Terminé. Dans la console : Ajouter un serveur › SSH, utilisateur $SSH_USER."',
  ]
  return [
    `# ${p.label} : connexion SSH (sans agent ni Runner). ${rootless ? 'À lancer sous l\'utilisateur du moteur rootless.' : 'Demande les droits root (sudo).'}`,
    `${rootless ? 'bash' : 'sudo bash'} <<'INSTALL'`,
    ...script,
    'INSTALL',
  ].join('\n')
}
