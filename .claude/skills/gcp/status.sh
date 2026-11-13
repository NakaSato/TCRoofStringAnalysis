#!/usr/bin/env bash
# Read-only GCP status for TC Roof Solar: live resources vs deploy/gcp.config, budget + cost guard,
# month-to-date spend (from the guard's budget messages), alerts, backups, app health.
# Usage (repo root): .claude/skills/gcp/status.sh            Changes nothing.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
. deploy/gcp.config
P="$PROJECT"; VM=tcroof-db; GUARD=tcroof-cost-guard; HOST="${PROJECT}.web.app"
g() { gcloud --project "$P" "$@" 2>/dev/null; }
ok() { [ "$1" = "$2" ] && echo "ok" || echo "MISMATCH (config: $2)"; }
h() { printf '\n== %s\n' "$1"; }

h "Account"
echo "gcloud account: $(gcloud config get-value account 2>/dev/null)"
BA="$(g billing projects describe "$P" --format='value(billingAccountName)' | sed 's#billingAccounts/##')"
echo "billing: account $BA, enabled=$(g billing projects describe "$P" --format='value(billingEnabled)'), currency=$(gcloud billing accounts describe "$BA" --format='value(currencyCode)' 2>/dev/null)"

h "VM and disk"
mt="$(g compute instances describe $VM --zone "$ZONE" --format='value(machineType.basename())')"
echo "VM $VM: $mt, $(g compute instances describe $VM --zone "$ZONE" --format='value(status)')  -> $(ok "$mt" "$MACHINE_TYPE")"
disk="$(g compute instances describe $VM --zone "$ZONE" --format='value(disks[0].source.basename())')"
dt="$(g compute disks describe "$disk" --zone "$ZONE" --format='value(type.basename())')"
ds="$(g compute disks describe "$disk" --zone "$ZONE" --format='value(sizeGb)')"
echo "boot disk $disk: $dt ${ds} GB -> $(ok "$dt/$ds" "$DISK_TYPE/$DISK_GB")"
echo "disks not attached to anything (still billed):"
loose="$(g compute disks list --filter='-users:*' --format='value(name,type.basename(),sizeGb,creationTimestamp.date("%Y-%m-%d"))')"
echo "${loose:-(none)}" | sed 's/^/  /'
echo "external IP: $(g compute addresses list --filter="name=tcroof-db-ext" --format='value(address,status)')"

h "Backups"
g compute resource-policies list --format='value(name,snapshotSchedulePolicy.retentionPolicy.maxRetentionDays)' | sed 's/^/  policy /;s/\t/ keep days=/'
echo "  attached to $disk: $(g compute disks describe "$disk" --zone "$ZONE" --format='value(resourcePolicies.basename())')"
g compute snapshots list --format='value(name,creationTimestamp.date("%Y-%m-%d %H:%M"),storageBytes.size(),autoCreated)' \
  | awk -F'\t' '{printf "  snapshot %s  %s  %s  %s\n",$1,$2,$3,($4=="True"?"auto":"MANUAL (not expired by the policy)")}'

h "Cloud Run tcroof-api"
ann="$(g run services describe tcroof-api --region "$REGION" --format='value(spec.template.metadata.annotations)')"
min="$(tr ';' '\n' <<<"$ann" | sed -n 's/.*minScale=//p')"; min="${min:-0}"
max="$(tr ';' '\n' <<<"$ann" | sed -n 's/^autoscaling.knative.dev\/maxScale=//p')"
echo "min $min / max ${max:-?}  -> $(ok "$min" "$API_MIN_INSTANCES")"
echo "revision: $(g run services describe tcroof-api --region "$REGION" --format='value(status.latestReadyRevisionName)')"

h "Budget and cost guard"
g billing budgets list --billing-project="$P" --billing-account="$BA" \
  --format='value(displayName,amount.specifiedAmount.units,amount.specifiedAmount.currencyCode,notificationsRule.pubsubTopic.basename())' \
  | while IFS=$'\t' read -r n a c t; do
      echo "budget $n: $a $c, topic $t -> $(ok "$a$c" "$BUDGET_AMOUNT")"
      echo "guard trips at ${COST_CAP_PCT} % = $(( a * COST_CAP_PCT / 100 )) $c"
    done
env="$(g functions describe $GUARD --region "$REGION" --format='value(state,serviceConfig.environmentVariables.CAP_PCT,serviceConfig.environmentVariables.DRY_RUN)')"
echo "function $GUARD: $env (state, CAP_PCT, DRY_RUN) -> cap $(ok "$(cut -f2 <<<"$env")" "$COST_CAP_PCT"), dry run $(ok "$(cut -f3 <<<"$env")" "$COSTGUARD_DRY_RUN")"

h "Spend this month (latest real budget messages; billing data lags several hours)"
g logging read "resource.labels.service_name=\"$GUARD\" AND jsonPayload.pct:* AND jsonPayload.budget=\"tcroof-monthly\"" \
  --freshness=35d --limit 3 --format='value(timestamp,jsonPayload.cost,jsonPayload.budget_amount,jsonPayload.currency,jsonPayload.pct)' \
  | awk -F'\t' '{printf "  %s  cost %s of %s %s (%s %%)\n",$1,$2,$3,$4,$5}' | grep . || echo "  no budget message logged yet"
echo "  (messages named TEST* are hand-sent tests, not spend)"

h "Alerts"
g monitoring policies list --format='value(displayName,enabled)' | sed 's/^/  /'
g monitoring uptime list-configs --format='value(displayName,period)' | sed 's/^/  uptime /'

h "App"
for p in / /api/health /api/health/worker; do
  printf '  %-20s %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code} %{time_total}s' "https://${HOST}${p}")"
done
echo "  worker: $(curl -s "https://${HOST}/api/health/worker")"
