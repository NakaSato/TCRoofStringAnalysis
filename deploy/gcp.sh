#!/usr/bin/env bash
# Deploy TC Roof Solar to GCP / Firebase. Production sizing and the monthly cost cap (BUDGET_AMOUNT,
# hard stop by the cost guard at COST_CAP_PCT): docs/plans/gcp-production.md.
#
#   Firebase Hosting (frontend)  ──/api/**──►  Cloud Run "tcroof-api" (us-central1, min API_MIN_INSTANCES / max 1)
#                                                   │  Direct VPC egress (private IP)
#                                                   ▼
#                                  VM "tcroof-db" (MACHINE_TYPE, e2-standard-2): Postgres 16 + growatt-worker
#                                  + Redis (live-cache mirror for the API, no persistence, :6379 VPC only)
#                                  disk DISK_GB pd-balanced (100 GB: 90 days of history for 629 inverters)
#
# Usage (from the repo root):
#   deploy/gcp.sh setup      # one time: APIs, budget + cost guard, registry, secrets, VM
#   deploy/gcp.sh snapshots  # weekly VM disk snapshots, kept SNAPSHOT_KEEP_DAYS (also run by setup)
#   deploy/gcp.sh ip         # promote the VM's external IP to static (also run by upsize)
#   deploy/gcp.sh upsize     # VM to MACHINE_TYPE / DISK_TYPE (stops the VM ~15 min; maintenance window)
#   deploy/gcp.sh costguard  # budget BUDGET_AMOUNT + Pub/Sub + function that disables billing at COST_CAP_PCT
#   deploy/gcp.sh monitoring # email alerts: API down, worker not syncing, disk > 85 %; Ops Agent on the VM
#   deploy/gcp.sh backend    # build image, update VM (Postgres + worker), deploy Cloud Run API
#   deploy/gcp.sh frontend   # build UI, deploy Firebase Hosting
#   deploy/gcp.sh ai         # AI Assistant key: AI_API_KEY from .env -> secret tcroof-ai-api-key (add / rotate), then: backend
#   deploy/gcp.sh all        # backend + frontend
#
# Requires: gcloud (logged in), bun, the project on the Blaze plan (billing enabled),
# GROWATT_TOKEN_PHASE1..4 (or legacy GROWATT_API_TOKEN) in .env, secrets/firebase-service-account.json.
# Optional ADMIN_PASSWORD in .env (>= 12 chars); otherwise setup generates one into Secret Manager:
#   gcloud secrets versions access latest --secret tcroof-admin-password --project tcroof-string-analysis
set -euo pipefail

# Official production settings (env vars of the same name override them for one run).
. "$(dirname "$0")/gcp.config"

PROJECT="${PROJECT:-tcroof-string-analysis}"
REGION="${REGION:-us-central1}"
ZONE="${ZONE:-us-central1-a}"
VM="tcroof-db"
DB_IP_NAME="tcroof-db-ip"
REPO="tcroof"
SERVICE="tcroof-api"
API_SA="tcroof-api"
EXT_IP_NAME="tcroof-db-ext"
MACHINE_TYPE="${MACHINE_TYPE:-e2-standard-2}"  # 2 vCPU / 8 GB (Postgres page cache for charts + history)
DISK_TYPE="${DISK_TYPE:-pd-balanced}"
API_MIN_INSTANCES="${API_MIN_INSTANCES:-1}"    # 1 = no cold start (idle instance ≈ ฿447/month)
# Monthly budget in the billing account's currency (override with BUDGET_AMOUNT, e.g. 1000 or 1000THB).
BUDGET_NAME="tcroof-monthly"
budget_amount_for() { case "$1" in THB) echo 1000 ;; USD) echo 29 ;; *) echo "" ;; esac; }
COST_CAP_PCT="${COST_CAP_PCT:-96}"             # cost guard disables billing here (billing data lags ~1 day)
COSTGUARD_DRY_RUN="${COSTGUARD_DRY_RUN:-false}"
BUDGET_TOPIC="tcroof-budget"
GUARD="tcroof-cost-guard"
DISK_GB="${DISK_GB:-100}"              # must hold HISTORY_RETENTION_DAYS of readings
RETENTION_DAYS="${RETENTION_DAYS:-90}"
STORE_RAW="${STORE_RAW:-false}"         # keep whole max_data records (growatt_inverter_raw)
STRING_RETENTION_DAYS="${STRING_RETENTION_DAYS:-30}"   # per-string 5-min readings
RAW_RETENTION_DAYS="${RAW_RETENTION_DAYS:-7}"
HISTORY_INTERVAL_MIN="${HISTORY_INTERVAL_MIN:-10}"   # history interval on the worker
ENV_INTERVAL_MIN="${ENV_INTERVAL_MIN:-0}"   # env_history interval on the worker; 0 = off
LATEST_INTERVAL_MIN="${LATEST_INTERVAL_MIN:-0}"   # inverter_latest interval on the worker; 0 = off
SNAPSHOT_POLICY="tcroof-db-weekly"
OLD_SNAPSHOT_POLICIES="tcroof-db-daily"        # detached from the disk when found
SNAPSHOT_KEEP_DAYS="${SNAPSHOT_KEEP_DAYS:-28}" # weekly snapshots kept 4 weeks; no daily backup
SNAPSHOT_DAY_UTC="${SNAPSHOT_DAY_UTC:-saturday}" # Saturday 19:00 UTC = Sunday 02:00 Bangkok, no PV output
SNAPSHOT_HOUR_UTC="${SNAPSHOT_HOUR_UTC:-19}"
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
vm_disk() { g compute instances describe "$VM" --zone "$ZONE" --format='value(disks[0].source.basename())'; }
vm_type() { g compute instances describe "$VM" --zone "$ZONE" --format='value(machineType.basename())'; }

# One Growatt account per project phase. Secret tcroof-growatt-token-phaseN <-> env GROWATT_TOKEN_PHASEN.
# The legacy GROWATT_API_TOKEN stands in for phase 1 when GROWATT_TOKEN_PHASE1 is empty.
PHASES="1 2 3 4"
phase_token_env() {  # phase -> token from .env (may be empty)
  local v; v="$(env_value "GROWATT_TOKEN_PHASE$1")"
  [ -z "$v" ] && [ "$1" = 1 ] && v="$(env_value GROWATT_API_TOKEN)"
  printf '%s' "$v"
}
google_weather_secret() { secret_exists tcroof-google-weather-key && echo tcroof-google-weather-key; return 0; }
# AI Assistant (Qwen Cloud): no secret = assistant off (the API answers 503 and the UI hides the button)
longdo_secret() { secret_exists tcroof-longdo-key && echo tcroof-longdo-key; return 0; }
ai_secret() { secret_exists tcroof-ai-api-key && echo tcroof-ai-api-key; return 0; }
# PWA Report sheet (Apps Script) -> GET /api/report/pwa/{day} with this shared key; the API reads
# the day's docs from Firestore as its own service account (roles/datastore.viewer). Idempotent.
report_access() {
  local sa="serviceAccount:${API_SA}@${PROJECT}.iam.gserviceaccount.com"
  secret_exists tcroof-report-key || secret_put tcroof-report-key "$(openssl rand -hex 24)"
  g secrets add-iam-policy-binding tcroof-report-key --member "$sa" --role roles/secretmanager.secretAccessor >/dev/null
  g projects add-iam-policy-binding "$PROJECT" --member "$sa" --role roles/datastore.viewer --condition=None >/dev/null
}
# PWA Report Google Sheet, filled by the worker (PWA_SHEET_ID in .env; empty = off). The worker
# writes as the Firebase service account: the Sheets API must be on and the sheet shared with it.
pwa_sheet_access() {
  [ -n "$(env_value PWA_SHEET_ID)" ] || return 0
  g services enable sheets.googleapis.com
  local email; email="$(sed -n 's/.*"client_email": *"\([^"]*\)".*/\1/p' secrets/firebase-service-account.json)"
  echo "PWA sheet: share https://docs.google.com/spreadsheets/d/$(env_value PWA_SHEET_ID)/edit as Editor with ${email}"
}
# Alarm push notifications: the worker sends through FCM as the Firebase service account.
push_access() {
  [ -n "$FIREBASE_VAPID_KEY" ] || return 0
  g services enable fcm.googleapis.com
}
phase_secrets() { for p in $PHASES; do secret_exists "tcroof-growatt-token-phase$p" && echo "$p"; done; return 0; }

cmd_setup() {
  [ "$(g billing projects describe "$PROJECT" --format='value(billingEnabled)')" = "True" ] || {
    echo "Billing is not enabled on $PROJECT. Upgrade to Blaze: https://console.firebase.google.com/project/$PROJECT/usage/details"; exit 1; }

  log "Enabling APIs"
  g services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com \
    compute.googleapis.com secretmanager.googleapis.com billingbudgets.googleapis.com cloudbilling.googleapis.com

  cmd_costguard

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
  # Optional: Google Maps Weather API key (GOOGLE_WEATHER_API_KEY in .env)
  local gw_key; gw_key="$(env_value GOOGLE_WEATHER_API_KEY)"
  [ -z "$gw_key" ] || secret_put tcroof-google-weather-key "$gw_key"
  # Optional: Longdo Map key for the Plant Map rain radar (LONGDO_API_KEY in .env)
  local longdo_key; longdo_key="$(env_value LONGDO_API_KEY)"
  [ -z "$longdo_key" ] || secret_put tcroof-longdo-key "$longdo_key"

  log "Static internal IP + VM $VM ($MACHINE_TYPE, ${DISK_GB} GB $DISK_TYPE)"
  g compute addresses describe "$DB_IP_NAME" --region "$REGION" >/dev/null 2>&1 || \
    g compute addresses create "$DB_IP_NAME" --region "$REGION" --subnet default
  secret_put tcroof-database-url "postgresql+psycopg://solar:$(secret_get tcroof-db-password)@$(db_ip):5432/tc_roof_solar"
  if ! g compute instances describe "$VM" --zone "$ZONE" >/dev/null 2>&1; then
    g compute instances create "$VM" --zone "$ZONE" --machine-type "$MACHINE_TYPE" \
      --image-family debian-12 --image-project debian-cloud \
      --boot-disk-size "${DISK_GB}GB" --boot-disk-type "$DISK_TYPE" \
      --private-network-ip "$(db_ip)" --tags tcroof-db \
      --scopes cloud-platform --metadata-from-file startup-script=deploy/vm/startup.sh
  else
    # Grow (never shrink) the disk of an existing VM; Debian grows the root filesystem on reboot.
    local disk cur; disk="$(vm_disk)"; cur="$(g compute disks describe "$disk" --zone "$ZONE" --format='value(sizeGb)')"
    if [ "$cur" -lt "$DISK_GB" ]; then
      log "Resizing $VM disk ${cur} GB -> ${DISK_GB} GB"
      g compute disks resize "$disk" --zone "$ZONE" --size "${DISK_GB}GB" --quiet
      echo "Reboot the VM once to grow the filesystem: gcloud compute instances reset $VM --zone $ZONE"
    fi
  fi

  cmd_ip
  cmd_snapshots

  log "Firewall: Postgres reachable from inside the VPC only"
  g compute firewall-rules describe tcroof-allow-postgres-internal >/dev/null 2>&1 || \
    g compute firewall-rules create tcroof-allow-postgres-internal --network default \
      --allow tcp:5432 --source-ranges 10.128.0.0/9 --target-tags tcroof-db

  log "Cloud Run service account"
  g iam service-accounts describe "${API_SA}@${PROJECT}.iam.gserviceaccount.com" >/dev/null 2>&1 || \
    g iam service-accounts create "$API_SA" --display-name "TC Roof API (Cloud Run)"
  for s in $(phase_secrets | sed 's/^/tcroof-growatt-token-phase/') $(google_weather_secret) $(longdo_secret) $(ai_secret) tcroof-jwt-secret tcroof-database-url tcroof-admin-password; do
    g secrets add-iam-policy-binding "$s" --member "serviceAccount:${API_SA}@${PROJECT}.iam.gserviceaccount.com" \
      --role roles/secretmanager.secretAccessor >/dev/null
  done

  report_access

  echo; echo "Setup done. Next: deploy/gcp.sh all"
}

# Weekly snapshot of the VM disk (Postgres history + worker state), kept SNAPSHOT_KEEP_DAYS; no daily
# backup, so a restore can be up to 7 days old (refill Growatt history with growatt_sync --start/--end).
# Snapshots are crash-consistent, which Postgres recovers from like a power cut (WAL replay). Restore:
#   gcloud compute snapshots list --filter="sourceDisk~tcroof-db" --project $PROJECT
#   gcloud compute disks create tcroof-db-restore --source-snapshot SNAPSHOT --zone $ZONE --project $PROJECT
# A disk takes one snapshot schedule only, so older policies are detached first.
cmd_snapshots() {
  local disk p start; disk="$(vm_disk)"; start="$(printf '%02d:00' "$SNAPSHOT_HOUR_UTC")"
  log "Weekly snapshots of disk $disk, ${SNAPSHOT_DAY_UTC} ${start} UTC, kept ${SNAPSHOT_KEEP_DAYS} days"
  if g compute resource-policies describe "$SNAPSHOT_POLICY" --region "$REGION" >/dev/null 2>&1; then
    g compute resource-policies update snapshot-schedule "$SNAPSHOT_POLICY" --region "$REGION" \
      --max-retention-days "$SNAPSHOT_KEEP_DAYS" --weekly-schedule "$SNAPSHOT_DAY_UTC" --start-time "$start" >/dev/null
  else
    g compute resource-policies create snapshot-schedule "$SNAPSHOT_POLICY" --region "$REGION" \
      --description "Weekly snapshot of the $VM disk (Postgres)" \
      --max-retention-days "$SNAPSHOT_KEEP_DAYS" --on-source-disk-delete keep-auto-snapshots \
      --weekly-schedule "$SNAPSHOT_DAY_UTC" --start-time "$start" --storage-location "$REGION"
  fi
  local attached; attached="$(g compute disks describe "$disk" --zone "$ZONE" --format='value(resourcePolicies)')"
  for p in $OLD_SNAPSHOT_POLICIES; do
    if grep -q "/$p" <<<"$attached"; then
      g compute disks remove-resource-policies "$disk" --zone "$ZONE" --resource-policies "$p"
    fi
  done
  grep -q "/$SNAPSHOT_POLICY" <<<"$attached" || \
    g compute disks add-resource-policies "$disk" --zone "$ZONE" --resource-policies "$SNAPSHOT_POLICY"
}

# The VM's external IP (the worker's outbound address to Growatt and Google) as a static address,
# so it survives a stop/start and can be allow-listed. Promoting in place keeps the address.
cmd_ip() {
  if g compute addresses describe "$EXT_IP_NAME" --region "$REGION" >/dev/null 2>&1; then
    log "Static external IP $EXT_IP_NAME: $(g compute addresses describe "$EXT_IP_NAME" --region "$REGION" --format='value(address)')"
    return 0
  fi
  local ip; ip="$(g compute instances describe "$VM" --zone "$ZONE" --format='value(networkInterfaces[0].accessConfigs[0].natIP)')"
  [ -n "$ip" ] || { echo "$VM has no external IP"; exit 1; }
  log "Promoting external IP $ip to static ($EXT_IP_NAME)"
  g compute addresses create "$EXT_IP_NAME" --addresses "$ip" --region "$REGION"
}

# VM to MACHINE_TYPE and its boot disk to DISK_TYPE. Stops the VM (~15 min): run it in the
# 21:30-23:00 Bangkok window. A disk can't change type in place: snapshot -> new disk -> swap the
# boot disk. The old disk is kept (delete it after a week); runs cut off by the stop are retried.
cmd_upsize() {
  local disk dtype mtype; disk="$(vm_disk)"; mtype="$(vm_type)"
  dtype="$(g compute disks describe "$disk" --zone "$ZONE" --format='value(type.basename())')"
  if [ "$mtype" = "$MACHINE_TYPE" ] && [ "$dtype" = "$DISK_TYPE" ]; then
    log "$VM is already $MACHINE_TYPE with a $DISK_TYPE disk"; return 0
  fi
  cmd_ip  # an ephemeral external IP would change on stop/start
  log "Stopping $VM ($mtype, $dtype disk $disk)"
  g compute instances stop "$VM" --zone "$ZONE"

  if [ "$dtype" != "$DISK_TYPE" ]; then
    local stamp snap new p; stamp="$(date -u +%Y%m%d%H%M)"
    snap="tcroof-db-upsize-$stamp"; new="tcroof-db-${DISK_TYPE#pd-}-$stamp"
    log "Disk $disk ($dtype) -> $new ($DISK_TYPE) via snapshot $snap"
    g compute disks snapshot "$disk" --zone "$ZONE" --snapshot-names "$snap" --storage-location "$REGION"
    g compute disks create "$new" --zone "$ZONE" --type "$DISK_TYPE" --source-snapshot "$snap" --size "${DISK_GB}GB"
    g compute instances detach-disk "$VM" --zone "$ZONE" --disk "$disk"
    g compute instances attach-disk "$VM" --zone "$ZONE" --disk "$new" --boot
    g compute instances set-disk-auto-delete "$VM" --zone "$ZONE" --disk "$new" --auto-delete
    for p in $SNAPSHOT_POLICY $OLD_SNAPSHOT_POLICIES; do  # the old disk stops taking snapshots
      g compute disks describe "$disk" --zone "$ZONE" --format='value(resourcePolicies)' | grep -q "/$p" && \
        g compute disks remove-resource-policies "$disk" --zone "$ZONE" --resource-policies "$p"
    done
    echo "Kept: old disk $disk and snapshot $snap. Delete them after a week:"
    echo "  gcloud compute disks delete $disk --zone $ZONE --project $PROJECT"
    echo "  gcloud compute snapshots delete $snap --project $PROJECT"
  fi
  [ "$mtype" = "$MACHINE_TYPE" ] || { log "Machine type $mtype -> $MACHINE_TYPE"; g compute instances set-machine-type "$VM" --zone "$ZONE" --machine-type "$MACHINE_TYPE"; }

  log "Starting $VM"
  g compute instances start "$VM" --zone "$ZONE"
  cmd_snapshots
  log "Waiting for Postgres + growatt-worker"
  g compute ssh "$VM" --zone "$ZONE" --command "for i in \$(seq 1 30); do sudo docker ps --format '{{.Names}} {{.Status}}' 2>/dev/null | grep -q 'postgres.*healthy' && break; sleep 10; done; sudo docker ps --format '{{.Names}}: {{.Status}}'"
  echo "Next: deploy/gcp.sh backend (Postgres settings for $MACHINE_TYPE), then deploy/gcp.sh monitoring"
}

# Budget BUDGET_AMOUNT/month with email at 50/90/100 % (and 100 % forecast) to the billing admins,
# published to Pub/Sub BUDGET_TOPIC. Function GUARD (deploy/costguard) disables billing on the project
# once actual cost reaches COST_CAP_PCT % of the budget: everything stops, disks and snapshots are
# kept. Restore: gcloud billing projects link $PROJECT --billing-account ACCOUNT, then start the VM.
# COSTGUARD_DRY_RUN=true deploys it logging only.
cmd_costguard() {
  local ba cur amount sa topic id r
  ba="$(g billing projects describe "$PROJECT" --format='value(billingAccountName)' | sed 's#billingAccounts/##')"
  cur="$(gcloud billing accounts describe "$ba" --format='value(currencyCode)')"
  amount="${BUDGET_AMOUNT:-$(budget_amount_for "$cur")}"; amount="${amount%"$cur"}"  # accept 3000 or 3000THB
  [ -n "$amount" ] || { echo "Billing account currency is $cur: set BUDGET_AMOUNT"; exit 1; }
  sa="${GUARD}@${PROJECT}.iam.gserviceaccount.com"; topic="projects/${PROJECT}/topics/${BUDGET_TOPIC}"

  log "Cost guard: APIs, topic $BUDGET_TOPIC, service account $GUARD"
  g services enable pubsub.googleapis.com cloudfunctions.googleapis.com run.googleapis.com eventarc.googleapis.com \
    cloudbuild.googleapis.com artifactregistry.googleapis.com cloudbilling.googleapis.com billingbudgets.googleapis.com
  g pubsub topics describe "$BUDGET_TOPIC" >/dev/null 2>&1 || g pubsub topics create "$BUDGET_TOPIC"
  g iam service-accounts describe "$sa" >/dev/null 2>&1 || \
    g iam service-accounts create "$GUARD" --display-name "Cost guard: disables billing over the budget cap"
  # projectManager: unlink billing; browser: resourcemanager.projects.get for getBillingInfo
  for r in roles/billing.projectManager roles/browser; do
    g projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$sa" --role "$r" --condition=None >/dev/null
  done

  log "Deploying function $GUARD (cap ${COST_CAP_PCT} %, dry run: $COSTGUARD_DRY_RUN)"
  g functions deploy "$GUARD" --gen2 --region "$REGION" --runtime python312 --source deploy/costguard \
    --entry-point stop_billing --trigger-topic "$BUDGET_TOPIC" \
    --service-account "$sa" --trigger-service-account "$sa" \
    --memory 256Mi --max-instances 1 --no-allow-unauthenticated \
    --set-env-vars "PROJECT_ID=${PROJECT},CAP_PCT=${COST_CAP_PCT},DRY_RUN=${COSTGUARD_DRY_RUN}"
  g run services add-iam-policy-binding "$GUARD" --region "$REGION" --member "serviceAccount:$sa" --role roles/run.invoker >/dev/null

  log "Budget $BUDGET_NAME: ${amount} ${cur}/month (email at 50/90/100 %, forecast 100 %; Pub/Sub -> $GUARD)"
  # The Budgets API needs a quota project when called with user credentials.
  local bb=(gcloud billing budgets --billing-project="$PROJECT")
  id="$("${bb[@]}" list --billing-account="$ba" --filter="displayName=$BUDGET_NAME" --format='value(name)' | head -1)"
  if [ -z "$id" ]; then
    "${bb[@]}" create --billing-account="$ba" --display-name="$BUDGET_NAME" \
      --budget-amount="${amount}${cur}" --filter-projects="projects/$PROJECT" \
      --threshold-rule=percent=0.5 --threshold-rule=percent=0.9 --threshold-rule=percent=1.0 \
      --threshold-rule=percent=1.0,basis=forecasted-spend --notifications-rule-pubsub-topic="$topic"
  else
    "${bb[@]}" update "$id" --billing-account="$ba" --budget-amount="${amount}${cur}" --notifications-rule-pubsub-topic="$topic" >/dev/null
  fi
  # Earlier budgets of this project (e.g. tcroof-10usd, ฿500, email only) are replaced by this one.
  for id in $("${bb[@]}" list --billing-account="$ba" --format='value(name,displayName)' | awk -v n="$BUDGET_NAME" '$2 ~ /^tcroof-/ && $2 != n {print $1}'); do
    "${bb[@]}" delete "$id" --quiet
  done
}

# Email alerts (ALERT_EMAIL, default: the gcloud account): API down (/api/health), worker not
# syncing (/api/health/worker = 503 when no history run finished in 2 h), disk > 85 % (Ops Agent).
cmd_monitoring() {
  local email host token ch
  email="${ALERT_EMAIL:-$(gcloud config get-value account 2>/dev/null)}"; host="${PROJECT}.web.app"
  g services enable monitoring.googleapis.com
  token="$(gcloud auth print-access-token)"
  local api="https://monitoring.googleapis.com/v3/projects/${PROJECT}"

  log "Email channel for $email"
  ch="$(curl -fsS -H "Authorization: Bearer $token" "$api/notificationChannels" |
    python3 -c 'import json,sys; e=sys.argv[1]; print(next((c["name"] for c in json.load(sys.stdin).get("notificationChannels",[]) if c.get("labels",{}).get("email_address")==e), ""))' "$email")"
  [ -n "$ch" ] || ch="$(curl -fsS -X POST -H "Authorization: Bearer $token" -H 'Content-Type: application/json' "$api/notificationChannels" \
    -d "{\"type\":\"email\",\"displayName\":\"tcroof alerts ($email)\",\"labels\":{\"email_address\":\"$email\"}}" |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["name"])')"

  local check path name id
  for check in "tcroof-api-health:/api/health:API down" "tcroof-worker-health:/api/health/worker:Data sync failing"; do
    IFS=: read -r name path title <<<"$check"
    id="$(g monitoring uptime list-configs --filter="displayName=$name" --format='value(name.basename())' | head -1)"
    if [ -z "$id" ]; then
      log "Uptime check $name: https://${host}${path} every 5 min"
      g monitoring uptime create "$name" --resource-type=uptime-url --resource-labels="host=${host},project_id=${PROJECT}" \
        --protocol=https --path="$path" --period=5 --timeout=30 --regions=usa-iowa,asia-pacific,europe >/dev/null
      id="$(g monitoring uptime list-configs --filter="displayName=$name" --format='value(name.basename())' | head -1)"
    fi
    alert_policy "tcroof: $title" "$ch" "$(cat <<JSON
{"displayName":"${title} (uptime check failing)","conditionThreshold":{
 "filter":"metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND resource.type=\"uptime_url\" AND metric.label.check_id=\"${id}\"",
 "aggregations":[{"alignmentPeriod":"600s","perSeriesAligner":"ALIGN_NEXT_OLDER","crossSeriesReducer":"REDUCE_COUNT_FALSE","groupByFields":["resource.label.host"]}],
 "comparison":"COMPARISON_GT","thresholdValue":1,"duration":"300s","trigger":{"count":1}}}
JSON
)"
  done

  if [ "$(vm_type)" != "e2-micro" ]; then
    log "Ops Agent on $VM (disk / memory metrics)"
    g compute ssh "$VM" --zone "$ZONE" --command "systemctl is-active --quiet google-cloud-ops-agent || {
      curl -sSO https://dl.google.com/cloudagents/add-google-cloud-ops-agent-repo.sh && sudo bash add-google-cloud-ops-agent-repo.sh --also-install; }"
    alert_policy "tcroof: Disk almost full" "$ch" '{"displayName":"VM disk used > 85 %","conditionThreshold":{
 "filter":"metric.type=\"agent.googleapis.com/disk/percent_used\" AND resource.type=\"gce_instance\" AND metric.label.state=\"used\"",
 "aggregations":[{"alignmentPeriod":"300s","perSeriesAligner":"ALIGN_MEAN"}],
 "comparison":"COMPARISON_GT","thresholdValue":85,"duration":"300s","trigger":{"count":1}}}'
  else
    echo "Skipping the Ops Agent on an e2-micro (not enough RAM): run again after deploy/gcp.sh upsize"
  fi
}

alert_policy() {  # display name, channel, condition JSON (created once; delete it in the console to change)
  g monitoring policies list --filter="displayName=\"$1\"" --format='value(name)' | grep -q . && return 0
  local f; f="$(mktemp)"
  printf '{"displayName":"%s","combiner":"OR","conditions":[%s],"notificationChannels":["%s"],"alertStrategy":{"autoClose":"86400s"}}' "$1" "$3" "$2" >"$f"
  g monitoring policies create --policy-from-file="$f" >/dev/null && log "Alert policy: $1"
  rm -f "$f"
}

# Redis on the VM (deploy/vm/compose.yml): password secret, the URL Cloud Run uses (VM internal
# IP), and a firewall rule that opens 6379 to the VPC only. Idempotent.
redis_setup() {
  secret_exists tcroof-redis-password || secret_put tcroof-redis-password "$(openssl rand -hex 24)"
  secret_put tcroof-redis-url "redis://:$(secret_get tcroof-redis-password)@$(db_ip):6379/0"
  g secrets add-iam-policy-binding tcroof-redis-url --member "serviceAccount:${API_SA}@${PROJECT}.iam.gserviceaccount.com" \
    --role roles/secretmanager.secretAccessor >/dev/null
  g compute firewall-rules describe tcroof-allow-redis-internal >/dev/null 2>&1 || \
    g compute firewall-rules create tcroof-allow-redis-internal --network default \
      --allow tcp:6379 --source-ranges 10.128.0.0/9 --target-tags tcroof-db >/dev/null
}

cmd_backend() {
  [ -f secrets/firebase-service-account.json ] || { echo "secrets/firebase-service-account.json missing"; exit 1; }
  local tag image; tag="$(git rev-parse --short HEAD)$(git diff --quiet || echo -dirty)-$(date +%Y%m%d%H%M)"
  image="${REGISTRY}/backend:${tag}"

  log "Building $image (Cloud Build)"
  g builds submit --region "$REGION" --config deploy/cloudbuild.yaml --substitutions "_IMAGE=${image}" .

  pwa_sheet_access
  redis_setup
  # Postgres memory for the VM's actual size (an e2-micro has 1 GB shared with the worker)
  local pg; if [ "$(vm_type)" = "e2-micro" ]; then
    pg="PG_SHARED_BUFFERS=128MB PG_EFFECTIVE_CACHE_SIZE=384MB PG_WORK_MEM=4MB PG_MAINTENANCE_WORK_MEM=64MB PG_MAX_CONNECTIONS=40"
  else
    pg="PG_SHARED_BUFFERS=2GB PG_EFFECTIVE_CACHE_SIZE=5GB PG_WORK_MEM=16MB PG_MAINTENANCE_WORK_MEM=512MB PG_MAX_CONNECTIONS=60"
  fi
  log "Updating VM: Postgres + growatt-worker"
  local tmp; tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' RETURN
  umask 077
  cat > "$tmp/.env" <<EOF
BACKEND_IMAGE=${image}
POSTGRES_PASSWORD=$(secret_get tcroof-db-password)
REDIS_PASSWORD=$(secret_get tcroof-redis-password)
DATABASE_URL=postgresql+psycopg://solar:$(secret_get tcroof-db-password)@postgres:5432/tc_roof_solar
$(for p in $(phase_secrets); do echo "GROWATT_TOKEN_PHASE$p=$(secret_get "tcroof-growatt-token-phase$p")"; done)
FIREBASE_PROJECT_ID=${PROJECT}
FIREBASE_CREDENTIALS_FILE=secrets/firebase-service-account.json
PUBLISH_SINK=firestore
PUBLISH_DAILY_WRITE_BUDGET=15000
WORKER_HISTORY_INTERVAL_MIN=${HISTORY_INTERVAL_MIN}
WORKER_ENV_INTERVAL_MIN=${ENV_INTERVAL_MIN}
WORKER_LATEST_INTERVAL_MIN=${LATEST_INTERVAL_MIN}
HISTORY_RETENTION_DAYS=${RETENTION_DAYS}
GROWATT_BLOCKED_PLANT_IDS=${BLOCKED_PLANT_IDS}
HISTORY_STORE_RAW=${STORE_RAW}
HISTORY_RAW_RETENTION_DAYS=${RAW_RETENTION_DAYS}
HISTORY_STRING_RETENTION_DAYS=${STRING_RETENTION_DAYS}
PUSH_ALARM_LEVELS=${PUSH_ALARM_LEVELS}
$(tr ' ' '\n' <<<"$pg")
$([ -z "$(google_weather_secret)" ] || echo "GOOGLE_WEATHER_API_KEY=$(secret_get tcroof-google-weather-key)")
$([ -z "$(env_value PWA_SHEET_ID)" ] || echo "PWA_SHEET_ID=$(env_value PWA_SHEET_ID)")
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

  report_access
  push_access
  local secrets="DATABASE_URL=tcroof-database-url:latest,JWT_SECRET_KEY=tcroof-jwt-secret:latest,ADMIN_PASSWORD=tcroof-admin-password:latest,REPORT_API_KEY=tcroof-report-key:latest,REDIS_URL=tcroof-redis-url:latest" p
  for p in $(phase_secrets); do secrets+=",GROWATT_TOKEN_PHASE$p=tcroof-growatt-token-phase$p:latest"; done
  [ -z "$(google_weather_secret)" ] || secrets+=",GOOGLE_WEATHER_API_KEY=tcroof-google-weather-key:latest"
  [ -z "$(longdo_secret)" ] || secrets+=",LONGDO_API_KEY=tcroof-longdo-key:latest"
  [ -z "$(ai_secret)" ] || secrets+=",AI_API_KEY=tcroof-ai-api-key:latest"

  log "Deploying Cloud Run $SERVICE"
  g run deploy "$SERVICE" --region "$REGION" --image "$image" \
    --service-account "${API_SA}@${PROJECT}.iam.gserviceaccount.com" \
    --port 8000 --cpu 1 --memory 1Gi --cpu-boost \
    --min-instances "$API_MIN_INSTANCES" --max-instances 1 --concurrency 80 --timeout 300 \
    --network default --subnet default --vpc-egress private-ranges-only \
    --allow-unauthenticated \
    --set-secrets "$secrets" \
    --set-env-vars "^@^CORS_ORIGINS=[\"https://${PROJECT}.web.app\",\"https://${PROJECT}.firebaseapp.com\"]@PUBLISH_SINK=json@APP_ENV=prod@FIREBASE_PROJECT_ID=${PROJECT}@HISTORY_RETENTION_DAYS=${RETENTION_DAYS}@GROWATT_BLOCKED_PLANT_IDS=${BLOCKED_PLANT_IDS}@AI_MODEL=${AI_MODEL}@AI_ENABLED_ROLES=${AI_ENABLED_ROLES}@AI_MONTHLY_BUDGET_USD=${AI_MONTHLY_BUDGET_USD}@AI_USER_DAILY_QUESTIONS=${AI_USER_DAILY_QUESTIONS}@AI_TURN_TIMEOUT_S=${AI_TURN_TIMEOUT_S}@FIREBASE_WEB_API_KEY=${FIREBASE_WEB_API_KEY}@FIREBASE_WEB_APP_ID=${FIREBASE_WEB_APP_ID}@FIREBASE_MESSAGING_SENDER_ID=${FIREBASE_MESSAGING_SENDER_ID}@FIREBASE_VAPID_KEY=${FIREBASE_VAPID_KEY}@PUSH_ALARM_LEVELS=${PUSH_ALARM_LEVELS}"
}

# AI Assistant key (docs/plans/ai-assistant.md §6): AI_API_KEY from .env -> Secret Manager, readable by
# the API's service account only. Run again after rotating the key; `backend` then picks it up.
cmd_ai() {
  local key; key="$(env_value AI_API_KEY)"
  [ -n "$key" ] || { echo "AI_API_KEY is empty in .env"; exit 1; }
  log "Secret tcroof-ai-api-key"
  secret_put tcroof-ai-api-key "$key"
  g secrets add-iam-policy-binding tcroof-ai-api-key \
    --member "serviceAccount:${API_SA}@${PROJECT}.iam.gserviceaccount.com" \
    --role roles/secretmanager.secretAccessor >/dev/null
  echo "Done. Deploy the API to use it: deploy/gcp.sh backend"
}

cmd_frontend() {
  log "Building frontend"
  # The AI Assistant's chat streams straight from Cloud Run: Hosting's /api rewrite buffers SSE and
  # cuts requests at 60 s. Everything else keeps going through /api on Hosting.
  local run_url; run_url="$(g run services describe "$SERVICE" --region "$REGION" --format='value(status.url)' 2>/dev/null || true)"
  [ -n "$run_url" ] || echo "Cloud Run URL not found: the assistant chat will go through Hosting (no streaming)"
  (cd frontend && bun install --frozen-lockfile && \
    VITE_API_BASE_URL=/api VITE_ASSISTANT_API_BASE_URL="${run_url:+${run_url}/api}" bun run build)
  log "Deploying Firebase Hosting"
  bunx firebase-tools deploy --only hosting --project "$PROJECT"
  echo; echo "Live at https://${PROJECT}.web.app"
}

case "${1:-}" in
  setup) cmd_setup ;;
  snapshots) cmd_snapshots ;;
  ip) cmd_ip ;;
  upsize) cmd_upsize ;;
  costguard) cmd_costguard ;;
  monitoring) cmd_monitoring ;;
  backend) cmd_backend ;;
  frontend) cmd_frontend ;;
  ai) cmd_ai ;;
  all) cmd_backend; cmd_frontend ;;
  *) sed -n '2,24p' "$0"; exit 1 ;;
esac
