# Section 4 — Container Build Customizations

## Intent

Three independent build enhancements:
1. **DateTime tagging** — each build gets a unique timestamp tag, so rollbacks are easy
2. **Multi-SSH key support** — `SSH_KEY_PATHS` (comma-separated) replaces single `SSH_KEY_PATH`
3. **`--no-cache` flag** — `./container/build.sh --no-cache` forces a full rebuild

Plus: `.env` is auto-updated with the latest `CONTAINER_IMAGE` tag after each build.

## How to apply

### 1. Check v2 container/build.sh first

V2's `container/build.sh` may already have a different structure. Read it
before applying these changes. Apply only what is missing.

```bash
git show upstream/main:container/build.sh | head -50
```

### 2. DateTime tagging

```bash
# In container/build.sh, near the top:
DATE_TAG="$(date +%Y%m%d-%H%M%S)"
# Use DATE_TAG as the image version instead of "latest" for versioned builds
# Build both:
#   nanoclaw-agent:latest  (always updated)
#   nanoclaw-agent:20260412-193045  (the specific build)
TAGS_ARG="-t nanoclaw-agent:latest -t nanoclaw-agent:${DATE_TAG}"
```

### 3. No-cache flag

```bash
# In container/build.sh, parse args:
NO_CACHE_ARG=""
for arg in "$@"; do
  if [ "$arg" = "--no-cache" ]; then
    NO_CACHE_ARG="--no-cache"
  fi
done

# Then in the docker build call:
${CONTAINER_RUNTIME:-docker} build $TAGS_ARG $SECRET_ARG $BUILD_ARG $NO_CACHE_ARG .
```

### 4. Multi-SSH key support

```bash
# In container/build.sh:
# Read SSH_KEY_PATHS from .env (comma-separated list), fallback to SSH_KEY_PATH
SSH_KEY_PATHS_VAR="${SSH_KEY_PATHS:-${SSH_KEY_PATH:-}}"
SECRET_ARG=""
SSH_KEY_NAMES=""

if [ -n "$SSH_KEY_PATHS_VAR" ]; then
  IFS=',' read -ra KEY_PATHS <<< "$SSH_KEY_PATHS_VAR"
  i=0
  for KEY_PATH in "${KEY_PATHS[@]}"; do
    KEY_PATH="${KEY_PATH// /}"  # trim spaces
    if [ -f "$KEY_PATH" ]; then
      SECRET_ARG="$SECRET_ARG --secret id=ssh_key_${i},src=${KEY_PATH}"
      BASENAME=$(basename "$KEY_PATH")
      SSH_KEY_NAMES="${SSH_KEY_NAMES:+${SSH_KEY_NAMES}:}${BASENAME}"
      ((i++))
    fi
  done
fi

# Add SSH config if present
if [ -f "$HOME/.ssh/config" ]; then
  SECRET_ARG="$SECRET_ARG --secret id=ssh_config,src=$HOME/.ssh/config"
fi

BUILD_ARG="--build-arg SSH_KEY_NAMES=${SSH_KEY_NAMES}"
export DOCKER_BUILDKIT=1
```

### 5. In Dockerfile: receive SSH keys via build secrets

```dockerfile
# syntax=docker/dockerfile:1

ARG SSH_KEY_NAMES
RUN --mount=type=secret,id=ssh_key_0 \
    --mount=type=secret,id=ssh_key_1 \
    --mount=type=secret,id=ssh_key_2 \
    --mount=type=secret,id=ssh_key_3 \
    --mount=type=secret,id=ssh_config \
    if [ -n "$SSH_KEY_NAMES" ]; then \
      mkdir -p /home/node/.ssh; \
      IFS=':' read -ra NAMES <<< "$SSH_KEY_NAMES"; \
      i=0; \
      for name in "${NAMES[@]}"; do \
        src="/run/secrets/ssh_key_${i}"; \
        [ -f "$src" ] && cp "$src" "/home/node/.ssh/$name" && chmod 600 "/home/node/.ssh/$name"; \
        ((i++)); \
      done; \
      [ -f /run/secrets/ssh_config ] && cp /run/secrets/ssh_config /home/node/.ssh/config && chmod 600 /home/node/.ssh/config; \
      chown -R node:node /home/node/.ssh; \
    fi
```

**Security note:** Keys are passed via `--mount=type=secret` and are never
stored in image layers. `SSH_KEY_NAMES` is just a list of basenames — no
path information leaves the build host.

### 6. .env auto-update after build

```bash
# In container/build.sh, after successful docker build:
CONTAINER_IMAGE="nanoclaw-agent:${DATE_TAG}"
if grep -q "^CONTAINER_IMAGE=" .env 2>/dev/null; then
  sed -i "s|^CONTAINER_IMAGE=.*|CONTAINER_IMAGE=${CONTAINER_IMAGE}|" .env
else
  echo "CONTAINER_IMAGE=${CONTAINER_IMAGE}" >> .env
fi
echo "Updated .env: CONTAINER_IMAGE=${CONTAINER_IMAGE}"
```

### 7. Plugin manifest generation (from Section 2)

```bash
# In container/build.sh, BEFORE the docker build call:
echo "Generating plugin manifest..."
(cd "$PROJECT_DIR" && npx tsx scripts/generate-plugin-manifest.ts)
```

## .env variables

```bash
# .env additions for this section:
SSH_KEY_PATHS=/home/paranoid/.ssh/id_rsa,/home/paranoid/.ssh/github_key
# CONTAINER_IMAGE is auto-updated by build.sh — do not edit manually
```

## CONTAINER_IMAGE in src/config.ts

V1 added `CONTAINER_IMAGE` support to `src/config.ts` so the host picks up
the versioned image tag automatically after each build:

```typescript
// In src/config.ts, in readEnvFile() or config loading:
export const CONTAINER_IMAGE = process.env.CONTAINER_IMAGE ?? readEnv('CONTAINER_IMAGE') ?? 'nanoclaw-agent:latest';
```

Check whether v2's config already supports `CONTAINER_IMAGE`. If not, add it
and use it in `src/container-runner.ts` as the image name for `docker run`.

## Systemd service: npm build before start

In v1, the systemd service runs `npm run build` before starting the agent.
This ensures TypeScript is always compiled to JS after updates.

If v2 uses a similar service file, add a `ExecStartPre` step:

```ini
# In nanoclaw.service or equivalent:
ExecStartPre=/usr/bin/npm run build
```

Or alternatively run `pnpm build` if v2 uses pnpm.
