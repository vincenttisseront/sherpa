import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { HOST_PROFILES, type HostInstallOptions, type HostProfileKey, hostInstallCommand, hostInstallErrors } from '../../shared/utils/host-install'

const SECRET = 'a'.repeat(64)
const runner = (o: Partial<NonNullable<HostInstallOptions['runner']>> = {}): NonNullable<HostInstallOptions['runner']> => ({
  image: 'registre.interne/sherpa-runner:1.4.0', user: 'deploy', base: '/srv', bindIp: '10.0.0.11', name: 'docker-01.interne',
  cert: { mode: 'self-signed' }, platformCa: '/etc/platform-runner/platform-ca.crt', ...o,
})
const bashOk = (() => {
  try {
    execFileSync('bash', ['-c', 'true'])
    return true
  }
  catch {
    return false
  }
})()
/** Contenu du heredoc (script exécuté sur l'hôte), vérifié par bash -n. */
const syntaxOk = (cmd: string) => execFileSync('bash', ['-n'], { input: cmd.replace(/^(sudo )?bash <<'INSTALL'$/m, '').replace(/^INSTALL$/m, '') }) !== undefined

describe('hostInstallCommand', () => {
  it('agent seul : socket et volumes du profil', () => {
    const docker = hostInstallCommand({ profile: 'docker', components: 'agent', agentSecret: SECRET })
    expect(docker).toContain('docker run -d --name portainer_agent --restart=always -p 9001:9001')
    expect(docker).toContain(`-e AGENT_SECRET='${SECRET}'`)
    expect(docker).toContain('-v "/var/run/docker.sock:/var/run/docker.sock"')
    expect(docker).toContain('-v "/var/lib/docker/volumes:/var/lib/docker/volumes"')
    const podman = hostInstallCommand({ profile: 'podman', components: 'agent', agentSecret: SECRET })
    expect(podman).toContain('systemctl enable --now podman.socket')
    expect(podman).toContain('podman run -d --name portainer_agent --restart=always --privileged')
    expect(podman).toContain('-v "/run/podman/podman.sock:/var/run/docker.sock"')
    const rootless = hostInstallCommand({ profile: 'rootless', components: 'agent', agentSecret: SECRET })
    expect(rootless).toContain('-v "$XDG_RUNTIME_DIR/docker.sock:/var/run/docker.sock"')
    expect(rootless).toContain('-v "$HOME/.local/share/docker/volumes:/var/lib/docker/volumes"')
    const custom = hostInstallCommand({ profile: 'custom', components: 'agent', agentSecret: SECRET, volumesDir: '/data/docker/volumes' })
    expect(custom).toContain('-v "/data/docker/volumes:/var/lib/docker/volumes"')
  })

  it('agent et Runner : racines, certificats, clé HMAC demandée, conteneur durci', () => {
    const cmd = hostInstallCommand({ profile: 'docker', components: 'agent-runner', agentSecret: SECRET, runner: runner() })
    expect(cmd.split('\n')[2]).toBe('sudo bash <<\'INSTALL\'')
    expect(cmd).toContain('ROOTS="$BASE/deployments,$BASE/builds,$BASE/tmp,$BASE/apps-data"')
    expect(cmd).toContain('useradd --system')
    expect(cmd).toContain('openssl req -x509')
    expect(cmd).toContain('read -rs HMAC </dev/tty')
    expect(cmd).toContain('--group-add "$(stat -c %g "$SOCKET")"')
    expect(cmd).toContain('--read-only --cap-drop ALL --security-opt no-new-privileges:true')
    expect(cmd).toContain('-p "$BIND_IP:8443:8443"')
    expect(cmd).toContain('RUNNER_IMAGE=\'registre.interne/sherpa-runner:1.4.0\'')
    expect(cmd.trim().endsWith('INSTALL')).toBe(true)
  })

  it('rootless : utilisateur courant, pas de sudo ni de chown', () => {
    const cmd = hostInstallCommand({ profile: 'rootless', components: 'agent-runner', agentSecret: SECRET, runner: runner({ base: '$HOME/platform', user: '' }) })
    expect(cmd).toContain('\nbash <<\'INSTALL\'')
    expect(cmd).not.toContain('sudo')
    expect(cmd).not.toContain('chown')
    expect(cmd).not.toContain('--group-add')
    expect(cmd).toContain('RUNNER_UID=0')
    expect(cmd).toContain('BASE="$HOME/platform"')
  })

  it('certificats de la PKI : copiés depuis les fichiers indiqués', () => {
    const cmd = hostInstallCommand({ profile: 'synology', components: 'agent-runner', agentSecret: SECRET, runner: runner({ base: '/volume1/platform', cert: { mode: 'files', cert: '/etc/pki/runner.crt', key: '/etc/pki/runner.key' } }) })
    expect(cmd).toContain('install -m 0400 "/etc/pki/runner.crt" "$RUNNER_DIR/secrets/runner.crt"')
    expect(cmd).not.toContain('openssl')
    expect(cmd).toContain('RUNNER_DIR="$BASE/.runner"')
    expect(cmd).toContain('-v "/volume1/@docker/volumes:/var/lib/docker/volumes"')
  })

  it('valeurs par défaut de l\'hôte quand l\'IP et le nom sont vides', () => {
    const cmd = hostInstallCommand({ profile: 'docker', components: 'agent-runner', agentSecret: SECRET, runner: runner({ bindIp: '', name: '' }) })
    expect(cmd).toContain('RUNNER_NAME="$(hostname -f 2>/dev/null || hostname)"')
    expect(cmd).toContain('ip -4 -o route get 1.1.1.1')
  })

  it.skipIf(!bashOk)('scripts syntaxiquement valides pour chaque profil', () => {
    for (const profile of Object.keys(HOST_PROFILES) as HostProfileKey[]) {
      const base = profile === 'rootless' ? '$HOME/platform' : HOST_PROFILES[profile].base
      for (const cert of [{ mode: 'self-signed' as const }, { mode: 'files' as const, cert: '/etc/pki/r.crt', key: '/etc/pki/r.key' }]) {
        for (const components of ['agent', 'agent-runner', 'ssh'] as const) {
          const key = cert.mode === 'files' ? { mode: 'public' as const, publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl console' } : { mode: 'generate' as const }
          const cmd = hostInstallCommand({ profile, components, agentSecret: SECRET, volumesDir: '/data/docker/volumes', runner: runner({ base, cert, bindIp: '', name: '' }), ssh: { user: 'deploy', base, key } })
          expect(() => syntaxOk(cmd), `${profile} ${components} ${cert.mode}`).not.toThrow()
        }
      }
    }
  })
})

describe('variante SSH', () => {
  const ssh = (o: Partial<NonNullable<HostInstallOptions['ssh']>> = {}, profile: HostProfileKey = 'docker') => hostInstallCommand({ profile, components: 'ssh', agentSecret: '', ssh: { user: 'deploy', base: '/srv', key: { mode: 'generate' }, ...o } })
  it('utilisateur, groupe du socket, clé générée affichée une fois, empreinte de la clé d\'hôte', () => {
    const cmd = ssh()
    expect(cmd).toContain('sudo bash <<\'INSTALL\'')
    expect(cmd).toContain('useradd --create-home --shell /bin/sh "$SSH_USER"')
    expect(cmd).toContain('usermod -p "*" "$SSH_USER"')
    expect(cmd).toContain('usermod -aG "$SOCK_GROUP" "$SSH_USER"')
    expect(cmd).toContain('ssh-keygen -q -t ed25519')
    expect(cmd).toContain('sed -i "/ console-plateforme@/d"')
    expect(cmd).toContain('rm -rf "$KEY_DIR"')
    expect(cmd).toContain('ssh-keygen -lf "$f"')
    expect(cmd).not.toContain('portainer_agent')
    expect(cmd).not.toContain('AGENT_SECRET')
  })
  it('clé publique fournie : ajoutée une seule fois, aucune clé générée', () => {
    const cmd = ssh({ key: { mode: 'public', publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl ops@poste' } })
    expect(cmd).toContain('PUBKEY=\'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl ops@poste\'')
    expect(cmd).toContain('grep -qxF "$PUBKEY"')
    expect(cmd).not.toContain('ssh-keygen -q')
  })
  it('Podman : socket ouvert au groupe podman ; rootless : utilisateur courant, sans sudo', () => {
    expect(ssh({}, 'podman')).toContain('SocketGroup=podman')
    const rootless = ssh({ base: '$HOME/platform' }, 'rootless')
    expect(rootless).not.toContain('sudo bash')
    expect(rootless).not.toContain('useradd')
    expect(rootless).toContain('SSH_USER="$(id -un)"')
    expect(rootless).toContain('loginctl enable-linger')
  })
  it('refuse une clé publique invalide, sans exiger de secret d\'agent', () => {
    const e = hostInstallErrors({ profile: 'docker', components: 'ssh', agentSecret: '', ssh: { user: 'deploy', base: '/srv', key: { mode: 'public', publicKey: 'ssh-ed25519 AAAA\'; rm -rf /' } } })
    expect(Object.keys(e)).toEqual(['publicKey'])
  })
})

describe('hostInstallErrors', () => {
  it('refuse les valeurs qui casseraient la commande', () => {
    const e = hostInstallErrors({ profile: 'custom', components: 'agent-runner', agentSecret: 'court', volumesDir: '/data/ma racine', runner: runner({ image: 'img; rm -rf /', user: 'Root!', base: 'srv', bindIp: '10.0.0.300', name: 'nom invalide', platformCa: 'relatif/ca.crt' }) })
    expect(Object.keys(e).sort()).toEqual(['agentSecret', 'base', 'bindIp', 'image', 'name', 'platformCa', 'user', 'volumesDir'])
  })
  it('accepte une saisie complète', () => {
    expect(hostInstallErrors({ profile: 'docker', components: 'agent-runner', agentSecret: SECRET, runner: runner() })).toEqual({})
    expect(hostInstallErrors({ profile: 'rootless', components: 'agent-runner', agentSecret: SECRET, runner: runner({ user: '', base: '$HOME/platform' }) })).toEqual({})
  })
})
