FROM node:22-bookworm-slim AS build

WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1
ENV NPM_CONFIG_PRODUCTION=false

COPY package*.json ./
COPY server/package*.json server/
COPY apps/web/package*.json apps/web/

RUN npm ci --prefix server && npm ci --prefix apps/web

COPY . .

RUN npm run build:server && npm run build:web:static

FROM node:22-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=10000
ENV NEXT_TELEMETRY_DISABLED=1

COPY server/package*.json server/

RUN npm ci --omit=dev --prefix server && npm cache clean --force

COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/public server/public
COPY server/scripts server/scripts

EXPOSE 10000

CMD ["npm", "run", "start", "--prefix", "server"]
