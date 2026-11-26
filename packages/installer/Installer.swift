// The installer each app's website offers ("Install SmartDoc", the user's choice, 2026-11-26): one
// small native app, built for each app by build.sh, which reads which app it's for from its
// Info.plist (SmartDesktopApp, SmartDesktopAppName). It downloads the latest release of that app,
// and of SmartDesktop if it isn't installed (the windows and the AI chat every app opens in), from
// the family's GitHub releases; checks each against its release's SHA256SUMS.txt and that it's
// signed by the installer's own developer team; installs it in /Applications (or ~/Applications),
// an old copy to the Bin; and opens the app. As @smartdesktop/ui's install-desktop.js does for an
// app that finds SmartDesktop gone.
//
// `--headless` installs with no window, saying each step (for checking it). For testing, the
// environment can move things: INSTALL_APP_RELEASES and INSTALL_DESKTOP_RELEASES
// (`owner/repo:tag prefix`), INSTALL_DIR, INSTALL_TEAM (an unsigned build has no team of its own),
// and INSTALL_OPEN=0 (don't open the app after).
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
@MainActor
final class Installation: ObservableObject {
  @Published var step = ""
  @Published var fraction: Double?
  @Published var problem: String?
  @Published var running = false
  @Published var finished = false

  let app: String // its id: smartdoc
  let name: String // its name: SmartDoc
  let environment = ProcessInfo.processInfo.environment
  var say: (String) -> Void = { _ in }

  init() {
    let info = Bundle.main.infoDictionary ?? [:]
    app = environment["INSTALL_APP"] ?? (info["SmartDesktopApp"] as? String) ?? "smartdoc"
    name = environment["INSTALL_APP_NAME"] ?? (info["SmartDesktopAppName"] as? String) ?? "SmartDoc"
  }

  var arch: String {
    var info = utsname()
    uname(&info)
    let machine = withUnsafePointer(to: &info.machine) { $0.withMemoryRebound(to: CChar.self, capacity: 256) { String(cString: $0) } }
    return machine.hasPrefix("arm64") ? "arm64" : "x64"
  }

  var installDir: URL {
    if let given = environment["INSTALL_DIR"] { return URL(fileURLWithPath: given) }
    return FileManager.default.isWritableFile(atPath: "/Applications") ? URL(fileURLWithPath: "/Applications") : FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications")
  }

  var desktopInstalled: Bool {
    let places = ["/Applications/SmartDesktop.app", FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications/SmartDesktop.app").path, installDir.appendingPathComponent("SmartDesktop.app").path]
    return places.contains { FileManager.default.fileExists(atPath: $0) }
  }

  func install() async {
    running = true
    problem = nil
    do {
      let team = try expectedTeam()
      let appPath = try await installLatest(Source.from("INSTALL_APP_RELEASES", fallback: "\(app)-v"), appName: name, team: team)
      if !desktopInstalled {
        _ = try await installLatest(Source.from("INSTALL_DESKTOP_RELEASES", fallback: "smartdesktop-v"), appName: "SmartDesktop", team: team)
      } else {
        show("SmartDesktop is installed already")
      }
      show("Opening \(name)")
      if environment["INSTALL_OPEN"] != "0" {
        let configuration = NSWorkspace.OpenConfiguration()
        _ = try await NSWorkspace.shared.openApplication(at: appPath, configuration: configuration)
      }
      finished = true
    } catch {
      problem = error.localizedDescription
      say("Couldn’t install: \(error.localizedDescription)")
    }
    running = false
  }

  func show(_ text: String, _ part: Double? = nil) {
    step = text
    fraction = part
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

  // Finds, downloads, checks and installs the latest release of `source` (an app called `appName`).
  func installLatest(_ source: Source, appName: String, team: String) async throws -> URL {
    show("Finding the latest \(appName)")
    var request = URLRequest(url: URL(string: "https://api.github.com/repos/\(source.repo)/releases?per_page=50")!)
    request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
    let (listing, response) = try await URLSession.shared.data(for: request)
    guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw InstallFailure("GitHub didn’t list \(appName)’s releases") }
    let releases = try JSONDecoder().decode([Release].self, from: listing)
      .filter { !$0.draft && !$0.prerelease && $0.tag_name.hasPrefix(source.prefix) }
      .sorted { $0.published_at > $1.published_at }
    guard let release = releases.first else { throw InstallFailure("There’s no \(appName) release yet") }
    guard let zip = release.assets.first(where: { $0.name.hasSuffix("-mac-\(arch).zip") }) else { throw InstallFailure("\(appName)’s release has nothing for this Mac") }
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

struct InstallerView: View {
  @ObservedObject var installation: Installation

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Install \(installation.name)").font(.headline)
      Text("\(installation.name) opens in SmartDesktop, which holds the windows and the AI chat for all your apps. This installs both (SmartDesktop only if you don’t have it), checks they’re genuine, and opens \(installation.name).")
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
      if installation.running || installation.finished {
        VStack(alignment: .leading, spacing: 6) {
          Text(installation.finished ? "Done" : installation.step).font(.caption).foregroundStyle(.secondary)
          if let part = installation.fraction { ProgressView(value: part) } else { ProgressView().progressViewStyle(.linear) }
        }
      }
      if let problem = installation.problem {
        Text("Couldn’t install: \(problem)").foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
      }
      HStack {
        Button("Cancel") { NSApp.terminate(nil) }.keyboardShortcut(.cancelAction).disabled(installation.running)
        Spacer()
        Button(installation.problem == nil ? "Install" : "Try Again") { Task { await installation.install() } }
          .keyboardShortcut(.defaultAction)
          .disabled(installation.running || installation.finished)
      }
    }
    .padding(22)
    .frame(width: 460)
    .onChange(of: installation.finished) { _, done in
      if done { DispatchQueue.main.asyncAfter(deadline: .now() + 1) { NSApp.terminate(nil) } }
    }
  }
}

struct InstallerApp: App {
  @StateObject private var installation = Installation()
  var body: some Scene {
    Window("Install", id: "install") { InstallerView(installation: installation) }
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
      exit(failed ? 1 : 0)
    }
    InstallerApp.main()
  }
}
