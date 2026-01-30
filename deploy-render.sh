#!/usr/bin/env bash
# Déclenche un déploiement sur Render via le Deploy Hook.
# Usage:
#   RENDER_DEPLOY_HOOK_URL="https://api.render.com/..." ./deploy-render.sh
#   ou: ./deploy-render.sh "https://api.render.com/..."
set -e
URL="${1:-$RENDER_DEPLOY_HOOK_URL}"
if [ -z "$URL" ]; then
  echo "Usage: RENDER_DEPLOY_HOOK_URL=<url> ./deploy-render.sh"
  echo "   ou: ./deploy-render.sh <url>"
  echo "URL du Deploy Hook: Render Dashboard → ws-media-stream-server → Settings → Deploy Hook"
  exit 1
fi
echo "Déclenchement du déploiement Render..."
curl -f -X POST "$URL"
echo ""
echo "Demande de déploiement envoyée à Render."
