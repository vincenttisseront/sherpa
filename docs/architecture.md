# Architecture

```
Navigateur ──HTTPS──▶ Traefik ──▶ Nuxt (UI + API Nitro) ──┬─▶ PostgreSQL (source de vérité)
                                                          ├─▶ Redis (jobs, verrous, cache)
                                                          └─▶ adaptateurs
Worker (BullMQ) ──────────────────────────────────────────┤
                                                          ├─▶ Agent Portainer (signé) ─▶ Docker Engine
                                                          ├─▶ Target Runner (sur l'hôte cible)
                                                          └─▶ Email / Teams
```

## Arborescence

| Dossier | Contenu |
|---|---|
| `app/` | Interface Nuxt : layout, pages, design system (`components/ui`), composables |
| `server/api/` | Routes Nitro, une par fichier (`*.get.ts`, `*.post.ts`) |
| `server/adapters/portainer` | Contrat `PortainerAdapter`, implémentation HTTP v2 et mock |
| `server/adapters/runner` | Contrat Target Runner (liste blanche Zod) et mock |
| `server/adapters/notifications` | Contrat des canaux (email, Teams webhook, Teams Graph) |
| `server/db` | Schéma Drizzle, migrations, client, seed |
| `server/queue` | Connexion Redis, files BullMQ, verrou distribué |
| `server/worker` | Processus worker : pipeline de déploiement, contrôle des serveurs, purges |
| `server/lib` | Code partagé avec le Runner : ZIP sécurisé, signature des requêtes |
| `runner/` | Target Runner (service installé sur les hôtes cibles), voir [runner.md](runner.md) |
| `scripts/` | Outils de développement (PKI de dev, déploiement de démonstration) |
| `server/utils` | Configuration, chiffrement, masquage, garde-fous chemins et ports, audit, auth |
| `shared/` | Code partagé front/back : permissions RBAC, machine d'états, schémas Zod |

## Modèle de données (résumé)

- **Identité** : `users` (local / sso / external, Argon2id), `identity_providers` (Keycloak, Okta, OIDC), `groups`, `user_groups`, `idp_group_mappings`, `sessions`, `invitations`.
- **RBAC** : `roles` (liste de permissions), `role_bindings` (sujet utilisateur ou groupe, portée serveur, environnement et projet ; NULL = toutes les valeurs).
- **Infrastructure** : `portainer_servers` → `server_endpoints` → `endpoint_environments`, `target_runners`, `path_configs`, `networks`, `docker_volumes`, `volume_rules`, `port_rules`, `traefik_configs`.
- **Applicatif** : `projects` → `project_sources`, puis `project_targets` (projet × endpoint × environnement) → `releases` → `deployments` → `deployment_logs`.
- **Transverse** : `secrets` (enveloppes AES-256-GCM), `audit_events`, `notification_channels`, `saved_views`.

Les objets découverts (réseaux, volumes) ne modifient jamais les politiques posées par un administrateur. Un objet disparu est marqué `missing`, pas supprimé.

## Sécurité : mécanismes en place dès le Sprint 0

| Exigence | Mise en œuvre |
|---|---|
| Tokens chiffrés, clé hors base | `server/utils/crypto.ts` : AES-256-GCM, keyId en AAD, rotation par trousseau. Clé fournie par `MASTER_KEY_FILE` (secret Docker) |
| Secrets masqués | `Redactor` (valeurs connues) + motifs (ghp_, github_pat_, ptr_, Bearer, password=, URL avec identifiants) |
| Chemins validés | `path-guard.ts` : refus des chemins relatifs, de `..`, de `/`, des préfixes système, du socket Docker, des chemins hors racine ou d'un autre projet |
| Ports contrôlés | `port-guard.ts` : SSH, Docker API, PostgreSQL, Redis et agent Portainer interdits d'office ; ports custom avec justification et confirmation |
| Pas de shell arbitraire | Runner limité aux schémas `runnerActions` |
| Jobs concurrents | Verrou Redis par projet × environnement, avec jeton, extension et report du job |
| Idempotence | `deployments.idempotency_key` unique, utilisé comme jobId BullMQ |
| Rétention six mois | Job planifié `retention-purge` (03:15) |
| Authentification fermée par défaut | `server/middleware/auth.ts` : 401 sans session. Le contournement de dev est refusé en production |

## Feuille de route

| Sprint | Statut | Contenu |
|---|---|---|
| 0 | ✅ | Fondations : stack, Compose, modèle de données, migrations, design system, contrats, mocks |
| 1 | ✅ | Assistant de connexion complet, découverte persistée, administration des serveurs, contrôle périodique |
| 2 | ✅ | Target Runner (service + client mTLS/HMAC), création des répertoires, dépôt ZIP, extraction contrôlée, nettoyage et rétention, logs temps réel, liste blanche des volumes bind |
| 3 | ✅ | Projets et cibles, analyse et génération Compose, diff, build sur le serveur cible, déploiement Portainer, healthchecks, rollback automatique, arrêt/démarrage/redémarrage/suppression |
| 4 | ✅ | Source GitHub (token chiffré, branche/tag/commit figé, sous-répertoire, sous-modules), exposition Traefik (labels générés, domaines contrôlés, conflits), services sous profil |
| 5 | ✅ | OIDC Keycloak/Okta, comptes locaux et externes, invitations, sessions, CSRF, limitation de débit, RBAC appliqué (API, listes, interface), administration des comptes et des droits |
| 6 | ✅ | Watchtower : politiques par cible et par service, injection dans le Compose, planification, constat et audit des mises à jour, provenance, écart Git, pause sur échec |
| 7 | ✅ | Tableau de bord, tableaux filtrables (période, colonnes, vues sauvegardées, export CSV), journal d'audit, notifications email et Teams (abstraction Graph), observation de la santé des cibles, rétention et purge |
| 8 | ✅ | Recette et mise en production : reprise des opérations interrompues, présence du worker, en-têtes de sécurité et CSP, configuration de production durcie et essayée, sauvegarde et restauration, rotation de la clé maîtresse, tests E2E navigateur, dépendances sans vulnérabilité, guide d'exploitation, rapport de recette |
| 9 | ✅ | Mise en service : page de contrôle en direct des prérequis, contrôle périodique des Runners, dépôts GitHub publics et privés (anonyme, fine-grained, classique, SAML SSO, limites, conseils de token), guide pas à pas |
| 10 | ✅ | Assistant d'initialisation au premier démarrage (vérifications, accès, SSO, notifications, serveurs, GitHub, récapitulatif), données de référence posées par migrate |
| 11 | ✅ | Refonte visuelle (design system, navigation, tableau de bord, thème sombre manuel), vue en direct des conteneurs (flux SSE, détail, métriques, logs), suppression des données de démonstration |



## Gestion des serveurs (Sprint 1)

### Assistant de connexion

Le §5.1 liste 13 étapes. L'assistant les regroupe en 10 écrans :

| Écran | Étapes du §5.1 |
|---|---|
| 1. Identification | nom (+ description, étiquettes) |
| 2. Connexion | agent : URL et token (+ AC interne optionnelle) ; SSH : hôte, utilisateur, mot de passe ou clé, empreinte de la clé d'hôte confirmée |
| 3. Sécurité, test et version | validation TLS ou clé d'hôte, test de connexion, détection de la version |
| 4. Endpoints | découverte des endpoints |
| 5. Environnements | association aux environnements |
| 6. Réseaux et volumes | découverte des réseaux et volumes, politique initiale |
| 7. Chemins de travail | configuration des chemins |
| 8. Ports | configuration des ports |
| 9. Traefik et domaines | configuration de Traefik, domaines autorisés |
| 10. Validation finale | validation finale |

L'association aux environnements vient avant les chemins, et non en 12ᵉ position comme dans le §5.1, parce que les chemins se définissent par environnement.

Rien n'est écrit avant la validation finale. `POST /api/servers/wizard` refait alors la découverte, revalide toutes les décisions et crée le serveur et sa configuration dans une seule transaction. Le client n'envoie que des décisions, jamais l'inventaire.

### Transport SSH (sans agent ni Runner)

Chaque serveur a un transport : `agent` (agent Portainer + Target Runner) ou `ssh`. L'adaptateur aiguille chaque opération selon la connexion ; le reste de la plateforme est identique.

- **Session** : une session SSH par hôte et identité (`server/adapters/ssh/session.ts`), partagée par l'API Docker, `docker compose` et SFTP, fermée après inactivité. La clé d'hôte est vérifiée à chaque connexion contre l'empreinte SHA-256 confirmée ; sans empreinte ou avec une autre clé, la connexion est refusée.
- **API Docker** : relais local (socket Unix privé, répertoire 0700) ; chaque connexion ouvre un canal vers le socket Docker de l'hôte (`direct-streamlocal@openssh.com`), sinon `docker system dial-stdio`. Les opérations Docker (`http.ts`) et les stacks Compose (`stacks.ts`) sont communes aux deux transports.
- **Fichiers et build** : les actions du Runner s'exécutent avec **le même code** (`runner/actions.ts`, `runner/fs-guard.ts`, `runner/docker.ts`) derrière une interface de système de fichiers (`runner/host-fs.ts`) : disque local pour le Runner, SFTP pour SSH (`server/adapters/ssh/sftp-fs.ts`). Les racines autorisées sont les chemins configurés de l'endpoint ; liens symboliques refusés, limites et empreintes inchangés. Une archive est contrôlée et extraite par la plateforme (mêmes limites), puis déposée dans un répertoire temporaire renommé à la fin.
- **Secrets** : mot de passe ou clé privée (et phrase de passe) chiffrés comme `AGENT_SECRET`, jamais renvoyés ni journalisés.
- **Dev** : service `ssh-host` de `compose.dev.yml` (Docker-in-Docker isolé, utilisateur `deploy`) ; identifiants générés par `npm run dev:ssh-setup` dans `.data/dev-ssh`.

### Découverte

- Les politiques posées par un administrateur ne sont jamais écrasées. Un réseau ou un volume disparu est marqué `missing`, pas supprimé.
- Politique initiale des réseaux : réseaux système (`bridge`, `host`, `none`…) interdits, réseaux du conteneur Traefik détecté autorisés avec le rôle `traefik`, les autres « à examiner ».
- Seuls les endpoints Docker Standalone sont activables. Swarm et Kubernetes sont découverts mais pas déployables.
- Un endpoint en erreur ou hors ligne n'empêche pas la découverte des autres et garde son inventaire précédent.

### Contrôle de santé

Le job `server-health` tourne toutes les 5 minutes (ou à la demande via « Tester maintenant ») :
- `offline` : Portainer injoignable ou token refusé ;
- `degraded` : un endpoint activé est hors ligne ou absent ;
- `online` : sinon.

Chaque changement de statut est tracé dans l'audit. La notification correspondante arrivera au Sprint 7.

### Garde-fous côté serveur

- Chemins : validation de `path-guard` (préfixes système, `..`, chemins relatifs, profondeur minimale), runtime séparé du travail, du temporaire et du build, chemins interdits configurables.
- Ports : une règle « autorisé » ou « soumis à validation » ne peut pas inclure un port toujours interdit.
- Traefik : le réseau doit exister et être autorisé. Une exposition externe exige au moins un domaine. Le réseau utilisé par Traefik ne peut pas être interdit.
- Token : jamais renvoyé. Le renouvellement est testé avant d'être enregistré, puis l'ancien secret est détruit.
- Suppression d'un serveur : refusée s'il porte des cibles de déploiement. Le token chiffré est supprimé avec lui.
- Corps de requête invalide : 422 avec erreurs par champ (`readValidated`).

## Fichiers et logs (Sprint 2)

### Compose généré à l'installation (Harbor)

Certains projets ne livrent pas de Compose : il est produit par un script d'installation. Pour **Harbor**, l'installateur (release `harbor-online-installer-vX.Y.Z.tgz`) est reconnu (`prepare` et `harbor.yml.tmpl` à la racine) et l'étape `prepare` est exécutée par la plateforme (`POST /api/targets/:id/generators/harbor`, `server/services/generators.ts`) :

1. `harbor.yml` rempli à partir du modèle : domaine, `external_url` en HTTPS (TLS terminé par le Traefik géré, Harbor en HTTP), `data_volume` et journaux dans le dossier de données du projet (`<data>/harbor/{data,prepare,log}`).
2. Mots de passe : variables secrètes de la cible `HARBOR_ADMIN_PASSWORD` (saisi ou généré dans le navigateur) et `HARBOR_DB_PASSWORD` (aléatoire) ; **réutilisés** d'une génération à l'autre (une base initialisée garde son mot de passe ; secrets de `<data>/harbor/data/secret` conservés par prepare).
3. `goharbor/prepare:<version de l'installateur>` exécuté sur l'hôte par l'adaptateur (`runOneShot`) : conteneur ponctuel **sans réseau**, non privilégié, `no-new-privileges`, mémoire et processus plafonnés, montages limités aux dossiers Harbor du projet, `harbor.yml` déposé dans le conteneur (jamais écrit sur l'hôte), conteneur toujours supprimé.
4. Compose produit adapté : montages `./common/config/…` rendus absolus vers les fichiers écrits par prepare, ports du service `proxy` retirés (exposition Traefik `proxy:8080`, enregistrée sur la cible).
5. Archive enregistrée (Compose + fichiers `env` + `harbor-generation.json`) puis circuit habituel ; les `env_file` sont importés en variables secrètes sans régénération.

Le collecteur syslog de Harbor (`127.0.0.1:1514`, utilisé par le pilote de journalisation du démon Docker) reste publié en local et demande une approbation justifiée.

### Parcours d'une archive

1. `POST /api/uploads` : réception en flux sur la plateforme (`UPLOAD_DIR`), taille plafonnée, SHA-256, **inspection complète** (mêmes règles que le Runner) avant d'accepter quoi que ce soit.
   - Formats : ZIP, tar.gz (`.tgz`) et tar, reconnus d'après le contenu. Un tar est **converti en ZIP** à la réception (`server/lib/tar.ts`) avec les mêmes refus (remontée `..`, chemin absolu, lien symbolique ou physique, fichier spécial, doublon à la casse près, nombre de fichiers et taille décompressée plafonnés, délai borné), puis le ZIP produit est inspecté. Taille et empreinte d'origine sont conservées (`report.source`) ; la suite du circuit (Runner compris) ne manipule que des ZIP.
   - Release GitHub (`POST /api/projects/:id/releases/inspect` puis `…/import`) : URL du dépôt ou d'une release (`/releases`, `/releases/tag/<tag>`, `/releases/latest`, `/releases/download/<tag>/<fichier>`). Tous les fichiers de la release sont listés : archives importables (.zip, .tar.gz, .tgz, .tar, sous la limite `UPLOAD_MAX_MB`) et code source du tag au choix ; signatures, sommes de contrôle, binaires et archives trop volumineuses affichés avec la raison. Le fichier doit appartenir à la release choisie. Un dépôt sans Compose propose directement ses releases dans l'onglet « Dépôt GitHub » ; une archive importée sans Compose est expliquée (installateur générant son Compose par script, modèle à adapter). Téléchargement limité aux hôtes GitHub autorisés, puis même circuit qu'une archive déposée. Le jeton éventuel sert à l'appel seulement (ou est repris de la source GitHub du projet pour le même dépôt).
2. Le worker (`PREPARING_FILES`) applique les contrôles suivants, sur l'hôte cible et via le Runner :
   - taille par rapport à `maxProjectSizeMb` ;
   - racines (créées si autorisé) ;
   - espace disque (minimum + 3 × l'archive) ;
   - arborescence §6.2 ;
   - dépôt dans `tmp/<projet>/` (empreinte vérifiée), extraction dans `releases/<release>/source` ;
   - empreinte de l'arborescence, `metadata.json` ;
   - suppression du temporaire, **même en cas d'échec**.
3. L'archive locale est supprimée une fois consommée. Une archive jamais utilisée est purgée après 24 h.

**Reprise** : si les sources d'une release sont déjà extraites et que leur empreinte est intacte, elles sont réutilisées sans nouveau transfert. Sinon elles sont supprimées et ré-extraites.

**Rétention** : après un déploiement réussi, les répertoires des releases au-delà de `releasesToKeep` sont supprimés (jamais la release active). La release est alors marquée `purged_at`. Un job nocturne purge les fichiers temporaires de plus de 24 h sur les endpoints sans déploiement en cours.

### Logs

- PostgreSQL est la source de vérité (`deployment_logs`), Redis diffuse en temps réel (pub/sub).
- Chaque ligne est masquée (`Redactor`) puis tronquée à 8 000 caractères avant écriture **et** avant diffusion.
- `GET /api/deployments/:id/logs` : pagination par curseur, filtres niveau/phase/service/texte/période, export texte.
- `GET /api/deployments/:id/logs/stream` : SSE. Rattrapage depuis la base puis temps réel, reprise automatique via `Last-Event-ID`, écritures sérialisées pour garantir l'ordre.
- Interface : composant `LogViewer` (recherche, filtres, copie de ligne, téléchargement, suivi automatique).

### Volumes bind

`evaluateBind` (utilisé au Sprint 3 pour valider les Compose) n'accepte un montage que s'il est couvert par une règle active de l'endpoint, compatible avec l'environnement, le projet et le mode (lecture seule / écriture). Le répertoire runtime du projet est toujours autorisé. Sont toujours refusés : les répertoires système, les sockets, et les répertoires de travail, de build et temporaires.

## Déploiement (Sprint 3)

### Parcours

1. **Projet et cible.** Un projet a au plus une cible par environnement : un endpoint × un environnement, avec une stack nommée `<projet>-<environnement>`.
2. **Archive.** Elle est déposée et inspectée (Sprint 2). Le Compose est lu directement dans le ZIP.
3. **Analyse** (`server/lib/compose/analyze.ts`, fonction pure). Le résultat est présenté avant toute confirmation :
   - **Sécurité** : refus de `privileged`, `network_mode/pid/ipc/uts/userns: host`, des capacités dangereuses, des `devices`, de la désactivation de seccomp/apparmor, de `volumes_from`, `extends`, `include`, `env_file`, des secrets fichiers, des labels `platform.*`, et des labels `traefik.*` (gérés par la plateforme au Sprint 4).
   - **Build** : contexte et Dockerfile obligatoirement dans les sources. Contexte distant, `dockerfile_inline`, `ssh` et secrets de build refusés.
   - **Ports** : `evaluatePort` avec les règles de l'endpoint. Port publié aléatoire refusé. Les ports custom exigent une justification et une confirmation, enregistrées dans la release.
   - **Volumes** : bind absolu → liste blanche ; bind relatif → réécrit vers `<runtime>/<projet>/…`, persistant entre releases. Volumes locaux à `driver_opts device` refusés (bind déguisé). Volumes externes : ils doivent exister.
   - **Réseaux** : un réseau externe doit être découvert et autorisé pour l'environnement. Seuls les réseaux internes `bridge` sont acceptés.
   - **Variables** : interpolées **après** l'analyse YAML, valeur par valeur, comme le fait Compose (aucune injection de structure possible). Les `$` substitués sont échappés. Les variables **secrètes** restent des références `${VAR}` et sont transmises à Portainer à part : elles n'apparaissent jamais dans le Compose final, le diff, la base ou les logs.
   - **Génération** : image construite à la place de `build` (`pull_policy: never`), `container_name` retiré, `restart` par défaut, labels `platform.*`, `version`/`name` retirés. Liste des modifications et diff unifié.
4. **Demande.** `POST /api/targets/:id/deployments` refait l'analyse. Si elle échoue, rien n'est créé. Le numéro de release est attribué sous verrou. Une seule opération active par cible (409 sinon). L'en-tête `Idempotency-Key` évite les doublons.
5. **Worker** :
   - préparation des fichiers ;
   - **revalidation avec les politiques en vigueur** ;
   - build de chaque service par le Runner, avec logs en flux ;
   - écriture du Compose final dans la release ;
   - création ou mise à jour de la stack Portainer (refus de reprendre une stack non gérée) ;
   - healthchecks.
6. **Issue** :
   - `HEALTHY` → release activée, puis rétention (répertoires **et images**).
   - Service en échec sur une nouvelle release → `FAILED` puis **rollback automatique** vers la release active précédente (`ROLLING_BACK` → `ROLLED_BACK`).
   - Sans release précédente, ou avec le rollback désactivé : `DEGRADED` si une partie seulement des services tourne, `FAILED` sinon.

### Build sur le serveur cible

Le Runner reçoit une action `build` : il copie le sous-répertoire des sources vers un contexte jetable (`<builds>/<projet>/<release>-<service>`). Le contexte est envoyé au moteur Docker local sous forme de tar, en appliquant `.dockerignore` avec la sémantique de Docker. Les logs remontent en flux NDJSON jusqu'aux logs du déploiement.

Le build est borné en durée, en volume de logs, en mémoire et CPU, et en nombre de builds simultanés. Les tags sont limités à `platform/…`, et les images de la plateforme sont les seules que le Runner peut supprimer.

### Healthchecks

Conteneurs repérés par le label `com.docker.compose.project`. Un service est OK s'il est `healthy`, ou démarré et stable (sans healthcheck). L'échec est rapide sur `exited`, `unhealthy` ou un redémarrage en boucle. Les 30 dernières lignes des services en échec sont ajoutées aux logs, après masquage.

### Cycle de vie

`POST /api/targets/:id/actions` (`stop`, `start`, `restart`, `delete`), avec les mêmes règles d'exclusivité et d'audit :
- `restart` redémarre chaque conteneur puis contrôle la santé ;
- `delete` supprime la stack, les releases et les images de la cible, et **conserve les données runtime**.

### Vérification de bout en bout

La chaîne complète a été exercée contre un **Portainer CE 2.27.4 réel** et un Runner en mTLS avec build Docker :
- déploiement, avec un secret absent du disque, de la base et des logs ;
- mise à jour ;
- release cassée → rollback automatique ;
- redémarrage, arrêt, démarrage ;
- refus d'une opération concurrente ;
- suppression.

## GitHub et Traefik (Sprint 4)

### Source GitHub

- **Configuration par projet** : API (parmi `GITHUB_ALLOWED_API_URLS`), dépôt `organisation/depot`, branche, tag ou commit, sous-répertoire, chemin du Compose, sous-modules, token. Le token est **chiffré, en écriture seule, jamais renvoyé ni journalisé**. Un token de portée minimale (lecture du contenu) est recommandé.
- **Analyse** : la référence est résolue en **SHA complet**, y compris pour un tag annoté. Le Compose est lu **à ce commit exact** et l'arbre du dépôt sert à vérifier contextes de build et Dockerfiles. Le déploiement porte sur **le commit présenté à l'analyse**, même si la branche a avancé depuis. Le commit et la référence sont enregistrés dans la release.
- **Téléchargement** (worker, phase `PREPARING_FILES`) : archive du commit (`zipball`), puis même parcours qu'un ZIP déposé (inspection, Runner, extraction). Le dossier racine `organisation-depot-sha/` est retiré à l'extraction : toute entrée hors de ce dossier fait échouer l'extraction.
- **Sous-modules** (option) : sous-modules hébergés sur la même instance GitHub, chacun téléchargé à son commit et extrait à son emplacement. Un sous-module hébergé ailleurs bloque l'analyse.
- **Protection contre le SSRF** :
  - seules les API autorisées sont joignables ;
  - les redirections ne mènent qu'aux hôtes de téléchargement attendus (`codeload.github.com` pour github.com, le même hôte pour GitHub Enterprise) ;
  - le token n'est jamais renvoyé vers un autre hôte ;
  - HTTP n'est accepté qu'hors production.

### Exposition Traefik

- **Configuration par cible** : service → domaine, port interne, préfixe de chemin facultatif, middlewares supplémentaires.
- **Contrôles** :
  - domaine conforme aux motifs de l'endpoint (`*.apps.x` couvre **un seul** niveau, `*.com` est refusé) ;
  - domaine non routé par une autre cible du même endpoint ;
  - réseau Traefik autorisé ;
  - service sans `network_mode`.
- **Génération** : labels `traefik.*` (routeur HTTPS avec TLS et resolver éventuel, routeur HTTP de redirection vers HTTPS, middlewares par défaut, port du service). Le service est raccordé au réseau Traefik **en plus** de ses réseaux, `default` compris. Les labels Traefik écrits à la main restent refusés.

### Services sous profil Compose

Un service avec `profiles:` n'est pas démarré par défaut, ni par Portainer. Il est retiré du Compose final, sans build ni healthcheck, et ce retrait est signalé.

### Vérification de bout en bout

Les vérifications ont été faites dans la stack de dev avec Traefik 3.6 :
- déploiement depuis un dépôt GitHub (faux serveur conforme à l'API) ;
- HTTPS servi par Traefik sur `demo-web.localhost`, redirection HTTP → HTTPS, domaine inconnu en 404, aucun port publié sur l'hôte ;
- analyse d'un dépôt public réel (`dockersamples/example-voting-app`) : ports publiés et port de débogage 9229 bloqués sans justification, contextes de build et service sous profil correctement traités ;
- conflit de domaine entre deux projets refusé.

**Traefik ≥ 3.6 est nécessaire avec Docker Engine 29** : les versions antérieures utilisent une API Docker que ce moteur refuse.

## Authentification et droits (Sprint 5)

### Sessions et protections

- **Session côté serveur** : cookie `pp_session` (`HttpOnly`, `SameSite=Lax`, `Secure` hors développement). La base ne conserve que l'empreinte SHA-256 du jeton. Expiration d'inactivité (`SESSION_IDLE_MIN`) et durée maximale (`SESSION_MAX_HOURS`). Révocation immédiate : déconnexion, suspension, changement de mot de passe, administrateur.
- **CSRF** :
  - toute requête modifiante doit porter le jeton CSRF de sa session (`x-csrf-token`, ajouté automatiquement par le front) ;
  - l'en-tête `Origin` doit correspondre à la plateforme.
- **Limitation de débit (Redis)** : connexion 20/min par adresse IP et 10 par 15 min par compte ; API 600/min par utilisateur et 120/min par adresse IP sans session.
- **Fermé par défaut** : hors des routes publiques (`/api/health`, `/api/auth/*`), toute requête sans session reçoit 401.

### Comptes locaux et externes

- **Mots de passe** : Argon2id (paramètres OWASP). Politique : 12 caractères minimum, pas l'identifiant, pas de mot de passe courant. Vérification à temps constant, même pour un compte inexistant.
- **Verrouillage** : après `LOGIN_MAX_FAILURES` échecs, pendant `LOGIN_LOCK_MIN`. Message générique (pas d'énumération des comptes), raison précise dans l'audit.
- **Création par invitation** :
  - un lien à usage unique (72 h) est remis une seule fois à l'administrateur, et seule son empreinte est conservée ;
  - un compte **externe** a obligatoirement une date d'expiration ;
  - suspension, réactivation, déverrouillage, lien de réinitialisation (2 h, coupe toutes les sessions).
- **Premier administrateur** : jeton d'initialisation à usage unique, affiché une seule fois dans les logs du serveur tant qu'aucun compte n'existe (`npm run admin:setup-token` pour en régénérer un).

### SSO OIDC (Keycloak, Okta, tout fournisseur OpenID Connect)

- **Protocole** : code d'autorisation + PKCE S256, `state` à usage unique (Redis, 10 min, anti-rejeu), nonce, ID token validé par `openid-client`, email vérifié exigé, domaines d'email éventuellement restreints.
- **Groupes** : groupes de l'IdP (claim configurable) → groupes internes par mapping, resynchronisés à chaque connexion. Par défaut, **sans groupe mappé, l'accès est refusé**.
- **Comptes existants** : un compte local ou externe de même email n'est **jamais** rattaché automatiquement à un compte SSO (pas de prise de contrôle).
- **Déconnexion** : elle se fait aussi chez le fournisseur (RP-initiated logout) s'il le propose. La redirection après connexion est limitée aux chemins locaux.

### RBAC

- **Rôles** : intégrés (Consultation, Création, Administrateur) ou personnalisés (choix des permissions). Ils sont attribués à un utilisateur ou à un groupe, pour toute la plateforme ou une portée limitée (serveur, environnement, projet).
- **API** : chaque route contrôle la permission dans la portée de la ressource. Les listes (projets, serveurs, options de déploiement) sont **filtrées**. Une ressource hors portée renvoie 404, pas 403, pour ne pas révéler son existence.
- **Interface** : menus, boutons et pages masqués selon les droits. Le serveur reste seul juge.
- **Garde-fous** : impossible de retirer le dernier administrateur actif (suspension, retrait de rôle, suppression ou modification de groupe), et impossible de se suspendre soi-même.

### Vérification de bout en bout (stack de dev)

Tout a été vérifié en conditions réelles :
- initialisation par jeton ;
- CSRF et origine refusés ;
- invitation acceptée ;
- utilisateur limité à un projet qui ne voit que ce projet (et son serveur), sans pouvoir déployer ni administrer ;
- verrouillage au 6ᵉ échec ;
- suspension qui coupe les sessions ;
- garde-fous du dernier administrateur.

Le SSO a été testé **dans le navigateur** avec un fournisseur OIDC de dev :
- connexion d'un membre du groupe mappé, avec ses droits ;
- refus d'un utilisateur sans groupe ;
- déconnexion chez le fournisseur.

Chaque cas est tracé dans l'audit, sans secret.

## Watchtower (Sprint 6)

Watchtower est configuré **par cible** (projet × environnement). Il est désactivé par défaut. Une configuration enregistrée s'applique au prochain déploiement, ou tout de suite par **Appliquer (redéployer)**. Ce redéploiement rejoue la release active avec la configuration actuelle et récupère à nouveau les images des registres.

### Politiques

| Mode | Effet |
|---|---|
| Mise à jour manuelle | Détection seule (`WATCHTOWER_MONITOR_ONLY`). Les nouvelles images sont signalées ; on les applique par un redéploiement. |
| Planifiée | `WATCHTOWER_SCHEDULE`, cron à 6 champs. |
| Automatique | `WATCHTOWER_POLL_INTERVAL`, 5 minutes minimum. |
| Labels | La sélection et la politique viennent des labels `com.centurylinklabs.watchtower.*` du Compose. |

Hors mode labels, chaque service est soit exclu, soit **signalé** (`monitor-only`), soit **mis à jour**. Les labels Watchtower du Compose sont alors remplacés par la décision de la plateforme.

### Injection dans le Compose final

La plateforme ajoute un service réservé `platform-watchtower`. Son image est choisie dans *Mises à jour d'images* (carte « Moteur de mise à jour ») parmi les dépôts maintenus du catalogue (`shared/schemas/update-engine.ts` : fork `nickfedor/watchtower`, sur Docker Hub ou GHCR) ; la version doit exister dans le registre et elle est **figée par empreinte** (`dépôt:tag@sha256:…`). Sans choix, `WATCHTOWER_IMAGE` s'applique (défaut `nickfedor/watchtower:1.23.0`) ; le projet archivé `containrrr/watchtower` est refusé.

Bascule et nettoyage : l'image réellement déployée est enregistrée par cible (`watchtower_image_applied`). Une cible sur une autre image est « Watchtower à appliquer » (tableau de bord, Mise en service) ; **Redéployer N cibles** les bascule (droits vérifiés par cible). Les anciens conteneurs et images Watchtower trouvés sur les hôtes sont listés (comparaison par identifiant d'image et par empreinte) : ceux d'une stack de la plateforme sont remplacés en redéployant, les autres et les images inutilisées sont supprimés sur demande, après une nouvelle lecture des hôtes.

Ce service :
- est limité à la stack par `WATCHTOWER_SCOPE=<stack>` et `WATCHTOWER_LABEL_ENABLE` ;
- ne se surveille jamais lui-même ;
- reçoit le socket Docker. C'est signalé comme avertissement à chaque analyse.

Chaque service reçoit les labels `enable`, `scope` et éventuellement `monitor-only`. Pour un registre privé, la plateforme transmet `REPO_USER` et `REPO_PASS` à partir des variables `WATCHTOWER_REPO_USER` et `WATCHTOWER_REPO_PASS` de la cible (secrètes de préférence).

Refus, à l'analyse comme à l'enregistrement de la configuration :
- un service construit par la plateforme (son image n'existe dans aucun registre : il faut redéployer depuis la source) ;
- une image figée par son empreinte (`@sha256:`) ;
- un service nommé `platform-watchtower` ;
- une source Git avec mises à jour automatiques **sans confirmation explicite** que l'exécution pourra différer du commit déployé.

Une image flottante (sans tag, ou `:latest`) mise à jour automatiquement produit un avertissement.

### Suivi des mises à jour

- **Notification.** Après chaque passage, Watchtower appelle `POST /api/watchtower/hook/<cible>/<jeton>`. Le message est un rapport JSON produit par un template Go (`updated`, `failed`, `stale`). Le jeton est propre à la cible, stocké chiffré et comparé à temps constant. Le traitement est confié au worker.
- **Constat.** La plateforme ne croit pas le rapport sur parole : elle compare l'identifiant d'image de chaque conteneur à la référence enregistrée au dernier déploiement. Ce constat a lieu à chaque notification et toutes les 5 minutes, et il est suspendu pendant une opération de la plateforme. Chaque changement est classé, historisé (`image_updates`, empreinte du registre comprise) et audité :
  - `watchtower.update` : mise à jour par Watchtower ;
  - `image.external_change` : origine inconnue ;
  - `watchtower.error` : nouveau conteneur arrêté.
- **Signalements.** Une nouvelle image disponible (service « signalé » ou mode manuel) est enregistrée une seule fois par image.
- **Échec.** Avec la politique « pause » (défaut), le conteneur Watchtower est arrêté (`watchtower.paused`). Il redémarre par **Reprendre** ou au prochain déploiement. Watchtower ne fait pas de rollback : le service reste en échec jusqu'à un redéploiement, ou jusqu'à la correction de l'image dans le registre.

### Provenance

La fiche de la cible distingue quatre informations :
1. la **configuration** : archive ou dépôt Git et commit de la release active ;
2. le **dernier déploiement de la plateforme** ;
3. la **dernière mise à jour d'image** faite hors plateforme ;
4. la **politique Watchtower appliquée** : en pause, ou modification non appliquée.

Les services dont l'image exécutée a changé depuis le dernier déploiement sont signalés. Avec une source Git, l'écart avec le commit est explicité.

### Vérification de bout en bout (stack de dev)

Le test a utilisé un registre local (`registry:3.1.2`, `localhost:15000`), Portainer CE et Docker 29 :
- Une image v1 a été déployée, puis Watchtower activé en mode automatique (`hello` mis à jour, `watcher` signalé) et appliqué par redéploiement.
- Le tag `stable` a été poussé en v3 : `hello` a été mis à jour par Watchtower, `watcher` est resté en v2 avec le signalement « nouvelle image disponible ». L'historique, l'empreinte, l'audit et l'écart ont été constatés par la plateforme.
- Une image cassée a été publiée sous `stable` : l'échec a été enregistré, puis audité, et Watchtower mis en pause automatiquement.
- La reprise et le redéploiement avec récupération des images ont ramené les deux services en v3 ; l'écart a été levé.
- Le redéploiement d'un projet dont les images sont construites par la plateforme (`pull_policy: never`) reste sain.

Limites connues :
- Watchtower peut inscrire l'URL de notification (jeton compris) dans ses propres logs. Ce jeton ne permet que d'envoyer un rapport : la plateforme vérifie elle-même les conteneurs, et seuls les signalements et les échecs proviennent du rapport.
- Sur un hôte dont l'image d'un conteneur n'a plus de tag (store containerd), Watchtower ignore ce conteneur jusqu'au prochain redéploiement.
- L'envoi des notifications email/Teams (`watchtower.error`) arrive au Sprint 7 ; d'ici là, l'événement est dans l'audit et l'historique.

## Tableau de bord, tableaux et notifications (Sprint 7)

### Tableau de bord

`GET /api/dashboard?period=` renvoie les indicateurs, **limités aux portées de l'utilisateur** :
- serveurs et endpoints disponibles ;
- projets actifs ;
- déploiements en cours, réussis et échoués ;
- builds échoués (`deployments.failed_from = BUILDING`) ;
- projets dégradés et healthchecks en erreur ;
- mises à jour d'images ;
- activité quotidienne ;
- dernières alertes, dernières actions (avec `audit:read`) et mises à jour Watchtower.

Chaque tuile ouvre le tableau correspondant, déjà filtré. Les alertes de droits et d'invitation ne sont visibles que des administrateurs.

La **santé des cibles** est constatée toutes les 5 minutes par le job `targets-observe` (`project_targets.health_state`). Ce même job détecte les changements d'image hors plateforme. Une dégradation constatée hors déploiement déclenche une alerte unique ; le retour à la normale est audité. La santé constatée prime sur le statut du dernier déploiement : un déploiement en échec dont la release précédente tourne toujours compte dans les échecs, pas dans les projets dégradés.

### Tableaux

`UiDataTable` couvre la recherche, les filtres combinables, le tri et la pagination côté serveur. Il ajoute :
- la **période** : relative (`period=7d`, conservée telle quelle dans les vues) ou personnalisée (`from` / `to`) ;
- les **colonnes configurables**, mémorisées par navigateur ;
- les **vues sauvegardées** par utilisateur (`saved_views` : filtres, tri, période, colonnes) ;
- la **réinitialisation** ;
- l'**export CSV**.

L'export rappelle la même route avec `format=csv&columns=…`, donc mêmes filtres et mêmes droits. Le fichier a un BOM et le séparateur `;` (Excel en français), des dates en heure de Paris, 50 000 lignes au plus. Les cellules sont protégées contre l'injection de formules. Chaque export est audité (`export.csv`, avec les filtres et les colonnes).

Tableaux concernés :

| Tableau | Route |
|---|---|
| Serveurs | `/api/servers` |
| Projets | `/api/projects` (filtres environnement et dernier statut) |
| Déploiements | `/api/deployments`, global et historique d'une cible (statut, opération, projet, environnement, serveur, échecs de build) |
| Mises à jour d'images | `/api/image-updates` |
| Audit | `/api/audit` (domaine, résultat, acteur, environnement ; fiche détaillée) |
| Utilisateurs | `/api/admin/users` |
| Envois de notifications | `/api/admin/notifications/deliveries` |

### Notifications (§18)

`emitNotification()` enregistre un évènement (`notification_events`), déjà masqué, puis la file `notifications` le répartit. Il y a **un envoi par canal abonné** (`notification_deliveries`) : statut, tentatives et dernière erreur. Les reprises sont exponentielles (4 tentatives) ; une erreur définitive (configuration, hôte refusé) n'est pas réessayée. Une notification ne fait jamais échouer l'opération qui l'émet.

| Évènement | Origine |
|---|---|
| `deployment.succeeded`, `deployment.failed`, `build.failed`, `healthcheck.degraded`, `deployment.rolled_back` | Fin de job de déploiement (statut final et `failed_from`) |
| `healthcheck.degraded` | Aussi émis par l'observation périodique |
| `server.unavailable` | Passage d'un agent à hors ligne |
| `watchtower.error` | Rapport Watchtower, ou conteneur recréé mais arrêté |
| `user.invited` | Création d'un compte. Le lien est aussi envoyé par email à la personne si SMTP est configuré. |
| `permissions.changed` | Toute action d'audit `permissions.*` |

Les canaux sont des adaptateurs interchangeables :
- **email** : SMTP, STARTTLS exigé en production, mot de passe lu dans un fichier ;
- **webhook Teams** : carte adaptative, hôtes autorisés par `NOTIFY_WEBHOOK_ALLOWED_HOSTS`, HTTPS, sans redirection ;
- **Microsoft Graph** : abstraction en place. La publication dans un canal exige une identité déléguée ; l'adaptateur sera branché sans toucher au moteur.

La configuration d'un canal (adresses, URL) est chiffrée et n'est jamais renvoyée. Le filtre d'environnement d'un canal ne s'applique qu'aux évènements liés à un environnement.

### Rétention

La purge quotidienne (03:15) traite les logs, l'audit, les évènements de notification (et leurs envois) et l'historique des images au-delà de `RETENTION_DAYS` (183 jours). Elle procède **par lots de 10 000** et elle est auditée. La page *Administration → Rétention* affiche les volumes, les éléments expirés et la dernière purge, et permet une purge manuelle (`policy:manage`).

### Correctif de sécurité côté client

Les appels `$fetch` des composants ne recevaient pas le jeton CSRF : seul `globalThis.$fetch` était équipé. Toute modification faite depuis l'interface était donc refusée (403), alors que les essais par l'API passaient. Le plugin `00.auth` équipe désormais `fetch` lui-même pour les requêtes modifiantes vers `/api/` du même domaine. Le jeton n'est jamais envoyé ailleurs.

### Vérification de bout en bout (stack de dev)

Le test a utilisé deux canaux (Teams webhook et email) vers la boîte de développement (`npm run dev:inbox`).

| Évènement | Résultat |
|---|---|
| Messages de test | Reçus sur les deux canaux ; un hôte de webhook non autorisé est refusé |
| Redéploiement réussi | Notifié |
| Build cassé | `build.failed` notifié, compté dans « Builds échoués » |
| Invitation | Lien envoyé à la personne, notification à l'équipe |
| Attribution de rôle | `permissions.changed` notifié |
| Service arrêté à la main | Dégradation détectée par l'observation, alertée, puis retour à la normale audité |
| Portainer arrêté | `server.unavailable` notifié |

Ont aussi été vérifiés :
- l'export CSV filtré, lui-même audité ;
- les vues sauvegardées et les colonnes depuis l'interface ;
- les droits : un utilisateur sans `audit:read` reçoit 403 sur l'audit et les envois, et ne voit pas les alertes d'administration.

## Recette et mise en production (Sprint 8)

Rapport de recette critère par critère : [recette.md](recette.md). Exploitation : [exploitation.md](exploitation.md).

- **Reprise après incident.** Une opération dont le job a disparu (worker arrêté, Redis vidé) est clôturée en échec en moins de 2 minutes, avec log, audit `deployment.recovered` et notification. Un job « bloqué » n'est jamais rejoué (`maxStalledCount: 0`) : un déploiement à moitié fait ne repart pas seul.
- **Présence du worker.** Clé Redis renouvelée toutes les 20 s, exposée par `/api/health` (`worker: ok | absent`) et sur le tableau de bord. Le conteneur a aussi son propre healthcheck.
- **En-têtes de sécurité.**
  - La CSP n'autorise que les scripts du site et, par empreinte SHA-256 calculée à chaque rendu, les scripts en ligne de Nuxt (configuration, importmap).
  - Pas de `'unsafe-inline'` pour les scripts, `frame-ancestors 'none'`, HSTS.
  - L'API répond en `no-store`.
- **Production.**
  - Secrets en fichiers : base, Redis, SMTP, anciennes clés (`*_FILE`).
  - Conteneurs en lecture seule, sans capacité ni nouvelle élévation de privilège, avec rotation des logs.
  - Configuration essayée telle quelle par `scripts/prod-smoke.sh`.
- **Sauvegarde.** `deploy/backup.sh` (pg_dump avec contrôle d'intégrité et rétention) et `deploy/restore.sh`. Un aller-retour a été vérifié avec une ligne témoin.
- **Rotation de clé.** `dist/rekey.mjs` : aperçu, rechiffrement idempotent, refus si une clé manque.
- **Dépendances.**
  - Nuxt et Vue ne servent qu'au build : ils passent en dépendances de développement et ne sont plus dans l'image.
  - nodemailer passe en version 10 (correctifs d'injection SMTP).
  - `npm audit --omit=dev` : 0.
- **Interface.**
  - Les dates s'affichent dans un fuseau fixe (Europe/Paris), ce qui corrige les écarts d'hydratation entre serveur et navigateur.
  - Le visualiseur de logs gagne les filtres par service et par période, le chargement des lignes précédentes et le téléchargement complet filtré.
  - Les tableaux locaux sont filtrables : endpoints, réseaux, volumes, groupes.
- **Tests E2E** (`npm run test:e2e`, Playwright avec le Chrome installé). Onze scénarios dont :
  - un **déploiement réel depuis l'interface** ;
  - les vues sauvegardées et l'export CSV ;
  - les canaux de notification ;
  - les en-têtes de sécurité et l'accès sans session.

  Chaque test échoue sur une boîte de dialogue native, une violation CSP, une erreur JavaScript ou un écart d'hydratation.

## Mise en service (Sprint 9)

Guide pas à pas : [mise-en-service.md](mise-en-service.md).

- **Page Mise en service** (`GET /api/admin/readiness`, `policy:manage`). Chaque prérequis est vérifié en direct :
  - HTTPS, cookies, mode production, worker, clé courante ;
  - compte local de secours, fournisseurs OIDC (découverte, groupes mappés, première connexion) ;
  - SMTP, canaux et dernier envoi, couverture des alertes critiques ;
  - Portainer, endpoints, chemins, Runners, Traefik ;
  - sources GitHub, rétention, sauvegardes, recette.

  Chaque point a un statut (OK, À revoir, Bloquant, À faire, Info) et un lien vers l'écran concerné.
- **Runners surveillés.** Le job `server-health` contrôle aussi, toutes les 5 minutes, les Runners des endpoints activés (mTLS, espace disque). Un Runner qui devient injoignable est audité (`runner.unavailable`) et notifié.
- **GitHub public et privé.**
  - Le client distingue l'organisation en SAML SSO (403 `x-github-sso`, avec le lien d'autorisation) et la limite d'appels, anonyme ou du token, avec l'heure de réinitialisation.
  - Il distingue aussi le dépôt privé « introuvable » sans token du token qui ne couvre pas le dépôt, et un token invalide n'est jamais ignoré.
  - « Tester l'accès » affiche la visibilité (public, privé, interne), le mode d'accès (anonyme, fine-grained, classique, application) et des conseils (token trop permissif, limite anonyme).
  - Le faux GitHub reproduit ces comportements : visibilité par dépôt, périmètres, SSO, limite anonyme, lien de téléchargement à jeton temporaire.
  - Le parcours complet a été vérifié dans le navigateur pour un dépôt public sans token et un dépôt privé avec token, jusqu'au déploiement sain.

## Assistant d'initialisation (Sprint 10)

1. **Création du premier administrateur.** Sans compte, toute page mène à `/setup` (jeton d'initialisation). Une fois l'administrateur créé, l'**assistant** `/onboarding` s'ouvre.
2. **Ouverture de l'assistant.** Il s'impose à l'administrateur (`policy:manage`, arrivée sur le tableau de bord) tant qu'il n'est ni terminé ni reporté. La progression est persistée dans `app_settings` (clé `onboarding`) et chaque action est auditée. Une installation déjà configurée (serveur déclaré, sans progression enregistrée) n'est pas concernée.
3. **Les étapes.**

   | Étape | Contenu |
   |---|---|
   | Vérifications | Points d'installation de la page Mise en service, avec le correctif à appliquer |
   | Accès | Trois groupes de départ liés aux rôles intégrés (Administrateur, Création, Consultation) ; invitation d'un second administrateur local |
   | SSO | Préréglages Keycloak, Okta, OIDC ; URI de redirection à copier ; enregistrement, test de découverte ; correspondance des groupes IdP vers les groupes créés |
   | Notifications | Canaux Teams et email abonnés aux évènements critiques, test immédiat ; état SMTP |
   | Serveurs | Assistant Portainer existant, avec retour à l'assistant (`returnTo`) ; état des endpoints et Runners |
   | GitHub | Joignabilité des API autorisées (`/rate_limit`, limite anonyme), rappel public / privé |
   | Récapitulatif | Bilan des étapes (faite, passée, non vue), puis page Mise en service |

4. **Configuration.** Toute la configuration passe par les API d'administration existantes (droits, validation, audit) : l'assistant n'a pas de chemin privilégié.

**Correctif de première installation.** Les environnements et les rôles intégrés n'étaient posés que par le seed de développement : un premier administrateur ne pouvait pas être créé sur une installation de production. `migrate` les applique désormais à chaque démarrage, de façon idempotente, et met à jour les permissions des rôles intégrés. La création du premier administrateur les garantit aussi.

**Vérifié.** Premier démarrage complet dans Chrome sur une instance vierge en configuration de production (`scripts/prod-smoke.sh e2e`) :
- de la page d'initialisation jusqu'à la page Mise en service ;
- groupes et second administrateur créés ;
- SSO enregistré avec un échec de découverte expliqué ;
- étapes passées ;
- test GitHub.

## Interface et vue en direct (Sprint 11)

### Design system

- **Bases.** Typographie Inter, servie par l'application : la CSP reste `font-src 'self'`. Icônes Lucide. Jetons de couleur, d'ombre et de rayon dans `main.css`.
- **Thèmes.** Clair, sombre, ou selon le système. Le choix est mémorisé par navigateur et appliqué avant le rendu par un script en ligne, autorisé par empreinte dans la CSP.
- **Navigation.** Barre latérale sombre en sections (Pilotage, Infrastructure, Gouvernance) avec icônes et carte utilisateur. En-tête collant avec l'état de la plateforme et le choix du thème.
- **Composants.** `UiPageHeader` (titre, phrase d'explication, icône, actions), `UiEmpty` (état vide avec action), `UiDrawer` (panneau de détail). Boutons, badges (pastille d'état), onglets en pilule, modales et tableaux harmonisés.
- **Tableau de bord.** Accueil personnalisé avec une phrase de synthèse (« Tout fonctionne normalement » ou « N points demandent votre attention »), tuiles à icônes colorées selon l'état.
- **Connexion.** Page en deux panneaux.

### Conteneurs en direct

| Élément | Rôle |
|---|---|
| `GET /api/live` | Instantané des endpoints gérés (activés, sur un serveur lisible) |
| `GET /api/live/stream` | Flux SSE : instantané à la connexion, puis seulement les changements, lus toutes les 3 s, 30 min maximum avec reconnexion automatique |
| `GET /api/endpoints/:id/containers/:cid` | Détail d'un conteneur avec métriques instantanées |
| `GET /api/endpoints/:id/containers/:cid/logs` | Dernières lignes de log, avec `logs:read` |

- **Lecture directe.** Les conteneurs, leur état et leur santé sont lus directement sur l'API Docker via Portainer : `containers/json`, `info`, `inspect`, `stats`. Un cache partagé de 2 s évite de multiplier les appels quand plusieurs écrans sont ouverts.
- **Rattachement aux projets.** Chaque conteneur est relié à son projet par sa stack Compose et l'endpoint.
- **Détail d'un conteneur.**
  - état et santé (historique des healthchecks) ;
  - CPU, mémoire, réseau, E/S et processus, rafraîchis toutes les 5 s ;
  - logs en direct ;
  - ports, réseaux, volumes ;
  - noms des variables d'environnement et labels.
- **Sécurité.**
  - Les **valeurs** d'environnement ne sont jamais lues.
  - Commandes, logs et sorties de healthcheck sont masqués par `redactPatterns`, qui couvre aussi `--password valeur` et les identifiants dans toute URL de connexion.
  - Aucune action n'est possible depuis cette vue.
- **Points d'accès.** Page *Conteneurs en direct*, onglet du même nom sur chaque serveur, lien « Voir les conteneurs en direct » sur chaque environnement d'un projet.

### Données de démonstration

Les données de démonstration de la stack de dev ont été supprimées, après une sauvegarde dans `.data/backups/` :
- projets et stacks déployées (par l'action *Supprimer*) ;
- serveur fictif ;
- comptes, groupes, SSO et canaux de test ;
- historique associé, registre et images de test.

L'audit est conservé. L'infrastructure de dev réelle reste en place : Portainer local, Runner, Traefik, compte `admin@acme.test`.

`e2e/deploy.spec.ts` s'ignore désormais, faute de projet de démonstration. `e2e/github.spec.ts` crée ses propres projets de test : le lancer seulement quand c'est voulu.

### Nettoyage Docker

Onglet *Nettoyage* de chaque serveur, et lien « Nettoyer » sur les cartes de la vue en direct. Permission `server:manage` sur le serveur.

1. **Aperçu** (`GET /api/endpoints/:id/cleanup`) : occupation disque (`docker system df`) et candidats de chaque catégorie, avec la raison de leur protection.
2. **Exécution** (`POST`) :
   - les candidats sont recalculés côté serveur : la sélection du client ne peut qu'en retirer ;
   - verrou par endpoint ;
   - refus pendant une opération de la plateforme sur l'endpoint ;
   - audit `docker.cleanup` avec l'espace récupéré.

| Nettoyage | Équivalent | Toujours conservé |
|---|---|---|
| Conteneurs arrêtés (option : depuis plus de 24 h) | `container prune` | Services des stacks de la plateforme (`label!=platform.managed=true`) : une stack arrêtée redémarre |
| Images sans tag, ou toutes les images inutilisées | `image prune [-a]` | Images construites pour un projet existant (rollback, rétention par environnement). Celles d'un projet supprimé sont retirées une à une. |
| Volumes inutilisés (sélection explicite, rien de présélectionné, confirmation en saisissant le nom de l'endpoint) | `volume rm` | Volumes des stacks de la plateforme (données runtime) ; tout volume encore utilisé |
| Réseaux inutilisés (sélection explicite) | `network rm` | Réseaux par défaut, réseaux déclarés dans la plateforme (Traefik, autorisés), réseaux des stacks |
| Cache de build (option : plus de 24 h, par défaut) | `builder prune -a` | Entrées récentes si l'option est cochée |

Dans les filtres de prune de Docker, plusieurs valeurs `label!=` n'excluent que les ressources portant *toutes* ces étiquettes. La protection repose donc sur une étiquette unique, posée sur tout service déployé par la plateforme.

Vérifié sur la stack de dev : suppression ciblée d'un réseau et d'un volume de test, refus d'un volume en service même demandé explicitement. Les protections sont couvertes par `test/integration/cleanup.test.ts`.

### Attentes et avancement

Toute attente indique ce que fait la plateforme et où elle en est.

- **Changement de page.** Barre d'avancement en haut de la fenêtre (`NuxtLoadingIndicator`).
- **Opérations.** Toute requête d'API qui modifie quelque chose, ainsi que les lectures longues, est suivie automatiquement par le plugin `00.auth`. Panneau en bas à gauche (`UiActivityHost`) :
  - nom de l'opération (`app/utils/activity.ts`) ;
  - étape en cours, avancement « étape n/N » ;
  - durée écoulée, puis issue (terminé ou échec).

  L'indicateur n'apparaît qu'au-delà de 350 ms, pour éviter les clignotements.
- **Étapes réelles.** Le client joint un identifiant (`x-progress-id`). Le serveur publie l'étape courante via `requestProgress(event).step(libellé, n, total)` : clé Redis liée à l'utilisateur, 10 min. Le client la lit sur `/api/progress/:id` pendant la requête : à 200 ms, puis toutes les 500 ms. Opérations instrumentées :
  - ajout d'un serveur et découverte (une étape par endpoint inventorié) ;
  - diagnostic du Runner (5 étapes) ;
  - analyse ZIP ou GitHub (résolution, arborescence, sous-modules, Compose) ;
  - préparation d'un déploiement ;
  - nettoyage Docker (une étape par catégorie) ;
  - vérifications de mise en service (une étape par domaine).
- **Tableaux.** Barre de chargement et résultats estompés pendant l'actualisation.
- **Déploiements.** Ils gardent leur suivi dédié : statuts et logs en direct sur la page du déploiement.


## Reverse proxies et reprise de l'existant

Objectif : repartir de ce qui tourne réellement sur un endpoint, sans rien y modifier avant une décision explicite.

### Lecture des reverse proxies (onglet « Proxy et expositions »)

- **Détection** (`server/lib/proxy/others.ts`) : Traefik, Caddy, caddy-docker-proxy, nginx, nginx-proxy, Nginx Proxy Manager, SWAG, HAProxy, Envoy, Apache. Un serveur web générique (nginx, Caddy, Apache) n'est retenu que s'il publie 80 ou 443 sur l'hôte. L'inventaire de découverte garde la liste (`inventory.proxies`) et le nombre de projets Compose.
- **Configuration statique de Traefik** (`server/lib/proxy/traefik.ts`), dans l'ordre de Traefik : fichier (`--configFile` ou emplacements par défaut, lu via l'archive Docker du conteneur, en lecture seule), sinon arguments de lancement, sinon variables `TRAEFIK_*`. On en tire les points d'entrée (adresse, port publié, TLS, résolveur, redirection, middlewares), les résolveurs ACME (challenge, fournisseur DNS, autorité de test, stockage), les fournisseurs (Docker, fichier, Swarm…), l'API et les avertissements (exposedByDefault, api.insecure, résolveur inconnu…). Le TOML est lu par un analyseur restreint aux syntaxes utilisées par Traefik.
- **Configuration dynamique** : labels Docker de tous les conteneurs (routeurs HTTP/TCP/UDP, services, middlewares), fournisseur fichier (routeurs, services, middlewares, options TLS, certificats fournis). Les règles `Host`/`PathPrefix` sont analysées. Une règle « simple » (hôtes, éventuellement un préfixe) est convertible.
- **Carte des expositions** (`server/lib/proxy/topology.ts`, fonction pure) : domaine → conteneur, port, réseau, TLS effectif (routeur, sinon points d'entrée qui ne redirigent pas), résolveur, redirection HTTPS. Elle signale ce qui doit l'être :
  - réseau non partagé avec Traefik ;
  - port indéterminé ;
  - labels ignorés (traefik.enable absent) ;
  - même routeur déclaré par plusieurs conteneurs ;
  - domaine routé deux fois ;
  - HTTP sans TLS.

  Pour nginx et Caddy, les sites (`server_name`, adresses Caddyfile, `{$VAR:défaut}`) et leurs destinations sont lus à titre indicatif. Un nom de service n'est résolu que sur les réseaux du proxy.
- **Sécurité** : extraction par liste blanche. Seuls des noms, adresses, chemins et booléens sortent. Les e-mails ACME, identifiants DNS, utilisateurs basic auth, `acme.json` et clés ne sont jamais lus ni renvoyés. Les variables d'environnement autres que `TRAEFIK_*` ne sont pas interprétées. Le cache dure 30 s ; « Relire » force une nouvelle lecture.

### Configuration Traefik pré-remplie

`GET /api/endpoints/:id/proxy/suggestion` propose, sans rien enregistrer :
- le réseau (fournisseur Docker, sinon celui des routes) ;
- les points d'entrée (:443, :80) ;
- le résolveur ;
- les domaines : ceux déjà autorisés sont conservés et seuls les hôtes non couverts sont ajoutés (joker uniquement sous un parent à deux niveaux, ou `*.localhost`) ;
- les middlewares communs, seulement s'ils sont durables (fichier ou conteneur Traefik, jamais les labels d'une application) ;
- l'exposition (interne si le port 443 n'est publié que sur 127.0.0.1).

Chaque valeur est justifiée dans l'onglet Traefik, et l'administrateur enregistre lui-même.

### Reprise d'une stack existante (onglet « Reprise de l'existant »)

- **Points d'entrée** : *Projets → Reprendre une stack* (stacks non gérées de tous les serveurs administrés, hors Traefik de la plateforme), *Reprendre en projet* sur une stack externe des conteneurs en direct et du détail d'une stack des reverse proxies. Tous mènent à l'onglet Reprise du serveur (`?tab=adopt&endpoint=…&stack=…`), assistant ouvert sur la stack.
- **Levée des points bloquants** (assistant *Lever les N points bloquants*, ou *Lever* sur un point) : un point à la fois.
  - *Port publié* (custom ou interdit) : si c'est une publication web probable (port ou image du conteneur), proposé d'abord derrière le Traefik de l'endpoint : le port est retiré du Compose et une exposition (domaine, préfixe, port du conteneur) est ajoutée (`webExposures` de l'aperçu, contrôlée par l'analyse : domaines autorisés).
  - *Port custom gardé* : justification confirmée pour ce projet (`portApprovals` de l'aperçu, reprise au premier déploiement et visible dans son audit), ou règle « autorisé » durable sur l'endpoint.
  - *Chemin bind hors liste blanche* : ajout du chemin ou de son dossier (lecture seule par défaut, portée environnement ou tous).
  - Règles écrites par `POST /api/endpoints/{id}/adoption/allow` (une règle, mêmes contrôles que l'édition des listes, droits `port:manage` / `volume:manage`, audit `port_rules.allow` / `volume_rules.allow`).
  - Autres points (port interdit, réseau, domaine, options refusées) : explication et lien vers le réglage. L'analyse est relancée à la fin.
- **Inventaire** : stacks Portainer (fichier Compose et variables disponibles) et projets Compose lancés hors Portainer. Chaque stack est présentée avec ses services, ses domaines servis, une mention si elle contient l'infrastructure (Traefik, Portainer) et le projet qui la gère, le cas échéant.
- **Source du Compose** :
  - *Stack Portainer* : son fichier ; `env_file: stack.env` est remplacé par des références `${VAR}`.
  - *Hors Portainer* : Compose reconstruit depuis les conteneurs (`server/lib/adoption/reconstruct.ts`). Seul ce qui diffère de l'image est repris (commande, environnement, labels, utilisateur, healthcheck). Les volumes et réseaux `<stack>_x` sont repris sous leur nom court, les autres en externes. Une commande contenant un secret en clair est refusée ; un volume anonyme est signalé.
- **Conversion** (`server/lib/adoption/convert.ts`, commentaires conservés) :
  - routes Traefik → expositions gérées ;
  - middlewares définis dans la stack écartés, avec un avertissement, y compris s'ils sont utilisés ailleurs ;
  - réseau Traefik retiré des services exposés (la plateforme le raccorde) ;
  - binds relatifs remplacés par le chemin réel de l'hôte : les données ne bougent pas ;
  - `build` remplacé par l'image en cours ;
  - routes non convertibles listées. Leur perte doit être confirmée.
- **Garde-fous** :
  - environnement servi par l'endpoint et chemins configurés ;
  - identifiant libre ;
  - stack pas déjà gérée ;
  - droits `server:manage` et `project:create` ;
  - audit `project.adopt`.
- **Effet** : le projet et la cible sont créés avec le **même nom de stack** (`AnalyzeContext.stackName`), donc les mêmes volumes et réseaux, et le même `portainerStackId` pour une stack Portainer. Sont aussi créés les expositions, les variables importées chiffrées (toutes secrètes, valeurs jamais renvoyées) et une archive `compose.yml` convertie. Rien ne change sur le serveur.
- **Mise en gestion** : bandeau du projet → « Mettre en gestion » (archive régénérée si besoin, `POST /api/targets/:id/adoption`) → circuit de déploiement normal (analyse, politiques, confirmation). Une stack Portainer est mise à jour en place ; un projet Compose hors Portainer devient une stack Portainer du même nom, qui reprend ses conteneurs.
- **Vérifié sur le Docker de dev** avec une stack de test lancée en ligne de commande :
  - reprise puis déploiement **HEALTHY** ;
  - conteneur passé en `platform.managed` ;
  - volume et fichier témoin intacts ;
  - route `adopt.localhost` toujours servie (200).

  La stack de test a ensuite été supprimée.

### Correctif

Fiche serveur : chargée directement sur un onglet d'endpoint (`?tab=…`), elle n'affichait pas les données de l'endpoint (configuration Traefik vue comme absente, réseaux vides). Au rendu serveur, `$fetch` ne transmet pas la session : la page utilise désormais `useRequestFetch()`, et l'endpoint est choisi dès la mise en place.

## Connexion directe aux agents Portainer

La console joint l'**agent Portainer** de chaque hôte (`portainer/agent`, port 9001). Il n'y a **aucun serveur Portainer** : le mode « serveur Portainer » a été retiré (migration `0011_agent_only`, qui refuse de s'appliquer s'il reste un serveur Portainer en base). Les noms internes (`portainer_servers`, `portainerEndpointId`, `portainerStackId`, adaptateur `portainer()`) sont conservés.

- **Adaptateur** (`server/adapters/portainer/`) : `createDockerOps` (`http.ts`) porte les opérations Docker, avec un transport signé ; `agent.ts` ajoute la version, l'endpoint et les stacks. En test, `PORTAINER_ADAPTER=mock`.
- **Signature** (`agent-signature.ts`), protocole vérifié dans le code de l'agent (`crypto/ecdsa.go`) et sur un agent réel :
  - en-têtes `X-PortainerAgent-PublicKey` (clé publique DER PKIX en hexadécimal) et `X-PortainerAgent-Signature` (ECDSA P-256 sur MD5 du secret, `r‖s` en base64 sans remplissage) ;
  - mode `AGENT_SECRET` uniquement : toute clé qui signe le secret est acceptée. La paire est donc propre au processus et jamais stockée ;
  - le secret est chiffré en base comme un token et ne circule jamais.
- **Un agent = un hôte = un endpoint** (identifiant 1), découvert via `/info` ; la version vient de l'en-tête `Portainer-Agent` de `/ping`.
- **Stacks** (`agent.ts`, `compose.ts`) : la console joue le rôle du serveur Portainer.
  - Le worker lance `docker compose -p <stack> -f - up -d --remove-orphans` (ainsi que `stop`, `start` et `down`) contre un **relais local** : socket Unix privé, propre à l'opération, qui ajoute la signature, relaie en HTTPS et gère flux et connexions détournées.
  - Les variables secrètes passent par l'environnement du processus (interpolation Compose), jamais par un fichier ; l'environnement de la console n'est pas transmis, et la sortie est masquée.
  - Une stack existe tant que des conteneurs portent son nom de projet et `platform.managed=true`. Son identifiant est stable, dérivé du nom.
  - La suppression conserve les volumes, comme une stack Portainer.
- **Image** : CLI Docker et plugin Compose copiés depuis `docker:29-cli` dans l'image de la console.
- **Reprise de l'existant** : le Compose est toujours reconstruit à partir des conteneurs (plus de lecture de fichier de stack Portainer). Un `env_file` est signalé comme bloquant.
- **TLS** : l'agent présente par défaut un certificat auto-signé régénéré à chaque démarrage. La vérification est alors désactivée et signalée comme risque ; avec un certificat d'AC interne fourni à l'agent (`MTLS_SSL_*`), elle est vérifiée.
- **Vérifié en dev** (service `agent` de `compose.dev.yml`, secret dans `.data/dev-auth/agent.env` ; plus de service Portainer), serveur `agent-local` :
  - test de connexion ; mauvais secret refusé ;
  - assistant, découverte ;
  - déploiement **HEALTHY**, avec variable secrète transmise et route Traefik en 200 ;
  - mise à jour, redémarrage, arrêt, démarrage, suppression ;
  - vue en direct, détail, statistiques, logs, lecture du proxy, aperçu du nettoyage, inventaire de reprise ;
  - aucune trace du secret dans les journaux ni dans l'audit.

## Placement des projets et Traefik géré

- **Assistant « Nouveau projet »** (projet → hôte et environnement → emplacement → reverse proxy → récapitulatif) : projet et première cible créés dans **une transaction**, après tous les contrôles (`POST /api/projects` avec `target`).
- **Chemin du projet** (`project_targets.project_path`) : un dossier unique sur l'hôte, `releases/` (sources et Compose de chaque release) et `data/` (données). Il est contrôlé par `validateProjectPath` et `validatePlacement` :
  - strictement sous la racine de travail ou runtime de l'environnement, là où le Runner peut écrire ;
  - ni zone sensible ni chemin interdit ;
  - sans recouvrement des dossiers d'un autre projet de l'endpoint.

  Il est fixé au premier déploiement (les données ne sont pas déplacées). Sans chemin choisi : `<workingRoot>/<projet>` et `<runtimeRoot>/<projet>`.
- **Volumes en dossiers** (`volumes_as_folders`) : à l'analyse, chaque volume nommé local du Compose devient un dossier `data/<volume>`. Les volumes externes, à driver ou à options restent des volumes Docker. Le dossier de données est montable même sous la racine de travail ; `releases/` ne l'est jamais.
- **Réseau du reverse proxy** (`proxy_network`) : remplace, pour la cible, le réseau de la configuration Traefik de l'endpoint. Il doit être autorisé sur l'endpoint, et se modifie dans les réglages du projet (appliqué au prochain déploiement).
- **Compose saisi** : le panneau de déploiement accepte un Compose collé. `POST /api/uploads/compose` en fait une archive `compose.yml`, et le circuit habituel s'applique (analyse, politiques, variables secrètes).
- **Traefik géré** (`managed_proxies`, stack `platform-traefik`), configuré par l'assistant de l'onglet « Traefik et domaines » :
  - écoute (adresse, ports) ;
  - réseaux, créés sur l'hôte s'ils manquent ;
  - ACME : e-mail, challenge HTTP, TLS ou DNS, avec identifiants du fournisseur chiffrés et transmis par l'environnement ; autorité de test ou de production, ou autre autorité ACME.

  Configuration par arguments uniquement ; routage limité aux conteneurs `platform.managed` ; résolveur `le` par défaut sur `websecure`. L'aperçu détecte les ports déjà publiés (conflit bloquant). L'application passe par l'agent (`docker compose`), resynchronise les réseaux (autorisés, rôle traefik) et aligne la configuration Traefik de l'endpoint (réseau, résolveur, points d'entrée ; domaines et middlewares conservés). L'opération est auditée (`proxy.configure`, `proxy.apply`).
- **Vérifié en dev avec phpIPAM** (exemple du README de phpipam-docker, images `latest`) :
  - Traefik géré sur 127.0.0.1:28080/28443, réseau `platform-edge` créé ;
  - projet sous `apps-data/staging/phpipam`, trois volumes en dossiers ;
  - exemple refusé tel quel (capacité `NET_ADMIN`), accepté avec `NET_RAW` seul ;
  - mots de passe en variables secrètes ;
  - déploiement **HEALTHY**, HTTP redirigé vers HTTPS, page d'installation servie en HTTPS.

  ACME a été tenté auprès de l'autorité de test mais ne peut aboutir en dev (domaine `localhost`, e-mail de test) : Traefik sert son certificat par défaut.

### État ACME et déploiement depuis une URL GitHub

- **État ACME du Traefik géré** (`GET /api/endpoints/:id/managed-proxy/acme`, panneau « Traefik géré ») : chaque domaine exposé sur l'endpoint obtient un état (valide, expire bientôt sous 21 jours, expiré, échec, en attente), avec l'émetteur, l'expiration, le marquage « test » et la dernière erreur ACME. Le compte ACME (enregistré ou non) est aussi affiché.
  - **Sources** : `acme.json`, lu via l'agent, dont seuls les domaines, l'émetteur et l'expiration sont extraits (les clés privées ne sont ni conservées ni renvoyées), et les erreurs ACME des derniers logs de Traefik.
  - **Sans appel sortant inutile** : le Traefik géré désactive la vérification de version et les statistiques anonymes.
- **Source « Dépôt GitHub » dans le panneau de déploiement** : il suffit de coller une URL (page du dépôt, `…/tree/<branche>/<dossier>`, `…/blob/<ref>/<compose>`, URL de clonage, `organisation/depot`, GitHub Enterprise via `/api/v3`). `POST /api/projects/:id/source/inspect` lit le dépôt sans rien enregistrer. Selon le résultat, l'assistant :
  - demande un jeton si le dépôt est privé ou introuvable ; un jeton déjà enregistré pour le même dépôt est réutilisé ;
  - propose la référence : celle de l'URL (branche, sinon tag, sinon commit), à défaut la branche par défaut ;
  - propose le fichier Compose (préféré : `compose.yaml`/`docker-compose.yml` à la racine du dossier) ;
  - offre les sous-modules s'il y en a ;
  - s'il n'y a aucun Compose, propose de coller un Compose.

  Valider enregistre la source GitHub du projet (jeton chiffré), puis l'analyse du commit figé démarre. « Changer de source » revient aux onglets Compose saisi, archive (fichier ou release GitHub) et dépôt GitHub. Une URL de release (`/releases/tag/<tag>`) désigne directement ce tag.
- **Vérifié en dev** :
  - phpipam-docker : public, aucun Compose ; l'assistant propose de coller un Compose.
  - netbox-docker : branche `release`, `docker-compose.yml`, analyse du commit refusée car le Compose utilise `env_file`, non pris en charge.
  - dépôt inexistant : jeton demandé.
  - phpIPAM : domaine en échec ACME, avec le motif de l'autorité de test.

### Passer un conteneur hors plateforme derrière le Traefik géré

Depuis la carte des reverse proxies, le tiroir d'une stack lancée hors plateforme propose de choisir, conteneur par conteneur, ceux à servir par le Traefik géré (port, domaine, préfixe de chemin, HTTPS) ; les autres ne sont pas touchés. Une stack de la plateforme passe toujours par l'exposition web de son projet (labels au déploiement). Les proxies non gérés (Caddy, nginx…) sont affichés mais ne sont jamais modifiés.

- **Routes** (`proxy_routes`) : écrites dans la configuration dynamique du Traefik géré (fournisseur fichier, répertoire `/etc/traefik/dynamic`, fichier `routes.yml` livré en « config » Compose), effectives à l'application du proxy (« à appliquer » sinon, empreintes dans `applied_routes`).
- **Réseau** : la plateforme rattache le conteneur au réseau du Traefik géré (API Docker, agent ou SSH). Désigné par son projet et son service Compose, il est rattaché de nouveau après une recréation : vérification dédiée toutes les 30 s (job `proxy-routes-attach`, hôtes avec routes uniquement), à chaque application du proxy, ou par « Rattacher maintenant ». Une route retirée détache le conteneur si c'est la plateforme qui l'avait rattaché.
- **Contrôles** : Traefik géré présent, domaine valide et autorisé sur l'endpoint, non déjà servi (routes, expositions des projets, routes lues sur les proxies). Les ports encore publiés en direct sont signalés : à retirer du Compose d'origine, que la plateforme ne modifie pas.
