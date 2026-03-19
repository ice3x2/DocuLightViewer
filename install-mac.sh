#!/usr/bin/env bash
# DocuLight Viewer — macOS installer / updater
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/ice3x2/DocuLightViewer/main/install-mac.sh | bash
#
# Downloads the latest ZIP release from GitHub, installs to /Applications,
# and strips quarantine attributes so Gatekeeper does not block the unsigned app.

set -euo pipefail

readonly APP_NAME="DocuLight"
readonly REPO="ice3x2/DocuLightViewer"
readonly INSTALL_DIR="/Applications"
readonly APP_PATH="${INSTALL_DIR}/${APP_NAME}.app"

# ── Colors ───────────────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; RED=$'\033[0;31m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
else
  GREEN=''; YELLOW=''; RED=''; BOLD=''; RESET=''
fi

info()  { printf "${GREEN}[INFO]${RESET}  %s\n" "$*"; }
warn()  { printf "${YELLOW}[WARN]${RESET}  %s\n" "$*"; }
error() { printf "${RED}[ERROR]${RESET} %s\n" "$*" >&2; }
die()   { error "$*"; exit 1; }

# ── Detect architecture ─────────────────────────────────────────────────────
detect_arch() {
  local machine
  machine="$(uname -m)"
  case "${machine}" in
    arm64|aarch64) echo "arm64" ;;
    x86_64)        echo "x64"   ;;
    *) die "Unsupported architecture: ${machine}" ;;
  esac
}

# ── Fetch latest release tag from GitHub API (no jq dependency) ──────────────
fetch_latest_tag() {
  local api_response
  api_response="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest")" \
    || die "Failed to query GitHub API. Check your network connection."

  local tag
  tag="$(printf '%s' "${api_response}" | grep '"tag_name"' | sed -E 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')" \
    || die "Failed to parse tag_name from GitHub API response."

  [[ -n "${tag}" ]] || die "Could not determine latest release tag."
  echo "${tag}"
}

# ── Read installed version from Info.plist ───────────────────────────────────
get_installed_version() {
  if [[ -d "${APP_PATH}" ]] && [[ -f "${APP_PATH}/Contents/Info.plist" ]]; then
    /usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "${APP_PATH}/Contents/Info.plist" 2>/dev/null || echo ""
  else
    echo ""
  fi
}

# ── Gracefully quit running app ──────────────────────────────────────────────
quit_running_app() {
  if pgrep -x "${APP_NAME}" > /dev/null 2>&1; then
    warn "${APP_NAME} is currently running."
    printf "  Quit and continue installation? [Y/n] "
    read -r answer < /dev/tty || answer=""
    if [[ "${answer}" =~ ^[Nn] ]]; then
      info "Installation cancelled."
      exit 0
    fi

    info "Quitting ${APP_NAME}..."
    osascript -e "tell application \"${APP_NAME}\" to quit" 2>/dev/null || true

    # Wait up to 5 seconds for graceful quit
    local waited=0
    while pgrep -x "${APP_NAME}" > /dev/null 2>&1 && (( waited < 5 )); do
      sleep 1
      (( ++waited ))
    done

    # Force kill if still running
    if pgrep -x "${APP_NAME}" > /dev/null 2>&1; then
      warn "Force killing ${APP_NAME}..."
      pkill -x "${APP_NAME}" 2>/dev/null || true
      sleep 1
    fi
  fi
}

# ── Main ─────────────────────────────────────────────────────────────────────
main() {
  info "DocuLight Viewer installer for macOS"
  echo ""

  # 1. Detect architecture
  local arch
  arch="$(detect_arch)"
  info "Architecture: ${arch}"

  # 2. Fetch latest version
  info "Checking latest release..."
  local tag
  tag="$(fetch_latest_tag)"
  local version="${tag#v}"  # Strip leading 'v'
  info "Latest version: ${BOLD}${version}${RESET}"

  # 3. Check installed version
  local installed
  installed="$(get_installed_version)"
  if [[ -n "${installed}" ]]; then
    info "Installed version: ${installed}"
    if [[ "${installed}" == "${version}" ]]; then
      info "Already up to date (v${version}). Nothing to do."
      exit 0
    fi
    info "Upgrading v${installed} → v${version}"
  else
    info "No existing installation found. Installing fresh."
  fi

  # 4. Quit running app if needed
  quit_running_app

  # 5. Download ZIP
  local zip_name="DocuLight-${version}-${arch}.zip"
  local download_url="https://github.com/${REPO}/releases/download/${tag}/${zip_name}"

  local tmp_dir
  tmp_dir="$(mktemp -d)" || die "Failed to create temp directory."
  trap 'rm -rf "${tmp_dir}"' EXIT

  local zip_path="${tmp_dir}/${zip_name}"
  info "Downloading ${zip_name}..."
  curl -fSL --progress-bar -o "${zip_path}" "${download_url}" \
    || die "Download failed. URL: ${download_url}"

  # 6. Install
  info "Installing to ${INSTALL_DIR}/..."

  # Remove existing app
  if [[ -d "${APP_PATH}" ]]; then
    rm -rf "${APP_PATH}" || die "Failed to remove existing ${APP_PATH}. Try: sudo bash install-mac.sh"
  fi

  # Extract with ditto (preserves macOS resource forks and permissions)
  ditto -xk "${zip_path}" "${INSTALL_DIR}" \
    || die "Failed to extract ZIP to ${INSTALL_DIR}."

  # Remove quarantine attributes
  xattr -cr "${APP_PATH}" 2>/dev/null || true

  # 7. Verify installation
  local new_version
  new_version="$(get_installed_version)"
  if [[ -z "${new_version}" ]]; then
    die "Installation failed — ${APP_PATH} not found after extraction."
  fi

  echo ""
  info "${GREEN}${BOLD}Successfully installed DocuLight Viewer v${new_version}${RESET}"
  info "Location: ${APP_PATH}"
  echo ""
  info "To launch: open ${APP_PATH}"
}

main "$@"
