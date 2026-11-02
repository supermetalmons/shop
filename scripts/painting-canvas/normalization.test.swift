import Foundation
import CoreGraphics
import ImageIO

struct TestError: Error { let message: String }
func check(_ condition: Bool, _ message: String) throws {
    if !condition { throw TestError(message: message) }
}
let srgb = CGColorSpace(name: CGColorSpace.sRGB)!
func raster(_ width: Int, _ height: Int, _ pixels: [UInt8]) -> CGImage {
    let provider = CGDataProvider(data: Data(pixels) as CFData)!
    return CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32,
                   bytesPerRow: width * 4, space: srgb,
                   bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.last.rawValue),
                   provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
}
func converted(_ image: CGImage, _ space: CGColorSpace = srgb) -> CGContext {
    let context = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8,
                            bytesPerRow: image.width * 4, space: space,
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue)!
    context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
    return context
}
func write(_ image: CGImage, _ path: URL, type: String = "public.png", orientation: Int = 1) throws {
    let destination = CGImageDestinationCreateWithURL(path as CFURL, type as CFString, 1, nil)!
    CGImageDestinationAddImage(destination, image, [kCGImagePropertyOrientation: orientation,
        kCGImageDestinationLossyCompressionQuality: 1.0] as CFDictionary)
    try check(CGImageDestinationFinalize(destination), "Fixture encoding failed")
}
func read(_ path: URL) -> (Int, Int, [UInt8]) {
    let source = CGImageSourceCreateWithURL(path as CFURL, nil)!
    let image = CGImageSourceCreateImageAtIndex(source, 0, nil)!
    let context = converted(image)
    return (image.width, image.height, Array(UnsafeBufferPointer(
        start: context.data!.assumingMemoryBound(to: UInt8.self), count: image.width * image.height * 4)))
}
func run(_ executable: URL, _ input: URL, _ output: URL) throws -> [String: Any] {
    let process = Process(), pipe = Pipe()
    process.executableURL = executable
    process.arguments = [input.path, output.path]
    process.standardOutput = pipe
    try process.run()
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    try check(process.terminationStatus == 0, "Normalizer failed")
    return try JSONSerialization.jsonObject(with: data) as! [String: Any]
}

do {
    let sourceDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("canvas-normalization-\(UUID())")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let executable = directory.appendingPathComponent("normalize-image")
    let compiler = Process()
    compiler.executableURL = URL(fileURLWithPath: "/usr/bin/swiftc")
    compiler.arguments = ["-O", sourceDirectory.appendingPathComponent("normalize-image.swift").path, "-o", executable.path]
    try compiler.run()
    compiler.waitUntilExit()
    try check(compiler.terminationStatus == 0, "Normalizer compilation failed")
    let output = directory.appendingPathComponent("normalized.png")
    let approved = try run(executable, sourceDirectory.appendingPathComponent("reference/artwork.webp"), output)
    try check(approved["normalized"] as? Bool == false && !FileManager.default.fileExists(atPath: output.path), "Approved artwork must pass through unchanged")

    let alpha = directory.appendingPathComponent("alpha.png")
    try write(raster(2, 1, [255, 0, 0, 0, 0, 70, 255, 255]), alpha)
    let alphaResult = try run(executable, alpha, output)
    try check(alphaResult["alphaFlattened"] as? Bool == true, "Alpha was not detected")
    try check(read(output).2 == [255, 255, 255, 255, 0, 70, 255, 255], "Transparency must become white while opaque pigment is retained")

    let colors: [[UInt8]] = [[220, 70, 20, 255], [30, 170, 60, 255], [40, 80, 220, 255], [180, 150, 40, 255]]
    let pixels = (0..<24).flatMap { y in (0..<32).flatMap { x in colors[(x / 16) + (y / 12) * 2] } }
    let image = raster(32, 24, pixels)
    let opaque = directory.appendingPathComponent("opaque.png")
    try write(image, opaque)
    try check(try run(executable, opaque, output)["normalized"] as? Bool == false, "Opaque sRGB RGBA must pass through")

    let oriented = directory.appendingPathComponent("oriented.jpg")
    try write(image, oriented, type: "public.jpeg", orientation: 6)
    let before = read(oriented), orientation = try run(executable, oriented, output), after = read(output)
    try check(orientation["orientationApplied"] as? Bool == true && after.0 == before.1 && after.1 == before.0, "Orientation must swap displayed dimensions")
    for y in 0..<after.1 { for x in 0..<after.0 { for channel in 0..<4 {
        try check(after.2[(y * after.0 + x) * 4 + channel] == before.2[((before.1 - 1 - x) * before.0 + y) * 4 + channel], "EXIF clockwise rotation differs")
    } } }

    let p3 = directory.appendingPathComponent("p3.png")
    try write(converted(image, CGColorSpace(name: CGColorSpace.displayP3)!).makeImage()!, p3)
    let expected = read(p3), profile = try run(executable, p3, output)
    try check(profile["colorConverted"] as? Bool == true, "Display P3 must be converted")
    try check(read(output).2 == expected.2, "Profile conversion differs from ColorSync sRGB conversion")
    print("Passed: approved passthrough, opaque RGBA, transparency, EXIF orientation, Display P3")
} catch {
    FileHandle.standardError.write(Data("\(error)\n".utf8))
    exit(1)
}
