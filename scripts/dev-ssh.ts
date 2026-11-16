/**
 * Identifiants de l'hôte SSH de développement (service ssh-host de compose.dev.yml) :
 * mot de passe aléatoire et paire de clés ed25519 dans .data/dev-ssh. Rien n'est affiché.
 */
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'

const dir = '.data/dev-ssh'
mkdirSync(dir, { recursive: true, mode: 0o700 })
if (!existsSync(`${dir}/password`)) writeFileSync(`${dir}/password`, randomBytes(18).toString('base64url'), { mode: 0o600 })
if (!existsSync(`${dir}/id_ed25519`)) execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'platform-dev', '-f', `${dir}/id_ed25519`])
console.log(`Identifiants de l'hôte SSH de dev prêts dans ${dir} (utilisateur deploy, port 12222).`)
