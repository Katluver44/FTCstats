#!/bin/bash
# Creates a YouTube Data API key in the Google Cloud project "ftcstats",
# restricted to the YouTube Data API, and stores it in .env and in the
# GitHub Actions secret YOUTUBE_API_KEY. The key is never printed.
# Run from the FTCstats folder:  bash scripts/setup-youtube-key.sh
set -euo pipefail
cd "$(dirname "$0")/.."

GCLOUD="$(command -v gcloud || echo "$HOME/google-cloud-sdk/bin/gcloud")"
if [ ! -x "$GCLOUD" ]; then
  echo "Installing Google Cloud CLI into ~/google-cloud-sdk ..."
  curl -sSL https://sdk.cloud.google.com | bash -s -- --disable-prompts --install-dir="$HOME" >/dev/null
  GCLOUD="$HOME/google-cloud-sdk/bin/gcloud"
fi

if [ -z "$("$GCLOUD" auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null)" ]; then
  echo "Sign in to Google in the browser window that opens ..."
  "$GCLOUD" auth login --quiet
fi

echo "Creating the API key ..."
KEY="$("$GCLOUD" services api-keys create --project=ftcstats \
  --display-name="FTCstats YouTube" \
  --api-target=service=youtube.googleapis.com \
  --format='value(response.keyString)' 2>/dev/null)"
if [ -z "$KEY" ]; then echo "Key creation failed."; exit 1; fi

# .env: replace the YOUTUBE_API_KEY line, or add one
touch .env && chmod 600 .env
grep -v '^YOUTUBE_API_KEY=' .env > .env.tmp || true
printf 'YOUTUBE_API_KEY=%s\n' "$KEY" >> .env.tmp && mv .env.tmp .env && chmod 600 .env
echo "Saved to .env"

GH="$(command -v gh || ls /private/tmp/claude-501/*/*/scratchpad/gh-dl/*/bin/gh 2>/dev/null | head -1)"
if [ -n "$GH" ]; then
  printf '%s' "$KEY" | "$GH" secret set YOUTUBE_API_KEY --repo Katluver44/FTCstats && echo "Saved as GitHub secret YOUTUBE_API_KEY"
else
  echo "GitHub CLI not found: add YOUTUBE_API_KEY as a repo secret by hand."
fi
unset KEY
echo "Done."
