# The API ships as its esbuild bundle rather than as a source tree.
#
# It depends on @microphi/di, @microphi/debug and @microgamma/apigator through
# `file:` paths into sibling checkouts, which exist on a development machine and
# nowhere else. esbuild inlines all three, so what reaches the server is one
# file plus Express, which is the only dependency left external.
FROM node:22-alpine

WORKDIR /app

RUN npm install --omit=dev --no-fund --no-audit express@^5.2.1 \
    && npm cache clean --force

COPY dist/main.js ./main.js

ENV NODE_ENV=production
EXPOSE 4319
USER node

CMD ["node", "main.js"]
