#!/bin/sh
# Lets the Release workflow publish @smartplan/cli: trusted publishing from GitHub Actions
# (tw050x/smartplan, .github/workflows/release.yml), set on npm once the package exists
# (scripts/publish-placeholder.sh). Run it in a terminal, signed in to npm (npm login): it asks
# you to approve in the browser.
set -eu
name=@smartplan/cli
if npx -y npm@11 trust list "$name" 2>/dev/null | grep -q "release.yml"; then
  echo "$name trusts release.yml already"
else
  npx -y npm@11 trust github "$name" --repository tw050x/smartplan --file release.yml --allow-publish --yes
fi
