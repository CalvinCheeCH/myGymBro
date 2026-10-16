# ── Build stage ────────────────────────────────────────────────────────
# Debian 13 (trixie) base: glibc (needed for onnxruntime and the SDK's native
# binary) and a shell (the agent runs bash/git), with a much smaller CVE surface
# than the bookworm-based slim images.
FROM node:24-trixie-slim AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

# Prune dev dependencies for the runtime image
RUN npm prune --production

# Strip the musl variant of the SDK's native binary. node:22-slim is Debian glibc,
# but npm installs both linux-x64 and linux-x64-musl optional deps, and the SDK's
# runtime discovery tries musl FIRST. Leaving the musl dir present causes the SDK
# to spawn a musl binary on glibc, which fails with ENOENT from the dynamic linker.
RUN rm -rf node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl

# ── Runtime stage ─────────────────────────────────────────────────────
FROM node:24-trixie-slim
WORKDIR /app

# git and ca-certificates are needed by the SDK and for any npx fetches.
RUN apt-get update && apt-get upgrade -y && \
    apt-get install -y --no-install-recommends ca-certificates git && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Copy built application (no dev deps, no source)
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./

# Copy project files. CLAUDE.md and the plugin are made read-only so the agent
# cannot rewrite its own persona or skills at runtime.
COPY CLAUDE.md ./
COPY coach-plugin/ ./coach-plugin/
RUN chmod 444 CLAUDE.md && chmod -R 555 coach-plugin/

# Bundled CLIs the agent runs via Bash (Notion helper, workspace builder, exercise
# lookup) and the docs some skills reference. Read-only at runtime; state files
# default to /data, not here.
COPY scripts/ ./scripts/
COPY docs/ ./docs/
RUN chmod -R 555 scripts/ docs/

# knowledge/ keeps its seeded README plus agent-appended import drops; writable.
COPY knowledge/ ./knowledge/

COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

# Editable profile files live directly on the mounted volume so profile edits,
# learned logging style, and /create personas survive container recreation. The
# links dangle harmlessly (agent treats them as missing) while the volume has no
# copy; the tool sandboxrecognises the fixed /data targets and nothing else.
RUN ln -sf /data/PERSONAL.md /app/PERSONAL.md && \
    ln -sf /data/LOGGING_STYLE.md /app/LOGGING_STYLE.md && \
    ln -sf /data/PERSONAS.md /app/PERSONAS.md

# Claude SDK conversation transcripts are agent state too; keep them on the volume.
ENV HOME=/data

# /data is the mountpoint for the persistent volume (sessions, schedule, history,
# persona, ledger, run-log, and token files default there via entrypoint.sh).
# The project data/ and knowledge/ folders stay writable for regenerable caches
# and reports instead of failing a brand-new container with EACCES.
RUN chown -R node:node /app/dist /app/node_modules /app/package.json /app/entrypoint.sh /app/knowledge && \
    mkdir -p /app/data /home/node/.claude /data/.claude && \
    chown -R node:node /home/node /data && \
    chown node:node /app/data

USER node

EXPOSE 8080

ENTRYPOINT ["./entrypoint.sh"]
