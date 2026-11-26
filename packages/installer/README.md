# The installer

The installer each app's website offers ("Install SmartDoc"): a small native Mac app (`Installer.swift`,
SwiftUI, no dependencies) that downloads the latest release of its app, and of SmartDesktop if it
isn't installed, from the family's GitHub releases (tw050x/smartdesktop, tags `<app>-v…` and
`smartdesktop-v…`); checks each against its release's `SHA256SUMS.txt` and that it's signed by the
installer's own developer team; installs it in `/Applications` (or `~/Applications`), an old copy to
the Bin; and opens the app.

    ./build.sh smartdoc SmartDoc [out folder]   # → "Install SmartDoc.app", Apple silicon and Intel

The build is unsigned: the release workflow signs and notarises it, as it does the apps. `--headless`
installs with no window, saying each step. For testing, the environment moves things:
`INSTALL_APP_RELEASES` and `INSTALL_DESKTOP_RELEASES` (`owner/repo:tag prefix`), `INSTALL_DIR`,
`INSTALL_TEAM` (an unsigned build has no team of its own) and `INSTALL_OPEN=0`.
