FROM node:20-slim AS client-deps
WORKDIR /app/client
COPY client/package.json ./
RUN npm install

FROM client-deps AS client-build
COPY client/ ./
RUN npm run build

FROM client-deps AS client-test
COPY client/ ./
CMD ["npm", "test"]

FROM node:20-slim AS server-deps
WORKDIR /app/server
COPY server/package.json ./
RUN npm install --omit=dev

FROM node:20-slim AS server-test
WORKDIR /app/server
COPY server/package.json ./
RUN npm install
COPY server/ ./
# Second pass re-runs the whole contract on the libsql driver; capped workers +
# raised timeout because two native sqlite stacks contend under full parallelism.
CMD ["sh", "-c", "npm test && DB_DRIVER=libsql npx vitest run --testTimeout=20000 --maxWorkers=4"]

FROM node:20-slim AS runtime
ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    STATIC_DIR=/app/public \
    PORT=3000
WORKDIR /app/server
COPY --from=server-deps /app/server/node_modules ./node_modules
COPY server/package.json ./
COPY server/src ./src
COPY --from=client-build /app/client/dist /app/public
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
EXPOSE 3000
CMD ["node", "src/index.js"]
