# Mise en service

Ce guide déroule, dans l'ordre, le branchement de la plateforme sur l'infrastructure réelle.

La page **Administration → Mise en service** vérifie chaque point en direct :
- joignabilité des fournisseurs ;
- derniers envois ;
- Runners, chemins, clés.

Elle donne aussi le lien vers l'écran où agir. L'objectif est qu'elle n'affiche plus ni « Bloquant » ni « À faire ».

> Les secrets (client secrets OIDC, tokens Portainer et GitHub, URL de webhook) se saisissent **dans l'interface** ou dans des **fichiers** de `secrets/`. Ils sont chiffrés et ne sont plus jamais réaffichés. Ne les transmettez par aucun autre canal.

## 1. Installer la plateforme

Suivre [installation.md](installation.md) : secrets en fichiers, `APP_DOMAIN`, `docker compose up -d --wait`.

Créer ensuite le premier administrateur avec le jeton d'initialisation. **Ce compte local reste le compte de secours** si le SSO est indisponible.

L'**assistant d'initialisation** s'ouvre ensuite et couvre les étapes 2 à 5 de ce guide : groupes et second administrateur, SSO, notifications, premier serveur, GitHub. Les sections suivantes détaillent ce qu'il faut préparer côté fournisseur.

## 2. SSO : Keycloak et Okta

Pour chaque fournisseur, dans *Administration → Fournisseurs SSO* :

| | Keycloak | Okta |
|---|---|---|
| Émetteur | `https://<keycloak>/realms/<realm>` | `https://<org>.okta.com/oauth2/default` |
| Client | Client confidentiel, *Standard flow*, PKCE S256 | Application *Web*, *Authorization Code* |
| URI de redirection | `https://<APP_DOMAIN>/api/auth/oidc/<clé>/callback` | idem |
| Déconnexion | *Valid post logout redirect URIs* : `https://<APP_DOMAIN>/login` | *Sign-out redirect URIs* : idem |
| Groupes | Mapper « Group Membership » vers la revendication `groups` | Revendication `groups` (filtre sur les groupes concernés) |

1. Saisir le client secret dans la fiche du fournisseur, puis cliquer sur **Tester** : l'émetteur doit être joignable.
2. Mapper les groupes de l'IdP vers les groupes de la plateforme, eux-mêmes liés aux rôles (*Rôles*). Un utilisateur sans groupe mappé est refusé.
3. Se connecter une première fois par SSO : le point passe à « OK » avec la date de connexion.

Détails et options (domaines d'email autorisés, scopes) : [installation.md](installation.md#authentification).

## 3. Notifications

1. **SMTP.**
   - Définir `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_FROM` ; mot de passe dans `secrets/smtp_password`.
   - Puis `docker compose up -d`.
2. **Teams.**
   - Dans le canal cible, créer un workflow « Publier dans un canal lorsqu'une requête webhook est reçue ».
   - Coller son URL dans *Administration → Notifications → Ajouter un canal*.
   - Hôtes autorisés : `NOTIFY_WEBHOOK_ALLOWED_HOSTS`.
3. **Créer un canal email** (destinataires de l'équipe).
4. Sur chaque canal, cliquer sur **Tester**. Le point « Alertes critiques couvertes » vérifie qu'échecs de déploiement, échecs de build et indisponibilités ont un destinataire.

## 4. Serveurs cibles

Chaque hôte Docker est joint par son **agent Portainer** ; aucun serveur Portainer n'est nécessaire.

**Installer un hôte** (tableau de bord, « server:manage ») donne la commande complète à coller dans le terminal de l'hôte :
- **type d'hôte** : Docker (Linux), Docker rootless (commande lancée sous l'utilisateur du moteur, racines dans son dossier personnel), Podman en root (socket `podman.socket` activé, agent `--privileged`), Synology DSM (volumes dans `/volume1/@docker`), Docker avec racine personnalisée (dossier des volumes à indiquer) ;
- **composants** : agent seul, agent et Target Runner, ou **SSH** (rien à installer : voir la variante ci-dessous). En SSH, la commande crée l'utilisateur de la console et lui donne accès au socket du moteur (groupe du socket ; Podman : socket ouvert au groupe `podman`), autorise la clé de la console (générée sur l'hôte et affichée une seule fois, ou clé publique fournie ; relancée, elle remplace la clé générée précédente), crée les chemins de travail, signale une redirection de socket limitée par sshd (repli sur `docker system dial-stdio`) et affiche les empreintes de la clé d'hôte à comparer dans l'assistant. **Ajouter ce serveur…** ouvre l'assistant en SSH avec l'utilisateur et le socket.
- avec l'agent et le Runner, la commande crée l'utilisateur propriétaire et les racines (`deployments`, `builds`, `tmp`, `apps-data` sous le dossier choisi), pose les certificats (auto-signé généré sur l'hôte, ou fichiers de la PKI) et l'AC des certificats clients de la console, **demande à l'écran la clé HMAC** affichée par la console à l'enregistrement du Runner, puis lance le Runner durci (lecture seule, sans capacités, écoute sur l'IP d'administration). Relancée, elle conserve clé et certificats et recrée les conteneurs ;
- l'AGENT_SECRET est généré dans le navigateur ; **Ajouter ce serveur…** ouvre l'assistant ci-dessous avec ce secret déjà saisi (jamais dans l'URL) ;
- l'image du Runner est celle de `RUNNER_IMAGE` (registre joignable des hôtes) ; à défaut, l'image construite par le rôle Ansible `runner` doit être présente sur l'hôte.
1. Dans *Serveurs → Ajouter un serveur*, **générer** un AGENT_SECRET.
2. Sur l'hôte, lancer l'agent avec ce secret (commande fournie par l'assistant, image `portainer/agent`). Un agent déjà installé doit être relancé avec `AGENT_SECRET`. N'ouvrir le port 9001 qu'à la console.
3. Saisir l'adresse `https://<hôte>:9001`, tester, puis suivre l'assistant. L'agent présente un certificat auto-signé ; pour le vérifier, lui fournir un certificat de l'AC interne (`MTLS_SSL_CERT`, `MTLS_SSL_KEY`, `MTLS_SSL_CA`) et activer la vérification avec cette AC.

Ensuite :
1. **Activer** les endpoints utilisés et leur associer les environnements.
2. Configurer les **chemins de travail** par environnement.
3. Installer le **Target Runner** sur l'hôte ([runner.md](runner.md)), le déclarer dans l'onglet *Runner* et lancer le **diagnostic complet**. Ensuite, la plateforme contrôle le Runner toutes les 5 minutes et alerte s'il devient injoignable ou manque d'espace disque.
4. Facultatif : **Traefik**, avec le réseau et les domaines autorisés.

### Variante sans agent : connexion SSH

Un hôte peut être joint en **SSH** (mot de passe ou clé), sans agent Portainer ni Target Runner : mêmes fonctions (inventaire, conteneurs en direct, logs, nettoyage, déploiements avec build, cycle de vie, exécutions ponctuelles, Traefik géré).

Prérequis sur l'hôte :
- `sshd` avec le sous-système SFTP et la redirection de socket (`AllowStreamLocalForwarding yes`, valeur par défaut d'OpenSSH) ; à défaut de redirection, la CLI Docker (`docker system dial-stdio`) ;
- un utilisateur dédié (ex. `deploy`) membre du groupe `docker` : l'accès au socket Docker équivaut à un accès root sur l'hôte, comme pour l'agent ;
- les chemins de travail de la plateforme accessibles en écriture par cet utilisateur (ce sont les seules racines autorisées : pas de `RUNNER_ROOTS` côté hôte).

Dans l'assistant, choisir **SSH**, saisir l'hôte, le port et l'utilisateur, puis la clé privée (préférable, dédiée à la plateforme) ou le mot de passe. **Lire la clé d'hôte** et comparer son empreinte sur l'hôte (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`) avant de la confirmer : toute connexion avec une autre clé est ensuite refusée. Après une réinstallation de l'hôte, *Vérifier* puis confirmer la nouvelle clé depuis la fiche du serveur. Les identifiants se remplacent depuis la même fiche (testés avant enregistrement, anciens détruits). L'onglet *Runner* lance le même diagnostic (racines, répertoires, espace disque, dépôt et extraction) à travers SSH.

**Répertoires créés automatiquement** : à la connexion du serveur, à l'enregistrement des chemins, au diagnostic et avant chaque déploiement, les répertoires de l'onglet *Chemins* absents sont créés. Sur un hôte SSH, ce que le compte ne peut pas créer (parent appartenant à root, ex. `/srv`) l'est par un conteneur éphémère sans réseau (image `HOST_HELPER_IMAGE`, `busybox:1.37` par défaut, téléchargée si absente), avec les droits du moteur Docker auxquels le compte a déjà accès. Seuls les répertoires créés, et une racine configurée existante fermée au compte, lui sont attribués : un dossier existant d'un projet ou de l'utilisateur ne change jamais de propriétaire.

**Hôte de la console lui-même** : la console tourne dans un conteneur, où `localhost` désigne le conteneur. Saisir `host.docker.internal` (déclaré dans les conteneurs app et worker) ou l'adresse IP de l'hôte. Si la lecture de la clé échoue par délai dépassé, autoriser dans le pare-feu de l'hôte (ufw, firewalld) les réseaux Docker de la console vers le port SSH.

Côté réseau, la plateforme doit joindre l'agent (port 9001) et le Runner (port mTLS), ou le port SSH des hôtes joints en SSH. Les hôtes cibles doivent joindre la plateforme si Watchtower est utilisé (`WATCHTOWER_HOOK_BASE_URL`).

## 5. Sources GitHub : dépôts publics et privés

Les deux modes sont supportés de la même façon (résolution du commit, analyse, sous-modules, archive, build).

| | Dépôt public | Dépôt privé |
|---|---|---|
| Token | Facultatif | Obligatoire |
| Sans token | 60 appels par heure et par adresse de la plateforme ; suffisant pour quelques déploiements | « Introuvable » : GitHub ne révèle pas l'existence d'un dépôt privé |
| Token recommandé | Fine-grained, *Public repositories (read-only)* | Fine-grained, limité au(x) dépôt(s) : **Contents : Read-only**, **Metadata : Read-only** |

**Créer un token fine-grained.** Dans GitHub : *Settings → Developer settings → Personal access tokens → Fine-grained tokens*.
- Propriétaire : l'organisation.
- Dépôts : *Only select repositories*.
- Permissions : Contents et Metadata en lecture seule.
- Prévoir une expiration et son renouvellement. L'organisation peut exiger une approbation.

**Organisation en SAML SSO.** Un token classique doit être autorisé pour l'organisation : *Configure SSO → Authorize*. Sans cela, la plateforme affiche « Token non autorisé pour l'organisation (SAML SSO) » avec le lien d'autorisation.

**Tokens classiques.** Ils sont acceptés, mais le périmètre `repo` donne aussi l'écriture sur tous les dépôts privés accessibles. Le test d'accès le signale et conseille un token fine-grained.

**GitHub Enterprise Server.** Ajouter `https://<ghe>/api/v3` à `GITHUB_ALLOWED_API_URLS`. Les dépôts *internes* sont traités comme privés.

**Réseau.** La plateforme joint `api.github.com` et, pour les archives, `codeload.github.com`. Une archive privée y est servie par un lien temporaire : le token n'est jamais transmis à un autre hôte.

**Côté projet.**
1. Onglet *Source* : renseigner le dépôt et la référence, avec le token si besoin.
2. Cliquer sur **Tester l'accès**. Le résultat donne la visibilité, le mode d'accès (anonyme, fine-grained, classique), le commit résolu, le Compose trouvé et les conseils.
3. Déployer depuis *Nouveau déploiement → Résoudre et analyser*. Le commit exact est figé dans la release.

**Messages d'erreur.**

| Message | Cause |
|---|---|
| Introuvable… un token est alors nécessaire | Dépôt privé sans token, ou nom erroné |
| … token sans accès à ce dépôt | Token qui ne couvre pas ce dépôt |
| Token GitHub refusé ou expiré | Token invalide. Il n'est jamais ignoré, même pour un dépôt public |
| Token non autorisé pour l'organisation (SAML SSO) | Autoriser le token pour l'organisation |
| Limite d'appels… réinitialisation à HH:MM | Ajouter un token (dépôt public) ou attendre |
| Sous-module hors de cette instance GitHub | Sous-modules sur un autre hôte : non supportés |

Un **sous-module privé** dans un dépôt public utilise le token du projet. Il faut alors un token qui couvre aussi ce sous-module.

## 6. Recette sur l'environnement

1. Page *Mise en service* : aucun point « Bloquant » ni « À faire ».
2. Tests navigateur contre l'environnement :
   ```bash
   E2E_BASE_URL=https://<APP_DOMAIN> E2E_ADMIN_EMAIL=<compte local de recette> E2E_ADMIN_PASSWORD_FILE=<fichier> npm run test:e2e
   ```
   Les scénarios qui exigent la boîte de développement ou le projet de démonstration sont ignorés automatiquement.
3. Planifier `deploy/backup.sh` et faire un **exercice de restauration** ([exploitation.md](exploitation.md)).
4. Mettre la clé maîtresse au coffre.
