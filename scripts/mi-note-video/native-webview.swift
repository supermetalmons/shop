import AppKit
import CoreGraphics
import CoreMedia
import CoreVideo
import CryptoKit
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers
import WebKit

struct CaptureFailure: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

func opaqueRGBImage(_ image: CGImage) throws -> CGImage {
    guard image.bitsPerComponent == 8, image.bitsPerPixel == 32,
          let provider = image.dataProvider, let data = provider.data,
          let pixels = CFDataGetBytePtr(data), let colorSpace = image.colorSpace else {
        throw CaptureFailure(message: "Opaque RGB output requires a native 8-bit four-component image.")
    }
    let alpha = image.alphaInfo
    if alpha == .noneSkipFirst || alpha == .noneSkipLast { return image }
    guard [.first, .last, .premultipliedFirst, .premultipliedLast].contains(alpha) else {
        throw CaptureFailure(message: "Native image uses an unsupported alpha layout.")
    }
    let first = alpha == .first || alpha == .premultipliedFirst
    let order = image.bitmapInfo.intersection(.byteOrderMask)
    guard order == .byteOrder32Little || order == .byteOrder32Big || order == .byteOrderDefault else {
        throw CaptureFailure(message: "Native image uses an unsupported component byte order.")
    }
    let littleEndian = order == .byteOrder32Little
    let alphaOffset = first == littleEndian ? 3 : 0
    let requiredBytes = (image.height - 1) * image.bytesPerRow + image.width * 4
    guard CFDataGetLength(data) >= requiredBytes else { throw CaptureFailure(message: "Native image data is truncated.") }
    for row in 0..<image.height {
        let start = row * image.bytesPerRow + alphaOffset
        for column in 0..<image.width {
            guard pixels[start + column * 4] == 255 else {
                throw CaptureFailure(message: "Native capture contains transparency at (\(column), \(row)); refusing to discard alpha.")
            }
        }
    }
    let skippedAlpha = first ? CGImageAlphaInfo.noneSkipFirst : .noneSkipLast
    let bitmapInfo = CGBitmapInfo(rawValue: (image.bitmapInfo.rawValue & ~CGBitmapInfo.alphaInfoMask.rawValue) | skippedAlpha.rawValue)
    guard let result = CGImage(width: image.width, height: image.height,
                               bitsPerComponent: image.bitsPerComponent, bitsPerPixel: image.bitsPerPixel,
                               bytesPerRow: image.bytesPerRow, space: colorSpace, bitmapInfo: bitmapInfo,
                               provider: provider, decode: image.decode, shouldInterpolate: image.shouldInterpolate,
                               intent: image.renderingIntent) else {
        throw CaptureFailure(message: "Could not preserve native RGB pixels while omitting the verified opaque alpha channel.")
    }
    return result
}

final class CaptureWindow: NSWindow {
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
    override var canBecomeKey: Bool { true }
}

final class CaptureStreamOutput: NSObject, SCStreamOutput, SCStreamDelegate {
    let receive: @MainActor (CMSampleBuffer) -> Void
    let failure: @MainActor (Error) -> Void

    init(receive: @escaping @MainActor (CMSampleBuffer) -> Void, failure: @escaping @MainActor (Error) -> Void) {
        self.receive = receive
        self.failure = failure
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen else { return }
        MainActor.assumeIsolated { receive(sampleBuffer) }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        Task { @MainActor in failure(error) }
    }
}

@MainActor
final class NativeCapture: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    private var window: CaptureWindow?
    private var webView: WKWebView?
    private var filter: SCContentFilter?
    private var physicalWidth = 3304
    private var physicalHeight = 3304
    private var pending = [String]()
    private var handling = false
    private var navigationCompletion: ((Result<Any, Error>) -> Void)?
    private var activity: NSObjectProtocol?
    private var inputEnded = false
    private var paintSerial = 0
    private var backingScale: CGFloat = 0
    private var stream: SCStream?
    private var streamOutput: CaptureStreamOutput?
    private var streamColorSpace: String?
    private var streamFailure: Error?
    private var streamBuffer: CVPixelBuffer?
    private var streamFrames = 0
    private var streamFrameInfo: [String: Any] = [:]
    private var streamExpectedSerial: Int?
    private var streamCompletion: ((Result<CGImage, Error>) -> Void)?
    private var streamTimeout: DispatchWorkItem?

    func applicationDidFinishLaunching(_ notification: Notification) {
        activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiated, .idleSystemSleepDisabled], reason: "Rendering Mi Note card frames")
        DispatchQueue.global(qos: .userInitiated).async {
            while let line = readLine() {
                Task { @MainActor in self.enqueue(line) }
            }
            Task { @MainActor in
                self.inputEnded = true
                self.finishIfNeeded()
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    private func enqueue(_ line: String) {
        pending.append(line)
        drain()
    }

    private func drain() {
        guard !handling, !pending.isEmpty else { finishIfNeeded(); return }
        handling = true
        let line = pending.removeFirst()
        var requestID: Any = NSNull()
        do {
            guard let data = line.data(using: .utf8),
                  let request = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let operation = request["operation"] as? String else {
                throw CaptureFailure(message: "Expected a JSON object with id, operation, and args.")
            }
            requestID = request["id"] ?? NSNull()
            let id = requestID
            execute(operation, args: request["args"] as? [String: Any] ?? [:]) { result in
                switch result {
                case .success(let value): self.reply(["id": id, "result": value])
                case .failure(let error): self.reply(["id": id, "error": self.errorDetails(error)])
                }
                self.handling = false
                self.drain()
            }
        } catch {
            reply(["id": requestID, "error": errorDetails(error)])
            handling = false
            drain()
        }
    }

    private func finishIfNeeded() {
        if inputEnded && !handling && pending.isEmpty { NSApplication.shared.terminate(nil) }
    }

    private func reply(_ value: [String: Any]) {
        do {
            var data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed])
            data.append(10)
            FileHandle.standardOutput.write(data)
        } catch {
            FileHandle.standardError.write(Data("Could not serialize native capture response: \(error)\n".utf8))
        }
    }

    private func errorDetails(_ error: Error) -> [String: Any] {
        let native = error as NSError
        return ["message": error.localizedDescription, "domain": native.domain, "code": native.code,
                "detail": String(describing: native.userInfo)]
    }

    private func execute(_ operation: String, args: [String: Any], completion: @escaping (Result<Any, Error>) -> Void) {
        do {
            switch operation {
            case "initialize": completion(.success(try initialize(args)))
            case "status": completion(.success(status()))
            case "load":
                guard let webView else { throw CaptureFailure(message: "Initialize before loading a page.") }
                guard navigationCompletion == nil else { throw CaptureFailure(message: "A navigation is already active.") }
                navigationCompletion = completion
                if let html = args["html"] as? String {
                    webView.loadHTMLString(html, baseURL: (args["baseURL"] as? String).flatMap(URL.init(string:)))
                } else if let rawURL = args["url"] as? String, let url = URL(string: rawURL) {
                    webView.load(URLRequest(url: url))
                } else {
                    navigationCompletion = nil
                    throw CaptureFailure(message: "load requires url or html.")
                }
            case "evaluate":
                guard let webView, let body = args["functionBody"] as? String else {
                    throw CaptureFailure(message: "evaluate requires a loaded web view and functionBody.")
                }
                webView.callAsyncJavaScript(body, arguments: args["arguments"] as? [String: Any] ?? [:], in: nil, in: .page) { result in
                    completion(result)
                }
            case "snapshot": try snapshot(args, completion: completion)
            case "start-stream":
                guard let window else { throw CaptureFailure(message: "Initialize before starting a capture stream.") }
                ensureStream(window: window, args: args) { result in
                    completion(result.map { ["streamStarted": true, "configuration": self.streamColorSpace ?? "display"] })
                }
            case "close":
                if let stream {
                    stream.stopCapture { error in
                        Task { @MainActor in
                            if let error { completion(.failure(error)) }
                            else { completion(.success(["closed": true])) }
                            NSApplication.shared.terminate(nil)
                        }
                    }
                } else {
                    completion(.success(["closed": true]))
                    NSApplication.shared.terminate(nil)
                }
            default: throw CaptureFailure(message: "Unknown operation: \(operation)")
            }
        } catch { completion(.failure(error)) }
    }

    private func initialize(_ args: [String: Any]) throws -> [String: Any] {
        guard window == nil else { throw CaptureFailure(message: "Native capture is already initialized.") }
        physicalWidth = try integer(args["physicalWidth"] ?? 3304, name: "physicalWidth", minimum: 1)
        physicalHeight = try integer(args["physicalHeight"] ?? 3304, name: "physicalHeight", minimum: 1)
        guard physicalWidth <= 16384, physicalHeight <= 16384, let screen = NSScreen.main else {
            throw CaptureFailure(message: "A display and dimensions no greater than 16384 are required.")
        }
        let scale = screen.backingScaleFactor
        backingScale = scale
        let size = NSSize(width: CGFloat(physicalWidth) / scale, height: CGFloat(physicalHeight) / scale)
        let rect = NSRect(x: screen.frame.minX + 16, y: screen.frame.maxY - size.height - 40, width: size.width, height: size.height)
        let captureWindow = CaptureWindow(contentRect: rect, styleMask: [.borderless], backing: .buffered, defer: false, screen: screen)
        captureWindow.title = args["title"] as? String ?? "Mi Note Native Capture"
        captureWindow.isReleasedWhenClosed = false
        captureWindow.hasShadow = false
        captureWindow.animationBehavior = .none
        captureWindow.isOpaque = true
        captureWindow.backgroundColor = .black
        captureWindow.colorSpace = screen.colorSpace
        captureWindow.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.suppressesIncrementalRendering = true
        let view = WKWebView(frame: NSRect(origin: .zero, size: size), configuration: configuration)
        view.navigationDelegate = self
        view.isInspectable = true
        view.autoresizingMask = [.width, .height]
        captureWindow.contentView = view
        captureWindow.setFrame(rect, display: true)
        captureWindow.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate()
        window = captureWindow
        webView = view
        return status()
    }

    private func status() -> [String: Any] {
        let scale = window?.backingScaleFactor ?? 0
        let bounds = webView?.bounds ?? .zero
        return ["protocolVersion": 1, "pid": ProcessInfo.processInfo.processIdentifier,
                "windowID": window?.windowNumber ?? 0, "backingScale": scale,
                "physicalWidth": physicalWidth, "physicalHeight": physicalHeight,
                "viewWidth": bounds.width, "viewHeight": bounds.height,
                "windowVisible": window?.isVisible ?? false,
                "screenCaptureAuthorized": CGPreflightScreenCaptureAccess(),
                "screenColorSpace": window?.screen?.colorSpace?.localizedName ?? "unknown",
                "methods": ["screen-capture-kit", "screen-capture-stream", "webkit"],
                "streamRunning": stream != nil, "streamFrames": streamFrames]
    }

    private func integer(_ value: Any, name: String, minimum: Int = 0) throws -> Int {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite, number.doubleValue.rounded() == number.doubleValue,
              number.doubleValue >= Double(minimum), number.doubleValue <= Double(Int32.max) else {
            throw CaptureFailure(message: "\(name) must be an integer at least \(minimum).")
        }
        return number.intValue
    }

    private func snapshot(_ args: [String: Any], completion: @escaping (Result<Any, Error>) -> Void) throws {
        guard let webView, let window, let path = args["path"] as? String, path.hasPrefix("/") else {
            throw CaptureFailure(message: "snapshot requires initialization and an absolute output path.")
        }
        guard window.backingScaleFactor == backingScale,
              abs(webView.bounds.width * backingScale - CGFloat(physicalWidth)) < 0.01,
              abs(webView.bounds.height * backingScale - CGFloat(physicalHeight)) < 0.01 else {
            throw CaptureFailure(message: "Capture window backing scale or physical dimensions changed; refusing implicit resizing.")
        }
        let method = args["method"] as? String ?? "screen-capture-kit"
        let started = CFAbsoluteTimeGetCurrent()
        let guardedCrop = (args["rect"] as? [String: Any])?["y"] as? NSNumber
        let acknowledgePaint = guardedCrop.map { $0.intValue >= 16 } ?? false
        paintSerial = paintSerial % 16_777_215 + 1
        let serial = paintSerial
        let captureCompletion: (Result<CGImage, Error>) -> Void = { result in
            switch result {
            case .failure(let error): completion(.failure(error))
            case .success(let image):
                let captureSeconds = CFAbsoluteTimeGetCurrent() - started
                do {
                    if acknowledgePaint { try self.verifyPaint(image, serial: serial) }
                    var output = try self.writeImage(image, args: args, path: path)
                    output["method"] = method
                    output["captureSeconds"] = captureSeconds
                    output["writeSeconds"] = CFAbsoluteTimeGetCurrent() - started - captureSeconds
                    output["totalSeconds"] = CFAbsoluteTimeGetCurrent() - started
                    output["paintSerial"] = acknowledgePaint ? serial : NSNull()
                    output["captureAttempts"] = 1
                    if method == "screen-capture-stream" {
                        output["streamFrameNumber"] = self.streamFrames
                        output["streamFrameInfo"] = self.streamFrameInfo
                    }
                    completion(.success(output))
                } catch { completion(.failure(error)) }
            }
        }
        let performCapture = {
        if method == "webkit" {
            let configuration = WKSnapshotConfiguration()
            configuration.rect = webView.bounds
            configuration.afterScreenUpdates = true
            webView.takeSnapshot(with: configuration) { image, error in
                if let error { captureCompletion(.failure(error)); return }
                guard let image, let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
                    captureCompletion(.failure(CaptureFailure(message: "WebKit returned no native image.")))
                    return
                }
                captureCompletion(.success(cgImage))
            }
        } else if method == "screen-capture-kit" {
            self.withCaptureFilter(window: window) { result in
                switch result {
                case .failure(let error): captureCompletion(.failure(error))
                case .success(let filter):
                    let configuration = SCStreamConfiguration()
                    configuration.width = self.physicalWidth
                    configuration.height = self.physicalHeight
                    configuration.pixelFormat = kCVPixelFormatType_32BGRA
                    configuration.showsCursor = false
                    configuration.ignoreShadowsSingleWindow = true
                    configuration.ignoreGlobalClipSingleWindow = true
                    configuration.captureResolution = .best
                    configuration.scalesToFit = false
                    if args["colorSpace"] as? String == "display-p3" { configuration.colorSpaceName = CGColorSpace.displayP3 }
                    SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration) { image, error in
                        Task { @MainActor in
                            if let error { captureCompletion(.failure(error)) }
                            else if let image { captureCompletion(.success(image)) }
                            else { captureCompletion(.failure(CaptureFailure(message: "ScreenCaptureKit returned no image."))) }
                        }
                    }
                }
            }
        } else if method == "screen-capture-stream" {
            self.awaitStreamImage(serial: serial, completion: captureCompletion)
        } else { completion(.failure(CaptureFailure(message: "Unknown snapshot method: \(method)"))) }
        }
        let acknowledgeAndCapture = {
        if acknowledgePaint {
            webView.callAsyncJavaScript("""
                const serial = \(serial);
                let marker = document.getElementById('__native_capture_serial');
                if (!marker) {
                    marker = document.createElement('div');
                    marker.id = '__native_capture_serial';
                    marker.style.cssText = 'position:fixed;left:0;top:0;display:flex;z-index:2147483647;pointer-events:none;isolation:isolate;mix-blend-mode:normal;opacity:1;filter:none;transform:none;';
                    document.documentElement.appendChild(marker);
                    for (let index = 0; index < 32; index++) marker.appendChild(document.createElement('div'));
                }
                const bits = [1,0,1,0,...Array.from({length:24}, (_,index)=>(serial>>index)&1),0,1,0,1];
                Array.from(marker.children).forEach((cell,index)=>{
                    cell.style.cssText = `width:${8/devicePixelRatio}px;height:${16/devicePixelRatio}px;flex:none;background:${bits[index]?'#ffffff':'#000000'};`;
                });
                await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
                return serial;
                """, arguments: [:], in: nil, in: .page) { result in
                    switch result {
                    case .failure(let error): completion(.failure(error))
                    case .success: performCapture()
                    }
                }
        } else { performCapture() }
        }
        if method == "screen-capture-stream" {
            guard acknowledgePaint else {
                throw CaptureFailure(message: "Persistent stream captures require a crop with at least 16 pixels of top paint-marker guard.")
            }
            ensureStream(window: window, args: args) { result in
                switch result {
                case .success: acknowledgeAndCapture()
                case .failure(let error): completion(.failure(error))
                }
            }
        } else { acknowledgeAndCapture() }
    }

    private func ensureStream(window: NSWindow, args: [String: Any], completion: @escaping (Result<Void, Error>) -> Void) {
        let requestedColorSpace = args["colorSpace"] as? String ?? "display"
        if let streamFailure { completion(.failure(streamFailure)); return }
        if stream != nil {
            guard streamColorSpace == requestedColorSpace else {
                completion(.failure(CaptureFailure(message: "Persistent stream color space cannot change after startup.")))
                return
            }
            completion(.success(()))
            return
        }
        withCaptureFilter(window: window) { [self] result in
            switch result {
            case .failure(let error): completion(.failure(error))
            case .success(let filter):
                let configuration = SCStreamConfiguration()
                configuration.width = self.physicalWidth
                configuration.height = self.physicalHeight
                configuration.pixelFormat = kCVPixelFormatType_32BGRA
                configuration.showsCursor = false
                configuration.ignoreShadowsSingleWindow = true
                configuration.ignoreGlobalClipSingleWindow = true
                configuration.captureResolution = .best
                configuration.scalesToFit = false
                configuration.queueDepth = 3
                configuration.minimumFrameInterval = CMTime(value: 1, timescale: 60)
                if requestedColorSpace == "display-p3" { configuration.colorSpaceName = CGColorSpace.displayP3 }
                let output = CaptureStreamOutput(receive: { [weak self] sample in self?.receiveStreamFrame(sample) },
                                                 failure: { [weak self] error in self?.failStream(error) })
                let stream = SCStream(filter: filter, configuration: configuration, delegate: output)
                do {
                    try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: .main)
                    self.stream = stream
                    self.streamOutput = output
                    self.streamColorSpace = requestedColorSpace
                    stream.startCapture { error in
                        Task { @MainActor in
                            if let error {
                                self.failStream(error)
                                completion(.failure(error))
                            } else { completion(.success(())) }
                        }
                    }
                } catch { completion(.failure(error)) }
            }
        }
    }

    private func receiveStreamFrame(_ sample: CMSampleBuffer) {
        guard sample.isValid,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let metadata = attachments.first,
              let rawStatus = metadata[.status] as? Int,
              SCFrameStatus(rawValue: rawStatus) == .complete,
              let buffer = sample.imageBuffer else { return }
        guard CVPixelBufferGetWidth(buffer) == physicalWidth, CVPixelBufferGetHeight(buffer) == physicalHeight,
              CVPixelBufferGetPixelFormatType(buffer) == kCVPixelFormatType_32BGRA else {
            failStream(CaptureFailure(message: "Persistent stream frame dimensions or pixel format changed."))
            return
        }
        guard let contentScale = metadata[.contentScale] as? NSNumber,
              let scaleFactor = metadata[.scaleFactor] as? NSNumber,
              let rectangle = metadata[.contentRect] as? [String: NSNumber],
              contentScale.doubleValue == 1, scaleFactor.doubleValue == Double(backingScale),
              rectangle["X"]?.doubleValue == 0, rectangle["Y"]?.doubleValue == 0,
              rectangle["Width"]?.doubleValue == Double(physicalWidth) / Double(backingScale),
              rectangle["Height"]?.doubleValue == Double(physicalHeight) / Double(backingScale) else {
            failStream(CaptureFailure(message: "Persistent stream content rectangle or scale differs from its unscaled native raster."))
            return
        }
        streamFrames += 1
        streamBuffer = buffer
        streamFrameInfo = ["status": rawStatus,
                           "contentRect": ["x": rectangle["X"]!, "y": rectangle["Y"]!,
                                           "width": rectangle["Width"]!, "height": rectangle["Height"]!],
                           "contentScale": contentScale, "scaleFactor": scaleFactor]
        consumeStreamImage()
    }

    private func awaitStreamImage(serial: Int, completion: @escaping (Result<CGImage, Error>) -> Void) {
        if let streamFailure { completion(.failure(streamFailure)); return }
        guard streamCompletion == nil else {
            completion(.failure(CaptureFailure(message: "A persistent stream frame request is already pending.")))
            return
        }
        streamExpectedSerial = serial
        streamCompletion = completion
        let timeout = DispatchWorkItem { [weak self] in
            self?.failStream(CaptureFailure(message: "Persistent stream did not deliver compositor paint serial \(serial) within 8 seconds."))
        }
        streamTimeout = timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + 8, execute: timeout)
        consumeStreamImage()
    }

    private func consumeStreamImage() {
        guard let serial = streamExpectedSerial, let buffer = streamBuffer, let completion = streamCompletion else { return }
        do {
            guard try streamPaintSerial(buffer) == serial else { return }
            let image = try streamImage(buffer)
            streamTimeout?.cancel()
            streamTimeout = nil
            streamExpectedSerial = nil
            streamCompletion = nil
            completion(.success(image))
        } catch { failStream(error) }
    }

    private func streamPaintSerial(_ buffer: CVPixelBuffer) throws -> Int? {
        guard CVPixelBufferGetWidth(buffer) >= 256, CVPixelBufferGetHeight(buffer) >= 16 else {
            throw CaptureFailure(message: "Persistent stream frame is smaller than its paint-marker guard.")
        }
        guard CVPixelBufferLockBaseAddress(buffer, .readOnly) == kCVReturnSuccess else {
            throw CaptureFailure(message: "Could not read persistent stream frame pixels.")
        }
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        guard let address = CVPixelBufferGetBaseAddress(buffer) else { return nil }
        let pixels = address.assumingMemoryBound(to: UInt8.self)
        let row = CVPixelBufferGetBytesPerRow(buffer) * 8
        var bits = [Int]()
        for index in 0..<32 {
            let offset = row + (index * 8 + 4) * 4
            guard pixels[offset + 3] == 255 else { return nil }
            let values = [pixels[offset], pixels[offset + 1], pixels[offset + 2]]
            if values.allSatisfy({ $0 >= 250 }) { bits.append(1) }
            else if values.allSatisfy({ $0 <= 5 }) { bits.append(0) }
            else { return nil }
        }
        guard Array(bits.prefix(4)) == [1, 0, 1, 0], Array(bits.suffix(4)) == [0, 1, 0, 1] else { return nil }
        return (0..<24).reduce(0) { $0 | (bits[$1 + 4] << $1) }
    }

    private func streamImage(_ buffer: CVPixelBuffer) throws -> CGImage {
        guard CVPixelBufferLockBaseAddress(buffer, .readOnly) == kCVReturnSuccess else {
            throw CaptureFailure(message: "Could not retain persistent stream frame pixels.")
        }
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        guard let address = CVPixelBufferGetBaseAddress(buffer), let colorSpace = CVImageBufferGetColorSpace(buffer)?.takeUnretainedValue(),
              colorSpace.copyICCData() != nil else {
            throw CaptureFailure(message: "Persistent stream frame has no pixels or truthful ICC color space.")
        }
        let rowBytes = CVPixelBufferGetBytesPerRow(buffer)
        let data = Data(bytes: address, count: rowBytes * physicalHeight)
        guard let provider = CGDataProvider(data: data as CFData),
              let image = CGImage(width: physicalWidth, height: physicalHeight, bitsPerComponent: 8, bitsPerPixel: 32,
                                  bytesPerRow: rowBytes, space: colorSpace,
                                  bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedFirst.rawValue).union(.byteOrder32Little),
                                  provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent) else {
            throw CaptureFailure(message: "Could not preserve persistent stream pixels in a native image.")
        }
        return image
    }

    private func failStream(_ error: Error) {
        streamFailure = error
        streamTimeout?.cancel()
        streamTimeout = nil
        streamExpectedSerial = nil
        let completion = streamCompletion
        streamCompletion = nil
        completion?(.failure(error))
    }

    private func verifyPaint(_ image: CGImage, serial: Int) throws {
        let width = 256
        let height = 16
        guard let marker = image.cropping(to: CGRect(x: 0, y: 0, width: width, height: height)) else {
            throw CaptureFailure(message: "Could not read compositor paint acknowledgment.")
        }
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        let rendered = pixels.withUnsafeMutableBytes { bytes -> Bool in
            guard let context = CGContext(data: bytes.baseAddress, width: width, height: height, bitsPerComponent: 8,
                                          bytesPerRow: width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
            context.draw(marker, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard rendered else { throw CaptureFailure(message: "Could not decode compositor paint acknowledgment.") }
        let expected = [1, 0, 1, 0] + (0..<24).map { (serial >> $0) & 1 } + [0, 1, 0, 1]
        for index in 0..<32 {
            let offset = (8 * width + index * 8 + 4) * 4
            let channels = Array(pixels[offset..<(offset + 3)])
            let matches = expected[index] == 1 ? channels.allSatisfy { $0 >= 250 } : channels.allSatisfy { $0 <= 5 }
            guard matches, pixels[offset + 3] == 255 else {
                throw CaptureFailure(message: "Compositor paint acknowledgment differs from serial \(serial) at bit \(index); refusing a stale frame.")
            }
        }
    }

    private func withCaptureFilter(window: NSWindow, completion: @escaping (Result<SCContentFilter, Error>) -> Void) {
        if let filter { completion(.success(filter)); return }
        let windowID = CGWindowID(window.windowNumber)
        SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: false) { content, error in
            Task { @MainActor in
                if let error { completion(.failure(error)); return }
                guard let match = content?.windows.first(where: { $0.windowID == windowID }) else {
                    completion(.failure(CaptureFailure(message: "Capture window was absent from ScreenCaptureKit shareable content.")))
                    return
                }
                let filter = SCContentFilter(desktopIndependentWindow: match)
                guard abs(Double(filter.pointPixelScale) - Double(window.backingScaleFactor)) < 0.001,
                      abs(filter.contentRect.width * CGFloat(filter.pointPixelScale) - CGFloat(self.physicalWidth)) < 0.01,
                      abs(filter.contentRect.height * CGFloat(filter.pointPixelScale) - CGFloat(self.physicalHeight)) < 0.01 else {
                    completion(.failure(CaptureFailure(message: "ScreenCaptureKit window geometry \(filter.contentRect) at \(filter.pointPixelScale)x differs from native \(self.physicalWidth)x\(self.physicalHeight) at \(window.backingScaleFactor)x.")))
                    return
                }
                self.filter = filter
                completion(.success(filter))
            }
        }
    }

    private func writeImage(_ image: CGImage, args: [String: Any], path: String) throws -> [String: Any] {
        guard image.width == physicalWidth, image.height == physicalHeight else {
            throw CaptureFailure(message: "Captured \(image.width)x\(image.height), expected native \(physicalWidth)x\(physicalHeight); refusing implicit resizing.")
        }
        var result = try opaqueRGBImage(image)
        var crop: [String: Int] = ["x": 0, "y": 0, "width": physicalWidth, "height": physicalHeight]
        if let rect = args["rect"] as? [String: Any] {
            for key in ["x", "y", "width", "height"] {
                guard let value = rect[key] else { throw CaptureFailure(message: "Crop requires x, y, width, height.") }
                crop[key] = try integer(value, name: "rect.\(key)", minimum: key == "width" || key == "height" ? 1 : 0)
            }
            guard crop["x"]! + crop["width"]! <= image.width, crop["y"]! + crop["height"]! <= image.height,
                  let cropped = result.cropping(to: CGRect(x: crop["x"]!, y: crop["y"]!, width: crop["width"]!, height: crop["height"]!)) else {
                throw CaptureFailure(message: "Crop exceeds the native captured image.")
            }
            result = cropped
        }
        guard let colorSpace = result.colorSpace, let profile = colorSpace.copyICCData() as Data? else {
            throw CaptureFailure(message: "Captured native image has no recoverable ICC profile.")
        }
        let url = URL(fileURLWithPath: path)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else {
            throw CaptureFailure(message: "Could not create the PNG destination.")
        }
        let pngOptions = [kCGImagePropertyPNGDictionary: [kCGImagePropertyPNGCompressionFilter: IMAGEIO_PNG_FILTER_SUB]] as CFDictionary
        CGImageDestinationAddImage(destination, result, pngOptions)
        guard CGImageDestinationFinalize(destination) else { throw CaptureFailure(message: "Could not encode native PNG.") }
        try (data as Data).write(to: url, options: .atomic)
        return ["path": path, "width": result.width, "height": result.height,
                "sourceWidth": image.width, "sourceHeight": image.height, "crop": crop,
                "bitsPerComponent": result.bitsPerComponent, "bitsPerPixel": result.bitsPerPixel,
                "mode": "RGB", "opaqueAlphaVerified": true,
                "bytes": data.length, "sha256": digest(data as Data),
                "colorSpaceName": colorSpace.name as String? ?? "unnamed",
                "iccDescription": NSColorSpace(cgColorSpace: colorSpace)?.localizedName ?? "unknown",
                "iccBytes": profile.count, "iccSha256": digest(profile)]
    }

    private func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        let completion = navigationCompletion
        navigationCompletion = nil
        completion?(.success(["url": webView.url?.absoluteString ?? "about:blank", "loaded": true]))
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failNavigation(error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failNavigation(error) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { failNavigation(CaptureFailure(message: "WebKit content process terminated.")) }

    private func failNavigation(_ error: Error) {
        let completion = navigationCompletion
        navigationCompletion = nil
        completion?(.failure(error))
    }
}

MainActor.assumeIsolated {
    let application = NSApplication.shared
    let delegate = NativeCapture()
    application.setActivationPolicy(.accessory)
    application.delegate = delegate
    application.run()
}
