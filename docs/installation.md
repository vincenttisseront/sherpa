# Installation

## Prérequis
- Hôte Docker avec Docker Compose v2.
- Traefik en frontal, sur un réseau externe `proxy`, avec TLS.
- Accès réseau aux agents Portainer des hôtes cibles (port 9001).

## Déploiement avec Ansible

Le rôle [deploy/ansible](../deploy/ansible/README.md) automatise toute cette page : prérequis, secrets générés sur l'hôte (jamais régénérés), image construite depuis le dépôt, chargée depuis une archive ou récupérée d'un registre, Traefik ou port local, sauvegarde avant mise à jour et sauvegarde quotidienne. Les sections suivantes décrivent l'installation manuelle équivalente.

## Secrets

Tous les secrets sont des **fichiers** montés en secrets Docker, jamais des variables d'environnement.

```bash
mkdir -p secrets && chmod 700 secrets
openssl rand -base64 32 > secrets/master_key
openssl rand -hex 24 > secrets/db_password
openssl rand -hex 24 > secrets/redis_password
: > secrets/master_keys_previous      # vide hors rotation de clé
: > secrets/smtp_password             # mot de passe SMTP, vide si aucun
cp /chemin/platform-client.crt secrets/runner-client.crt   # identité mTLS vers les Runners (docs/runner.md)
cp /chemin/platform-client.key secrets/runner-client.key
# Lisibles par l'utilisateur des conteneurs (uid 1000), par personne d'autre.
sudo chown 1000:1000 secrets/* && chmod 400 secrets/*
```

La clé maîtresse ne doit jamais être stockée dans PostgreSQL ni dans le dépôt. La sauvegarder **séparément** de la base : sans elle, les tokens chiffrés sont irrécupérables.

## Démarrage

```bash
export APP_DOMAIN=deploy.interne.example
docker compose up -d --build --wait
```

- Le service `migrate` applique les migrations avant le démarrage de `app` et `worker`.
- Une seule instance du worker suffit au départ. Il peut être mis à l'échelle (`--scale worker=N`) : les verrous Redis empêchent les déploiements concurrents sur un même projet et environnement.
- Les conteneurs applicatifs tournent sans privilège, sur un système de fichiers en lecture seule, avec rotation des logs Docker.
- Redis exige un mot de passe ; PostgreSQL lit le sien dans le secret.

Variables principales :

| Variable | Défaut | Rôle |
|---|---|---|
| `APP_DOMAIN` | — | Domaine public (Traefik) ; `APP_URL` = `https://<APP_DOMAIN>` |
| `APP_VERSION` | `latest` | Tag de l'image |
| `GITHUB_ALLOWED_API_URLS` | `https://api.github.com` | API GitHub autorisées |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_FROM` | — | Email (voir Notifications) |
| `NOTIFY_WEBHOOK_ALLOWED_HOSTS` | Teams, Slack, Discord, ntfy.sh | Hôtes joignables par les canaux de notification (ajouter celui d'un ntfy ou Gotify auto-hébergé) |
| `WATCHTOWER_IMAGE`, `WATCHTOWER_HOOK_BASE_URL` | voir Watchtower | Watchtower |
| `RETENTION_DAYS` | 183 | Rétention des logs, de l'audit et des notifications |
| `METRICS_RETENTION_DAYS` | 7 | Historique des ressources des conteneurs (relevé chaque minute) |
| `SESSION_IDLE_MIN` / `SESSION_MAX_HOURS` | 60 / 12 | Durée des sessions |
| `WORKER_CONCURRENCY` | 2 | Déploiements simultanés par worker |
| `RUNNER_IMAGE` | `sherpa-runner:latest` | Image du Target Runner proposée par « Installer un hôte » (tableau de bord) : la publier sur un registre joignable des hôtes, sinon la charger sur chaque hôte |

### Essai de la configuration de production

`scripts/prod-smoke.sh up` démarre le même `docker-compose.yml` en local, dans un projet isolé (`pp-prod-smoke`, port 3200), avec des secrets générés. Le script `scripts/prod-smoke.sh down` le supprime.

## Premier démarrage

1. Tant qu'aucun compte n'existe, l'application émet à **chaque démarrage** un nouveau **jeton d'initialisation** (usage unique, valable 24 h ; le précédent est invalidé) et l'affiche dans ses logs :

   ```bash
   docker compose logs app | grep "Jeton d'initialisation"
   ```

   Pour obtenir un nouveau jeton sans redémarrer, lancer `docker compose exec app node dist/setup-token.mjs` (en développement : `npm run admin:setup-token`). L'outil ne fait rien si un compte existe déjà. Avec plusieurs instances `app`, seul le dernier jeton émis est valide.
2. Ouvrir `<APP_URL>`. Toute page mène à `/setup` : saisir le jeton et créer le compte administrateur. Ce compte local reste le **compte de secours**.
3. L'**assistant d'initialisation** s'ouvre ensuite. Les étapes SSO, Notifications, Serveurs et GitHub sont facultatives et peuvent être passées :

   | Étape | Contenu |
   |---|---|
   | Vérifications | HTTPS, cookies, worker, clé |
   | Accès | Groupes de départ liés aux rôles, invitation d'un second administrateur |
   | SSO | Keycloak, Okta ou OIDC, avec URI de redirection, test de découverte et correspondance des groupes |
   | Notifications | Canaux Teams et email, avec envoi de test |
   | Serveurs | Assistant Portainer, avec retour à l'assistant |
   | GitHub | Joignabilité des API, dépôts publics et privés |
   | Récapitulatif | Bilan des étapes |

   *Reprendre plus tard* le reporte. Il se rouvre depuis *Administration → Mise en service*. Chaque action est auditée (`onboarding.*`).

Les environnements et les rôles intégrés sont posés par `migrate` à chaque démarrage, sans action manuelle. Les permissions des rôles intégrés sont ainsi mises à jour avec les nouvelles versions.

## Authentification

| Variable | Défaut | Rôle |
|---|---|---|
| `APP_URL` | — | URL publique (retours OIDC, liens d'invitation) |
| `SESSION_IDLE_MIN` / `SESSION_MAX_HOURS` | 60 / 12 | Expiration d'inactivité / durée maximale d'une session |
| `COOKIE_SECURE` | true | Cookie réservé à HTTPS (ne désactiver qu'en développement HTTP) |
| `LOGIN_MAX_FAILURES` / `LOGIN_LOCK_MIN` | 5 / 15 | Verrouillage après échecs |

### Keycloak

1. Créer un client confidentiel, avec le flux « Standard flow » et la redirection `<APP_URL>/api/auth/oidc/<identifiant>/callback` (affichée dans Administration → Fournisseurs SSO).
2. Ajouter un mapper « Group Membership » (claim `groups`). Les groupes arrivent sous la forme `/nom`.
3. Dans la plateforme : émetteur `https://keycloak/realms/<realm>`, client ID et secret, puis mapping `/nom` → groupe de la plateforme.

### Okta

1. Créer une application « OIDC – Web Application », avec la redirection indiquée par la plateforme.
2. Serveur d'autorisation : ajouter un claim `groups` (filtre de groupes) et le scope `groups`.
3. Dans la plateforme : émetteur `https://<org>.okta.com/oauth2/default`, scopes `openid profile email groups`.

Par défaut, un utilisateur SSO **sans groupe mappé est refusé**.

## Sources GitHub

`GITHUB_ALLOWED_API_URLS` liste les API joignables, séparées par des virgules : `https://api.github.com` et/ou l'API de GitHub Enterprise (`https://ghe.interne/api/v3`). Aucun projet ne peut utiliser une autre URL. La plateforme doit pouvoir joindre l'API et l'hôte de téléchargement (`codeload.github.com` pour github.com).

## Traefik

Avec Docker Engine 29, utiliser **Traefik 3.6 ou plus récent**. Déclarer dans la fiche serveur le réseau de Traefik (autorisé, rôle traefik) et les domaines autorisés de l'endpoint.

## Watchtower

- `WATCHTOWER_IMAGE` : image par défaut injectée dans les stacks, tant qu'aucune version n'est figée par l'administration (page *Mises à jour d'images*, carte « Moteur de mise à jour »). Défaut : `nickfedor/watchtower:1.23.0`. Le projet `containrrr/watchtower` est archivé (17/12/2025) et incompatible avec Docker 29 : s'il est configuré ici, il est ignoré au profit du défaut.
- `WATCHTOWER_HOOK_BASE_URL` : URL de la plateforme **vue depuis les serveurs cibles**, pour les notifications de fin de passage. Défaut : `APP_URL`.

Les serveurs cibles doivent pouvoir joindre `<WATCHTOWER_HOOK_BASE_URL>/api/watchtower/hook/…`. Sans cela, les mises à jour restent constatées toutes les 5 minutes, mais les signalements et les échecs ne remontent pas.

En production, préférer le mode manuel ou planifié et des tags de version, plutôt que des tags flottants.

## Notifications

**Email.** Variables :
- `SMTP_HOST` et `SMTP_PORT` (587 par défaut) ;
- `SMTP_SECURE=true` pour le TLS implicite (465). Sinon STARTTLS est exigé en production ;
- `SMTP_USER`, et `SMTP_PASSWORD_FILE` qui pointe vers un secret Docker ;
- `SMTP_FROM`.

Sans `SMTP_HOST`, les canaux email sont indisponibles et les liens d'invitation sont remis à l'administrateur.

**Teams (webhook).**
1. Dans Teams, créer un workflow « Publier dans un canal lorsqu'une requête webhook est reçue ».
2. Copier son URL dans *Administration → Notifications*.

Les hôtes joignables sont limités par `NOTIFY_WEBHOOK_ALLOWED_HOSTS`. Défaut : `*.webhook.office.com,*.logic.azure.com,*.api.powerplatform.com,hooks.slack.com,discord.com,discordapp.com,ntfy.sh`. Le délai d'envoi est fixé par `NOTIFY_TIMEOUT_MS`.

**Tester un canal.** Bouton *Tester*. Chaque envoi est visible dans l'historique, avec son statut et sa dernière erreur.

## Rétention

`RETENTION_DAYS` vaut 183 jours (six mois) par défaut. La purge a lieu chaque nuit à 03:15. Elle peut aussi être lancée depuis *Administration → Rétention*.

## Exploitation

Supervision, sauvegarde et restauration, mise à jour, rotation de la clé maîtresse, incidents courants : [exploitation.md](exploitation.md).

## Build de l'image derrière un registry npm interne

En développement, `npm run dev:export-ca` exporte l'AC du trousseau macOS (par défaut `SCEPman-Root-CA-V1`, à surcharger avec `CA_NAME`) vers `.data/ca/internal-ca.pem`, utilisé par `compose.dev.yml`. La vérification TLS n'est jamais désactivée dans les images, et l'AC n'est pas conservée dans les couches.

`package-lock.json` référence le registry configuré au moment de l'installation. Si ce registry utilise une CA interne, il faut la fournir au build, sous forme de secret (elle n'est pas conservée dans l'image) :

```bash
docker build --secret id=npm_ca,src=/chemin/vers/ca-interne.pem -t sherpa .
```
