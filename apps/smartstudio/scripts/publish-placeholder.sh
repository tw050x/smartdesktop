#!/bin/sh
# Publishes a placeholder of @smartstudio/cli (0.0.0, nothing in it but this note) from this Mac, so
# the package exists on npm: a package has to exist before it can trust the Release workflow to
# publish it (scripts/trust-release-workflow.sh), and from then on the workflow publishes every
# real version. Sign in first (npm login), then give it a code from your authenticator:
#
#   sh scripts/publish-placeholder.sh 123456
#
# Does nothing if the package is on npm already.
set -eu
otp=${1:?Give a one-time code from your authenticator: sh scripts/publish-placeholder.sh 123456}
name=@smartstudio/cli
if npm view "$name" version >/dev/null 2>&1; then
  echo "$name is on npm already: nothing to do."
  exit 0
fi
dir=$(mktemp -d "${TMPDIR:-/tmp}/smartstudio-placeholder.XXXXXX")
trap 'rm -rf "$dir"' EXIT
cat >"$dir/package.json" <<'EOF'
{
  "name": "@smartstudio/cli",
  "version": "0.0.0",
  "description": "A placeholder for SmartStudio's command: the first real version follows shortly.",
  "license": "MIT",
  "homepage": "https://smartstudio.tw050x.net",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/tw050x/smartstudio.git",
    "directory": "packages/cli"
  },
  "files": ["README.md"]
}
EOF
cat >"$dir/README.md" <<'EOF'
# @smartstudio/cli

A placeholder. SmartStudio's command (connecting an AI app to SmartStudio) is published from
[tw050x/smartstudio](https://github.com/tw050x/smartstudio); use the latest version.
EOF
echo "publishing $name@0.0.0 (placeholder)"
(cd "$dir" && npm publish --access public --otp="$otp" --loglevel=warn)
