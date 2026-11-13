# One image for production: the API also serves the built frontend, so the
# site and the API share one origin (session cookie, no CORS).
FROM node:20-bookworm-slim

# Chromium renders the PDFs (Puppeteer); fonts so documents don't fall back to
# a blank font; OpenSSL for Prisma; python3/make/g++ to compile argon2.
# postgresql-client-16 (from the PostgreSQL apt repo, because Debian's own is older
# than the Postgres 16 server) provides pg_dump for the nightly backup job. Keep its
# major version equal to the database server's.
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium fonts-liberation openssl ca-certificates python3 make g++ curl gnupg \
  && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /usr/share/keyrings/pgdg.gpg \
  && echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client-16 \
  && apt-get purge -y curl gnupg && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/schemas/package.json packages/schemas/
COPY backend/package.json backend/
COPY frontend/package.json frontend/
# Dev dependencies are needed to build, and the Prisma CLI runs migrations at start.
RUN npm ci --include=dev

COPY . .
RUN npm run prisma:generate --workspace backend \
  && npm run build --workspace @clinic/schemas \
  && npm run build --workspace @clinic/backend \
  && npm run build --workspace @clinic/frontend

ENV NODE_ENV=production PORT=4000
EXPOSE 4000
USER node
CMD ["sh", "-c", "npm run prisma:migrate:deploy --workspace backend && node backend/dist/index.js"]
