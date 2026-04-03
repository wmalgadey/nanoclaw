#!/bin/bash
# Build the NanoClaw agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR/.."

DATE_TAG="$(date +%Y%m%d-%H%M%S)"

IMAGE_NAME="nanoclaw-agent"
TAG="${1:-$DATE_TAG}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

echo "Generating plugin manifest..."
(cd "$PROJECT_DIR" && npx tsx scripts/generate-plugin-manifest.ts)

# Display what plugins contributed
echo ""
echo "Plugin contributions:"
if [ -f "$SCRIPT_DIR/plugins/binaries.json" ]; then
  BINARIES=$(cat "$SCRIPT_DIR/plugins/binaries.json" | grep -c '"name"' || echo "0")
  if [ "$BINARIES" -gt 0 ]; then
    echo "  Binaries (${BINARIES}):"
    cat "$SCRIPT_DIR/plugins/binaries.json" | grep '"name"' | sed 's/.*"name": "\([^"]*\)".*/    - \1/'
  fi
fi
if [ -f "$SCRIPT_DIR/plugins/directories.json" ]; then
  DIRS=$(cat "$SCRIPT_DIR/plugins/directories.json" | grep -c '/' || echo "0")
  if [ "$DIRS" -gt 0 ]; then
    echo "  Directories (${DIRS}):"
    cat "$SCRIPT_DIR/plugins/directories.json" | grep '/' | sed 's/.*"\([^"]*\)".*/    - \1/'
  fi
fi
if [ "$BINARIES" -eq 0 ] && [ "$DIRS" -eq 0 ]; then
  echo "  (none)"
fi
echo ""

echo "Building NanoClaw agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

TAGS_ARG="-t ${IMAGE_NAME}:${TAG}"
if [ "$TAG" != "latest" ]; then
  TAGS_ARG="-t ${IMAGE_NAME}:latest -t ${IMAGE_NAME}:${TAG}"
fi

SECRET_ARG=""
BUILD_ARG=""

# Load SSH_KEY_PATH from .env if not already set in environment
if [ -z "$SSH_KEY_PATH" ] && [ -f "$SCRIPT_DIR/../.env" ]; then
  SSH_KEY_PATH=$(grep -E '^SSH_KEY_PATH=' "$SCRIPT_DIR/../.env" | cut -d= -f2- | tr -d '"'"'" | head -1)
fi
SSH_KEY="${SSH_KEY_PATH:-}"
if [ -n "$SSH_KEY" ] && [ -f "$SSH_KEY" ]; then
  SSH_KEY_NAME="$(basename "$SSH_KEY")"
  SECRET_ARG="--secret id=ssh_key,src=$SSH_KEY"
  BUILD_ARG="--build-arg SSH_KEY_NAME=$SSH_KEY_NAME"
  echo "SSH key: $SSH_KEY (as $SSH_KEY_NAME)"
elif [ -n "$SSH_KEY_PATH" ]; then
  echo "Warning: SSH key not found at $SSH_KEY_PATH — skipping"
fi

SSH_CONFIG="$HOME/.ssh/config"
if [ -f "$SSH_CONFIG" ]; then
  SECRET_ARG="$SECRET_ARG --secret id=ssh_config,src=$SSH_CONFIG"
  echo "SSH config: $SSH_CONFIG"
fi

export DOCKER_BUILDKIT=1

cd "$SCRIPT_DIR"
${CONTAINER_RUNTIME} build $TAGS_ARG $SECRET_ARG $BUILD_ARG .

# Update CONTAINER_IMAGE in .env so NanoClaw uses this image on next start
ENV_FILE="$SCRIPT_DIR/../.env"
if grep -q '^CONTAINER_IMAGE=' "$ENV_FILE" 2>/dev/null; then
  sed -i "s|^CONTAINER_IMAGE=.*|CONTAINER_IMAGE=${IMAGE_NAME}:${TAG}|" "$ENV_FILE"
else
  echo "CONTAINER_IMAGE=${IMAGE_NAME}:${TAG}" >> "$ENV_FILE"
fi
echo "Updated .env: CONTAINER_IMAGE=${IMAGE_NAME}:${TAG}"

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${CONTAINER_RUNTIME} run -i ${IMAGE_NAME}:${TAG}"
