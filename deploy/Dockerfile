# One image for every Hushd service; SERVICE picks which one runs.
# Node 24: the NEAR AI intake verifies attestations with @nearai/inference-sdk (Node >= 24.22).
FROM node:24.22.2-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1
RUN corepack enable
WORKDIR /repo

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/sdk/package.json packages/sdk/
COPY packages/protocol/package.json packages/protocol/
COPY services/package.json services/
RUN pnpm install --frozen-lockfile --filter "@hushd/services..."

FROM base
RUN groupadd -r hushd && useradd -r -g hushd -d /repo hushd
COPY --from=deps /repo /repo
COPY packages/sdk packages/sdk
COPY packages/protocol packages/protocol
COPY services services
# The relayer verifies with the vkeys; makers prove their swap legs with joinsplit.
COPY app/public/circuits/manifest.json app/public/circuits/*.vkey.json app/public/circuits/joinsplit.wasm app/public/circuits/joinsplit.zkey app/public/circuits/
RUN mkdir -p /data && chown hushd:hushd /data
USER hushd
WORKDIR /repo/services
ENV NODE_ENV=production MAKERS_DATA_DIR=/data/makers
CMD ["node", "--import", "tsx", "src/main.ts"]
