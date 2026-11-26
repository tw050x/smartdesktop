// The installer each app's website offers ("Install SmartDoc", the user's choice, 2026-11-26): one
// small native app, built for each app by build.sh, which reads which app it's for from its
// Info.plist (SmartDesktopApp, SmartDesktopAppName). It downloads that app, and SmartDesktop if it
// isn't installed (the windows and the AI chat every app opens in), from the family's latest GitHub
// release (every app released together at one version, tagged v…: each app's files named for it); checks each against its release's SHA256SUMS.txt and that it's
// signed by the installer's own developer team; installs it in /Applications (or ~/Applications),
// an old copy to the Bin; and opens the app. As @smartdesktop/ui's install-desktop.js does for an
// app that finds SmartDesktop gone.
//
// `--headless` installs with no window, saying each step (for checking it). For testing, the
// environment can move things: INSTALL_APP_RELEASES and INSTALL_DESKTOP_RELEASES
// (`owner/repo:tag prefix`), INSTALL_DIR, INSTALL_TEAM (an unsigned build has no team of its own),
// INSTALL_OPEN=0 (don't open the app after) and INSTALL_DESKTOP=1 (SmartDesktop
// too, even if it's installed).
import AppKit
import CryptoKit
import Foundation
import SwiftUI

struct InstallFailure: LocalizedError {
  let errorDescription: String?
  init(_ message: String) { errorDescription = message }
}

struct Source {
  let repo: String
  let prefix: String
  // `owner/repo:prefix` from the environment, else the family's repo with `fallback` as prefix.
  static func from(_ variable: String, fallback: String) -> Source {
    if let given = ProcessInfo.processInfo.environment[variable], let colon = given.firstIndex(of: ":") {
      return Source(repo: String(given[..<colon]), prefix: String(given[given.index(after: colon)...]))
    }
    return Source(repo: "tw050x/smartdesktop", prefix: fallback)
  }
}

struct Release: Decodable {
  struct Asset: Decodable {
    let name: String
    let browser_download_url: URL
    let size: Int
  }
  let tag_name: String
  let draft: Bool
  let prerelease: Bool
  let published_at: String
  let assets: [Asset]
}

// The installing: what's happening, as the window shows it.
// One app being installed, as the Installation step lists it.
struct Item: Identifiable {
  enum State: Equatable { case waiting, working(String), installed, skipped(String), failed }
  let id: String // its id: smartdoc, smartdesktop
  let name: String
  var state: State = .waiting
  var fraction: Double?
}

@MainActor
final class Installation: ObservableObject {
  @Published var step = ""
  @Published var fraction: Double?
  @Published var problem: String?
  @Published var running = false
  @Published var finished = false
  @Published var items: [Item] = []
  // Where it goes: /Applications, for everyone on this Mac, or ~/Applications, just for this user.
  @Published var forEveryone = FileManager.default.isWritableFile(atPath: "/Applications")
  var installedApp: URL?

  let app: String // its id: smartdoc
  let name: String // its name: SmartDoc
  let environment = ProcessInfo.processInfo.environment
  var say: (String) -> Void = { _ in }

  init() {
    let info = Bundle.main.infoDictionary ?? [:]
    app = environment["INSTALL_APP"] ?? (info["SmartDesktopApp"] as? String) ?? "smartdoc"
    name = environment["INSTALL_APP_NAME"] ?? (info["SmartDesktopAppName"] as? String) ?? "SmartDoc"
    items = [Item(id: app, name: name)] + (desktopInstalled && environment["INSTALL_DESKTOP"] != "1" ? [] : [Item(id: "smartdesktop", name: "SmartDesktop")])
  }

  var canInstallForEveryone: Bool { FileManager.default.isWritableFile(atPath: "/Applications") }

  var arch: String {
    var info = utsname()
    uname(&info)
    let machine = withUnsafePointer(to: &info.machine) { $0.withMemoryRebound(to: CChar.self, capacity: 256) { String(cString: $0) } }
    return machine.hasPrefix("arm64") ? "arm64" : "x64"
  }

  var installDir: URL {
    if let given = environment["INSTALL_DIR"] { return URL(fileURLWithPath: given) }
    return forEveryone && canInstallForEveryone ? URL(fileURLWithPath: "/Applications") : FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications")
  }

  var desktopInstalled: Bool {
    let places = ["/Applications/SmartDesktop.app", FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications/SmartDesktop.app").path, installDir.appendingPathComponent("SmartDesktop.app").path]
    return places.contains { FileManager.default.fileExists(atPath: $0) }
  }

  // Installs each item in turn (those already installed left as they are), each one's progress on
  // its row. Opening the app is the Summary's (openApp), or the end of --headless.
  func install() async {
    running = true
    problem = nil
    var current = 0
    do {
      let team = try expectedTeam()
      for index in items.indices where items[index].state != .installed {
        current = index
        let item = items[index]
        let source = item.id == "smartdesktop" ? Source.from("INSTALL_DESKTOP_RELEASES", fallback: "v") : Source.from("INSTALL_APP_RELEASES", fallback: "v")
        let path = try await installLatest(source, appId: item.id, appName: item.name, team: team)
        items[index].state = .installed
        items[index].fraction = nil
        if item.id == app { installedApp = path }
      }
      if !items.contains(where: { $0.id == "smartdesktop" }) { say("SmartDesktop is installed already") }
      finished = true
    } catch {
      problem = error.localizedDescription
      if items.indices.contains(current) { items[current].state = .failed }
      say("Couldn’t install: \(error.localizedDescription)")
    }
    running = false
  }

  func openApp() async {
    guard let installedApp, environment["INSTALL_OPEN"] != "0" else { return }
    _ = try? await NSWorkspace.shared.openApplication(at: installedApp, configuration: NSWorkspace.OpenConfiguration())
  }

  // What's happening now, on the row of the item being installed.
  func show(_ text: String, _ part: Double? = nil) {
    step = text
    fraction = part
    if let index = items.firstIndex(where: { if case .installed = $0.state { return false }; return text.hasSuffix($0.name) || text.contains("\($0.name)’s") }) {
      items[index].state = .working(text)
      items[index].fraction = part
    }
    say(part.map { "\(text) \(Int(($0 * 100).rounded()))%" } ?? text)
  }

  // The team the downloads must be signed by: the installer's own (INSTALL_TEAM for an unsigned build).
  func expectedTeam() throws -> String {
    if let given = environment["INSTALL_TEAM"], !given.isEmpty { return given }
    if let own = try? teamOf(Bundle.main.bundleURL) { return own }
    throw InstallFailure("This installer isn’t signed, so there’s no team to check the apps against")
  }

  func run(_ tool: String, _ arguments: [String]) throws -> (status: Int32, output: String) {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: tool)
    process.arguments = arguments
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = pipe
    try process.run()
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    return (process.terminationStatus, String(decoding: data, as: UTF8.self))
  }

  // The developer team an app is signed by, after checking its signature holds.
  func teamOf(_ app: URL) throws -> String {
    let verified = try run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app.path])
    if verified.status != 0 { throw InstallFailure("\(app.lastPathComponent)’s signature doesn’t hold") }
    let details = try run("/usr/bin/codesign", ["-dv", "--verbose=2", app.path]).output
    guard let line = details.split(separator: "\n").first(where: { $0.hasPrefix("TeamIdentifier=") }) else { throw InstallFailure("\(app.lastPathComponent) isn’t signed by a team") }
    return String(line.dropFirst("TeamIdentifier=".count))
  }

  // Finds, downloads, checks and installs an app (`appId`, called `appName`) from the latest release
  // of `source`: its zip for this Mac, <appId>-<version>-mac-<arch>.zip.
  func installLatest(_ source: Source, appId: String, appName: String, team: String) async throws -> URL {
    show("Finding the latest \(appName)")
    var request = URLRequest(url: URL(string: "https://api.github.com/repos/\(source.repo)/releases?per_page=50")!)
    request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
    let (listing, response) = try await URLSession.shared.data(for: request)
    guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw InstallFailure("GitHub didn’t list \(appName)’s releases") }
    let releases = try JSONDecoder().decode([Release].self, from: listing)
      .filter { !$0.draft && !$0.prerelease && $0.tag_name.hasPrefix(source.prefix) }
      .sorted { $0.published_at > $1.published_at }
    guard let release = releases.first else { throw InstallFailure("There’s no \(appName) release yet") }
    guard let zip = release.assets.first(where: { $0.name.hasPrefix("\(appId)-") && $0.name.hasSuffix("-mac-\(arch).zip") }) else { throw InstallFailure("\(appName)’s release has nothing for this Mac") }
    guard let sums = release.assets.first(where: { $0.name == "SHA256SUMS.txt" }) else { throw InstallFailure("\(appName)’s release has no SHA256SUMS.txt to check it against") }
    let (sumsData, _) = try await URLSession.shared.data(from: sums.browser_download_url)
    let expected = String(decoding: sumsData, as: UTF8.self).split(separator: "\n").compactMap { line -> String? in
      let parts = line.split(whereSeparator: { $0 == " " || $0 == "*" })
      return parts.count >= 2 && parts.last.map(String.init) == zip.name ? parts.first.map { $0.lowercased() } : nil
    }.first
    guard let expected else { throw InstallFailure("SHA256SUMS.txt doesn’t list \(zip.name)") }

    let work = FileManager.default.temporaryDirectory.appendingPathComponent("install-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: work) }
    let file = work.appendingPathComponent(zip.name)
    try await download(zip.browser_download_url, to: file, size: zip.size, label: "Downloading \(appName)")

    show("Checking \(appName)")
    guard try sha256(of: file) == expected else { throw InstallFailure("\(appName)’s download doesn’t match its checksum, so it wasn’t installed") }
    let unpacked = work.appendingPathComponent("unpacked")
    if try run("/usr/bin/ditto", ["-x", "-k", file.path, unpacked.path]).status != 0 { throw InstallFailure("\(appName)’s download couldn’t be unpacked") }
    let bundle = unpacked.appendingPathComponent("\(appName).app")
    guard FileManager.default.fileExists(atPath: bundle.path) else { throw InstallFailure("The download has no \(appName).app") }
    let theirs = try teamOf(bundle)
    guard theirs == team else { throw InstallFailure("\(appName) is signed by \(theirs), not \(team), so it wasn’t installed") }

    show("Installing \(appName)")
    let dir = installDir
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let target = dir.appendingPathComponent("\(appName).app")
    if FileManager.default.fileExists(atPath: target.path) { try FileManager.default.trashItem(at: target, resultingItemURL: nil) }
    try FileManager.default.moveItem(at: bundle, to: target)
    return target
  }

  func sha256(of file: URL) throws -> String {
    let handle = try FileHandle(forReadingFrom: file)
    defer { try? handle.close() }
    var hash = SHA256()
    while let chunk = try handle.read(upToCount: 1 << 20), !chunk.isEmpty { hash.update(data: chunk) }
    return hash.finalize().map { String(format: "%02x", $0) }.joined()
  }

  func download(_ url: URL, to file: URL, size: Int, label: String) async throws {
    show(label, 0)
    let watcher = DownloadProgress(to: file) { [weak self] received, total in
      let whole = total > 0 ? total : Int64(size)
      Task { @MainActor in self?.show(label, whole > 0 ? Double(received) / Double(whole) : nil) }
    }
    // A session of its own, whose delegate hears the bytes arrive (the async download call doesn't
    // pass progress on).
    let session = URLSession(configuration: .default, delegate: watcher, delegateQueue: nil)
    defer { session.finishTasksAndInvalidate() }
    try await withCheckedThrowingContinuation { (done: CheckedContinuation<Void, Error>) in
      watcher.done = { done.resume(with: $0) }
      session.downloadTask(with: url).resume()
    }
  }
}

// A download: its progress as the bytes arrive (a whole percent at a time), the file put at `file`
// once it's in, and `done` once it's over.
final class DownloadProgress: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
  let file: URL
  let changed: (Int64, Int64) -> Void
  var done: (Result<Void, Error>) -> Void = { _ in }
  var shown = -1
  var failure: Error?
  init(to file: URL, _ changed: @escaping (Int64, Int64) -> Void) {
    self.file = file
    self.changed = changed
  }
  func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData written: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
    let percent = totalBytesExpectedToWrite > 0 ? Int(totalBytesWritten * 100 / totalBytesExpectedToWrite) : -1
    if percent == shown { return }
    shown = percent
    changed(totalBytesWritten, totalBytesExpectedToWrite)
  }
  // (macOS removes `location` once this returns, so the file is moved now.)
  func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
    guard (downloadTask.response as? HTTPURLResponse)?.statusCode == 200 else {
      failure = InstallFailure("The download failed")
      return
    }
    do { try FileManager.default.moveItem(at: location, to: file) } catch { failure = error }
  }
  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    if let error = error ?? failure { done(.failure(error)) } else { done(.success(())) }
  }
}

// A wizard, as a Mac installer is (the user's choice): its steps listed down the left, the current
// one marked; each step's page on the right; Go Back and Continue along the bottom.
enum Step: Int, CaseIterable {
  case introduction, destination, installation, summary
  var title: String { ["Introduction", "Destination", "Installation", "Summary"][rawValue] }
}

struct InstallerView: View {
  @ObservedObject var installation: Installation
  @State private var step = Step.introduction

  var body: some View {
    VStack(spacing: 0) {
      HStack(alignment: .top, spacing: 0) {
        // The steps.
        VStack(alignment: .leading, spacing: 10) {
          ForEach(Step.allCases, id: \.self) { one in
            HStack(spacing: 8) {
              Circle()
                .fill(one == step ? Color.accentColor : one.rawValue < step.rawValue ? Color.secondary : Color.secondary.opacity(0.3))
                .frame(width: 8, height: 8)
              Text(one.title)
                .fontWeight(one == step ? .semibold : .regular)
                .foregroundStyle(one.rawValue <= step.rawValue ? .primary : .secondary)
            }
          }
          Spacer()
        }
        .padding(20)
        .frame(width: 170, alignment: .leading)
        .frame(maxHeight: .infinity)
        .background(.quaternary.opacity(0.5))
        Divider()
        // The step's page.
        VStack(alignment: .leading, spacing: 14) {
          page
          Spacer(minLength: 0)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      }
      Divider()
      buttons.padding(.horizontal, 20).padding(.vertical, 14)
    }
    .frame(width: 640, height: 420)
  }

  @ViewBuilder var page: some View {
    switch step {
    case .introduction:
      Text("Welcome to \(installation.name)").font(.title2).fontWeight(.semibold)
      Text("\(installation.name) opens in SmartDesktop, which holds the windows and the AI chat for all your apps.")
        .fixedSize(horizontal: false, vertical: true)
      Text("This installs:").padding(.top, 4)
      VStack(alignment: .leading, spacing: 6) {
        ForEach(installation.items) { item in
          Label(item.name, systemImage: "app.badge").labelStyle(.titleAndIcon)
        }
      }
      if installation.items.count == 1 {
        Text("SmartDesktop is installed already, so only \(installation.name) is added.").foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      }
      Text("Each is downloaded from its latest release and checked to be genuine before it’s installed. After that they keep themselves up to date.")
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
    case .destination:
      Text("Where to install").font(.title2).fontWeight(.semibold)
      Picker("", selection: $installation.forEveryone) {
        Text("For everyone on this Mac (Applications)").tag(true)
        Text("Just for me (Applications in your home folder)").tag(false)
      }
      .pickerStyle(.radioGroup)
      .labelsHidden()
      .disabled(!installation.canInstallForEveryone)
      if !installation.canInstallForEveryone {
        Text("You can’t add apps to Applications for everyone on this Mac, so they go in your own.").foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      }
    case .installation:
      Text(installation.finished ? "Installed" : installation.running ? "Installing…" : "Ready to install").font(.title2).fontWeight(.semibold)
      VStack(alignment: .leading, spacing: 14) {
        ForEach(installation.items) { item in row(item) }
      }
      if let problem = installation.problem {
        Text("Couldn’t install: \(problem)").foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
      }
    case .summary:
      Text("\(installation.name) is installed").font(.title2).fontWeight(.semibold)
      Text("Open it to start. It opens in SmartDesktop, with your AI chat beside it.")
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  func row(_ item: Item) -> some View {
    VStack(alignment: .leading, spacing: 5) {
      HStack {
        Text(item.name).fontWeight(.medium)
        Spacer()
        switch item.state {
        case .installed: Label("Installed", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
        case .failed: Label("Not installed", systemImage: "xmark.circle.fill").foregroundStyle(.red)
        case .skipped(let why): Text(why).foregroundStyle(.secondary)
        case .waiting: Text("Waiting").foregroundStyle(.secondary)
        case .working(let what): Text(what).foregroundStyle(.secondary)
        }
      }
      if case .working = item.state {
        if let part = item.fraction { ProgressView(value: part) } else { ProgressView().progressViewStyle(.linear) }
      }
    }
  }

  @ViewBuilder var buttons: some View {
    HStack {
      if step == .summary {
        Spacer()
        Button("Close") { NSApp.terminate(nil) }.keyboardShortcut(.cancelAction)
        Button("Open \(installation.name)") {
          Task {
            await installation.openApp()
            NSApp.terminate(nil)
          }
        }.keyboardShortcut(.defaultAction)
      } else {
        Button("Cancel") { NSApp.terminate(nil) }.keyboardShortcut(.cancelAction).disabled(installation.running)
        Spacer()
        Button("Go Back") { step = Step(rawValue: step.rawValue - 1) ?? .introduction }
          .disabled(step == .introduction || installation.running || installation.finished)
        Button(continueLabel) { advance() }
          .keyboardShortcut(.defaultAction)
          .disabled(installation.running)
      }
    }
  }

  var continueLabel: String {
    switch step {
    case .destination: return "Install"
    case .installation: return installation.finished ? "Continue" : installation.problem == nil ? "Install" : "Try Again"
    default: return "Continue"
    }
  }

  func advance() {
    switch step {
    case .introduction: step = .destination
    case .destination:
      step = .installation
      Task { await installation.install() }
    case .installation:
      if installation.finished { step = .summary } else { Task { await installation.install() } }
    case .summary: break
    }
  }
}

struct InstallerApp: App {
  @StateObject private var installation = Installation()
  var body: some Scene {
    Window("Install \(installation.name)", id: "install") { InstallerView(installation: installation) }
      .windowResizability(.contentSize)
  }
}

@main
enum Main {
  static func main() async {
    if CommandLine.arguments.contains("--headless") {
      let installation = await MainActor.run { () -> Installation in
        let made = Installation()
        made.say = { print($0) }
        return made
      }
      await installation.install()
      let failed = await MainActor.run { installation.problem != nil }
      if !failed { await installation.openApp() }
      exit(failed ? 1 : 0)
    }
    InstallerApp.main()
  }
}
