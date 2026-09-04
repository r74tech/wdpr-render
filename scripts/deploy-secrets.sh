#!/usr/bin/env bash
set -euo pipefail

environment="${1:?Usage: deploy-secrets.sh <staging|production> <sops-file> [--dry-run]}"
source_file="${2:?Usage: deploy-secrets.sh <staging|production> <sops-file> [--dry-run]}"
mode="${3:-}"

case "$environment" in
  staging | production) ;;
  *)
    echo "environment must be staging or production" >&2
    exit 1
    ;;
esac

if [[ ! -f "$source_file" ]]; then
  echo "SOPS file not found: $source_file" >&2
  exit 1
fi

wrangler_args=()
case "$mode" in
  "") ;;
  --dry-run) wrangler_args+=(--dry-run) ;;
  *)
    echo "third argument must be --dry-run when specified" >&2
    exit 1
    ;;
esac

decrypted_file="$(mktemp)"
cleanup() {
  rm -f "$decrypted_file"
}
trap cleanup EXIT
chmod 600 "$decrypted_file"

sops --decrypt --output-type dotenv "$source_file" > "$decrypted_file"
if ! grep -Eq '^FILES_URL_SECRET=.+$' "$decrypted_file"; then
  echo "decrypted file must contain FILES_URL_SECRET" >&2
  exit 1
fi

bunx wrangler deploy \
  --config wrangler.files.jsonc \
  --env "$environment" \
  --secrets-file "$decrypted_file" \
  "${wrangler_args[@]}"

bunx wrangler deploy \
  --config wrangler.jsonc \
  --env "$environment" \
  --secrets-file "$decrypted_file" \
  "${wrangler_args[@]}"
