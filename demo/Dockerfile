# Directus 12 demo with the Supertext extension built from this repository.
# Build context: repository root.
FROM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY vendor ./vendor
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npx directus-extension build

FROM directus/directus:12.7.0@sha256:f197911d949a37d882f781b0381955b851c86625435014cd67bdaf3eabcff2a7
USER root
COPY --from=build /src/dist /directus/extensions/directus-extension-supertext-translation/dist
COPY package.json /directus/extensions/directus-extension-supertext-translation/package.json
COPY demo/extensions/directus-extension-demo-setup /directus/extensions/directus-extension-demo-setup
COPY demo/docker/start.cjs /directus/demo-start.cjs
RUN chown -R node:node /directus/extensions
USER node
CMD ["node", "/directus/demo-start.cjs"]
# Variables: see demo/.env.example. The image's own command bootstraps the database
# and starts Directus; the demo setup hook adds languages, content and accounts.
