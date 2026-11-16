# Déploiement avec Ansible

- `site.yml` : la console (rôle `platform`).
- `runners.yml` : les Target Runners des hôtes cibles (rôle `runner`).

**Choix des hôtes** : si l'inventaire a un groupe `platform` (console) ou `runners` (Runners), seuls ses hôtes sont visés. Sinon, le playbook tourne sur l'hôte choisi par la limite (AWX : champ « Limite » du modèle ; ligne de commande : `--limit`). Un inventaire d'un seul hôte n'a besoin de rien. Plusieurs hôtes sans groupe ni limite : refus, pour ne pas installer partout par erreur.
- `backup.yml` : sauvegarde immédiate de la base de la console.
- `awx/configure.yml` : configuration AWX / AAP (voir [AWX](#awx)).

## Console

Rôle `platform` : installe ou met à jour la console (migrations, app, worker, PostgreSQL, Redis) sur un hôte Docker, à partir du `docker-compose.yml` du dépôt. Idempotent : un second passage sans changement ne modifie rien (seules les migrations sont rejouées).

## Prérequis

- Poste de contrôle : `ansible-core` ≥ 2.15, `git`, et `docker` pour le mode `archive`.
- Hôte cible : Docker ≥ 24 avec Compose ≥ 2.24.4, `python3`, `openssl`, accès `sudo` (`ansible_become`).
- Mode `traefik` : un Traefik existant sur l'hôte, avec TLS (le réseau externe `proxy` est créé s'il manque).

```bash
cd deploy/ansible
ansible-galaxy collection install -r requirements.yml -p collections
cp inventory/hosts.example.yml inventory/hosts.yml   # non versionné
ansible-playbook site.yml
```

## Image (`platform_image_source`)

| Mode | Fonctionnement |
|---|---|
| `build` (défaut) | `git archive` de `platform_git_ref` sur le poste, copie, `docker build` sur l'hôte. Seul le code **commité** est déployé. AC npm d'entreprise : `platform_build_ca_file`. |
| `archive` | Image locale exportée (`docker save`) puis chargée sur l'hôte : hôte sans accès Internet ni registre. Archive existante : `platform_image_archive`. |
| `registry` | Image publiée `platform_image_repository:platform_version`, récupérée par Compose. |

L'image est reconstruite ou rechargée seulement si `platform_image_repository:platform_version` est absente de l'hôte : changer `platform_version` pour mettre à jour (par exemple le commit court, comme dans l'inventaire d'exemple).

En mode `build`, l'image porte la révision des sources (commit, sinon empreinte du contenu) dans le
label `platform.revision` : elle est reconstruite dès que les sources changent, même si
`platform_version` reste identique. La révision apparaît dans le journal de chaque déploiement
(« Console <révision> »).

## Exposition (`platform_expose`)

- `port` : application publiée sur `platform_bind` (défaut `127.0.0.1:3000`) pour un reverse proxy de l'hôte (nginx, HAProxy…) qui assure HTTPS. Aucun label Traefik.
- `traefik` : conteneur `app` rattaché au réseau du Traefik, avec ses labels. Variables :

| Variable | Défaut | Rôle |
|---|---|---|
| `platform_proxy_network` | `proxy` | réseau Docker partagé avec Traefik (label `traefik.docker.network`) |
| `platform_proxy_network_create` | `true` | crée le réseau s'il manque ; `false` : échec si absent |
| `platform_traefik_router` | `platform` | nom du routeur et du service |
| `platform_traefik_rule` | ``Host(`<platform_domain>`)`` | règle du routeur |
| `platform_traefik_entrypoints` | `[websecure]` | points d'entrée |
| `platform_traefik_tls` | `true` | TLS sur le routeur |
| `platform_traefik_certresolver` | — | résolveur ACME de votre Traefik (ex. `letsencrypt`) |
| `platform_traefik_middlewares` | `[]` | ex. `[secure-headers@file]` |
| `platform_traefik_priority` | — | priorité du routeur |
| `platform_traefik_labels` | `{}` | labels ajoutés ou remplacés, tels quels |

Les labels générés **remplacent** ceux du `docker-compose.yml` (pas de routeur `platform` résiduel). Exemple (variables du modèle AWX) :

```yaml
platform_expose: traefik
platform_proxy_network: traefik_public
platform_proxy_network_create: false
platform_traefik_router: console
platform_traefik_certresolver: letsencrypt
platform_traefik_middlewares: [secure-headers@file]
platform_traefik_labels:
  traefik.http.routers.console.tls.domains[0].main: interne.example
```

Dans les deux cas `APP_URL` vaut `https://<platform_domain>`.

## Dossier d'installation (`platform_dir`)

Par défaut `/opt/sherpa` ; chemin absolu obligatoire (ex. `platform_dir: /opt/tools`).
Changé sur une console déjà installée, le playbook reprend les secrets de l'ancien dossier (la base
garde son mot de passe), arrête la stack puis la relance depuis le nouveau dossier ; les volumes
(base, Redis, fichiers) sont conservés. L'ancien dossier est laissé en place : le retirer après vérification.

## Migration depuis l'ancien nom (`portainer-platform` → Sherpa)

La console s'appelait `portainer-platform` : projet Compose, dossier `/opt/portainer-platform`, image `portainer-platform`, dépôt GitHub. Sous le nom Sherpa, ces valeurs par défaut deviennent `sherpa` et `/opt/sherpa`. Comme le projet Compose change, ses volumes aussi (`portainer-platform_pgdata` → `sherpa_pgdata`) : **le premier déploiement sous le nouveau nom reprend automatiquement l'installation existante** (`roles/platform/tasks/legacy.yml`), sans rien saisir :

1. les secrets de l'ancien dossier sont repris (clé maîtresse, mots de passe : la base et les secrets chiffrés restent lisibles) ;
2. si l'ancienne base tourne, elle est **sauvegardée** (`platform_backup_dir`) : un échec arrête le déploiement avant tout arrêt ;
3. les conteneurs et réseaux de l'ancien projet sont arrêtés et retirés, **volumes conservés** ;
4. les volumes `pgdata`, `redisdata` et `uploads` sont copiés vers ceux du nouveau projet, avec l'image PostgreSQL déjà présente sur l'hôte (sinon `busybox:1.37`) ;
5. Sherpa démarre sur ces données (migrations de base habituelles).

La reprise n'a lieu que si les volumes de l'ancien projet existent et que `<projet>_pgdata` n'existe pas : un second passage ne fait rien (le message l'indique). Elle s'arrête là si `platform_project` ou `platform_dir` sont fixés explicitement à leurs anciennes valeurs dans votre inventaire : vous gardez alors les anciens noms. `platform_legacy_project: ""` désactive la reprise ; `platform_legacy_dir` indique l'ancien dossier quand ses conteneurs n'existent plus.

**Rien n'est supprimé.** Après validation de Sherpa (connexion, un déploiement, les sauvegardes) :

```bash
docker volume rm portainer-platform_pgdata portainer-platform_redisdata portainer-platform_uploads
rm -rf /opt/portainer-platform        # secrets et sauvegardes de l'ancienne installation : copier avant si besoin
docker image rm portainer-platform:latest
```

**Retour arrière** (avant ce nettoyage) : redéployer l'ancienne version du dépôt. Elle redémarre sur les anciens volumes, intacts ; les écritures faites depuis la bascule ne s'y trouvent pas.

**AWX** : le dépôt a changé (`https://github.com/vti_ibf/sherpa.git`). Dans le projet AWX, remplacer l'URL du dépôt par celle-ci. Les noms de projet, inventaire et identifiants AWX viennent de votre `awx/vars.yml` (`awx_project_name`…) : tant que vous ne les changez pas, rien n'est recréé. Les renommer reviendrait à créer de nouveaux identifiants vides à resaisir.

**Identifiants conservés** : ils servent à reconnaître ce qui est déjà déployé ou stocké, les renommer orphelinerait des piles gérées : étiquettes `platform.*` des conteneurs, préfixe `platform/` des images construites, base et utilisateur PostgreSQL `platform`, réseau `platform-edge`, conteneur `platform-runner` et volume `platform-trivy-cache` sur les hôtes, variables Ansible `platform_*`.

## Plages réseau (`platform_network_subnets`, `platform_avoid_subnets`)

Docker prend par défaut des plages en 172.17–172.31.x.x. Si l'une recouvre un réseau de
l'entreprise (AWX, VPN, sous-réseau des serveurs), l'hôte route les réponses vers le pont Docker :
la machine devient injoignable depuis ce réseau (« Connection timed out » sur Gathering Facts).

```yaml
# Variables de l'hôte ou du groupe platform (inventaire AWX)
platform_network_subnets:          # plages imposées aux réseaux de la stack
  internal: 10.250.1.0/24
  runners: 10.250.2.0/24
  proxy: 10.250.3.0/24             # mode port (ou réseau proxy créé par le rôle)
platform_avoid_subnets:            # plages interdites : échec si un réseau Docker de l'hôte les recouvre
  - 172.24.0.0/16
```

Changer une plage arrête la stack (`down`) pour recréer ses réseaux ; les volumes sont conservés.

Pour que **toutes** les stacks de l'hôte (pas seulement la console) évitent ces plages, fixer les
plages par défaut du démon dans `/etc/docker/daemon.json`, puis `systemctl restart docker` :

```json
{ "default-address-pools": [{ "base": "10.200.0.0/16", "size": 24 }] }
```

Les réseaux existants gardent leur plage : les supprimer (`docker compose … down`) puis redéployer.

Hôte déjà injoignable : depuis une console sur la machine, `docker compose -p sherpa down`
(ou `docker network rm` du réseau fautif) rétablit la route, puis relancer le modèle avec les variables ci-dessus.

## Secrets

Fichiers de `/opt/sherpa/secrets/` (répertoire réservé à root), montés en secrets Docker :

- `master_key`, `db_password`, `redis_password` : générés sur l'hôte au premier passage, **jamais régénérés**. Pour les imposer (restauration, réinstallation), les fournir chiffrés avec ansible-vault (`platform_master_key`…). Une valeur fournie différente de celle de l'hôte **arrête le déploiement** : une autre clé maîtresse rendrait les secrets chiffrés illisibles.
- `master_keys_previous`, `smtp_password` : réécrits à chaque passage depuis les variables (vides par défaut).
- `runner-client.crt` / `.key` : identité mTLS vers les Target Runners (`platform_runner_client_cert_file` / `_key_file`, voir [docs/runner.md](../../docs/runner.md)). Sans elle, les Runners ne sont pas joignables.

Aucune valeur n'apparaît dans la sortie d'Ansible (`no_log`).

**La clé maîtresse n'est pas dans les sauvegardes** : la copier dans un coffre après le premier déploiement.

## Mise à jour et sauvegardes

- Avant de remplacer l'image en service, la base est sauvegardée (`platform_backup_before_upgrade`) dans `platform_backup_dir`.
- Sauvegarde quotidienne par minuterie systemd (`platform_backup_on_calendar`, rétention `platform_backup_keep`). Sans systemd, planifier `backup.sh` autrement.
- Sauvegarde à la demande : `ansible-playbook backup.yml`. Restauration : `restore.sh` sur l'hôte (voir [docs/exploitation.md](../../docs/exploitation.md)).

## Premier démarrage

Le playbook indique si l'instance attend son administrateur. Le jeton d'initialisation n'est pas affiché par Ansible : le lire sur l'hôte avec la commande indiquée, puis ouvrir `https://<platform_domain>/setup`.

## Variables de la console

Voir [roles/platform/defaults/main.yml](roles/platform/defaults/main.yml). `platform_env` ajoute des variables d'environnement à la console (SMTP, GitHub, rétention…, voir [docs/installation.md](../../docs/installation.md)).

## Target Runners

Rôle `runner` : installe le Runner (fichiers, extraction et builds pour la console, voir [docs/runner.md](../../docs/runner.md)) sur chaque hôte du groupe `runners`.

- **Racines** (`runner_roots`, défaut `/srv/deployments`, `/srv/builds`, `/srv/tmp`, `/srv/apps-data`) : créées, propriété de `runner_user` (créé s'il manque), montées aux mêmes chemins dans le conteneur. Les chemins de l'endpoint dans la console doivent être **sous** ces racines.
- **Écoute** : `runner_bind_ip:runner_port` (8443), sur l'interface d'administration uniquement (`0.0.0.0` refusé).
- **PKI d'entreprise** (obligatoire) : `runner_tls_cert_file` / `runner_tls_key_file` (certificat serveur, SAN = nom utilisé dans l'URL, `serverAuth`) et `runner_client_ca_file` (AC du certificat client de la console).
- **Builds** : socket Docker de l'hôte et groupe `docker` (`runner_docker_build`, défaut vrai) ; `false` désactive les builds.
- **Image** : `runner_image_source` `build` (`Dockerfile.runner`), `archive` ou `registry`, comme pour la console.

**Mise en service en deux passages** (la clé HMAC est générée par la console) :

1. `ansible-playbook runners.yml` : tout est préparé, le Runner n'est pas démarré ; le playbook affiche l'URL à déclarer.
2. Console → fiche du serveur → onglet **Target Runner** : URL et AC du Runner. La clé HMAC affichée une seule fois va dans `runner_hmac_key` (ansible-vault, `host_vars/<hôte>/vault.yml`).
3. Relancer le playbook : le Runner démarre ; l'empreinte HMAC affichée doit être celle de la console. Puis **Lancer le diagnostic** dans la console.

Changer de clé HMAC (nouvel enregistrement) ou de certificats : mettre à jour les variables et relancer ; le Runner est recréé.

## AWX

`awx/configure.yml` crée dans AWX (ou Automation Controller), avec la collection `awx.awx` :

| Objet | Nom | Contenu |
|---|---|---|
| Identifiant *Source Control* | `sherpa — GitHub` | utilisateur + jeton GitHub (lecture du dépôt privé) |
| Identifiant *Machine* | `sherpa — SSH déploiement` | compte de déploiement, clé SSH, `sudo` |
| Identifiant *Vault* | `sherpa — Vault` | mot de passe des variables chiffrées |
| Projet | `sherpa` | `https://github.com/vti_ibf/sherpa.git`, branche `main`, mise à jour au lancement, branche modifiable au lancement |
| Inventaire | `Sherpa` | groupes `platform` et `runners`, hôtes et variables de `awx/vars.yml` |
| Modèle | `Console — déployer` | `deploy/ansible/site.yml`, limite `platform` ; questionnaire : version, source de l'image, sauvegarde préalable ; branche, limite et mode *check* demandés au lancement |
| Modèle | `Runners — déployer` | `deploy/ansible/runners.yml`, limite `runners` (un hôte : limiter à son nom) ; questionnaire : version, source de l'image |
| Modèle | `Console — sauvegarder` | `deploy/ansible/backup.yml` |
| Workflow | `Plateforme — mise à jour complète` | sauvegarde → console → Runners, arrêt au premier échec ; variables (`platform_version`, `runner_version`) au lancement |

```bash
cd deploy/ansible
ansible-galaxy collection install awx.awx -p collections
cp awx/vars.example.yml awx/vars.yml          # non versionné
ansible-vault create awx/vault.yml            # awx_github_token, awx_vault_password (non versionné)
export CONTROLLER_HOST=https://awx.interne.example CONTROLLER_OAUTH_TOKEN=…
ansible-playbook awx/configure.yml -e @awx/vars.yml -e @awx/vault.yml --ask-vault-pass
```

### Lancer `awx/configure.yml` depuis AWX

Les tâches qui créent les identifiants masquent leur sortie (`no_log`) : le playbook contrôle d'abord l'accès à l'API et les variables, avec un message lisible en cas de manque.

1. Créer à la main dans AWX, organisation `Default` (ou celle de `awx_organization`), les trois identifiants **avec exactement ces noms** : `sherpa — GitHub` (Source Control), `sherpa — SSH déploiement` (Machine, élévation `sudo`), `sherpa — Vault` (Vault). Les secrets sont saisis dans AWX, jamais dans un fichier.
2. Créer un identifiant **Red Hat Ansible Automation Platform** : URL d'AWX et jeton OAuth d'un compte autorisé à créer projets, inventaires et modèles. C'est lui qui donne au playbook l'accès à l'API.
3. Créer le projet `sherpa` à la main une première fois (il sera ensuite mis à jour par le playbook), puis un modèle de tâche :
   - playbook `deploy/ansible/awx/configure.yml`, inventaire `Demo Inventory` (localhost) ;
   - identifiants : *Red Hat Ansible Automation Platform* ;
   - variables supplémentaires : le contenu de `awx/vars.example.yml` adapté, avec `awx_manage_credentials: false`.
4. Lancer le modèle. Relancer après chaque changement de variables.

Points propres à AWX :

- **Collections** : AWX installe `community.docker` depuis `collections/requirements.yml` à la racine du dépôt (paramètre « Activer le téléchargement des collections »). Sinon, utiliser un environnement d'exécution qui la contient (≥ 4.0).
- **Secrets** : les valeurs chiffrées (clé HMAC des Runners, certificats, clé maîtresse imposée…) vont dans des fichiers ansible-vault **du dépôt**, à côté des playbooks : `deploy/ansible/host_vars/<hôte>/vault.yml`, `deploy/ansible/group_vars/<groupe>/vault.yml`. Ils sont lus automatiquement et déchiffrés avec l'identifiant *Vault*. Les certificats se passent alors en contenu PEM : `runner_tls_cert`, `runner_tls_key`, `runner_client_ca`, `platform_runner_client_cert`, `platform_runner_client_key` (prioritaires sur les variables `*_file`).
- **Image** : `build` (sources du projet synchronisé, archive de la révision ou, sans dépôt Git dans la copie, de l'arborescence) ou `registry`. Le mode `archive` exige Docker sur le poste de contrôle : pas dans un environnement d'exécution AWX.
- **Version** : la saisir dans le questionnaire, par exemple le commit court de la branche déployée ; une nouvelle valeur reconstruit l'image.

## Vérification des rôles

```bash
ansible-lint            # profil « production »
ansible-playbook site.yml --syntax-check
```
