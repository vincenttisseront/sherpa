# Sherpa

Console interne pour déployer et administrer des projets Docker sur plusieurs hôtes, joints en SSH (sans rien installer dessus) ou par leur agent Portainer (Docker Standalone d'abord).

Le navigateur ne parle qu'à l'API Nuxt/Nitro. Celle-ci passe par les adaptateurs d'hôte (SSH, agent Portainer) et le Target Runner, jamais par Docker directement.

## Démarrage (développement)

Prérequis : Node 22+, Docker. Une fois pour toutes :

```bash
npm install
cp .env.example .env            # puis renseigner MASTER_KEY (openssl rand -base64 32)
npm run dev:runner-setup        # PKI de dev + racines simulées sous .data/runner-dev
npm run dev:export-ca           # AC interne (registry npm) → .data/ca, pour construire les images
```

**Mode « stack »** : toute la plateforme dans Docker, une seule stack `sherpa-dev` contenant app, worker, Runner, Portainer CE, Traefik, PostgreSQL et Redis.

Connexion : au premier lancement, créer l'administrateur sur `/setup` avec le jeton affiché dans `docker compose -f compose.dev.yml logs app`. Pour tester le SSO, lancer `npm run dev:oidc` (fournisseur OIDC de dev sur `http://oidc.localhost:18400`, comptes `alice`, `bob`, `zoe`).

```bash
npm run stack:up                # https://console.localhost:28443 (APP_URL, via le Traefik géré) ou http://localhost:3100 — Portainer : http://localhost:19000
npm run stack:logs
```

**Mode « développement »** : rechargement à chaud. Seuls PostgreSQL et Redis tournent dans Docker.

```bash
npm run deps:up
npm run db:migrate && npm run db:seed
npm run dev                     # http://localhost:3000
npm run worker                  # second terminal
```

Ne pas faire tourner les deux modes en même temps sur le même port. Avec `PORTAINER_ADAPTER=mock` / `RUNNER_ADAPTER=mock`, les agents et le Runner sont simulés. Dans le mock, un secret contenant `invalid` déclenche une erreur d'authentification, et un secret contenant `timeout` un dépassement de délai.

Dans la stack, les services se joignent par leur nom : agent `https://agent:9001` (secret dans `.data/dev-auth/agent.env`), Runner `https://runner:8443` avec le nom de certificat attendu `localhost`.

## Scripts

| Script | Rôle |
|---|---|
| `npm run dev` | Nuxt en développement |
| `npm run worker` | Worker BullMQ : déploiements, notifications, observation des cibles, purge de rétention |
| `npm run db:generate` | Génère une migration après modification de `server/db/schema.ts` |
| `npm run stack:up` / `stack:down` / `stack:logs` | Plateforme complète dans Docker |
| `npm run db:migrate` / `db:seed` | Applique les migrations / données de référence |
| `npm run test` | Tests unitaires et d'intégration (Vitest, dont un vrai Runner en mTLS) |
| `npm run runner` / `build:runner` | Target Runner en dev / fichier autonome `dist/runner.mjs` |
| `npm run dev:runner-setup` / `dev:demo-deploy` | Runner local avec PKI de dev / déploiement de démonstration |
| `npx tsx scripts/mock-github.ts <port> <org/depot> <répertoire>` | Faux GitHub servant un répertoire local (essais hors ligne, autorisé en dev sur `http://host.docker.internal:18300`) |
| `npm run dev:inbox` | Boîte de réception de développement : SMTP sur le port 1025 et webhook Teams sur `http://localhost:18500/teams` (messages listés sur `GET /`) |
| `npm run test:e2e` | Tests de bout en bout dans Chrome (Playwright) contre la stack de dev, ou contre `E2E_BASE_URL` |
| `scripts/prod-smoke.sh up` / `e2e` / `down` | Essai local de la configuration de production (`docker-compose.yml`) ; `e2e` joue le premier démarrage (assistant d'initialisation) sur l'instance vierge |
| `deploy/backup.sh` / `deploy/restore.sh` | Sauvegarde et restauration de la base |
| `npm run admin:rekey` (`node dist/rekey.mjs`) | Rotation de la clé maîtresse |
| `npm run typecheck` / `lint` | Vérifications statiques |
| `npm run build` + `build:worker` | Build de production |

Les contrats d'API sont publiés en OpenAPI sur `/_openapi.json` (interface Scalar sur `/_scalar`) en développement.

## Documentation

- [Architecture](docs/architecture.md)
- [Exploitation](docs/exploitation.md)
- [Mise en service](docs/mise-en-service.md)
- [Recette](docs/recette.md)
- [Spikes techniques](docs/spikes.md)
- [Installation et exploitation](docs/installation.md)
- [Target Runner](docs/runner.md)
- [Décisions d'architecture (ADR)](docs/adr/)
