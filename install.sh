#!/usr/bin/env bash
set -e

REPO="ephor/warpforge"
BIN_NAME="warpforge"
INSTALL_DIR="/usr/local/bin"
CLI_NAME="wf"

# Detect OS
OS=$(uname -s)
ARCH=$(uname -m)

case "$OS" in
  Darwin)
    case "$ARCH" in
      x86_64) TARGET="x86_64-apple-darwin" ;;
      arm64)  TARGET="aarch64-apple-darwin" ;;
      *) echo "Unsupported arch: $ARCH" && exit 1 ;;
    esac
    ;;
  Linux)
    case "$ARCH" in
      x86_64)          TARGET="x86_64-unknown-linux-gnu" ;;
      aarch64 | arm64) TARGET="aarch64-unknown-linux-gnu" ;;
      *) echo "Unsupported arch: $ARCH" && exit 1 ;;
    esac
    ;;
  *)
    echo "Unsupported OS: $OS"
    exit 1
    ;;
esac

# Get latest release version
VERSION=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
  | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"\(.*\)".*/\1/')

if [ -z "$VERSION" ]; then
  echo "Could not determine latest version"
  exit 1
fi

URL="https://github.com/$REPO/releases/download/$VERSION/$BIN_NAME-$TARGET.tar.gz"

echo "Installing warpforge $VERSION ($TARGET)..."

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

curl -fsSL "$URL" | tar xz -C "$TMP"

if [ -w "$INSTALL_DIR" ]; then
  install -m755 "$TMP/$BIN_NAME" "$INSTALL_DIR/$CLI_NAME"
else
  sudo install -m755 "$TMP/$BIN_NAME" "$INSTALL_DIR/$CLI_NAME"
fi

echo "Installed: $(which $CLI_NAME)"
echo "Run: wf"
