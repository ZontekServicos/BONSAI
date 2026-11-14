FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN npm install --global pnpm@10.34.3
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
ARG VITE_API_URL
ENV VITE_API_URL=$VITE_API_URL
RUN pnpm build && pnpm prune --prod

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production SERVE_WEB=true
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/database ./database
USER node
EXPOSE 3001
CMD ["node", "apps/api/dist/server.js"]
