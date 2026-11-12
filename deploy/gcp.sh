#!/usr/bin/env bash
# Deploy TC Roof Solar to GCP / Firebase, sized for < $10/month.
#
#   Firebase Hosting (frontend)  ──/api/**──►  Cloud Run "tcroof-api" (us-central1, scale to zero)
#                                                   │  Direct VPC egress (private IP)
#                                                   ▼
#                                  e2-micro VM "tcroof-db" (free tier): Postgres 16 + growatt-worker
#                                  disk DISK_GB (100 GB: 90 days of history for 629 inverters;
#                                  30 GB is free, the rest ~$0.04/GB-month ≈ $2.80/month)
#
# Usage (from the repo root):
#   deploy/gcp.sh setup      # one time: APIs, $10 budget alert, registry, secrets, VM
#   deploy/gcp.sh backend    # build image, update VM (Postgres + worker), deploy Cloud Run API
#   deploy/gcp.sh frontend   # build UI, deploy Firebase Hosting
#   deploy/gcp.sh all        # backend + frontend
#
# Requires: gcloud (logged in), bun, the project on the Blaze plan (billing enabled),
# GROWATT_TOKEN_PHASE1..4 (or legacy GROWATT_API_TOKEN) in .env, secrets/firebase-service-account.json.
# Optional ADMIN_PASSWORD in .env (>= 12 chars); otherwise setup generates one into Secret Manager:
#   gcloud secrets versions access latest --secret tcroof-admin-password --project tcroof-string-analysis
set -euo pipefail

PROJECT="${PROJECT:-tcroof-string-analysis}"
REGION="${REGION:-us-central1}"        # e2-micro free tier exists only in us-west1/us-central1/us-east1
ZONE="${ZONE:-us-central1-a}"
VM="tcroof-db"
DB_IP_NAME="tcroof-db-ip"
REPO="tcroof"
SERVICE="tcroof-api"
API_SA="tcroof-api"
BUDGET_USD="${BUDGET_USD:-10}"
# Budgets must be in the billing account's currency (override with BUDGET_AMOUNT, e.g. 500 or 500THB).
budget_amount_for() { case "$1" in USD) echo "$BUDGET_USD" ;; THB) echo 500 ;; EUR) echo 10 ;; *) echo "" ;; esac; }
DISK_GB="${DISK_GB:-100}"              # pd-standard; must hold HISTORY_RETENTION_DAYS of readings
RETENTION_DAYS="${RETENTION_DAYS:-90}"
REGISTRY="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}"

cd "$(dirname "$0")/.."
g() { gcloud --project "$PROJECT" "$@"; }
log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

secret_exists() { g secrets describe "$1" >/dev/null 2>&1; }
secret_get() { g secrets versions access latest --secret "$1"; }
secret_put() {  # name value  (adds a version only when the value changed)
  if secret_exists "$1"; then
    [ "$(secret_get "$1")" = "$2" ] && return 0
    printf '%s' "$2" | g secrets versions add "$1" --data-file=- >/dev/null
  else
    printf '%s' "$2" | g secrets create "$1" --replication-policy=user-managed --locations="$REGION" --data-file=- >/dev/null
  fi
}
env_value() {  # missing key -> empty string (grep's exit 1 must not trip set -e/pipefail)
  { grep -E "^$1=" .env 2>/dev/null || true; } | tail -1 | cut -d= -f2- | sed -e 's/[[:space:]]*#.*$//' -e 's/^"//' -e 's/"$//'
}
db_ip() { g compute addresses describe "$DB_IP_NAME" --region "$REGION" --format='value(address)'; }

# One Growatt account per project phase. Secret tcroof-growatt-token-phaseN <-> env GROWATT_TOKEN_PHASEN.
# The legacy GROWATT_API_TOKEN stands in for phase 1 when GROWATT_TOKEN_PHASE1 is empty.
PHASES="1 2 3 4"
phase_token_env() {  # phase -> token from .env (may be empty)
  local v; v="$(env_value "GROWATT_TOKEN_PHASE$1")"
  [ -z "$v" ] && [ "$1" = 1 ] && v="$(env_value GROWATT_API_TOKEN)"
  printf '%s' "$v"
}
phase_secrets() { for p in $PHASES; do secret_exists "tcroof-growatt-token-phase$p" && echo "$p"; done; return 0; }

cmd_setup() {
  [ "$(g billing projects describe "$PROJECT" --format='value(billingEnabled)')" = "True" ] || {
    echo "Billing is not enabled on $PROJECT. Upgrade to Blaze: https://console.firebase.google.com/project/$PROJECT/usage/details"; exit 1; }

  log "Enabling APIs"
  g services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com \
    compute.googleapis.com secretmanager.googleapis.com billingbudgets.googleapis.com cloudbilling.googleapis.com

  local ba cur amount
  ba="$(g billing projects describe "$PROJECT" --format='value(billingAccountName)' | sed 's#billingAccounts/##')"
  cur="$(gcloud billing accounts describe "$ba" --format='value(currencyCode)')"
  amount="${BUDGET_AMOUNT:-$(budget_amount_for "$cur")}"; amount="${amount%"$cur"}"  # accept 500 or 500THB
  [ -n "$amount" ] || { echo "Billing account currency is $cur: set BUDGET_AMOUNT (~\$${BUDGET_USD} in $cur)"; exit 1; }
  log "Budget alert at ${amount} ${cur}/month (emails billing admins at 50/90/100%)"
  # The Budgets API needs a quota project when called with user credentials.
  if ! gcloud billing budgets list --billing-project="$PROJECT" --billing-account="$ba" --format='value(displayName)' | grep -qx "tcroof-${BUDGET_USD}usd"; then
    gcloud billing budgets create --billing-project="$PROJECT" --billing-account="$ba" --display-name="tcroof-${BUDGET_USD}usd" \
      --budget-amount="${amount}${cur}" --filter-projects="projects/$PROJECT" \
      --threshold-rule=percent=0.5 --threshold-rule=percent=0.9 --threshold-rule=percent=1.0 \
      --threshold-rule=percent=1.0,basis=forecasted-spend
  fi

  log "Artifact Registry (keep only the 3 newest images to stay in the 0.5 GB free tier)"
  g artifacts repositories describe "$REPO" --location "$REGION" >/dev/null 2>&1 || \
    g artifacts repositories create "$REPO" --location "$REGION" --repository-format docker
  cat > /tmp/tcroof-ar-policy.json <<'EOF'
[{"name":"keep-3","action":{"type":"Keep"},"mostRecentVersions":{"keepCount":3}},
 {"name":"delete-old","action":{"type":"Delete"},"condition":{"tagState":"ANY"}}]
EOF
  g artifacts repositories set-cleanup-policies "$REPO" --location "$REGION" --policy /tmp/tcroof-ar-policy.json --no-dry-run

  log "Secrets (Secret Manager)"
  local p token n=0
  for p in $PHASES; do
    token="$(phase_token_env "$p")"
    [ -n "$token" ] || continue
    secret_put "tcroof-growatt-token-phase$p" "$token"; n=$((n + 1))
  done
  [ "$n" -gt 0 ] || { echo "No Growatt token in .env (GROWATT_TOKEN_PHASE1..4 or GROWATT_API_TOKEN)"; exit 1; }
  secret_exists tcroof-jwt-secret || secret_put tcroof-jwt-secret "$(openssl rand -hex 32)"
  # Production admin (APP_ENV=prod seeds no demo users). .env ADMIN_PASSWORD wins; else generated once.
  local admin_pw; admin_pw="$(env_value ADMIN_PASSWORD)"
  if [ -n "$admin_pw" ]; then
    [ "${#admin_pw}" -ge 12 ] || { echo "ADMIN_PASSWORD in .env must be at least 12 characters"; exit 1; }
    secret_put tcroof-admin-password "$admin_pw"
  elif ! secret_exists tcroof-admin-password; then
    secret_put tcroof-admin-password "$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)"
    echo "Generated the admin password (username: admin). Read it with:"
    echo "  gcloud secrets versions access latest --secret tcroof-admin-password --project $PROJECT"
  fi
  secret_exists tcroof-db-password || secret_put tcroof-db-password "$(openssl rand -hex 24)"

  log "Static internal IP + VM $VM (e2-micro, 30 GB pd-standard = free tier)"
  g compute addresses describe "$DB_IP_NAME" --region "$REGION" >/dev/null 2>&1 || \
    g compute addresses create "$DB_IP_NAME" --region "$REGION" --subnet default
  secret_put tcroof-database-url "postgresql+psycopg://solar:$(secret_get tcroof-db-password)@$(db_ip):5432/tc_roof_solar"
  if ! g compute instances describe "$VM" --zone "$ZONE" >/dev/null 2>&1; then
    g compute instances create "$VM" --zone "$ZONE" --machine-type e2-micro \
      --image-family debian-12 --image-project debian-cloud \
      --boot-disk-size "${DISK_GB}GB" --boot-disk-type pd-standard \
      --private-network-ip "$(db_ip)" --tags tcroof-db \
      --scopes cloud-platform --metadata-from-file startup-script=deploy/vm/startup.sh
  else
    # Grow (never shrink) the disk of an existing VM; Debian grows the root filesystem on reboot.
    local cur; cur="$(g compute disks describe "$VM" --zone "$ZONE" --format='value(sizeGb)')"
    if [ "$cur" -lt "$DISK_GB" ]; then
      log "Resizing $VM disk ${cur} GB -> ${DISK_GB} GB"
      g compute disks resize "$VM" --zone "$ZONE" --size "${DISK_GB}GB" --quiet
      echo "Reboot the VM once to grow the filesystem: gcloud compute instances reset $VM --zone $ZONE"
    fi
  fi

  log "Firewall: Postgres reachable from inside the VPC only"
  g compute firewall-rules describe tcroof-allow-postgres-internal >/dev/null 2>&1 || \
    g compute firewall-rules create tcroof-allow-postgres-internal --network default \
      --allow tcp:5432 --source-ranges 10.128.0.0/9 --target-tags tcroof-db

  log "Cloud Run service account"
  g iam service-accounts describe "${API_SA}@${PROJECT}.iam.gserviceaccount.com" >/dev/null 2>&1 || \
    g iam service-accounts create "$API_SA" --display-name "TC Roof API (Cloud Run)"
  for s in $(phase_secrets | sed 's/^/tcroof-growatt-token-phase/') tcroof-jwt-secret tcroof-database-url tcroof-admin-password; do
    g secrets add-iam-policy-binding "$s" --member "serviceAccount:${API_SA}@${PROJECT}.iam.gserviceaccount.com" \
      --role roles/secretmanager.secretAccessor >/dev/null
  done

  echo; echo "Setup done. Next: deploy/gcp.sh all"
}

cmd_backend() {
  [ -f secrets/firebase-service-account.json ] || { echo "secrets/firebase-service-account.json missing"; exit 1; }
  local tag image; tag="$(git rev-parse --short HEAD)$(git diff --quiet || echo -dirty)-$(date +%Y%m%d%H%M)"
  image="${REGISTRY}/backend:${tag}"

  log "Building $image (Cloud Build)"
  g builds submit --region "$REGION" --config deploy/cloudbuild.yaml --substitutions "_IMAGE=${image}" .

  log "Updating VM: Postgres + growatt-worker"
  local tmp; tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' RETURN
  umask 077
  cat > "$tmp/.env" <<EOF
BACKEND_IMAGE=${image}
POSTGRES_PASSWORD=$(secret_get tcroof-db-password)
DATABASE_URL=postgresql+psycopg://solar:$(secret_get tcroof-db-password)@postgres:5432/tc_roof_solar
$(for p in $(phase_secrets); do echo "GROWATT_TOKEN_PHASE$p=$(secret_get "tcroof-growatt-token-phase$p")"; done)
FIREBASE_PROJECT_ID=${PROJECT}
FIREBASE_CREDENTIALS_FILE=secrets/firebase-service-account.json
PUBLISH_SINK=firestore
PUBLISH_DAILY_WRITE_BUDGET=15000
WORKER_HISTORY_INTERVAL_MIN=30
HISTORY_RETENTION_DAYS=${RETENTION_DAYS}
EOF
  cp deploy/vm/compose.yml "$tmp/compose.yml"
  cp secrets/firebase-service-account.json "$tmp/firebase-service-account.json"
  g compute scp --zone "$ZONE" "$tmp/.env" "$tmp/compose.yml" "$tmp/firebase-service-account.json" "${VM}:/tmp/"
  g compute ssh "$VM" --zone "$ZONE" --command "set -e
    until command -v docker >/dev/null; do echo 'waiting for startup script to install docker...'; sleep 10; done
    sudo mkdir -p /opt/tcroof/secrets
    sudo mv /tmp/.env /tmp/compose.yml /opt/tcroof/
    sudo mv /tmp/firebase-service-account.json /opt/tcroof/secrets/
    sudo chmod 600 /opt/tcroof/.env /opt/tcroof/secrets/firebase-service-account.json
    sudo chmod 644 /opt/tcroof/compose.yml
    sudo -H gcloud auth configure-docker ${REGION}-docker.pkg.dev --quiet >/dev/null
    cd /opt/tcroof && sudo docker compose pull -q && sudo docker compose up -d --remove-orphans
    sudo docker image prune -af >/dev/null
    sudo docker compose ps"

  local secrets="DATABASE_URL=tcroof-database-url:latest,JWT_SECRET_KEY=tcroof-jwt-secret:latest,ADMIN_PASSWORD=tcroof-admin-password:latest" p
  for p in $(phase_secrets); do secrets+=",GROWATT_TOKEN_PHASE$p=tcroof-growatt-token-phase$p:latest"; done

  log "Deploying Cloud Run $SERVICE"
  g run deploy "$SERVICE" --region "$REGION" --image "$image" \
    --service-account "${API_SA}@${PROJECT}.iam.gserviceaccount.com" \
    --port 8000 --cpu 1 --memory 1Gi --cpu-boost \
    --min-instances 0 --max-instances 1 --concurrency 80 --timeout 300 \
    --network default --subnet default --vpc-egress private-ranges-only \
    --allow-unauthenticated \
    --set-secrets "$secrets" \
    --set-env-vars "^@^CORS_ORIGINS=[\"https://${PROJECT}.web.app\",\"https://${PROJECT}.firebaseapp.com\"]@PUBLISH_SINK=json@APP_ENV=prod@HISTORY_RETENTION_DAYS=${RETENTION_DAYS}"
}

cmd_frontend() {
  log "Building frontend"
  (cd frontend && bun install --frozen-lockfile && VITE_API_BASE_URL=/api bun run build)
  log "Deploying Firebase Hosting"
  bunx firebase-tools deploy --only hosting --project "$PROJECT"
  echo; echo "Live at https://${PROJECT}.web.app"
}

case "${1:-}" in
  setup) cmd_setup ;;
  backend) cmd_backend ;;
  frontend) cmd_frontend ;;
  all) cmd_backend; cmd_frontend ;;
  *) sed -n '2,16p' "$0"; exit 1 ;;
esac
