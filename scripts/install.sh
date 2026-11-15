#!/usr/bin/env bash
# Luculent Browser Driver - Automated Zero-Dependency Installer for macOS and Linux
# Usage: curl -fsSL https://raw.githubusercontent.com/LuculentTechnology/luculent-browser-driver/main/scripts/install.sh | bash

set -euo pipefail

echo -e "\033[36m=== Luculent Browser Driver Auto-Installer ===\033[0m"
echo "Setting up local relay for AI agents (Claude, Cursor, Codex, Gemini)..."

INSTALL_DIR="$HOME/.luculent/browser-driver"
BIN_DIR="$HOME/.luculent/bin"
RUNTIME_DIR="$HOME/.luculent/runtime"

mkdir -p "$INSTALL_DIR" "$BIN_DIR" "$RUNTIME_DIR"

# 1. Check or Auto-Install Node Runtime
NODE_BIN=""

if command -v node >/dev/null 2>&1; then
    NODE_VER=$(node -v | sed 's/^v//' | cut -d'.' -f1)
    if [ "$NODE_VER" -ge 20 ]; then
        NODE_BIN=$(command -v node)
        echo -e "\033[32m✓ Detected existing Node.js $(node -v) ($NODE_BIN)\033[0m"
    fi
fi

if [ -z "$NODE_BIN" ] && [ -f "$RUNTIME_DIR/bin/node" ]; then
    NODE_BIN="$RUNTIME_DIR/bin/node"
    echo -e "\033[32m✓ Detected portable Node runtime in $RUNTIME_DIR\033[0m"
fi

if [ -z "$NODE_BIN" ]; then
    echo -e "\033[33m→ Node 20+ not detected in system. Auto-installing portable runtime...\033[0m"
    OS=$(uname -s | tr '[:upper:]' '[:lower:]')
    ARCH=$(uname -m)
    case "$ARCH" in
        x86_64) ARCH="x64" ;;
        aarch64|arm64) ARCH="arm64" ;;
        *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
    esac
    case "$OS" in
        darwin) OS="darwin" ;;
        linux) OS="linux" ;;
        *) echo "Unsupported OS: $OS"; exit 1 ;;
    esac

    NODE_VERSION="v22.11.0"
    TAR_NAME="node-$NODE_VERSION-$OS-$ARCH.tar.xz"
    URL="https://nodejs.org/dist/$NODE_VERSION/$TAR_NAME"
    TMP_DIR=$(mktemp -d)

    echo "  Downloading portable Node runtime ($NODE_VERSION $OS-$ARCH)..."
    curl -fsSL "$URL" -o "$TMP_DIR/$TAR_NAME"

    echo "  Extracting runtime to $RUNTIME_DIR..."
    tar -xJf "$TMP_DIR/$TAR_NAME" -C "$TMP_DIR"
    EXTRACTED=$(find "$TMP_DIR" -mindepth 1 -maxdepth 1 -type d | head -n 1)
    cp -R "$EXTRACTED/"* "$RUNTIME_DIR/"
    rm -rf "$TMP_DIR"

    NODE_BIN="$RUNTIME_DIR/bin/node"
    echo -e "\033[32m✓ Portable Node runtime auto-installed successfully.\033[0m"
fi

# 2. Stage/Sync Driver Files
echo "→ Synchronizing Luculent Browser Driver relay..."
TMP_REPO=$(mktemp -d)
curl -fsSL "https://github.com/LuculentTechnology/luculent-browser-driver/archive/refs/heads/main.tar.gz" -o "$TMP_REPO/repo.tar.gz"
tar -xzf "$TMP_REPO/repo.tar.gz" -C "$TMP_REPO"
SRC_ROOT=$(find "$TMP_REPO" -mindepth 1 -maxdepth 1 -type d | head -n 1)
cp -R "$SRC_ROOT/"* "$INSTALL_DIR/"
rm -rf "$TMP_REPO"

# 3. Create Global 'lbd' CLI Wrapper
cat <<EOF > "$BIN_DIR/lbd"
#!/usr/bin/env bash
export PATH="$RUNTIME_DIR/bin:\$PATH"
exec "$NODE_BIN" "$INSTALL_DIR/src/cli.mjs" "\$@"
EOF
chmod +x "$BIN_DIR/lbd"

# Add to PATH in shell profile if needed
PROFILE_FILE=""
if [ -f "$HOME/.zshrc" ]; then
    PROFILE_FILE="$HOME/.zshrc"
elif [ -f "$HOME/.bashrc" ]; then
    PROFILE_FILE="$HOME/.bashrc"
fi

if [ -n "$PROFILE_FILE" ] && ! grep -q "$BIN_DIR" "$PROFILE_FILE" 2>/dev/null; then
    echo "export PATH=\"$BIN_DIR:\$PATH\"" >> "$PROFILE_FILE"
    echo -e "\033[32m✓ Added $BIN_DIR to $PROFILE_FILE.\033[0m"
fi

# 4. Mint Initial API Key
echo "→ Minting your agent API key..."
"$NODE_BIN" "$INSTALL_DIR/src/cli.mjs" keys mint --name default-agent

echo -e "\n\033[32m=== Installation Complete! ===\033[0m"
echo "1. Install the extension in Chrome: https://luculent.dev/beta (or Chrome Web Store)"
echo "2. Start the relay: lbd start"
echo "3. Connect your AI agent (Claude Desktop, Cursor, Codex, Gemini) using http://127.0.0.1:47800/mcp"
