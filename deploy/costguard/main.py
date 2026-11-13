"""Cost guard: hard monthly cap for the project (deploy/gcp.sh costguard).

A Cloud Billing budget only sends alerts. Its Pub/Sub messages land here; once the month's
actual cost reaches CAP_PCT % of the budget, billing is disabled on the project, which stops
every paid resource (VM, Cloud Run, Hosting). Disks and snapshots are kept. To restore:
    gcloud billing projects link PROJECT --billing-account ACCOUNT ; then start the VM.
CAP_PCT sits below 100 because billing data arrives hours late.
"""

from __future__ import annotations

import base64
import json
import os

import functions_framework
from googleapiclient import discovery

PROJECT_ID = os.environ["PROJECT_ID"]
CAP_PCT = float(os.environ.get("CAP_PCT", "96"))
DRY_RUN = os.environ.get("DRY_RUN", "false").lower() == "true"


def over_cap(msg: dict) -> tuple[bool, float]:
    """(over the cap?, percent of budget spent) for one budget notification."""
    budget = float(msg.get("budgetAmount") or 0)
    cost = float(msg.get("costAmount") or 0)
    pct = 100.0 * cost / budget if budget > 0 else 0.0
    return pct >= CAP_PCT, pct


@functions_framework.cloud_event
def stop_billing(event) -> None:
    msg = json.loads(base64.b64decode(event.data["message"]["data"]).decode("utf-8"))
    over, pct = over_cap(msg)
    print(json.dumps({"budget": msg.get("budgetDisplayName"), "cost": msg.get("costAmount"),
                      "budget_amount": msg.get("budgetAmount"), "currency": msg.get("currencyCode"),
                      "pct": round(pct, 1), "cap_pct": CAP_PCT, "over_cap": over, "dry_run": DRY_RUN}))
    if not over:
        return

    billing = discovery.build("cloudbilling", "v1", cache_discovery=False)
    name = f"projects/{PROJECT_ID}"
    if not billing.projects().getBillingInfo(name=name).execute().get("billingEnabled"):
        print("billing already disabled")
        return
    if DRY_RUN:
        print(f"DRY RUN: would disable billing on {PROJECT_ID} at {pct:.1f} % of budget")
        return
    billing.projects().updateBillingInfo(name=name, body={"billingAccountName": ""}).execute()
    print(f"BILLING DISABLED on {PROJECT_ID} at {pct:.1f} % of budget")
