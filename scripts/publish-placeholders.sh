#!/bin/sh
# Publishes a placeholder (0.0.0, nothing in it but a note) of each of the apps' npm packages that
# isn't on npm yet and is released with the apps (on the family's version: each app's CLI, SmartDoc's
# PDF converter), so it exists: a package has to exist before it can trust the Release workflow to
# publish it (scripts/trust-release-workflow.sh, run after this), which then publishes every real
# version. Signed in to npm (npm login), it asks for a fresh code from your authenticator before each
# one (a code lasts about 30 seconds).
#
#   sh scripts/publish-placeholders.sh
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
version=$(node -p "require('$here/apps/smartdesktop/packages/app/package.json').version")
for json in "$here"/apps/*/packages/*/package.json; do
  [ "$(node -p "Boolean(require('$json').private)")" = true ] && continue
  [ "$(node -p "require('$json').version")" = "$version" ] || continue # (a package of its own version)
  name=$(node -p "require('$json').name")
  if npx -y npm@11 view "$name" version >/dev/null 2>&1; then
    echo "$name is on npm already"
    continue
  fi
  folder=$(dirname "$json")
  app=$(basename "$(dirname "$(dirname "$folder")")")
  directory=${folder#"$here"/}
  description=$(node -p "require('$json').description ?? ''")
  dir=$(mktemp -d "${TMPDIR:-/tmp}/placeholder.XXXXXX")
  cat >"$dir/package.json" <<JSON
{
  "name": "$name",
  "version": "0.0.0",
  "description": "A placeholder: the first real version follows shortly. $description",
  "license": "MIT",
  "homepage": "https://github.com/tw050x/smartdesktop/tree/master/apps/$app",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/tw050x/smartdesktop.git",
    "directory": "$directory"
  },
  "files": ["README.md"]
}
JSON
  cat >"$dir/README.md" <<README
# $name

A placeholder. $name is published from [tw050x/smartdesktop](https://github.com/tw050x/smartdesktop/tree/master/$directory); use the latest version.
README
  printf 'Code from your authenticator for %s: ' "$name"
  read -r otp
  echo "publishing $name@0.0.0 (placeholder)"
  (cd "$dir" && npx -y npm@11 publish --access public --otp="$otp" --loglevel=warn)
  rm -rf "$dir"
done
echo "Now run: sh scripts/trust-release-workflow.sh <code>"
