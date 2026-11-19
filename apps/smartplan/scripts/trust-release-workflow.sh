#!/bin/sh
# Lets the Release workflow publish @smartplan/cli: trusted publishing from GitHub Actions
# (tw050x/smartplan, .github/workflows/release.yml), set on npm once the package exists
# (scripts/publish-placeholder.sh). Signed in to npm (npm login), give it a code from your
# authenticator; without one it asks you to approve in the browser, which needs a terminal that waits.
#
#   sh scripts/trust-release-workflow.sh 123456
set -eu
name=@smartplan/cli
otp=${1:-}
if npx -y npm@11 trust list "$name" 2>/dev/null | grep -q "release.yml"; then
  echo "$name trusts release.yml already"
else
  npx -y npm@11 trust github "$name" --repository tw050x/smartplan --file release.yml --allow-publish --yes ${otp:+--otp="$otp"}
fi
