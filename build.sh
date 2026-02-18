#!/usr/bin/env bash
# DocuLight Build Script (macOS / Linux)
# Output: dist/

set -e

OS="$(uname -s)"

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "[DocuLight] Installing dependencies..."
    npm install
fi

# Build for current platform
case "$OS" in
    Darwin)
        echo "[DocuLight] Building for macOS..."
        npm run build:mac
        ;;
    Linux)
        echo "[DocuLight] Building for Linux..."
        npm run build:linux
        ;;
    *)
        echo "[DocuLight] Unsupported platform: $OS"
        exit 1
        ;;
esac

echo "[DocuLight] Build complete. Output: dist/"
