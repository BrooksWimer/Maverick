#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="maverick"
SERVICE_USER="maverick"
SERVICE_GROUP="maverick"
APP_DIR="/srv/maverick/app"
NETWISE_DIR="/srv/maverick/repos/netwise"
SYNCSONIC_DIR="/srv/maverick/repos/syncsonic"
STATE_DIR="/var/lib/maverick"
ENV_TARGET="/etc/maverick/maverick.env"
ENV_SOURCE=""
GITHUB_PRIVATE_KEY_SOURCE=""
GITHUB_PUBLIC_KEY_SOURCE=""
MAVERICK_BRANCH="main"
NETWISE_BRANCH="master"
SYNCSONIC_BRANCH="pi-stable-baseline-2026-04-05"
MAVERICK_REPO_URL=""
NETWISE_REPO_URL=""
SYNCSONIC_REPO_URL=""

log() {
  printf '[maverick-bootstrap] %s\n' "$*"
}

usage() {
  cat <<'EOF'
Usage:
  bootstrap-linux-server.sh --maverick-repo <url> --netwise-repo <url> --syncsonic-repo <url> [options]

Options:
  --maverick-branch <branch>    Default: main
  --netwise-branch <branch>     Default: master
  --syncsonic-branch <branch>   Default: pi-stable-baseline-2026-04-05
  --app-dir <path>              Default: /srv/maverick/app
  --netwise-dir <path>          Default: /srv/maverick/repos/netwise
  --syncsonic-dir <path>        Default: /srv/maverick/repos/syncsonic
  --state-dir <path>            Default: /var/lib/maverick
  --env-file <path>             Optional pre-rendered env file to install
  --service-name <name>         Default: maverick
  --github-private-key <path>   Optional SSH private key to install for GitHub access
  --github-public-key <path>    Optional SSH public key to install for GitHub access
EOF
}

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    echo "Run this script as root (for example via sudo)." >&2
    exit 1
  fi
}

run_as_service_user() {
  sudo -u "${SERVICE_USER}" -H -- "$@"
}

upsert_env_var() {
  local key="$1"
  local value="$2"

  if grep -q "^${key}=" "${ENV_TARGET}" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${value}|" "${ENV_TARGET}"
  else
    printf '%s=%s\n' "${key}" "${value}" >> "${ENV_TARGET}"
  fi
}

ensure_apt_packages() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y ca-certificates curl git build-essential python3 make g++ sqlite3 rsync openssh-client golang-go libpcap-dev
}

ensure_node20() {
  local node_major=""
  if command -v node >/dev/null 2>&1; then
    node_major="$(node -p 'process.versions.node.split(".")[0]')"
  fi

  if [[ -n "${node_major}" && "${node_major}" -ge 20 ]]; then
    log "Node.js ${node_major} already available"
    return
  fi

  log "Installing Node.js 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
}

ensure_codex() {
  log "Installing Codex globally"
  npm install -g @openai/codex
}

ensure_service_account() {
  if ! getent group "${SERVICE_GROUP}" >/dev/null 2>&1; then
    groupadd --system "${SERVICE_GROUP}"
  fi

  if ! id -u "${SERVICE_USER}" >/dev/null 2>&1; then
    useradd \
      --system \
      --gid "${SERVICE_GROUP}" \
      --home-dir /srv/maverick \
      --create-home \
      --shell /usr/sbin/nologin \
      "${SERVICE_USER}"
  fi
}

ensure_directories() {
  install -d -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" -m 0755 /srv/maverick
  install -d -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" -m 0755 /srv/maverick/repos
  install -d -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" -m 0755 "$(dirname "${APP_DIR}")"
  install -d -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" -m 0755 "$(dirname "${NETWISE_DIR}")"
  install -d -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" -m 0755 "$(dirname "${SYNCSONIC_DIR}")"
  install -d -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" -m 0755 "${STATE_DIR}"
  install -d -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" -m 0755 "${STATE_DIR}/daily-briefs"
  install -d -o root -g "${SERVICE_GROUP}" -m 0750 /etc/maverick
}

ensure_service_user_known_host() {
  local host="$1"
  local ssh_dir="/srv/maverick/.ssh"
  local known_hosts="${ssh_dir}/known_hosts"

  install -d -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" -m 0700 "${ssh_dir}"
  touch "${known_hosts}"
  chown "${SERVICE_USER}:${SERVICE_GROUP}" "${known_hosts}"
  chmod 0600 "${known_hosts}"

  if run_as_service_user ssh-keygen -F "${host}" -f "${known_hosts}" >/dev/null 2>&1; then
    return
  fi

  ssh-keyscan -H "${host}" >> "${known_hosts}"
  chown "${SERVICE_USER}:${SERVICE_GROUP}" "${known_hosts}"
  chmod 0600 "${known_hosts}"
}

install_service_user_git_auth() {
  local ssh_dir="/srv/maverick/.ssh"
  local private_key_target="${ssh_dir}/id_ed25519"
  local public_key_target="${ssh_dir}/id_ed25519.pub"
  local ssh_config_target="${ssh_dir}/config"

  install -d -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" -m 0700 "${ssh_dir}"

  if [[ -n "${GITHUB_PRIVATE_KEY_SOURCE}" ]]; then
    install -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" -m 0600 "${GITHUB_PRIVATE_KEY_SOURCE}" "${private_key_target}"
  fi

  if [[ -n "${GITHUB_PUBLIC_KEY_SOURCE}" && -f "${GITHUB_PUBLIC_KEY_SOURCE}" ]]; then
    install -o "${SERVICE_USER}" -g "${SERVICE_GROUP}" -m 0644 "${GITHUB_PUBLIC_KEY_SOURCE}" "${public_key_target}"
  fi

  if [[ -f "${private_key_target}" ]]; then
    cat > "${ssh_config_target}" <<EOF
Host github.com
  HostName github.com
  User git
  IdentityFile ${private_key_target}
  IdentitiesOnly yes
EOF
    chown "${SERVICE_USER}:${SERVICE_GROUP}" "${ssh_config_target}"
    chmod 0600 "${ssh_config_target}"
  fi
}

clone_or_update_repo() {
  local repo_url="$1"
  local branch="$2"
  local target_path="$3"

  if [[ -d "${target_path}/.git" ]]; then
    log "Updating $(basename "${target_path}")"
    run_as_service_user git -C "${target_path}" -c safe.directory="${target_path}" fetch --all --prune
    run_as_service_user git -C "${target_path}" -c safe.directory="${target_path}" checkout "${branch}"
    run_as_service_user git -C "${target_path}" -c safe.directory="${target_path}" pull --ff-only origin "${branch}"
    return
  fi

  log "Cloning ${repo_url} into ${target_path}"
  run_as_service_user git clone --branch "${branch}" "${repo_url}" "${target_path}"
}

resolve_codex_js_path() {
  local npm_root
  npm_root="$(npm root -g)"
  local candidate="${npm_root}/@openai/codex/bin/codex.js"

  if [[ -f "${candidate}" ]]; then
    printf '%s\n' "${candidate}"
    return
  fi

  echo "Could not resolve codex.js after global install." >&2
  exit 1
}

install_env_file() {
  if [[ -n "${ENV_SOURCE}" ]]; then
    log "Installing env file from ${ENV_SOURCE}"
    install -o root -g "${SERVICE_GROUP}" -m 0640 "${ENV_SOURCE}" "${ENV_TARGET}"
  elif [[ ! -f "${ENV_TARGET}" ]]; then
    log "Installing example env file"
    install -o root -g "${SERVICE_GROUP}" -m 0640 \
      "${APP_DIR}/deploy/linux/maverick.env.example" \
      "${ENV_TARGET}"
  fi

  upsert_env_var "NODE_ENV" "production"
  upsert_env_var "STATE_BACKEND" "sqlite"
  upsert_env_var "DATABASE_PATH" "${STATE_DIR}/orchestrator.db"
  upsert_env_var "HTTP_PORT" "3847"
  upsert_env_var "CODEX_NODE_PATH" "$(command -v node)"
  upsert_env_var "CODEX_JS_PATH" "$(resolve_codex_js_path)"
}

install_service_unit() {
  log "Installing systemd service unit"
  install -o root -g root -m 0644 \
    "${APP_DIR}/deploy/systemd/maverick.service" \
    "/etc/systemd/system/${SERVICE_NAME}.service"
  systemctl daemon-reload
  systemctl enable "${SERVICE_NAME}"
  systemctl stop "${SERVICE_NAME}" >/dev/null 2>&1 || true
}

build_maverick() {
  log "Installing Maverick dependencies"
  run_as_service_user npm --prefix "${APP_DIR}" ci --include=dev
  log "Building Maverick"
  run_as_service_user npm --prefix "${APP_DIR}" run build
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --maverick-repo)
      MAVERICK_REPO_URL="$2"
      shift 2
      ;;
    --netwise-repo)
      NETWISE_REPO_URL="$2"
      shift 2
      ;;
    --syncsonic-repo)
      SYNCSONIC_REPO_URL="$2"
      shift 2
      ;;
    --maverick-branch)
      MAVERICK_BRANCH="$2"
      shift 2
      ;;
    --netwise-branch)
      NETWISE_BRANCH="$2"
      shift 2
      ;;
    --syncsonic-branch)
      SYNCSONIC_BRANCH="$2"
      shift 2
      ;;
    --app-dir)
      APP_DIR="$2"
      shift 2
      ;;
    --netwise-dir)
      NETWISE_DIR="$2"
      shift 2
      ;;
    --syncsonic-dir)
      SYNCSONIC_DIR="$2"
      shift 2
      ;;
    --state-dir)
      STATE_DIR="$2"
      shift 2
      ;;
    --env-file)
      ENV_SOURCE="$2"
      shift 2
      ;;
    --service-name)
      SERVICE_NAME="$2"
      shift 2
      ;;
    --github-private-key)
      GITHUB_PRIVATE_KEY_SOURCE="$2"
      shift 2
      ;;
    --github-public-key)
      GITHUB_PUBLIC_KEY_SOURCE="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

require_root

if [[ -z "${MAVERICK_REPO_URL}" || -z "${NETWISE_REPO_URL}" || -z "${SYNCSONIC_REPO_URL}" ]]; then
  echo "All repo URLs are required." >&2
  usage
  exit 1
fi

log "Preparing Linux host for Maverick"
ensure_apt_packages
ensure_node20
ensure_codex
ensure_service_account
ensure_directories
install_service_user_git_auth
ensure_service_user_known_host "github.com"
clone_or_update_repo "${MAVERICK_REPO_URL}" "${MAVERICK_BRANCH}" "${APP_DIR}"
clone_or_update_repo "${NETWISE_REPO_URL}" "${NETWISE_BRANCH}" "${NETWISE_DIR}"
clone_or_update_repo "${SYNCSONIC_REPO_URL}" "${SYNCSONIC_BRANCH}" "${SYNCSONIC_DIR}"
build_maverick
install_env_file
install_service_unit

log "Bootstrap complete"
log "Next step: sync the SQLite state, then start ${SERVICE_NAME} with systemctl."
