# CLAUDE.md

Sherpa : plateforme interne de déploiement Docker (hôtes joints en SSH ou par agent Portainer). Le cahier des charges v0.1 (8 oct. 2026) fait référence. Le plan est découpé en sprints (0 à 7), voir docs/architecture.md § Feuille de route.

## Stack
Nuxt 4 (app/ = front, server/ = Nitro, shared/ = code commun), TypeScript strict, Drizzle ORM + PostgreSQL, BullMQ + Redis, Zod 4, Vitest.

## Règles non négociables
- Le navigateur n'accède jamais à Docker, Portainer ou au Runner : tout passe par `server/adapters/*`.
- Aucun secret en clair en base, dans les logs ou dans les réponses API. Les secrets sont stockés via `encryptSecret` dans la table `secrets` et référencés par id. Tout texte destiné aux logs ou à l'audit passe par `Redactor` / `redactObject`.
- Chemins serveur cible : toujours construits via `projectLayout()` (server/utils/path-guard.ts), jamais saisis librement.
- Ports : `evaluatePort()`. Volumes bind : whitelist `volume_rules`.
- Target Runner : uniquement les actions de `runnerActions` (schémas Zod = liste blanche). Aucune commande arbitraire.
- Chaque route API commence par `requirePermission(event, '<perm>', scope)`. Toute action sensible est tracée avec `audit()`.
- Statuts de déploiement : transitions via `assertTransition` (shared/utils/deployment-status.ts).
- UI : aucun `alert/confirm/prompt` natif (règle ESLint). Utiliser `useConfirm()`, `useToast()` et `UiModal`.
- Tous les tableaux utilisent `UiDataTable`, avec pagination, tri et recherche côté serveur. Pour une liste métier : `table-key` (colonnes et vues sauvegardées), `export-url` et `period`. Côté API, `tableResponse()` (`server/utils/table.ts`) sert le JSON paginé et l'export CSV (mêmes filtres, mêmes droits, export audité), et `periodRange()` traduit la période.
- Corps de requête : `readValidated(event, schema)` (422 + erreurs par champ), jamais `readValidatedBody`. Côté front : `apiError(err)`.
- La découverte (`server/services/discovery.ts`) ne modifie jamais une décision d'administrateur.
- `server/lib/` et `server/utils/path-guard.ts` sont embarqués dans le Runner (bundle autonome) : pas d'import Nuxt/Nitro, de base ni de Redis dans ces fichiers.
- Toute suppression côté hôte passe par `assertInsideProject` / `projectLayout` ; ne jamais appeler `cleanup` sur une racine configurée.
- Logs de déploiement : `appendLogs` (masquage + diffusion), jamais d'insert direct.
- `npm run typecheck` couvre aussi `runner/`, `scripts/` et `test/` (tsconfig.tools.json).
- Analyse Compose : `server/lib/compose/analyze.ts` reste PURE (pas d'E/S). Toute nouvelle règle = un test dans `test/unit/compose.test.ts`. Les types partagés avec le front sont dans `shared/schemas/analysis.ts`.
- Une valeur de variable secrète ne doit jamais apparaître dans le Compose final, le diff, la base ou les logs (ajouter au `Redactor` du job).
- Toute demande de déploiement ou d'action passe par `server/services/deploy-requests.ts` (exclusivité par cible, idempotence).
- Appels Portainer longs (stack, arrêt, redémarrage) : délai dédié (`LONG_MS`), jamais le délai court par défaut.
- GitHub : toujours via `server/lib/github.ts` (API autorisées, redirections contrôlées). Ne jamais construire d'URL GitHub à partir d'une saisie utilisateur ailleurs. Le token GitHub ne sort jamais du serveur.
- Labels Traefik : uniquement générés par l'analyse à partir des expositions de la cible. Domaines : `shared/utils/domains.ts`.
- Stack de dev : l'image `sherpa:dev` se reconstruit via `docker compose -f compose.dev.yml build migrate` (ou `npm run stack:up`).
- Authentification : `server/auth/*` (sessions, OIDC, mots de passe, débit). Ne jamais rattacher un compte SSO à un compte local existant.
- Toute route modifiante est protégée par le jeton CSRF (middleware). Le plugin `00.auth` l'ajoute à tout `fetch` vers `/api/` (donc `$fetch` et `useFetch`). Seul XHR doit joindre `x-csrf-token` lui-même (`useAuth().me.csrfToken`).
- Notifications : `emitNotification()` (`server/services/notifications.ts`) ne lève jamais d'erreur. Un nouvel évènement s'ajoute à `NOTIFICATION_EVENTS` ; un nouveau canal s'ajoute comme adaptateur dans `server/adapters/notifications/`.
- Listes : `requireAnyPermission` puis filtrage par portée (`server/services/access.ts`). Une ressource hors portée renvoie 404.
- Garde-fou du dernier administrateur : `globalAdminUserIds(tx)` à l'intérieur de la transaction.
- Tests avec base : `test/helpers/db.ts` (base `platform_test`, jamais la base de dev).

## Conventions
- Code serveur : imports relatifs explicites. Le worker est bundlé hors Nuxt et n'a pas d'auto-imports.
- Après modification de `server/db/schema.ts` : `npm run db:generate` et commit de la migration.
- Avant de livrer : `npm run lint && npm run typecheck && npm test`.
- Textes UI et messages d'erreur en français.
- Tests de bout en bout : `e2e/*.spec.ts` (Playwright, Chrome installé), importer `test` et `expect` depuis `e2e/fixtures.ts`. Toute boîte de dialogue native, violation CSP, erreur JavaScript ou écart d'hydratation fait échouer le test.
- Dates affichées : toujours via `fmtDateTime` / `fmtTime` (fuseau fixe `DISPLAY_TZ`), jamais `toLocaleString` direct (écarts d'hydratation).
- Secrets de déploiement : toujours en fichiers (`*_FILE`), jamais en variables d'environnement.
- Interface :
  - chaque page commence par `UiPageHeader` (titre, phrase d'explication, icône par nom ou composant Lucide, actions) ;
  - un état vide utilise `UiEmpty` (icône, explication, action) ;
  - icônes : `lucide-vue-next` ;
  - couleurs : uniquement les jetons de `main.css` (thèmes clair et sombre ; choix manuel via `useTheme`).
- Vue en direct (`/containers`) :
  - lecture seule de l'API Docker via Portainer (`server/services/live.ts`, cache partagé de 2 s) ;
  - les valeurs d'environnement ne sont jamais lues ; commandes, logs et healthchecks passent par `redactPatterns`.
- Opération longue côté serveur : `requestProgress(event)` puis `progress.step('Libellé', n, total)` à chaque étape (passer `progress` aux services, `noProgress` par défaut). Côté client, le libellé de l'opération se déclare dans `app/utils/activity.ts`. Le suivi est ensuite automatique.
- Reverse proxies : toute lecture de configuration passe par `server/lib/proxy/` (fonctions pures, testées) et `services/proxy.ts` (lectures Docker). Extraction par liste blanche uniquement : jamais de valeur de configuration brute, d'e-mail ACME, d'identifiant ou de variable d'environnement renvoyés au client.
- Reprise de l'existant : le nom de stack d'une cible reprise est conservé (`target.stackName` → `AnalyzeContext.stackName`). Ne jamais le recalculer depuis `<projet>-<env>` pour une cible existante. Les valeurs importées sont des variables secrètes chiffrées, jamais dans le Compose.
- Données de page au rendu serveur : `useFetch` ou `useRequestFetch()` (jamais `$fetch` dans `useAsyncData`, qui perd la session).
- Hôtes joints uniquement par leur agent Portainer (aucun serveur Portainer) : les opérations Docker vivent dans `createDockerOps` (`http.ts`), la version, l'endpoint et les stacks dans `agent.ts`. Ne jamais transmettre l'environnement de la console à `docker compose`.
- Dossiers d'un projet : toujours via `projectLayout(paths, slug, target.projectPath)` (analyse, extraction, purge) ; ne jamais recomposer `<runtimeRoot>/<projet>` à la main.
