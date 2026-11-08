# Directus 12 demo with the Supertext extension built from this repository.
# Build context: repository root.
FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY vendor ./vendor
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npx directus-extension build

FROM directus/directus:12.6.1
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
