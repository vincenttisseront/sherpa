# syntax=docker/dockerfile:1.7
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
# CA d'entreprise optionnelle (registry npm interne) : --secret id=npm_ca,src=/chemin/ca.pem
RUN --mount=type=secret,id=npm_ca,required=false \
    if [ -f /run/secrets/npm_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca; fi; \
    npm ci --ignore-scripts
COPY . .
RUN npx nuxt prepare && npm run build && npm run build:worker

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=npm_ca,required=false \
    if [ -f /run/secrets/npm_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca; fi; \
    npm ci --omit=dev --ignore-scripts

FROM node:24-alpine
ENV NODE_ENV=production
# Révision des sources (commit), affichée dans les journaux de déploiement.
ARG APP_REVISION=dev
ENV APP_REVISION=$APP_REVISION
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/.output ./.output
COPY --from=build /app/dist ./dist
COPY --from=build /app/server/db/migrations ./dist/migrations
COPY package.json ./
# CLI Docker et plugin Compose : stacks déployées directement sur les agents Portainer
# (la console y joue le rôle du serveur Portainer, à travers un relais signé).
COPY --from=docker:29-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker:29-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
ENV MIGRATIONS_DIR=/app/dist/migrations
RUN mkdir -p /var/lib/platform/uploads && chown node:node /var/lib/platform/uploads
USER node
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
