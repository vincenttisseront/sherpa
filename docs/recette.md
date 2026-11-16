# Recette

Chaque critère d'acceptation (§24) est mis en regard de sa preuve. Légende :
- **Auto** : test automatisé rejoué à chaque livraison (`npm test`, `npm run test:e2e`) ;
- **Réel** : vérifié de bout en bout sur la stack de développement (Portainer CE 2.27, Docker 29, Runner mTLS, registre local), décrit dans [architecture.md](architecture.md) ;
- **À valider** : nécessite l'infrastructure cible (fournisseurs, services réels).

## Critères d'acceptation (§24)

| # | Critère | Statut | Preuves |
|---|---|---|---|
| 1 | Plusieurs hôtes configurables (agents Portainer) | Auto + Réel | Assistant, découverte et administration ; agent réel en dev |
| 2 | Token ajouté par assistant | Auto + Réel | Assistant en 4 étapes, token chiffré (`crypto.test.ts`) |
| 3 | Réseaux et volumes découverts | Auto + Réel | `discovery.test.ts` ; découverte persistée sur Portainer réel |
| 4 | Chemin de travail par serveur et environnement | Auto | `path-guard.test.ts`, `infra-config.test.ts` (racines par endpoint × environnement, sans chevauchement) |
| 5 | Fichiers GitHub ou ZIP déposés dans ce chemin | Auto + Réel | `runner.test.ts`, `release-files.test.ts`, `github.test.ts`, `github-access.test.ts` (dépôts **publics et privés** : anonyme, fine-grained, classique, SAML SSO, limite d'appels, archive privée par lien temporaire) ; E2E `deploy.spec.ts` (ZIP) et `github.spec.ts` (dépôt public sans token et dépôt privé avec token, jusqu'au déploiement) |
| 6 | Projet Dockerfile construit sur le serveur cible | Auto + Réel | `test/integration/build.test.ts` (vrai moteur Docker) ; échec de build détecté et notifié (Sprint 7) |
| 7 | Logs de build visibles | Auto + Réel | Flux SSE en direct, filtres niveau / phase / service / période, lignes précédentes, téléchargement complet ; E2E `deploy.spec.ts` |
| 8 | Stack déployée via Portainer | Auto + Réel | E2E `deploy.spec.ts` jusqu'à `HEALTHY` ; rollback automatique, cycle de vie |
| 9 | Volumes et ports non autorisés bloqués | Auto | `compose.test.ts`, `bind-guard.test.ts`, `port-guard.test.ts` ; revalidation avant chaque déploiement |
| 10 | Port custom ajouté avec validation | Auto | Approbation justifiée par port, `port-guard.test.ts` |
| 11 | Traefik utilise la configuration du serveur cible | Auto + Réel | `traefik.test.ts` ; routage HTTPS réel avec Traefik 3.6 |
| 12 | Watchtower activable service par service | Auto + Réel | `watchtower.test.ts` ; mise à jour, signalement, échec et pause sur registre réel (Sprint 6) |
| 13 | Keycloak, Okta et comptes locaux | Auto + **À valider** | Parcours OIDC complet contre un fournisseur réel en mémoire (`oidc.test.ts`) et dans le navigateur. Comptes locaux : E2E. **Reste à brancher le Keycloak et l'Okta de l'organisation** (procédure dans installation.md). |
| 14 | Permissions contrôlées côté frontend et backend | Auto + Réel | `permissions.test.ts`, `auth.test.ts` ; E2E (accès sans session refusé) ; utilisateur limité vérifié (403 sur l'audit, alertes d'administration masquées) |
| 15 | Logs et audit conservés six mois | Auto | Purge par lots au-delà de `RETENTION_DAYS=183` (`notifications.test.ts` : seules les données expirées sont supprimées) ; page Rétention |
| 16 | Notifications email et Teams | Auto + Réel + **À valider** | SMTP et webhook réels en local (`notifications.test.ts`, E2E `admin.spec.ts`). **Reste à configurer le SMTP et un workflow Teams de l'organisation.** |
| 17 | Tous les tableaux filtrables | Auto | Listes métier : `UiDataTable` (recherche, filtres combinables, tri, période, pagination serveur, colonnes, vues, CSV). Listes de configuration : filtre texte et statut. E2E `tables.spec.ts`. |
| 18 | Modals et confirmations custom | Auto | Toute boîte de dialogue native fait échouer les tests E2E (`e2e/fixtures.ts`) |
| 19 | Aucune commande arbitraire exécutable | Auto | Runner à liste blanche d'actions, sans shell (`runner.test.ts`) ; compose analysé, aucune entrée utilisateur passée à un shell |
| 20 | Déploiement par Docker Compose | Auto + Réel | `docker-compose.yml` démarré tel quel sur une base vierge (`scripts/prod-smoke.sh`) : secrets en fichiers, lecture seule, sans privilège, sauvegarde et restauration vérifiées ; **premier démarrage complet dans le navigateur** (`scripts/prod-smoke.sh e2e` : jeton, administrateur, assistant d'initialisation) |

Complément hors critères : **vue en direct des conteneurs** des endpoints gérés (état, santé, métriques, logs). Elle est couverte par l'E2E `live.spec.ts` et par `live.test.ts`.

## Sécurité (§19)

| Règle | Mise en œuvre |
|---|---|
| Aucun accès Docker depuis le navigateur | Le navigateur ne parle qu'à l'API ; Portainer et les Runners ne sont joints que par le serveur |
| Aucun secret dans le frontend | Tokens et configurations de canaux jamais renvoyés ; aucune valeur secrète dans la configuration publique |
| Tokens chiffrés, clé hors PostgreSQL | AES-256-GCM, clé en secret fichier, rotation outillée (`rekey.test.ts`) |
| Secrets masqués dans les logs | `redact.test.ts` ; notifications masquées avant envoi |
| Validation serveur des chemins, ZIP, volumes, ports, domaines | Gardes dédiées et tests associés |
| Timeouts et retries Portainer limités | Adaptateur HTTP (délais, retries GET seulement) |
| Verrouillage des jobs concurrents | Verrou Redis par projet × environnement ; une opération active par cible ; reprise des opérations orphelines |
| Audit des actions sensibles | Journal filtrable et exportable ; exports, purges et rotations eux-mêmes audités |
| Purge après six mois | Job nocturne, par lots |
| Rate limiting, CSRF, sessions sécurisées | Limitation par compte et par IP ; jeton CSRF sur toute écriture (y compris depuis l'interface, test E2E) ; cookies `HttpOnly`, `Secure`, `SameSite` |
| En-têtes HTTP | CSP stricte à empreintes, anti-iframe, HSTS (E2E `navigation.spec.ts`) |
| Aucun shell arbitraire | Voir critère 19 |
| Dépendances | `npm audit --omit=dev` : 0 vulnérabilité dans l'image de production |

## Reste à faire sur l'infrastructure cible

Procédure pas à pas : [mise-en-service.md](mise-en-service.md). La page *Administration → Mise en service* vérifie chaque point en direct.

1. Connecter le **Keycloak** et l'**Okta** de l'organisation, puis mapper les groupes.
2. Configurer le **SMTP** et un **workflow Teams** ; vérifier l'envoi avec le bouton *Tester*.
3. Déclarer les **agents** des hôtes réels et installer un **Runner** par hôte cible ([runner.md](runner.md)).
4. Tester une **source GitHub privée** (ou GitHub Enterprise) avec un token de l'organisation.
5. Planifier les **sauvegardes** et un exercice de restauration.
6. Rejouer `npm run test:e2e` contre la recette (`E2E_BASE_URL`, `E2E_ADMIN_EMAIL`, `E2E_ADMIN_PASSWORD_FILE`).

Hors MVP :
- **Microsoft Graph** : l'abstraction est en place, l'adaptateur n'est pas activé. Il faut une identité déléguée.
- **Docker Swarm et Kubernetes** : seuls les endpoints Docker Standalone sont déployables.
