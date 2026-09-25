#!/usr/bin/env bash
#
# Bring the whole NGSL stack up on this machine with Docker alone.
#
#   preflight checks → (reset) → build images → postgres + redis
#   → schema (migrations) → seed the NGSL words → worker, aligner, bot
#   → (ingest, content) → summary
#
# Every step is safe to re-run: migrations and the seed are idempotent, and
# services that are already up are left running. See README → "Run it locally".

set -euo pipefail
cd "$(dirname "$0")/.."

usage() {
  cat <<'EOF'
Usage: scripts/local-up.sh [options]

  --check        Run the preflight checks only, change nothing
  --no-build     Use the images already built instead of rebuilding
  --no-bot       Start everything except the bot (e.g. while the same token
                 is polling on a server: two pollers on one token fight)
  --no-aligner   Skip the forced-alignment service (about 2 GB of image and
                 1 GB of RAM); clips are then cut on pauses instead
  --ingest=N     After start, index N new videos from every enabled channel
  --content      After start, generate examples and collocations for every
                 word in the background (hours; resumable)
  --reset        Delete this project's local volumes first: database, Redis,
                 clip scratch. Asks for confirmation
  --yes          Do not ask (with --reset)
  -h, --help     Show this help
EOF
}

check_only=false build=true with_bot=true with_aligner=true reset=false assume_yes=false
ingest=0 content=false
for arg in "$@"; do
  case "$arg" in
    --check) check_only=true ;;
    --no-build) build=false ;;
    --no-bot) with_bot=false ;;
    --no-aligner) with_aligner=false ;;
    --ingest=*) ingest="${arg#--ingest=}" ;;
    --content) content=true ;;
    --reset) reset=true ;;
    --yes) assume_yes=true ;;
    -h | --help) usage; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; usage >&2; exit 2 ;;
  esac
done
[[ "$ingest" =~ ^[0-9]+$ ]] || { echo "--ingest needs a number" >&2; exit 2; }

if [[ -t 1 ]]; then bold=$'\e[1m' green=$'\e[32m' yellow=$'\e[33m' red=$'\e[31m' reset_c=$'\e[0m'
else bold='' green='' yellow='' red='' reset_c=''; fi
step() { printf '\n%s▶ %s%s\n' "$bold" "$*" "$reset_c"; }
ok()   { printf '  %s✓%s %s\n' "$green" "$reset_c" "$*"; }
warn() { printf '  %s!%s %s\n' "$yellow" "$reset_c" "$*"; warnings=$((warnings + 1)); }
die()  { printf '  %s✗ %s%s\n' "$red" "$*" "$reset_c" >&2; exit 1; }
warnings=0

# Value of KEY in .env: last assignment wins, inline comments and padding dropped.
env_get() { grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- | sed -E 's/[[:space:]]+#.*$//; s/[[:space:]]+$//' || true; }

compose() { docker compose "$@"; }
container_of() { compose ps -q "$1" 2>/dev/null | head -1; }

wait_healthy() {
  local service=$1 timeout=${2:-120} id status
  for ((waited = 0; waited < timeout; waited += 3)); do
    id=$(container_of "$service")
    status=$([[ -n "$id" ]] && docker inspect -f '{{.State.Health.Status}}' "$id" 2>/dev/null || echo missing)
    [[ "$status" == healthy ]] && return 0
    sleep 3
  done
  return 1
}

psql_q() { compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "$1"' _ "$1"; }

# ── Preflight ───────────────────────────────────────────────────────────────
step "Preflight checks"

command -v docker >/dev/null || die "docker is not installed"
docker info >/dev/null 2>&1 || die "the Docker daemon is not running (or this user cannot reach it)"
compose version >/dev/null 2>&1 || die "Docker Compose v2 is missing (\`docker compose\`)"
ok "Docker $(docker version --format '{{.Server.Version}}'), Compose $(compose version --short)"

if [[ ! -f .env ]]; then
  cp .env.example .env
  chmod 600 .env
  die ".env did not exist; created it from .env.example. Fill in BOT_TOKEN, ADMIN_TELEGRAM_IDS, the passwords and GEMINI_API_KEYS, then run again."
fi
ok ".env found"

token=$(env_get BOT_TOKEN)
[[ "$token" =~ ^[0-9]+:[A-Za-z0-9_-]{30,}$ ]] || die "BOT_TOKEN is missing or malformed (get one from @BotFather)"
[[ "$token" == 123456789:AAx* ]] && die "BOT_TOKEN is still the .env.example placeholder"
[[ -n "$(env_get ADMIN_TELEGRAM_IDS)" ]] || die "ADMIN_TELEGRAM_IDS is empty (your numeric Telegram id)"

pg_user=$(env_get POSTGRES_USER); pg_user=${pg_user:-ngsl}
pg_pass=$(env_get POSTGRES_PASSWORD)
pg_db=$(env_get POSTGRES_DB); pg_db=${pg_db:-ngsl}
redis_pass=$(env_get REDIS_PASSWORD)
[[ -n "$pg_pass" ]] || die "POSTGRES_PASSWORD is empty"
[[ -n "$redis_pass" ]] || die "REDIS_PASSWORD is empty"
[[ "$pg_pass" == change-me || "$redis_pass" == change-me ]] && warn "a database password is still 'change-me' (fine locally, never on a server)"
[[ "$(env_get DATABASE_URL)" == "postgres://$pg_user:$pg_pass@localhost:5432/$pg_db" ]] ||
  warn "DATABASE_URL does not match POSTGRES_* (containers are unaffected; host tools like pnpm db:push would fail)"
[[ "$(env_get REDIS_URL)" == "redis://:$redis_pass@localhost:6379" ]] ||
  warn "REDIS_URL does not match REDIS_PASSWORD (containers are unaffected; host tools would fail)"

if [[ "$(env_get LLM_PROVIDER)" != vllm ]]; then
  keys=$(env_get GEMINI_API_KEYS)
  if [[ -z "$keys" || "$keys" == key1,key2,key3 ]]; then
    die "GEMINI_API_KEYS is not set (needed by the writing coach and content generation)"
  fi
fi
ok "required settings present"

vault_group=$(env_get CLIP_VAULT_GROUP_ID)
if [[ -z "$vault_group" || "$vault_group" == -1001234567890 ]]; then
  warn "CLIP_VAULT_GROUP_ID is not set: no clips will be rendered"
fi
monitor_group=$(env_get MONITOR_GROUP_ID)
if [[ -n "$monitor_group" && "$monitor_group" == -1001234567890 ]]; then
  warn "MONITOR_GROUP_ID is the .env.example placeholder: the monitor will switch itself off"
fi

cookies=$(env_get YOUTUBE_COOKIES_HOST_PATH)
if [[ -z "$cookies" ]]; then
  warn "YOUTUBE_COOKIES_HOST_PATH is not set: YouTube may block downloads from this IP"
elif [[ ! -r "$cookies" ]]; then
  die "YOUTUBE_COOKIES_HOST_PATH points to $cookies, which is missing or unreadable"
else
  # The worker runs as uid 1000 and reads the file through a bind mount.
  owner=$(stat -c %u "$cookies")
  mode=$(stat -c %a "$cookies")
  if [[ "$owner" != 1000 && "${mode: -1}" -lt 4 ]]; then
    warn "$cookies belongs to uid $owner; the worker (uid 1000) cannot read it: sudo chown 1000:1000 $cookies"
  else
    ok "YouTube cookies at $cookies"
  fi
  [[ "$(env_get YOUTUBE_COOKIES_FILE)" == /run/secrets/youtube_cookies.txt ]] ||
    warn "set YOUTUBE_COOKIES_FILE=/run/secrets/youtube_cookies.txt so the worker uses the mounted file"
fi

free_gb=$(df -BG --output=avail "$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo /)" 2>/dev/null | tail -1 | tr -dc 0-9 || echo 0)
if $build && [[ "${free_gb:-0}" -lt 8 ]]; then
  warn "only ${free_gb} GB free for Docker; the images need about 5 GB"
fi

$with_bot && warn "the bot will poll with this BOT_TOKEN; if the same token runs on a server, stop one of them (or use --no-bot)"

if $check_only; then
  step "Checks done ($warnings warning(s)); nothing was changed"
  exit 0
fi

# ── Reset ───────────────────────────────────────────────────────────────────
if $reset; then
  step "Reset"
  if ! $assume_yes; then
    [[ -t 0 ]] || die "--reset needs --yes when not run from a terminal"
    read -r -p "  Delete the local database, Redis and clip scratch of this project? Type 'yes': " answer
    [[ "$answer" == yes ]] || die "reset cancelled"
  fi
  compose down -v --remove-orphans
  ok "containers and volumes removed"
fi

# ── Build ───────────────────────────────────────────────────────────────────
services=(worker)
$with_aligner && services+=(aligner)
$with_bot && services+=(bot)

if $build; then
  step "Building images: ${services[*]} (the first aligner build downloads about 1 GB)"
  compose build "${services[@]}"
  ok "images built"
fi

# ── Database ────────────────────────────────────────────────────────────────
step "Starting Postgres and Redis"
compose up -d postgres redis
wait_healthy postgres || die "Postgres did not become healthy; see: docker compose logs postgres"
wait_healthy redis || die "Redis did not become healthy; see: docker compose logs redis"
ok "Postgres and Redis are healthy"

step "Applying the schema"
compose run --rm --no-deps -T worker node packages/db/dist/migrate.js
ok "schema is up to date"

step "Seeding the NGSL word list"
compose run --rm --no-deps -T worker node packages/db/dist/seed/index.js >/dev/null
ok "$(psql_q 'select count(*) from word') words in the database"

# ── Services ────────────────────────────────────────────────────────────────
step "Starting ${services[*]}"
if $with_aligner; then
  compose up -d aligner
  wait_healthy aligner 240 || warn "the aligner is not healthy yet; clips will fall back to pause-based cuts until it is"
fi
compose up -d worker
$with_bot && compose up -d bot
sleep 15

for service in "${services[@]}"; do
  id=$(container_of "$service")
  [[ -n "$id" ]] || { warn "$service is not running"; continue; }
  restarts=$(docker inspect -f '{{.RestartCount}}' "$id")
  state=$(docker inspect -f '{{.State.Status}}' "$id")
  if [[ "$state" != running || "$restarts" -gt 0 ]]; then
    warn "$service is $state after $restarts restart(s); see: docker compose logs $service"
  else
    ok "$service is running"
  fi
done
if $with_bot && docker logs "$(container_of bot)" 2>&1 | grep -q '409'; then
  warn "Telegram reports a conflict (409): this BOT_TOKEN is polling somewhere else too"
fi

# ── Optional: corpus and content ────────────────────────────────────────────
if [[ "$ingest" -gt 0 ]]; then
  step "Ingesting $ingest new video(s) per enabled channel (a few seconds per video)"
  compose exec -T worker node packages/media/dist/cli.js --limit="$ingest" || warn "ingest stopped early; see the output above"
fi

if $content; then
  step "Generating examples and collocations in the background"
  if docker ps -a --format '{{.Names}}' | grep -qx ngsl-content; then
    warn "a content run (ngsl-content) already exists; follow it with: docker logs -f ngsl-content"
  else
    compose run -d --rm --no-deps --name ngsl-content worker node packages/content/dist/cli.js all >/dev/null
    ok "started; follow it with: docker logs -f ngsl-content"
  fi
fi

# ── Summary ─────────────────────────────────────────────────────────────────
step "Summary"
compose ps --format 'table {{.Service}}\t{{.Status}}'
echo
printf '  words %s · videos indexed %s · sentences %s · clips %s\n' \
  "$(psql_q 'select count(*) from word')" \
  "$(psql_q "select count(*) from video where sub_status = 'manual'")" \
  "$(psql_q 'select count(*) from segment')" \
  "$(psql_q 'select count(*) from segment_media')"
if $with_bot && command -v curl >/dev/null; then
  username=$(curl -s -m 10 "https://api.telegram.org/bot$token/getMe" | sed -nE 's/.*"username":"([^"]+)".*/\1/p' || true)
  [[ -n "$username" ]] && printf '  bot: https://t.me/%s\n' "$username"
fi
cat <<EOF

  Logs:        docker compose logs -f bot worker
  More videos: docker compose exec worker node packages/media/dist/cli.js --limit=25
  Coverage:    docker compose exec worker node apps/worker/dist/prewarm-cli.js --status
  Stop:        docker compose stop
EOF
[[ $warnings -eq 0 ]] || printf '\n  %s%d warning(s) above.%s\n' "$yellow" "$warnings" "$reset_c"
