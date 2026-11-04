# Builds the server and web app. This stage has the dev dependencies they need.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY tsconfig.base.json ./
COPY server server
COPY web web
RUN npm run build

# The image that runs: production dependencies and built output only.
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
# typeorm's optional peer on ts-node marks ts-node and typescript as dev-or-optional,
# so npm drops them only when both groups are omitted.
RUN npm ci --omit=dev --omit=optional --workspace @competitor-pulse/server && npm cache clean --force
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
# The stub reads this at startup, relative to server/dist/src/source.
COPY files/fixtures/listings.json files/fixtures/listings.json
USER node
EXPOSE 3000
# node directly, not npm, so the process receives the stop signal.
CMD ["node", "server/dist/src/main.js"]
