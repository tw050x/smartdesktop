#!/bin/sh
# build.sh <app id> <App name> [out folder]: builds the installer for one app ("Install SmartDoc.app"),
# for Apple silicon and Intel Macs both, with the app's icon. Signing and notarising are the release
# workflow's (as the apps'), which this leaves unsigned for.
set -e
APP=$1
NAME=$2
OUT=${3:-dist}
[ -n "$APP" ] && [ -n "$NAME" ] || { echo "usage: build.sh <app id> <App name> [out folder]"; exit 2; }
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$OUT"
BUNDLE="$OUT/Install $NAME.app"
rm -rf "$BUNDLE"
mkdir -p "$BUNDLE/Contents/MacOS" "$BUNDLE/Contents/Resources"
for ARCH in arm64 x86_64; do
  swiftc -parse-as-library -O -target "$ARCH-apple-macos14.0" "$HERE/Installer.swift" -o "$OUT/.installer-$ARCH"
done
lipo -create "$OUT/.installer-arm64" "$OUT/.installer-x86_64" -output "$BUNDLE/Contents/MacOS/Install $NAME"
rm -f "$OUT/.installer-arm64" "$OUT/.installer-x86_64"
ICON="$HERE/../../apps/$APP/packages/app/resources/icon.icns"
[ -f "$ICON" ] && cp "$ICON" "$BUNDLE/Contents/Resources/AppIcon.icns"
cat > "$BUNDLE/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>com.tw050x.install-$APP</string>
  <key>CFBundleName</key><string>Install $NAME</string>
  <key>CFBundleDisplayName</key><string>Install $NAME</string>
  <key>CFBundleExecutable</key><string>Install $NAME</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>SmartDesktopApp</key><string>$APP</string>
  <key>SmartDesktopAppName</key><string>$NAME</string>
</dict>
</plist>
PLIST
echo "$BUNDLE"
