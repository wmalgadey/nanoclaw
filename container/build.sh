#!/bin/bash
# Build the NanoClaw agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

DATE_TAG="$(date +%Y%m%d-%H%M%S)"

IMAGE_NAME="nanoclaw-agent"
TAG="${1:-$DATE_TAG}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

echo "Building NanoClaw agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

TAGS_ARG="-t ${IMAGE_NAME}:${TAG}"
if [ "$TAG" != "latest" ]; then
  TAGS_ARG="-t ${IMAGE_NAME}:latest -t ${IMAGE_NAME}:${TAG}"
fi

${CONTAINER_RUNTIME} build $TAGS_ARG .

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
