#!/usr/bin/env bash
set -euo pipefail

command=${1:?usage: admin.sh plan|deploy}
cd "$(dirname "$0")/.."

set -a
. ../.env
set +a

export CLOUDFLARE_API_TOKEN=$CLOUDFLARE_DEPLOY_TOKEN
export GOOGLE_ACCESS_TOKEN=$(gcloud auth print-access-token)
export GOOGLE_PROJECT_ID=virtual-office-notifier
export GITHUB_TOKEN=$(gh auth token)
export ALCHEMY_TELEMETRY_DISABLED=1

case $command in
  plan) exec alchemy plan admin.run.ts --stage prod --adopt --env-file /dev/null ;;
  deploy) exec alchemy deploy admin.run.ts --stage prod --adopt --env-file /dev/null ;;
  *) echo "usage: admin.sh plan|deploy" >&2; exit 2 ;;
esac
