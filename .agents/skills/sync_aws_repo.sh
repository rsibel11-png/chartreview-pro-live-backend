#!/bin/bash
# Syncs chartreview-aws changes to GitHub
# Run this after any AWS file edits

set -e

REPO_DIR="/app/chartreview-aws"
GITHUB_REPO="rsibel11-png/chartreview-pro-aws"

cd "$REPO_DIR"

git config user.email "friday@base44.app"
git config user.name "Friday"
git remote set-url origin "https://rsibel11-png:${GITHUB_ACCESS_TOKEN}@github.com/${GITHUB_REPO}.git"

git add -A

if git diff --cached --quiet; then
  echo "No changes to commit — repo already up to date."
  exit 0
fi

TIMESTAMP=$(date -u +"%Y-%m-%d %H:%M UTC")
MSG="${1:-Auto-sync: $TIMESTAMP}"

git commit -m "$MSG"
git push origin main

echo "✅ Pushed: $MSG"
