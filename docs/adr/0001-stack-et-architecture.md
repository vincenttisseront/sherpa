# ADR 0001 — Stack et découpage des processus

Date : 2026-10-08 · Statut : accepté

## Contexte
Le cahier des charges impose Nuxt, TypeScript, PostgreSQL, Redis et Docker, et recommande Nuxt 3.

## Décisions
1. **Nuxt 4** plutôt que Nuxt 3. Nuxt 4 est la version stable courante : la séparation `app/` / `server/` / `shared/` correspond à la séparation front/back exigée, et Nuxt 3 arrive en fin de maintenance.
2. **Drizzle ORM** plutôt que Prisma : schéma TypeScript sans générateur binaire, SQL explicite, migrations SQL versionnées et relisibles.
3. **Worker séparé** (même image, autre commande), bundlé avec esbuild. Les builds longs ne bloquent pas l'API, et le worker se met à l'échelle indépendamment.
4. **Configuration par variables d'environnement validées par Zod** (`server/utils/env.ts`), partagée par Nitro et le worker, plutôt que `runtimeConfig` Nuxt, qui n'existe pas dans le worker.
5. **Adaptateurs derrière des interfaces** (Portainer, Runner, notifications), sélectionnés par configuration. Les mocks permettent de développer sans infrastructure.
6. **SSO via un seul client OIDC générique**. Keycloak et Okta ne diffèrent que par leur configuration (issuer, claim des groupes).
