#!/bin/bash
# Sets the GitHub secrets the Release workflow signs and notarises with (see
# .github/workflows/release.yml), asking for each value. Values are typed or pasted at hidden
# prompts and piped straight to `gh secret set`: they're never shown or written to a file. (Two
# checks, of the .p12's password and of the Apple details, pass a password on a command line for a
# moment; see below.) Run it in your own terminal, from anywhere, with the Developer ID Application
# certificate's .p12 file, or without it to be asked for it:
#
#   bash scripts/set-release-secrets.sh [path/to/DeveloperID.p12]
#
# It needs the GitHub CLI signed in with access to the repository. Leave a value empty to keep that
# secret as it is.

set -euo pipefail

REPO="tw050x/smartdoc"

say() { printf '\n%s\n' "$*"; }
fail() { printf '\nStopped: %s\n' "$*" >&2; exit 1; }

# Reads a value at a hidden prompt into the named variable.
ask_hidden() {
  local prompt=$1 name=$2 value
  IFS= read -r -s -p "$prompt" value
  printf '\n'
  printf -v "$name" '%s' "$value"
}

# Sets a secret from standard input, if it isn't empty.
set_secret() {
  local name=$1
  gh secret set "$name" --repo "$REPO" >/dev/null
  printf '  ✓ %s set\n' "$name"
}

command -v gh >/dev/null || fail "the GitHub CLI (gh) isn't installed: brew install gh"
gh auth status >/dev/null 2>&1 || fail "the GitHub CLI isn't signed in: gh auth login"
gh repo view "$REPO" >/dev/null 2>&1 || fail "the GitHub CLI can't see $REPO"

say "Setting the release secrets for $REPO. Values you type or paste aren't shown."

# --- The Developer ID certificate (CSC_LINK, CSC_KEY_PASSWORD) ---------------------------------

say "1. The Developer ID Application certificate, exported from Keychain Access as a .p12."
p12=${1:-}
if [ -n "$p12" ]; then
  printf '   %s\n' "$p12"
else
  IFS= read -r -p "   Its file (drag it here), or press Return to skip: " p12
fi
# A dragged file's path may come quoted, or with its spaces escaped.
p12=${p12%"${p12##*[![:space:]]}"}
p12=${p12#\'}; p12=${p12%\'}; p12=${p12#\"}; p12=${p12%\"}
p12=${p12//\\ / }
if [ -n "$p12" ]; then
  [ -f "$p12" ] || fail "there's no file at $p12"
  ask_hidden "   The password you exported it with: " p12_password
  # Checks the password opens it before uploading either, with macOS's own tools: the import goes
  # to a throwaway keychain that's deleted straight after. (security takes the password on its
  # command line, so it's in this Mac's process list for that moment.)
  check_keychain=$(mktemp -u "${TMPDIR:-/tmp}/smartdoc-check.XXXXXX").keychain
  check_password=$(uuidgen)
  security create-keychain -p "$check_password" "$check_keychain" >/dev/null
  trap 'security delete-keychain "$check_keychain" >/dev/null 2>&1 || true' EXIT
  if ! security import "$p12" -k "$check_keychain" -f pkcs12 -P "$p12_password" >/dev/null 2>&1; then
    fail "the password doesn't open that .p12 (nothing was uploaded)"
  fi
  identity=$(security find-identity -p codesigning "$check_keychain" | grep -o '"Developer ID Application: [^"]*"' | head -1 || true)
  security delete-keychain "$check_keychain" >/dev/null 2>&1 || true
  trap - EXIT
  [ -n "$identity" ] || fail "that .p12 doesn't hold a Developer ID Application certificate (nothing was uploaded)"
  printf '   Found %s\n' "$identity"
  base64 -i "$p12" | set_secret CSC_LINK
  printf '%s' "$p12_password" | set_secret CSC_KEY_PASSWORD
  unset p12_password
  # The team ID is in the certificate's name: "Developer ID Application: Name (TEAMID)".
  team_from_cert=$(sed -n 's/.*(\([A-Z0-9]\{10\}\))"$/\1/p' <<<"$identity")
fi

# --- Notarising (APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID) --------------------------

say "2. Notarising: your Apple Account, an app-specific password for it, and your team ID."
IFS= read -r -p "   Apple Account email, or press Return to skip: " apple_id
if [ -n "$apple_id" ]; then
  ask_hidden "   App-specific password (from account.apple.com): " apple_password
  [ -n "$apple_password" ] || fail "the app-specific password is needed with the Apple Account"
  team=${team_from_cert:-}
  if [ -n "$team" ]; then
    IFS= read -r -p "   Team ID [$team, from the certificate]: " typed
    team=${typed:-$team}
  else
    IFS= read -r -p "   Team ID (developer.apple.com → Membership details): " team
  fi
  [[ "$team" =~ ^[A-Z0-9]{10}$ ]] || fail "a team ID is 10 letters and numbers"
  # Checks Apple accepts them, by asking the notary service for its history. (notarytool takes
  # the password on its command line, so it's in this Mac's process list for that moment.)
  printf '   Checking with Apple…\n'
  if ! xcrun notarytool history --apple-id "$apple_id" --team-id "$team" --password "$apple_password" >/dev/null 2>&1; then
    fail "Apple didn't accept that Apple Account, app-specific password and team ID (nothing was uploaded for them)"
  fi
  printf '%s' "$apple_id" | set_secret APPLE_ID
  printf '%s' "$apple_password" | set_secret APPLE_APP_SPECIFIC_PASSWORD
  printf '%s' "$team" | set_secret APPLE_TEAM_ID
  unset apple_password
fi

say "Done. The secrets $REPO has now (names only):"
gh secret list --repo "$REPO" | awk '{ print "   " $1 }'
