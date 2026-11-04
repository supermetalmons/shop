import CoreGraphics
import CoreText
import Foundation
import ImageIO

struct SheetError: Error, CustomStringConvertible {
    let description: String
    init(_ message: String) { description = message }
}

let finishes = [
    ("01-natural-eggshell", "Natural eggshell"),
    ("02-satin-ceramic", "Satin ceramic"),
    ("03-polished-lacquer", "Polished lacquer"),
    ("04-pearl-glaze", "Pearl glaze")
]
let srgb = CGColorSpace(name: CGColorSpace.sRGB)!

func bitmap(width: Int, height: Int, alpha: CGImageAlphaInfo) throws -> CGContext {
    guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                                  bytesPerRow: width * 4, space: srgb,
                                  bitmapInfo: CGBitmapInfo.byteOrder32Big.rawValue | alpha.rawValue) else {
        throw SheetError("Cannot allocate \(width) × \(height) bitmap")
    }
    return context
}

func checkedFrame(_ url: URL) throws -> CGImage {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
          CGImageSourceGetType(source) as String? == "public.png",
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
          image.width == 1400, image.height == 1400 else {
        throw SheetError("Expected a 1400 × 1400 PNG at \(url.path)")
    }
    let check = try bitmap(width: image.width, height: image.height, alpha: .premultipliedLast)
    check.setBlendMode(.copy)
    check.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
    let rgba = check.data!.assumingMemoryBound(to: UInt8.self)
    let pixels = image.width * image.height
    for i in [0, image.width - 1, pixels - image.width, pixels - 1] {
        guard (0..<4).allSatisfy({ rgba[4 * i + $0] == 255 }) else {
            throw SheetError("Expected opaque white corners in \(url.path)")
        }
    }
    switch image.alphaInfo {
    case .none, .noneSkipFirst, .noneSkipLast:
        break
    default:
        for i in 0..<pixels where rgba[4 * i + 3] != 255 {
            throw SheetError("Expected fully opaque pixels in \(url.path)")
        }
    }
    return image
}

func originalFrame(_ url: URL) throws -> CGImage {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        throw SheetError("Cannot read original artwork at \(url.path)")
    }
    // The catalog silhouette is 537 px tall on a 1024 px square. Match the studio's 80% framing.
    let side = (CGFloat(image.height) * (537.0 / 1024.0) / 0.8).rounded()
    let crop = CGRect(x: (CGFloat(image.width) - side) / 2, y: (CGFloat(image.height) - side) / 2,
                      width: side, height: side)
    guard let original = image.cropping(to: crop) else { throw SheetError("Cannot frame \(url.path)") }
    return original
}

func label(_ string: String, font: String, size: CGFloat, tone: CGFloat, x: Int, baseline: Int,
           in context: CGContext, rightAligned: Bool = false) {
    let attributes: [NSAttributedString.Key: Any] = [
        NSAttributedString.Key(kCTFontAttributeName as String): CTFontCreateWithName(font as CFString, size, nil),
        NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(gray: tone, alpha: 1)
    ]
    let line = CTLineCreateWithAttributedString(NSAttributedString(string: string, attributes: attributes))
    let offset = rightAligned ? CTLineGetTypographicBounds(line, nil, nil, nil) : 0
    context.textPosition = CGPoint(x: CGFloat(x) - offset, y: CGFloat(context.height - baseline))
    CTLineDraw(line, context)
}

func makeSheet() throws {
    let arguments = CommandLine.arguments
    guard arguments.count >= 4 else {
        throw SheetError("Usage: comparison.swift OUTPUT_DIR SOURCE_DIR ID [ID ...]")
    }
    let root = URL(fileURLWithPath: arguments[1], isDirectory: true)
    let sources = URL(fileURLWithPath: arguments[2], isDirectory: true)
    let ids = arguments.dropFirst(3)
    let margin = 36, gutter = 100, tile = 400, header = 146
    let firstColumn = margin + gutter
    let firstFinish = firstColumn + tile
    let width = firstFinish + finishes.count * tile + margin
    let height = header + ids.count * tile + margin
    let context = try bitmap(width: width, height: height, alpha: .noneSkipLast)
    context.setFillColor(CGColor(gray: 1, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    context.interpolationQuality = .high

    func rule(top: Int, tone: CGFloat) {
        context.setFillColor(CGColor(gray: tone, alpha: 1))
        context.fill(CGRect(x: margin, y: height - top - 1, width: width - 2 * margin, height: 1))
    }
    label("Egg finish studies", font: "HelveticaNeue-Medium", size: 45, tone: 0.1,
          x: margin, baseline: 65, in: context)
    label("111k  /  EGGS", font: "Menlo", size: 17, tone: 0.32,
          x: width - margin, baseline: 62, in: context, rightAligned: true)
    rule(top: 88, tone: 0.22)
    label("EGG ID", font: "Menlo", size: 15, tone: 0.32, x: margin, baseline: 126, in: context)
    label("Original 2D", font: "HelveticaNeue-Medium", size: 25, tone: 0.12,
          x: firstColumn + 18, baseline: 126, in: context)
    for (column, finish) in finishes.enumerated() {
        let x = firstFinish + column * tile
        label(String(format: "%02d", column + 1), font: "Menlo", size: 17, tone: 0.4,
              x: x + 18, baseline: 126, in: context)
        label(finish.1, font: "HelveticaNeue-Medium", size: 25, tone: 0.12,
              x: x + 56, baseline: 126, in: context)
    }
    for (row, id) in ids.enumerated() {
        let top = header + row * tile
        label("#\(id)", font: "Menlo", size: 24, tone: 0.17,
              x: margin, baseline: top + tile / 2 + 9, in: context)
        let y = height - top - tile
        let original = try originalFrame(sources.appendingPathComponent("\(id).webp"))
        context.draw(original, in: CGRect(x: firstColumn, y: y, width: tile, height: tile))
        for (column, finish) in finishes.enumerated() {
            try autoreleasepool {
                let frame = root.appendingPathComponent(finish.0).appendingPathComponent("\(id).png")
                let image = try checkedFrame(frame)
                context.draw(image, in: CGRect(x: firstFinish + column * tile, y: y, width: tile, height: tile))
            }
        }
        rule(top: top, tone: 0.85)
    }
    rule(top: height - margin, tone: 0.22)
    let output = root.appendingPathComponent("comparison.png")
    let data = NSMutableData()
    guard let image = context.makeImage(),
          let destination = CGImageDestinationCreateWithData(data, "public.png" as CFString, 1, nil) else {
        throw SheetError("Cannot encode \(output.path)")
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { throw SheetError("Cannot encode \(output.path)") }
    try (data as Data).write(to: output, options: .atomic)
}

do {
    try makeSheet()
} catch {
    FileHandle.standardError.write(Data("\(error)\n".utf8))
    exit(1)
}
