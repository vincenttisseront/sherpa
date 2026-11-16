# Target Runner

Le Target Runner est le seul composant qui agit sur le système de fichiers des hôtes cibles. Il est livré en un seul fichier JavaScript (`dist/runner.mjs`, Node 22+) ou en image Docker (`Dockerfile.runner`).

## Ce qu'il fait, et ce qu'il ne fait pas

| Action | Rôle |
|---|---|
| `checkDir`, `ensureDir`, `pathExists` | Vérifier et créer des répertoires (mode, propriétaire) |
| `uploadFile` | Recevoir un fichier en flux. La taille et le SHA-256 sont vérifiés, il n'y a jamais d'écrasement |
| `extractArchive` | Extraire un ZIP (voir contrôles ci-dessous) |
| `hashTree` | Empreinte déterministe d'une arborescence |
| `prepareBuildContext` | Copier un sous-répertoire des sources vers le contexte de build |
| `writeFile` | Écrire un fichier généré (`metadata.json`, Compose) |
| `diskUsage` | Espace disque |
| `cleanup` | Supprimer un sous-arbre, ou les fichiers temporaires anciens. Une racine n'est jamais supprimée |

| `build` | Construire une image `platform/…` à partir d'un contexte situé dans les racines (moteur Docker local). Logs en flux |
| `removeImages` | Supprimer des images `platform/…` (rétention) |

Le Runner n'a **aucune route d'exécution de commande**. Toute route hors de cette liste répond 404. `build` et `removeImages` n'existent que si le socket Docker est joignable (`RUNNER_DOCKER_SOCKET`).

Le build applique `.dockerignore` avec la sémantique de Docker (`*` couvre aussi les fichiers cachés comme `.env`). Il refuse les liens symboliques du contexte et ne tire jamais d'image de base (`pull=0`). Il est limité en durée, en volume de logs, en mémoire (`RUNNER_BUILD_MAX_MEMORY_MB`) et en nombre de builds simultanés (`RUNNER_MAX_BUILDS`, les suivants attendent leur tour).

## Sécurité

- **mTLS** : le Runner n'accepte que les clients présentant un certificat signé par l'AC déclarée dans `RUNNER_CLIENT_CA_FILE` (le certificat client de la plateforme). La plateforme vérifie le certificat du Runner avec l'AC enregistrée pour l'endpoint.
- **Requêtes signées** : HMAC-SHA256 sur la méthode, le chemin, l'horodatage, le nonce et le hash du corps. Fenêtre de ±60 s, nonces mémorisés pour bloquer le rejeu, corps vérifié contre la signature. Chaque Runner a sa propre clé. Les horloges doivent être synchronisées (NTP).
- **Racines locales** : `RUNNER_ROOTS` est la seule source de vérité. Une plateforme compromise ne peut pas élargir le périmètre.
- **Chemins** : préfixes système refusés, ainsi que `..`, les chemins relatifs et les **liens symboliques** sur tout le chemin (vérification `lstat` composant par composant, sur le disque).
- **Archives ZIP** : chemins absolus, `..`, liens symboliques, fichiers spéciaux et doublons à la casse près sont refusés. Le nombre de fichiers, la taille réellement décompressée (comptée octet par octet, protection contre les bombes) et la profondeur sont bornés, ainsi que la durée. L'extraction se fait dans un répertoire temporaire, renommé seulement en cas de succès.
- **Audit local** : une ligne JSON par requête sur la sortie standard (identifiant de requête, acteur, action, résultat, durée, chemins), sans contenu de fichier.

## Installation sur un hôte

Avec Ansible : rôle `runner` de [deploy/ansible](../deploy/ansible/README.md) (racines, utilisateur, certificats, clé HMAC, lancement). Sans Ansible : **Installer un hôte** (tableau de bord) génère la commande complète selon le type d'hôte (voir [mise-en-service.md](mise-en-service.md#4-serveurs-cibles)). Les étapes manuelles équivalentes :

### 1. Racines

```bash
sudo mkdir -p /srv/deployments /srv/builds /srv/tmp /srv/apps-data
sudo chown -R deploy:deploy /srv/deployments /srv/builds /srv/tmp /srv/apps-data
```

Les chemins configurés dans la plateforme pour cet endpoint (onglet Chemins) doivent se trouver **sous** ces racines, par exemple `/srv/deployments/production`. Le diagnostic le vérifie.

### 2. Certificats (PKI d'entreprise)

- Certificat serveur du Runner : le SAN doit contenir le nom utilisé dans l'URL, `extendedKeyUsage=serverAuth`.
- AC qui a signé le certificat client de la plateforme : à copier dans `secrets/platform-ca.crt`.
- Côté plateforme : le certificat et la clé client (`extendedKeyUsage=clientAuth`) sont montés en secrets Docker (`runner-client.crt` / `runner-client.key`).

### 3. Enregistrement dans la plateforme

Fiche serveur → onglet **Target Runner** : renseigner l'URL (`https://hote.interne:8443`) et l'AC du certificat du Runner. À l'enregistrement, la plateforme génère une **clé HMAC affichée une seule fois** : la copier dans `secrets/hmac.key` sur l'hôte.

Pour vérifier la clé sans l'exposer, la commande suivante doit afficher l'empreinte indiquée par la plateforme :

```bash
tr -d '\n' < secrets/hmac.key | sha256sum | cut -c1-16
```

### 4. Accès au moteur Docker

Le build exige l'accès au socket Docker de l'hôte, ce qui équivaut à des droits root sur celui-ci. Ce privilège est concentré dans un composant sans route de commande, limité à deux actions contrôlées. L'agent Portainer dispose déjà du même accès. Dans `runner.compose.yml`, le socket est monté et le groupe `docker` de l'hôte est ajouté (`group_add`).

### 5. Lancement

Avec Docker : `deploy/runner.compose.yml`. Le Runner est en lecture seule, sans capacités, et le port n'est exposé que sur l'interface d'administration.

```bash
RUNNER_UID=$(id -u deploy) RUNNER_GID=$(id -g deploy) RUNNER_BIND_IP=10.0.0.11 docker compose -f runner.compose.yml up -d
```

Sans Docker (service systemd), lancer `node runner.mjs` avec les mêmes variables d'environnement, sous l'utilisateur propriétaire des racines.

### 6. Diagnostic

Bouton **Lancer le diagnostic** dans l'onglet Target Runner. Il vérifie dans l'ordre :
1. connexion, mTLS et signature ;
2. couverture des chemins configurés par `RUNNER_ROOTS` ;
3. présence et droits des répertoires (création si « création automatique » est active) ;
4. espace disque par rapport au minimum configuré ;
5. dépôt, extraction, empreinte et nettoyage d'une archive témoin.

## Variables

| Variable | Défaut | Rôle |
|---|---|---|
| `RUNNER_ROOTS` | — | Racines autorisées, séparées par des virgules : dossier dédié (`/srv/deployments`, `/tools`), jamais `/` ni un dossier partagé de premier niveau (`/srv`, `/opt`, `/home`, `/mnt`, `/media`, `/var`, `/tmp`, `/data`) |
| `RUNNER_HMAC_KEY_FILE` | — | Clé HMAC (base64, 32 octets) |
| `RUNNER_TLS_CERT_FILE` / `RUNNER_TLS_KEY_FILE` | — | Certificat serveur |
| `RUNNER_CLIENT_CA_FILE` | — | AC des certificats clients acceptés |
| `RUNNER_PORT` / `RUNNER_HOST` | 8443 / 0.0.0.0 | Écoute |
| `RUNNER_MAX_UPLOAD_MB` | 2048 | Taille maximale d'un fichier reçu |
| `RUNNER_MAX_CONCURRENT` | 4 | Requêtes traitées simultanément (au-delà : 503) |
| `RUNNER_DOCKER_SOCKET` | /var/run/docker.sock | Moteur Docker pour le build (absent : build désactivé) |
| `RUNNER_MAX_BUILDS` | 2 | Builds simultanés |
| `RUNNER_BUILD_MAX_MEMORY_MB` | 4096 | Mémoire maximale d'un build (builder classique) |
| `RUNNER_BUILDKIT` | false | Builds avec BuildKit (API `version=2`) : étapes indépendantes d'un Dockerfile multi-étapes en parallèle, cache plus efficace (mesuré : 13 s → 6,5 s sur deux étapes de 6 s ; aucun gain sur un Dockerfile linéaire). **Pas de limite mémoire par build** (réglage du démon BuildKit). Les premiers builds repartent à froid (cache distinct du builder classique). Repli automatique sur le builder classique si BuildKit ou le frontend `# syntax=` est indisponible, ou si BuildKit ne renvoie aucune progression pendant 60 s après l'envoi du contexte (jamais sur une erreur de Dockerfile). Option à valider sur vos hôtes avant de la généraliser. Avec Ansible : `runner_env: { RUNNER_BUILDKIT: "true" }`. Hôtes joints en SSH : même variable sur la console (`platform_env`). Nécessite Docker 23 ou plus. |
| `RUNNER_INSECURE_HTTP` | false | Développement uniquement. Refusé si `NODE_ENV=production` |

## Développement local

```bash
npm run dev:runner-setup     # PKI de dev et racines simulées sous .data/runner-dev, affiche la suite
npm run runner               # avec les variables affichées
npm run dev:demo-deploy      # déploiement de démonstration (ZIP généré) mis en file
```
