import Foundation
import CoreGraphics
import ImageIO

struct ImageError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

func bitmap(_ image: CGImage, opaque: Bool) throws -> CGContext {
    let alpha = opaque ? CGImageAlphaInfo.noneSkipLast : CGImageAlphaInfo.premultipliedLast
    guard let space = CGColorSpace(name: CGColorSpace.sRGB),
          let context = CGContext(data: nil, width: image.width, height: image.height,
                                  bitsPerComponent: 8, bytesPerRow: image.width * 4, space: space,
                                  bitmapInfo: alpha.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else {
        throw ImageError("Cannot allocate image normalization buffer")
    }
    let rect = CGRect(x: 0, y: 0, width: image.width, height: image.height)
    if opaque {
        context.setFillColor(CGColor(gray: 1, alpha: 1))
        context.fill(rect)
    } else {
        context.setBlendMode(.copy)
    }
    context.interpolationQuality = .none
    context.draw(image, in: rect)
    return context
}

func hasTransparency(_ image: CGImage) throws -> Bool {
    switch image.alphaInfo {
    case .none, .noneSkipFirst, .noneSkipLast: return false
    default: break
    }
    let context = try bitmap(image, opaque: false)
    guard let bytes = context.data?.assumingMemoryBound(to: UInt8.self) else {
        throw ImageError("Cannot inspect image alpha")
    }
    for row in 0..<image.height {
        for column in 0..<image.width where bytes[row * context.bytesPerRow + column * 4 + 3] != 255 {
            return true
        }
    }
    return false
}

func normalize() throws {
    guard CommandLine.arguments.count == 3 else {
        throw ImageError("Usage: normalize-image INPUT OUTPUT.png")
    }
    let input = URL(fileURLWithPath: CommandLine.arguments[1]).standardizedFileURL
    let output = URL(fileURLWithPath: CommandLine.arguments[2]).standardizedFileURL
    guard input.resolvingSymlinksInPath() != output.resolvingSymlinksInPath() else {
        throw ImageError("Normalization output must differ from its source")
    }
    guard let source = CGImageSourceCreateWithURL(input as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        throw ImageError("Cannot decode artwork: \(input.path)")
    }
    let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] ?? [:]
    let orientation = (properties[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1
    guard (1...8).contains(orientation) else { throw ImageError("Invalid image orientation") }
    let profile = properties[kCGImagePropertyProfileName] as? String
    let space = image.colorSpace?.name as String?
    let srgb = [CGColorSpace.sRGB as String, CGColorSpace.extendedSRGB as String]
    let convertColor = profile != nil && !srgb.contains(space ?? "")
    let transparent = try hasTransparency(image)
    let required = orientation != 1 || convertColor || transparent
    var result: [String: Any] = ["normalized": required, "width": image.width, "height": image.height,
                                 "orientationApplied": orientation != 1, "colorConverted": convertColor,
                                 "alphaFlattened": transparent]
    if required {
        var upright = image
        if orientation != 1 {
            let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true,
                                           kCGImageSourceCreateThumbnailWithTransform: true,
                                           kCGImageSourceThumbnailMaxPixelSize: max(image.width, image.height)]
            guard let transformed = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
                throw ImageError("Cannot apply image orientation")
            }
            upright = transformed
        }
        let context = try bitmap(upright, opaque: true)
        guard let normalized = context.makeImage(),
              let destination = CGImageDestinationCreateWithURL(output as CFURL, "public.png" as CFString, 1, nil) else {
            throw ImageError("Cannot write normalized artwork")
        }
        CGImageDestinationAddImage(destination, normalized, [kCGImagePropertyOrientation: 1] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { throw ImageError("Cannot save normalized artwork") }
        result["width"] = upright.width
        result["height"] = upright.height
    }
    let encoded = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
    FileHandle.standardOutput.write(encoded)
    FileHandle.standardOutput.write(Data([10]))
}

do {
    try normalize()
} catch {
    FileHandle.standardError.write(Data("\(error)\n".utf8))
    exit(1)
}
