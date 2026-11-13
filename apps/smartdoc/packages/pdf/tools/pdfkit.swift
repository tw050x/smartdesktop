// Renders PDF pages to PNGs with Apple's PDFKit, as Preview shows them (the crop box, the page's
// rotation, annotations): the reference the reader's drawing is measured against.
//   swift pdfkit.swift <file.pdf> <out-prefix> <scale> [max pages]   →  <out-prefix>-1.png …
// Prints the number of pages rendered; a page's pixel size is its crop box times the scale,
// rounded down, as the reader's viewport gives it.
import AppKit
import PDFKit

let args = CommandLine.arguments
guard args.count >= 4, let doc = PDFDocument(url: URL(fileURLWithPath: args[1])), let scale = Double(args[3]) else {
  FileHandle.standardError.write("usage: pdfkit <file.pdf> <out-prefix> <scale> [max pages]\n".data(using: .utf8)!)
  exit(1)
}
let maxPages = args.count > 4 ? Int(args[4]) ?? 1000 : 1000
var count = 0
for i in 0..<min(doc.pageCount, maxPages) {
  guard let page = doc.page(at: i) else { continue }
  let box = page.bounds(for: .cropBox)
  let rotated = page.rotation % 180 != 0
  let w = Int((rotated ? box.height : box.width) * scale)
  let h = Int((rotated ? box.width : box.height) * scale)
  if w < 1 || h < 1 { continue }
  let image = page.thumbnail(of: NSSize(width: Double(w), height: Double(h)), for: .cropBox)
  let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: w, pixelsHigh: h, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  rep.size = NSSize(width: w, height: h)
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  NSColor.white.setFill()
  NSRect(x: 0, y: 0, width: w, height: h).fill()
  image.draw(in: NSRect(x: 0, y: 0, width: w, height: h))
  NSGraphicsContext.restoreGraphicsState()
  try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "\(args[2])-\(i + 1).png"))
  count += 1
}
print(count)
