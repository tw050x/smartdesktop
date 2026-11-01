// The window the launcher shows when the AI first uses SmartDoc and the app isn't on this Mac yet:
// it asks the user whether to download it, then shows how the download is going. Started as
//
//   download-window --icon <png> --size <text>      e.g. --size "120 MB" (left out if not known)
//
// it asks first, with Download and Not now, and prints the user's answer: "download" or
// "decline". Then the launcher tells it what to show, a line at a time on standard input:
//
//   progress <fraction> <detail>   the bar (0 to 1, or -1 while it's not known) and the line below it
//   error <message>                says the download failed; the button becomes Close
//   close                          closes the window
//
// It prints "cancel" if the user cancels the download (with the button or by closing the window),
// and closes when standard input does, so it never outlives the launcher. Built by
// scripts/build-helper.mjs.
import AppKit

final class DownloadWindow: NSObject, NSApplicationDelegate, NSWindowDelegate {
  private enum Stage { case asking, downloading, failed }

  private let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 440, height: 140), styleMask: [.titled, .closable], backing: .buffered, defer: false)
  private let heading = NSTextField(labelWithString: "Download SmartDoc?")
  private let note = NSTextField(wrappingLabelWithString: "")
  private let bar = NSProgressIndicator()
  private let detail = NSTextField(labelWithString: "")
  private let primary = NSButton(title: "Download", target: nil, action: nil)
  private let secondary = NSButton(title: "Not now", target: nil, action: nil)
  private var stage = Stage.asking

  init(icon: NSImage?, size: String?) {
    super.init()
    window.title = "SmartDoc"
    window.isReleasedWhenClosed = false
    window.level = .floating
    window.delegate = self

    let image = NSImageView(image: icon ?? NSApp.applicationIconImage)
    image.imageScaling = .scaleProportionallyUpOrDown
    heading.font = .boldSystemFont(ofSize: 13)
    note.font = .systemFont(ofSize: 11)
    note.textColor = .secondaryLabelColor
    note.stringValue = "Your agent wants to use SmartDoc, which isn’t on this Mac yet. Download it now\(size.map { " (\($0))" } ?? "")? It opens by itself when it’s ready."
    bar.minValue = 0
    bar.maxValue = 1
    bar.isHidden = true
    detail.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)
    detail.textColor = .secondaryLabelColor
    primary.target = self
    primary.action = #selector(pressPrimary)
    primary.keyEquivalent = "\r"
    secondary.target = self
    secondary.action = #selector(pressSecondary)
    secondary.keyEquivalent = "\u{1b}"

    // The text and bar in a column, which closes up around whatever's hidden.
    let column = NSStackView(views: [heading, note, bar])
    column.orientation = .vertical
    column.alignment = .leading
    column.spacing = 3
    column.setCustomSpacing(12, after: note)

    let content = window.contentView!
    for view in [image, column, detail, primary, secondary] as [NSView] {
      view.translatesAutoresizingMaskIntoConstraints = false
      content.addSubview(view)
    }
    NSLayoutConstraint.activate([
      content.widthAnchor.constraint(equalToConstant: 440),
      image.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
      image.topAnchor.constraint(equalTo: content.topAnchor, constant: 18),
      image.widthAnchor.constraint(equalToConstant: 64),
      image.heightAnchor.constraint(equalToConstant: 64),

      column.leadingAnchor.constraint(equalTo: image.trailingAnchor, constant: 16),
      column.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -20),
      column.topAnchor.constraint(equalTo: content.topAnchor, constant: 18),
      note.widthAnchor.constraint(equalTo: column.widthAnchor),
      bar.widthAnchor.constraint(equalTo: column.widthAnchor),
      detail.leadingAnchor.constraint(equalTo: column.leadingAnchor),
      detail.trailingAnchor.constraint(lessThanOrEqualTo: secondary.leadingAnchor, constant: -12),
      detail.centerYAnchor.constraint(equalTo: primary.centerYAnchor),
      primary.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -20),
      primary.topAnchor.constraint(greaterThanOrEqualTo: column.bottomAnchor, constant: 14),
      primary.topAnchor.constraint(greaterThanOrEqualTo: image.bottomAnchor, constant: 8),
      primary.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -16),
      secondary.trailingAnchor.constraint(equalTo: primary.leadingAnchor, constant: -8),
      secondary.centerYAnchor.constraint(equalTo: primary.centerYAnchor),
    ])
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    window.center()
    window.makeKeyAndOrderFront(nil)
    window.orderFrontRegardless()
    if #available(macOS 14, *) { NSApp.activate() } else { NSApp.activate(ignoringOtherApps: true) }
  }

  private func say(_ word: String) {
    print(word)
    fflush(stdout)
  }

  // Download, then Cancel while downloading, or Close once it's failed.
  @objc func pressPrimary() {
    switch stage {
    case .asking:
      say("download")
      stage = .downloading
      heading.stringValue = "Downloading SmartDoc"
      note.stringValue = "This happens once. SmartDoc opens by itself when it’s ready."
      bar.isHidden = false
      bar.isIndeterminate = true
      bar.startAnimation(nil)
      detail.stringValue = "Starting…"
      secondary.isHidden = true
      primary.title = "Cancel"
      primary.keyEquivalent = "\u{1b}"
    case .downloading:
      say("cancel")
      NSApp.terminate(nil)
    case .failed:
      NSApp.terminate(nil)
    }
  }

  // Not now.
  @objc func pressSecondary() {
    say("decline")
    NSApp.terminate(nil)
  }

  func windowWillClose(_ notification: Notification) {
    switch stage {
    case .asking: say("decline")
    case .downloading: say("cancel")
    case .failed: break
    }
    NSApp.terminate(nil)
  }

  // One line from the launcher.
  func handle(_ line: String) {
    let parts = line.split(separator: " ", maxSplits: 1).map(String.init)
    guard let command = parts.first else { return }
    let rest = parts.count > 1 ? parts[1] : ""
    switch command {
    case "progress":
      guard stage == .downloading else { return }
      let fields = rest.split(separator: " ", maxSplits: 1).map(String.init)
      let fraction = Double(fields.first ?? "") ?? -1
      if fraction < 0 {
        bar.isIndeterminate = true
        bar.startAnimation(nil)
      } else {
        bar.stopAnimation(nil)
        bar.isIndeterminate = false
        bar.doubleValue = min(fraction, 1)
      }
      detail.stringValue = fields.count > 1 ? fields[1] : ""
    case "error":
      stage = .failed
      heading.stringValue = "Couldn’t download SmartDoc"
      note.stringValue = rest
      bar.isHidden = true
      detail.stringValue = ""
      secondary.isHidden = true
      primary.title = "Close"
    case "close":
      NSApp.terminate(nil)
    default:
      break
    }
  }
}

func argument(_ name: String) -> String? {
  let args = CommandLine.arguments
  guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
  return args[i + 1]
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let controller = DownloadWindow(icon: argument("--icon").flatMap { NSImage(contentsOfFile: $0) }, size: argument("--size"))
app.delegate = controller

// Standard input, a line at a time, off the main thread; its end closes the window.
Thread.detachNewThread {
  while let line = readLine() {
    DispatchQueue.main.async { controller.handle(line) }
  }
  DispatchQueue.main.async { NSApp.terminate(nil) }
}

app.run()
