#!/bin/sh
# Lets the Release workflow (tw050x/smartdesktop, .github/workflows/release.yml) stage every app's
# npm packages that are on npm (each app's CLI, and SmartDoc's PDF converter once it's there): npm's
# trusted publishing, set per package. They trusted their own repos' workflows before the apps moved
# into this one. Signed in to npm (npm login) as a maintainer, give it a code from your authenticator;
# without one it asks you to approve each in the browser, which needs a terminal that waits.
#
#   sh scripts/trust-release-workflow.sh 123456
set -eu
otp=${1:-}
here=$(cd "$(dirname "$0")/.." && pwd)
version=$(node -p "require('$here/apps/smartdesktop/packages/app/package.json').version")
for json in "$here"/apps/*/packages/*/package.json; do
  [ "$(node -p "Boolean(require('$json').private)")" = true ] && continue
  [ "$(node -p "require('$json').version")" = "$version" ] || continue # (a package of its own version, not released with the apps)
  name=$(node -p "require('$json').name")
  if ! npx -y npm@11 view "$name" name >/dev/null 2>&1; then
    echo "$name isn't on npm yet: publish its placeholder (sh scripts/publish-placeholders.sh), then run this again"
    continue
  fi
  if npx -y npm@11 trust list "$name" 2>/dev/null | grep -q "tw050x/smartdesktop"; then
    echo "$name trusts tw050x/smartdesktop already"
  else
    # (npm refuses a second trusted publisher that could match the same token: one already set, from
    # an earlier run, counts as done.)
    if output=$(npx -y npm@11 trust github "$name" --repository tw050x/smartdesktop --file release.yml --allow-publish --yes ${otp:+--otp="$otp"} 2>&1); then
      echo "$name now trusts tw050x/smartdesktop's release.yml"
    elif printf '%s' "$output" | grep -q "already exists"; then
      echo "$name has a trusted publisher already (from an earlier run): check it's tw050x/smartdesktop's on npmjs.com if unsure"
    else
      printf '%s\n' "$output" >&2
      exit 1
    fi
  fi
done
