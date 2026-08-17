#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_NAME="$(basename "$PROJECT_DIR")"
BUILD_DIR="$PROJECT_DIR/builds"
ZIP_PATH="$BUILD_DIR/$PROJECT_NAME.zip"

mkdir -p "$BUILD_DIR"
rm -f "$ZIP_PATH"

cd "$PROJECT_DIR"
zip -r "$ZIP_PATH" . \
  -x "debug-htmls/*" \
  -x "plans/*" \
  -x "builds/*" \
  -x ".git/*" \
  -x ".DS_Store"

echo "Built: $ZIP_PATH"
