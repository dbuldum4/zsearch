// zsearch-ocr: reads the text in images and in scanned PDF pages with the Vision framework.
// The engine runs it from the app bundle (Contents/Helpers) while indexing.
//
//   zsearch-ocr image <path>                       the text in an image
//   zsearch-ocr pdf <path> [--max-pages N]          every page, separated by form feeds: the text
//                                                   OCR reads on pages without text of their own,
//                                                   and nothing on the others
//
// Exits with 0 and prints the text (possibly nothing), or exits with 1 and an error on stderr.
#if os(macOS)
import AppKit
import Foundation
import PDFKit
import Vision

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

/// Lines of text Vision recognizes, top to bottom.
func recognize(_ handler: VNImageRequestHandler) throws -> String {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.automaticallyDetectsLanguage = true
    try handler.perform([request])
    let observations = request.results ?? []
    // Vision reports lines in reading order for one column; sort top to bottom, then left to right,
    // so lines on the same row stay together.
    let sorted = observations.sorted {
        let a = $0.boundingBox, b = $1.boundingBox
        if abs(a.midY - b.midY) > min(a.height, b.height) / 2 { return a.midY > b.midY }
        return a.minX < b.minX
    }
    return sorted.compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
}

/// A page rendered for OCR: about 2,000 pixels on its long side, on white.
func render(_ page: PDFPage) -> CGImage? {
    let box = page.bounds(for: .mediaBox)
    guard box.width > 0, box.height > 0 else { return nil }
    let scale = min(4, 2000 / max(box.width, box.height))
    let width = Int(box.width * scale), height = Int(box.height * scale)
    guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
    else { return nil }
    context.setFillColor(CGColor(gray: 1, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    context.scaleBy(x: scale, y: scale)
    context.translateBy(x: -box.minX, y: -box.minY)
    page.draw(with: .mediaBox, to: context)
    return context.makeImage()
}

/// Whether a page has text of its own (at least a few letters or digits).
func hasText(_ page: PDFPage) -> Bool {
    var n = 0
    for scalar in (page.string ?? "").unicodeScalars where CharacterSet.alphanumerics.contains(scalar) {
        n += 1
        if n >= 3 { return true }
    }
    return false
}

// Indexing runs in the background: so does this.
setpriority(PRIO_PROCESS, 0, 10)

let args = CommandLine.arguments
guard args.count >= 3 else { fail("usage: zsearch-ocr image <path> | pdf <path> [--max-pages N]") }
let url = URL(fileURLWithPath: args[2])

switch args[1] {
case "image":
    do {
        print(try recognize(VNImageRequestHandler(url: url)))
    } catch {
        fail("could not read the image: \(error.localizedDescription)")
    }
case "pdf":
    var maxPages = 100
    if let i = args.firstIndex(of: "--max-pages"), i + 1 < args.count, let n = Int(args[i + 1]) { maxPages = n }
    guard let document = PDFDocument(url: url) else { fail("could not open the PDF") }
    if document.isLocked { fail("document is password-protected") }
    var pages: [String] = []
    var read = 0
    for index in 0..<document.pageCount {
        guard let page = document.page(at: index), !hasText(page), read < maxPages else {
            pages.append("")
            continue
        }
        read += 1
        // Each page in a pool of its own: rendered pages are large.
        let text: String = autoreleasepool {
            guard let image = render(page) else { return "" }
            return (try? recognize(VNImageRequestHandler(cgImage: image))) ?? ""
        }
        pages.append(text)
    }
    FileHandle.standardOutput.write(Data(pages.joined(separator: "\u{0C}").utf8))
default:
    fail("unknown command \(args[1]): use image or pdf")
}
#else
import Foundation
FileHandle.standardError.write(Data("zsearch-ocr needs macOS\n".utf8))
exit(1)
#endif
