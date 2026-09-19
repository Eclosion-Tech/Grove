# syntax=docker/dockerfile:1
# Primary build context: Grove. Named build context "worm": Worm.so.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY . .
RUN npm ci --no-audit --no-fund
RUN npm run build
COPY --from=worm grove-admin/package.json modules/worm/package.json
COPY --from=worm grove-admin/tsconfig.json modules/worm/tsconfig.json
COPY --from=worm grove-admin/src modules/worm/src
RUN ./node_modules/.bin/tsc -p modules/worm/tsconfig.json
RUN npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=4310 GROVE_ADMIN_MODULES=/app/modules/worm/dist/index.js
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/grove/package.json ./packages/grove/package.json
COPY --from=build /app/packages/grove/dist ./packages/grove/dist
COPY --from=build /app/packages/grove/migrations ./packages/grove/migrations
COPY --from=build /app/packages/email-builder/package.json ./packages/email-builder/package.json
COPY --from=build /app/packages/email-builder/dist ./packages/email-builder/dist
COPY --from=build /app/apps/grove/package.json ./apps/grove/package.json
COPY --from=build /app/apps/grove/dist ./apps/grove/dist
COPY --from=build /app/apps/editor/dist ./apps/editor/dist
COPY --from=build /app/apps/example-site/dist ./apps/example-site/dist
COPY --from=build /app/modules/worm/package.json ./modules/worm/package.json
COPY --from=build /app/modules/worm/dist ./modules/worm/dist
USER node
EXPOSE 4310
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "const h=require('node:http');h.get({hostname:'127.0.0.1',port:process.env.PORT, path:'/auth/session',headers:{host:new URL(process.env.GROVE_PUBLIC_URL).host}},r=>{r.resume();process.exit(r.statusCode===401||r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"
CMD ["node", "apps/grove/dist/syntropy-host.js"]
