#!/usr/bin/env bash
#
# Deploy the current commit to the production server.
#
#   preflight (here and on the server) → build images → ship the ones that
#   changed → pull the code on the server → migrations → restart → health check
#
# The server is too small to build images, so they are built on this machine
# and shipped with docker save → rsync (resumable) → docker load. The server
# pulls the same commit from origin, so it must be pushed first. Safe to re-run:
# unchanged images are not shipped again. See README → "Deploy to the server".

set -euo pipefail
cd "$(dirname "$0")/.."

usage() {
  cat <<'EOF'
Usage: scripts/deploy.sh [options]

  --host=NAME    SSH host of the server (default: $DEPLOY_HOST, else Paris)
  --dir=PATH     The checkout on the server
                 (default: $DEPLOY_DIR, else /root/ngsl_telegram_bot)
  --aligner      Also build, ship and restart the aligner (about 2 GB)
  --no-build     Ship the images already built instead of rebuilding
  --check        Run the preflight checks only, change nothing
  --baseline     Once, for a database built with `drizzle-kit push`: record
                 every migration as applied so later ones run automatically.
                 Only when the server's schema matches the newest migration
  -h, --help     Show this help
EOF
}

host=${DEPLOY_HOST:-Paris}
dir=${DEPLOY_DIR:-/root/ngsl_telegram_bot}
with_aligner=false build=true check_only=false do_baseline=false
for arg in "$@"; do
  case "$arg" in
    --host=*) host="${arg#--host=}" ;;
    --dir=*) dir="${arg#--dir=}" ;;
    --aligner) with_aligner=true ;;
    --no-build) build=false ;;
    --check) check_only=true ;;
    --baseline) do_baseline=true ;;
    -h | --help) usage; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -t 1 ]]; then bold=$'\e[1m' green=$'\e[32m' yellow=$'\e[33m' red=$'\e[31m' reset_c=$'\e[0m'
else bold='' green='' yellow='' red='' reset_c=''; fi
step() { printf '\n%s▶ %s%s\n' "$bold" "$*" "$reset_c"; }
ok()   { printf '  %s✓%s %s\n' "$green" "$reset_c" "$*"; }
warn() { printf '  %s!%s %s\n' "$yellow" "$reset_c" "$*"; warnings=$((warnings + 1)); }
die()  { printf '  %s✗ %s%s\n' "$red" "$*" "$reset_c" >&2; exit 1; }
warnings=0

services=(bot worker)
if $with_aligner; then services+=(aligner); fi
# Compose pins `name: ngsl_telegram_bot`, so the image names are fixed; the
# container names come from `container_name` in docker-compose.yml.
image_of() { echo "ngsl_telegram_bot-$1:latest"; }
container_of() { echo "ngsl-v2-$1"; }

ssh_opts=(-o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15)
# Run a command in the server checkout.
remote() { ssh "${ssh_opts[@]}" "$host" "cd '$dir' && $1"; }
image_id() { docker image inspect "$(image_of "$1")" --format '{{.Id}}' 2>/dev/null || true; }
remote_image_id() { remote "docker image inspect $(image_of "$1") --format '{{.Id}}' 2>/dev/null || true"; }
strip_ansi() { sed -E 's/\x1b\[[0-9;]*m//g'; }

# ── Preflight ───────────────────────────────────────────────────────────────
step "Preflight checks"

command -v docker >/dev/null || die "docker is not installed"
docker info >/dev/null 2>&1 || die "the Docker daemon is not running (or this user cannot reach it)"
command -v rsync >/dev/null || die "rsync is not installed"

git diff --quiet && git diff --cached --quiet ||
  die "uncommitted changes; the server deploys what is on origin, so commit and push first"
branch=$(git rev-parse --abbrev-ref HEAD)
[[ "$branch" == main ]] || die "on branch '$branch'; the server tracks main"
git fetch -q origin main || die "could not fetch origin"
head=$(git rev-parse HEAD)
[[ "$head" == "$(git rev-parse origin/main)" ]] ||
  die "local main and origin/main differ; push (or pull) first so the server gets this exact commit"
version=$(sed -nE 's/^  "version": "([^"]+)".*/\1/p' package.json)
tag=$(git describe --tags --exact-match HEAD 2>/dev/null || true)
if [[ -n "$tag" ]]; then ok "commit ${head:0:7} ($tag), version $version, pushed"
else warn "commit ${head:0:7} has no release tag (version $version); deploying anyway"; fi

ssh "${ssh_opts[@]}" "$host" true 2>/dev/null || die "cannot reach '$host' over SSH (BatchMode: needs a key, no password prompt)"
remote "git rev-parse --git-dir >/dev/null 2>&1" || die "$dir on $host is not a git checkout"
[[ -z "$(remote "git status --porcelain --untracked-files=no")" ]] ||
  die "the checkout on $host has local changes to tracked files; resolve them there first"
server_head=$(remote "git rev-parse HEAD")
server_version=$(remote "sed -nE 's/^  \"version\": \"([^\"]+)\".*/\1/p' package.json")
if [[ "$server_head" != "$head" ]]; then
  git merge-base --is-ancestor "$server_head" "$head" 2>/dev/null ||
    die "the server is on ${server_head:0:7}, which is not an ancestor of ${head:0:7}; it cannot fast-forward"
fi
ok "$host:$dir is on ${server_head:0:7} (version $server_version)"

free_gb=$(remote "df -Pk / | awk 'NR==2 {print int(\$4 / 1048576)}'")
if ((free_gb < 3)); then warn "only ${free_gb} GB free on $host; loading images needs room"
else ok "${free_gb} GB free on $host"; fi

if $check_only; then
  step "Check only: nothing changed"
  exit 0
fi

# ── Build ───────────────────────────────────────────────────────────────────
if $build; then
  step "Building ${services[*]}"
  log_file=$(mktemp)
  if ! docker compose build "${services[@]}" >"$log_file" 2>&1; then
    tail -30 "$log_file" >&2; rm -f "$log_file"
    die "the build failed"
  fi
  rm -f "$log_file"
  ok "built"
fi
for service in "${services[@]}"; do
  [[ -n "$(image_id "$service")" ]] || die "no local image $(image_of "$service"); run without --no-build"
done

# ── Ship ────────────────────────────────────────────────────────────────────
step "Shipping images"
to_ship=()
for service in "${services[@]}"; do
  if [[ "$(image_id "$service")" == "$(remote_image_id "$service")" ]]; then
    ok "$service: the server already has this image"
  else
    to_ship+=("$service")
  fi
done

if ((${#to_ship[@]} > 0)); then
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  images=()
  for service in "${to_ship[@]}"; do images+=("$(image_of "$service")"); done
  docker save "${images[@]}" | gzip -1 >"$work/images.tar.gz"
  ok "${to_ship[*]}: $(du -h "$work/images.tar.gz" | cut -f1) to send"

  # rsync --partial resumes an interrupted transfer instead of starting over.
  sent=false
  for attempt in 1 2 3 4 5; do
    if rsync -a --partial --timeout=60 -e "ssh ${ssh_opts[*]}" "$work/images.tar.gz" "$host:/root/ngsl-images.tar.gz"; then
      sent=true; break
    fi
    warn "transfer interrupted (attempt $attempt), resuming"
    sleep 10
  done
  $sent || die "could not send the images"
  remote "docker load -i /root/ngsl-images.tar.gz >/dev/null && rm -f /root/ngsl-images.tar.gz" ||
    die "docker load failed on $host"

  for service in "${to_ship[@]}"; do
    [[ "$(image_id "$service")" == "$(remote_image_id "$service")" ]] ||
      die "$service: the server's image does not match the one built here"
    ok "$service: shipped and verified"
  done
fi

# ── Code ────────────────────────────────────────────────────────────────────
step "Updating the code on $host"
remote "git pull -q --ff-only" || die "git pull failed on $host"
[[ "$(remote "git rev-parse HEAD")" == "$head" ]] || die "the server did not end up on ${head:0:7}"
ok "on ${head:0:7}"

# ── Schema ──────────────────────────────────────────────────────────────────
# Before the restart: a new bot that reads a column the database lacks crashes.
step "Database migrations"
migrate() {
  remote "docker compose run --rm --no-deps -T worker node packages/db/dist/migrate.js $1 2>&1" | strip_ansi
}
if $do_baseline; then
  out=$(migrate --baseline) || { echo "$out" | tail -8 >&2; die "the baseline failed"; }
  grep -q 'Baseline recorded' <<<"$out" || { echo "$out" | tail -8 >&2; die "the baseline did not complete"; }
  ok "baseline recorded: every current migration marked as applied"
fi
out=$(migrate "") || { echo "$out" | tail -8 >&2; die "migrations failed; nothing was restarted"; }
if grep -q 'no migration journal' <<<"$out"; then
  die "the server's database has no migration journal (built with drizzle-kit push), so migrations
    cannot be applied automatically and nothing was restarted. If its schema already matches the
    newest migration, run once with --baseline. Otherwise apply the pending SQL in
    packages/db/drizzle by hand first, then --baseline."
fi
grep -q 'Migrations applied' <<<"$out" || { echo "$out" | tail -8 >&2; die "unexpected migration output"; }
ok "migrations applied (any pending)"

# ── Restart ─────────────────────────────────────────────────────────────────
step "Restarting ${services[*]}"
# The server's clock, not this machine's, bounds the logs read below.
started=$(remote "date -u +%Y-%m-%dT%H:%M:%SZ")
remote "docker compose up -d --no-deps --force-recreate ${services[*]} >/dev/null 2>&1" || die "docker compose up failed"

# ── Health ──────────────────────────────────────────────────────────────────
step "Health check"
sleep 25
for service in "${services[@]}"; do
  c=$(container_of "$service")
  state=$(remote "docker inspect -f '{{.State.Status}} {{.RestartCount}} {{.Image}}' $c" 2>/dev/null || echo "missing 0 -")
  read -r status restarts running_image <<<"$state"
  [[ "$status" == running ]] || die "$service is $status; see: ssh $host docker logs $c"
  [[ "$running_image" == "$(image_id "$service")" ]] || die "$service is not running the new image"
  ((restarts == 0)) || warn "$service restarted $restarts times since it was recreated"
  logs=$(remote "docker logs --since $started $c 2>&1" | strip_ansi)
  errors=$(grep -c 'ERROR' <<<"$logs" || true)
  ((errors == 0)) || warn "$service logged $errors errors; see: ssh $host docker logs --since $started $c"
  ok "$service: running the new image"
  case "$service" in
    bot)
      grep -q 'Bot started' <<<"$logs" || warn "the bot has not logged 'Bot started' yet"
      if grep -q '409' <<<"$logs"; then warn "Telegram 409: another process is polling the same BOT_TOKEN"; fi
      ;;
    worker)
      grep -q 'Worker ready' <<<"$logs" || warn "the worker has not logged 'Worker ready' yet"
      # Only a new version is announced, so an empty match is normal here.
      audience=$(grep -A3 'Announcing release' <<<"$logs" | sed -nE 's/.*audience: ([0-9]+).*/\1/p' | head -1 || true)
      if [[ -n "$audience" ]]; then ok "announcing version $version to $audience learners (five a second)"; fi
      ;;
  esac
done

step "Deployed"
echo "  $host: ${server_head:0:7} ($server_version) → ${head:0:7} ($version${tag:+, $tag})"
if ((warnings > 0)); then echo "  ${yellow}$warnings warning(s) above${reset_c}"; fi
