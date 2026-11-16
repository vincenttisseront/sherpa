/**
 * Prépare un Target Runner local pour le développement :
 *   npm run dev:runner-setup -- <répertoire de simulation de l'hôte>
 * - PKI de dev (AC, certificat serveur localhost, certificat client plateforme) ;
 * - racines simulées <dir>/srv/{deployments,builds,tmp,apps-data} ;
 * - affiche les variables à placer dans .env et la commande de lancement.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { generatePki } from './pki'

if (process.env.NODE_ENV === 'production') throw new Error('Script réservé au développement')
const base = resolve(process.argv[2] ?? '.data/runner-dev')
const pkiDir = join(base, 'pki')
mkdirSync(pkiDir, { recursive: true, mode: 0o700 })
const pki = generatePki(pkiDir, 365)
for (const [f, v] of Object.entries({ 'platform-client.crt': pki.clientCert, 'platform-client.key': pki.clientKey })) writeFileSync(join(pkiDir, f), v, { mode: 0o600 })
const roots = ['deployments', 'builds', 'tmp', 'apps-data'].map(d => join(base, 'srv', d))
for (const r of roots) mkdirSync(r, { recursive: true })

console.info(`PKI et racines créées sous ${base}

1) Dans .env de la plateforme :
RUNNER_ADAPTER=http
RUNNER_CLIENT_CERT_FILE=${join(pkiDir, 'platform-client.crt')}
RUNNER_CLIENT_KEY_FILE=${join(pkiDir, 'platform-client.key')}

2) Dans la plateforme : endpoint → onglet Target Runner → URL https://localhost:8443,
   AC = contenu de ${join(pkiDir, 'ca.crt')} ; copier la clé HMAC affichée dans ${join(base, 'hmac.key')}.
   Chemins de l'endpoint : sous ${join(base, 'srv')}/<racine>/<environnement>.

3) Lancer le Runner :
RUNNER_ROOTS=${roots.join(',')} \\
RUNNER_HMAC_KEY_FILE=${join(base, 'hmac.key')} \\
RUNNER_TLS_CERT_FILE=${join(pkiDir, 'server.crt')} RUNNER_TLS_KEY_FILE=${join(pkiDir, 'server.key')} \\
RUNNER_CLIENT_CA_FILE=${join(pkiDir, 'ca.crt')} NODE_ENV=development npm run runner
`)
