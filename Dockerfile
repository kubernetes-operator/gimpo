# syntax=docker/dockerfile:1
# 멀티스테이지: frontend 빌드 → backend 빌드 → 런타임(백엔드가 SPA 정적 서빙)

# ── 1) 의존성 설치 (워크스페이스) ─────────────────────────────
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm install

# ── 2) frontend 빌드 ─────────────────────────────────────────
FROM deps AS build-frontend
WORKDIR /app
COPY frontend/ frontend/
RUN npm -w frontend run build

# ── 3) backend 빌드 ──────────────────────────────────────────
FROM deps AS build-backend
WORKDIR /app
COPY backend/ backend/
RUN npm -w backend run build

# ── 4) 런타임 ────────────────────────────────────────────────
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV VELERO_NAMESPACE=velero
ENV STATIC_DIR=/app/public

# 프로덕션 의존성만
COPY package.json package-lock.json* ./
COPY backend/package.json backend/
RUN npm install --omit=dev -w backend

COPY --from=build-backend /app/backend/dist backend/dist
COPY --from=build-frontend /app/frontend/dist ./public

USER node
EXPOSE 3000
CMD ["node", "backend/dist/server.js"]
