// Draws the app icon into an .iconset folder (run by build-app.sh, then iconutil makes the .icns).
//
//   swift macos/scripts/make-icon.swift build/AppIcon.iconset
import AppKit

let out = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "AppIcon.iconset")
try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

func render(_ px: Int) -> Data {
    let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4,
        hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
    )!
    rep.size = NSSize(width: px, height: px)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let s = CGFloat(px)

    // Body on the macOS icon grid: 80% of the canvas, continuous-looking corners.
    let inset = s * 0.1
    let body = NSRect(x: inset, y: inset * 1.1, width: s - 2 * inset, height: s - 2 * inset)
    let squircle = NSBezierPath(roundedRect: body, xRadius: body.width * 0.225, yRadius: body.width * 0.225)
    NSGraphicsContext.saveGraphicsState()
    let shadow = NSShadow()
    shadow.shadowColor = NSColor.black.withAlphaComponent(0.28)
    shadow.shadowBlurRadius = s * 0.025
    shadow.shadowOffset = NSSize(width: 0, height: -s * 0.012)
    shadow.set()
    NSGradient(
        starting: NSColor(srgbRed: 0.33, green: 0.30, blue: 0.93, alpha: 1),
        ending: NSColor(srgbRed: 0.10, green: 0.58, blue: 0.98, alpha: 1)
    )!.draw(in: squircle, angle: -65)
    NSGraphicsContext.restoreGraphicsState()

    // A page of text...
    let page = NSRect(x: body.minX + body.width * 0.17, y: body.minY + body.height * 0.2, width: body.width * 0.5, height: body.height * 0.62)
    NSColor.white.withAlphaComponent(0.95).setFill()
    NSBezierPath(roundedRect: page, xRadius: s * 0.035, yRadius: s * 0.035).fill()
    NSColor(srgbRed: 0.33, green: 0.36, blue: 0.85, alpha: 0.55).setFill()
    for i in 0..<5 {
        let width = page.width * (i == 4 ? 0.45 : i == 2 ? 0.62 : 0.74)
        let line = NSRect(x: page.minX + page.width * 0.13, y: page.maxY - page.height * (0.2 + CGFloat(i) * 0.15), width: width, height: page.height * 0.055)
        NSBezierPath(roundedRect: line, xRadius: line.height / 2, yRadius: line.height / 2).fill()
    }

    // ...and a magnifying glass over it.
    let config = NSImage.SymbolConfiguration(pointSize: s * 0.36, weight: .heavy).applying(.init(paletteColors: [.white]))
    if let glass = NSImage(systemSymbolName: "magnifyingglass", accessibilityDescription: nil)?.withSymbolConfiguration(config) {
        let size = glass.size
        let rect = NSRect(x: body.maxX - size.width - body.width * 0.08, y: body.minY + body.height * 0.08, width: size.width, height: size.height)
        NSGraphicsContext.saveGraphicsState()
        let glow = NSShadow()
        glow.shadowColor = NSColor(srgbRed: 0.1, green: 0.1, blue: 0.4, alpha: 0.45)
        glow.shadowBlurRadius = s * 0.03
        glow.set()
        glass.draw(in: rect)
        NSGraphicsContext.restoreGraphicsState()
    }

    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

for base in [16, 32, 128, 256, 512] {
    try render(base).write(to: out.appendingPathComponent("icon_\(base)x\(base).png"))
    try render(base * 2).write(to: out.appendingPathComponent("icon_\(base)x\(base)@2x.png"))
}
print("Wrote \(out.path)")
