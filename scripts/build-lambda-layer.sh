#!/bin/bash
set -euo pipefail

# Build a Lambda Layer zip containing dd-trace-js and the datadog_wrapper script.
#
# Usage:
#   ./scripts/build-lambda-layer.sh [output_path]
#
# The resulting zip can be published as an AWS Lambda Layer.
# Users set AWS_LAMBDA_EXEC_WRAPPER=/opt/datadog_wrapper to enable auto-instrumentation.
#
# Layer structure on disk at /opt/:
#   /opt/
#     datadog_wrapper              # Shell script entry point
#     nodejs/
#       node_modules/
#         dd-trace/                # Full dd-trace package
#           init.js
#           ...

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTPUT_PATH="${1:-$REPO_ROOT/lambda-layer.zip}"
BUILD_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$BUILD_DIR"
}
trap cleanup EXIT

echo "==> Building Lambda layer..."
echo "    Repo root: $REPO_ROOT"
echo "    Output:    $OUTPUT_PATH"

# 1. Create layer directory structure
LAYER_DIR="$BUILD_DIR/layer"
mkdir -p "$LAYER_DIR/nodejs/node_modules"

# 2. Pack dd-trace
echo "==> Packing dd-trace..."
PACK_FILE=$(cd "$REPO_ROOT" && npm pack --pack-destination "$BUILD_DIR" 2>/dev/null | tail -1)
PACK_PATH="$BUILD_DIR/$PACK_FILE"

# 3. Extract into the layer
echo "==> Extracting dd-trace into layer..."
mkdir -p "$LAYER_DIR/nodejs/node_modules/dd-trace"
tar xzf "$PACK_PATH" -C "$LAYER_DIR/nodejs/node_modules/dd-trace" --strip-components=1

# 4. Install production dependencies
echo "==> Installing production dependencies..."
cd "$LAYER_DIR/nodejs/node_modules/dd-trace"
npm install --omit=dev --ignore-scripts 2>/dev/null

# 5. Copy the wrapper script
echo "==> Adding datadog_wrapper script..."
cp "$REPO_ROOT/lambda-layer/datadog_wrapper" "$LAYER_DIR/datadog_wrapper"
chmod +x "$LAYER_DIR/datadog_wrapper"

# 6. Create the zip
echo "==> Creating zip..."
cd "$LAYER_DIR"
zip -r -q "$OUTPUT_PATH" .

LAYER_SIZE=$(du -sh "$OUTPUT_PATH" | cut -f1)
echo "==> Lambda layer built successfully: $OUTPUT_PATH ($LAYER_SIZE)"
echo ""
echo "To publish:"
echo "  aws lambda publish-layer-version \\"
echo "    --layer-name datadog-node \\"
echo "    --zip-file fileb://$OUTPUT_PATH \\"
echo "    --compatible-runtimes nodejs18.x nodejs20.x nodejs22.x"
echo ""
echo "To use:"
echo "  Set AWS_LAMBDA_EXEC_WRAPPER=/opt/datadog_wrapper on your Lambda function"
