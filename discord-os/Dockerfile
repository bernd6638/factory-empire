# Discord OS – Produktions-Image (Bot + API + Dashboard)
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
COPY server/prisma server/prisma
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev && npx prisma generate --schema server/prisma/schema.prisma

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache openssl tini
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/package.json ./server/
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/prisma ./server/prisma
COPY --from=build /app/web/dist ./web/dist
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s CMD wget -qO- http://127.0.0.1:3001/api/meta/health || exit 1
WORKDIR /app/server
ENTRYPOINT ["/sbin/tini", "--"]
# Migrationen anwenden, dann Bot + API starten
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
