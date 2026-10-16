import Darwin
import AppKit
import Foundation
import Virtualization

private struct RunnerFailure: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

private struct Options {
    let vm: URL
    let status: URL
    let stopFile: URL
    let ownerPID: pid_t

    init(arguments: [String]) throws {
        let allowed: Set<String> = ["--vm", "--status", "--stop-file", "--owner-pid"]
        var values: [String: String] = [:]
        var index = 0
        while index < arguments.count {
            let key = arguments[index]
            guard allowed.contains(key), values[key] == nil, index + 1 < arguments.count else {
                throw RunnerFailure("Invalid or duplicate command-line option")
            }
            values[key] = arguments[index + 1]
            index += 2
        }
        func path(_ key: String) throws -> URL {
            guard let value = values[key], value.hasPrefix("/"), !value.contains("\0") else {
                throw RunnerFailure("Missing or nonabsolute path for \(key)")
            }
            guard !value.split(separator: "/").contains(where: { $0 == "." || $0 == ".." }) else {
                throw RunnerFailure("Path must not contain relative components for \(key)")
            }
            return URL(fileURLWithPath: value)
        }
        vm = try path("--vm")
        status = try path("--status")
        stopFile = try path("--stop-file")
        guard let rawPID = values["--owner-pid"], let pid = Int32(rawPID), pid > 1, pid != getpid() else {
            throw RunnerFailure("Invalid owner PID")
        }
        ownerPID = pid

    }
}

private func checkedPath(_ url: URL, directory: Bool, mayBeMissing: Bool = false) throws {
    let components = url.pathComponents
    var current = ""
    for (index, component) in components.enumerated() {
        current = index == 0 ? "/" : (current as NSString).appendingPathComponent(component)
        var info = stat()
        if lstat(current, &info) != 0 {
            if index == components.count - 1 && mayBeMissing && errno == ENOENT { return }
            throw RunnerFailure("Required path is unavailable: \(url.lastPathComponent)")
        }
        let expected = index < components.count - 1 || directory ? S_IFDIR : S_IFREG
        guard info.st_mode & S_IFMT == expected else {
            throw RunnerFailure("Path contains a symlink or unexpected file type: \(url.lastPathComponent)")
        }
    }
}

private func boundedData(_ url: URL, maximum: Int) throws -> Data {
    try checkedPath(url, directory: false)
    let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
    guard let size = attributes[.size] as? NSNumber, size.intValue <= maximum else {
        throw RunnerFailure("Input file is too large: \(url.lastPathComponent)")
    }
    return try Data(contentsOf: url)
}

private func within(_ child: URL, _ parent: URL) -> Bool {
    child.path == parent.path || child.path.hasPrefix(parent.path + "/")
}

private func requireOwned(_ url: URL) throws {
    var information = stat()
    guard lstat(url.path, &information) == 0, information.st_uid == getuid() else {
        throw RunnerFailure("VM and control files must be owned by the current user")
    }
}

private func processStart(_ pid: pid_t) -> [UInt64]? {
    var information = proc_bsdinfo()
    let size = MemoryLayout<proc_bsdinfo>.size
    let count = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &information, Int32(size))
    guard count == size, information.pbi_pid == UInt32(pid), information.pbi_uid == getuid(),
          information.pbi_start_tvsec > 0, information.pbi_start_tvusec < 1_000_000 else { return nil }
    return [information.pbi_start_tvsec, information.pbi_start_tvusec]
}

private func timestamp() -> String { ISO8601DateFormatter().string(from: Date()) }

@MainActor
private final class Host: NSObject, VZVirtualMachineDelegate {
    private let options: Options
    private var machine: VZVirtualMachine?
    private var lockFD: Int32 = -1
    private var timer: DispatchSourceTimer?
    private var signals: [DispatchSourceSignal] = []
    private var state = "starting"
    private var shutdownStarted: Date?
    private var stopReason: String?
    private var failure: String?
    private var forceStopRequested = false
    private let startedAt = timestamp()
    private let sessionID = UUID().uuidString

    private let ownerStart: [UInt64]
    private let hostStart: [UInt64]

    init(options: Options) throws {
        guard let ownerStart = processStart(options.ownerPID), let hostStart = processStart(getpid()) else {
            throw RunnerFailure("VM processes must be owned by the current user")
        }
        self.options = options
        self.ownerStart = ownerStart
        self.hostStart = hostStart
    }

    func start() throws {
        try validatePaths()
        try acquireLock()
        try writeStatus()
        if stopRequested() { finish(code: 0); return }
        let configuration = try makeConfiguration()
        try configuration.validate()
        let machine = VZVirtualMachine(configuration: configuration, queue: .main)
        self.machine = machine
        machine.delegate = self
        installWatchdog()
        let startOptions = VZMacOSVirtualMachineStartOptions()
        machine.start(options: startOptions) { [weak self] error in
            MainActor.assumeIsolated {
                guard let self else { return }
                if let error {
                    self.fail("VM start failed (\((error as NSError).domain):\((error as NSError).code))")
                } else {
                    if self.shutdownStarted != nil {
                        self.requestShutdown()
                    } else {
                        self.state = "running"
                        self.publishStatus()
                    }
                }
            }
        }
    }

    private func validatePaths() throws {
        guard options.vm.pathExtension == "vbvm" else { throw RunnerFailure("VM must be a .vbvm bundle") }
        try checkedPath(options.vm, directory: true)
        try requireOwned(options.vm)
        try requireOwned(options.status.deletingLastPathComponent())
        try requireOwned(options.stopFile.deletingLastPathComponent())
        try checkedPath(options.status, directory: false, mayBeMissing: true)
        try checkedPath(options.stopFile, directory: false, mayBeMissing: true)
        for control in [options.status, options.stopFile] {
            if FileManager.default.fileExists(atPath: control.path) { try requireOwned(control) }
        }
        guard options.status != options.stopFile,
              !within(options.status, options.vm), !within(options.stopFile, options.vm) else {
            throw RunnerFailure("Control paths must be distinct and outside the VM bundle")
        }
        for filename in ["Disk.img", "AuxiliaryStorage", "HardwareModel", "MachineIdentifier", ".vbdata/Config.plist"] {
            try checkedPath(options.vm.appendingPathComponent(filename), directory: false)
            try requireOwned(options.vm.appendingPathComponent(filename))
        }
        let build = options.vm.appendingPathComponent("BuildData.img")
        try checkedPath(build, directory: false, mayBeMissing: true)
        if FileManager.default.fileExists(atPath: build.path) { try requireOwned(build) }
    }

    private func acquireLock() throws {
        let url = options.vm.appendingPathComponent(".mi-note-video-vm.lock")
        try checkedPath(url, directory: false, mayBeMissing: true)
        lockFD = open(url.path, O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0o600)
        var information = stat()
        guard lockFD >= 0, fstat(lockFD, &information) == 0, information.st_uid == getuid(),
              information.st_mode & 0o077 == 0, flock(lockFD, LOCK_EX | LOCK_NB) == 0 else {
            throw RunnerFailure("VM is already owned by another runner or cannot be locked")
        }
    }

    private func makeConfiguration() throws -> VZVirtualMachineConfiguration {
        let data = try boundedData(options.vm.appendingPathComponent(".vbdata/Config.plist"), maximum: 1024 * 1024)
        guard let plist = try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
              plist["systemType"] as? String == "mac", let hardware = plist["hardware"] as? [String: Any],
              let cpu = hardware["cpuCount"] as? NSNumber, let memory = hardware["memorySize"] as? NSNumber,
              cpu.intValue == 4, memory.uint64Value == 8 * 1024 * 1024 * 1024,
              cpu.intValue >= VZVirtualMachineConfiguration.minimumAllowedCPUCount,
              cpu.intValue <= VZVirtualMachineConfiguration.maximumAllowedCPUCount,
              memory.uint64Value >= VZVirtualMachineConfiguration.minimumAllowedMemorySize,
              memory.uint64Value <= VZVirtualMachineConfiguration.maximumAllowedMemorySize else {
            throw RunnerFailure("Unsupported VM configuration or host resource limits")
        }
        let platform = VZMacPlatformConfiguration()
        guard let model = VZMacHardwareModel(dataRepresentation: try boundedData(options.vm.appendingPathComponent("HardwareModel"), maximum: 65536)), model.isSupported,
              let identifier = VZMacMachineIdentifier(dataRepresentation: try boundedData(options.vm.appendingPathComponent("MachineIdentifier"), maximum: 65536)) else {
            throw RunnerFailure("VM hardware model or machine identity is unsupported")
        }
        platform.hardwareModel = model
        platform.machineIdentifier = identifier
        platform.auxiliaryStorage = VZMacAuxiliaryStorage(contentsOf: options.vm.appendingPathComponent("AuxiliaryStorage"))
        let configuration = VZVirtualMachineConfiguration()
        configuration.platform = platform
        configuration.bootLoader = VZMacOSBootLoader()
        configuration.cpuCount = cpu.intValue
        configuration.memorySize = memory.uint64Value
        let graphics = VZMacGraphicsDeviceConfiguration()
        graphics.displays = [VZMacGraphicsDisplayConfiguration(widthInPixels: 4480, heightInPixels: 2520, pixelsPerInch: 218)]
        configuration.graphicsDevices = [graphics]
        let silentOutput = VZVirtioSoundDeviceOutputStreamConfiguration()
        silentOutput.sink = nil
        let sound = VZVirtioSoundDeviceConfiguration()
        sound.streams = [silentOutput]
        configuration.audioDevices = [sound]
        configuration.keyboards = [VZUSBKeyboardConfiguration()]
        configuration.pointingDevices = [VZUSBScreenCoordinatePointingDeviceConfiguration()]
        configuration.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
        let network = VZVirtioNetworkDeviceConfiguration()
        guard let networks = hardware["networkDevices"] as? [[String: Any]], networks.count == 1,
              let raw = networks[0]["macAddress"] as? String, let address = VZMACAddress(string: raw) else {
            throw RunnerFailure("The VM requires one network device with a fixed MAC address")
        }
        network.macAddress = address
        network.attachment = VZNATNetworkDeviceAttachment()
        configuration.networkDevices = [network]
        let attachment = try VZDiskImageStorageDeviceAttachment(url: options.vm.appendingPathComponent("Disk.img"), readOnly: false, cachingMode: .cached, synchronizationMode: .fsync)
        configuration.storageDevices = [VZVirtioBlockDeviceConfiguration(attachment: attachment)]
        let buildData = options.vm.appendingPathComponent("BuildData.img")
        if FileManager.default.fileExists(atPath: buildData.path) {
            let buildAttachment = try VZDiskImageStorageDeviceAttachment(url: buildData, readOnly: false, cachingMode: .cached, synchronizationMode: .fsync)
            configuration.storageDevices.append(VZVirtioBlockDeviceConfiguration(attachment: buildAttachment))
        }
        configuration.directorySharingDevices = []
        return configuration
    }

    private func installWatchdog() {
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now(), repeating: 2)
        timer.setEventHandler { [weak self] in MainActor.assumeIsolated { self?.tick() } }
        timer.resume()
        self.timer = timer
        for value in [SIGINT, SIGTERM, SIGHUP] {
            signal(value, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: value, queue: .main)
            source.setEventHandler { [weak self] in
                MainActor.assumeIsolated { self?.beginShutdown(reason: "signal") }
            }
            source.resume()
            signals.append(source)
        }
    }

    private func stopRequested() -> Bool {
        if FileManager.default.fileExists(atPath: options.stopFile.path) {
            stopReason = "stop-file"
            return true
        }
        if processStart(options.ownerPID) != ownerStart {
            stopReason = "owner-exited-or-changed"
            return true
        }
        return false
    }

    private func tick() {
        if shutdownStarted == nil && stopRequested() { beginShutdown(reason: stopReason ?? "requested") }
        if let since = shutdownStarted {
            if Date().timeIntervalSince(since) >= 15 && !forceStopRequested { forceStop() }
            if Date().timeIntervalSince(since) >= 25 { finish(code: failure == nil ? 0 : 1) }
        }
        publishStatus()
    }

    private func beginShutdown(reason: String) {
        guard shutdownStarted == nil else { return }
        shutdownStarted = Date()
        stopReason = reason
        state = "stopping"
        publishStatus()
        requestShutdown()
    }

    private func requestShutdown() {
        guard let machine else { finish(code: failure == nil ? 0 : 1); return }
        if machine.state == .stopped || machine.state == .error { finish(code: failure == nil ? 0 : 1); return }
        guard machine.state == .running else { return }
        do { try machine.requestStop() } catch { forceStop() }
    }

    private func forceStop() {
        guard !forceStopRequested, let machine else { return }
        forceStopRequested = true
        machine.stop { [weak self] error in
            MainActor.assumeIsolated {
                guard let self else { return }
                if let error { self.failure = "VM force stop failed (\((error as NSError).code))" }
                self.finish(code: self.failure == nil ? 0 : 1)
            }
        }
    }

    private func fail(_ message: String) {
        failure = message
        if machine?.state == .running { beginShutdown(reason: "error") }
        else { finish(code: 1) }
    }

    func startupFailed(_ error: Error) {
        failure = (error as? RunnerFailure)?.description ?? "VM configuration failed (\((error as NSError).domain):\((error as NSError).code))"
        finish(code: 1)
    }

    private func finish(code: Int32) {
        state = code == 0 ? "stopped" : "failed"
        try? writeStatus()
        if lockFD >= 0 { close(lockFD); lockFD = -1 }
        if let failure { FileHandle.standardError.write(Data((failure + "\n").utf8)) }
        exit(code)
    }

    private func writeStatus() throws {
        var status: [String: Any] = [
            "schemaVersion": 1, "state": state, "running": machine?.state == .running,
            "hostPID": getpid(), "ownerPID": options.ownerPID, "hostStart": hostStart, "ownerStart": ownerStart,
            "vmPath": options.vm.path, "sessionId": sessionID, "startedAt": startedAt, "updatedAt": timestamp(),
        ]
        if let stopReason { status["stopReason"] = stopReason }
        if let failure { status["error"] = failure }
        try checkedPath(options.status, directory: false, mayBeMissing: true)
        try JSONSerialization.data(withJSONObject: status, options: [.sortedKeys]).write(to: options.status, options: .atomic)
    }

    private func publishStatus() {
        do { try writeStatus() }
        catch {
            if failure == nil { failure = "Cannot publish VM status" }
            if shutdownStarted == nil { beginShutdown(reason: "status-write-failed") }
        }
    }

    nonisolated func guestDidStop(_ virtualMachine: VZVirtualMachine) {
        MainActor.assumeIsolated { finish(code: failure == nil ? 0 : 1) }
    }

    nonisolated func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) {
        MainActor.assumeIsolated {
            failure = "VM stopped with an error (\((error as NSError).domain):\((error as NSError).code))"
            finish(code: 1)
        }
    }
}

@main
@MainActor
private struct VMHostProgram {
    static func main() {
        umask(0o077)
        do {
            let options = try Options(arguments: Array(CommandLine.arguments.dropFirst()))
            let application = NSApplication.shared
            let policy: NSApplication.ActivationPolicy = .prohibited
            if application.activationPolicy() != policy {
                _ = application.setActivationPolicy(policy)
            }
            guard application.activationPolicy() == policy else {
                throw RunnerFailure("VM host could not apply the requested application activation policy")
            }
            let host = try Host(options: options)
            do { try host.start() } catch { host.startupFailed(error) }
            withExtendedLifetime(host) { application.run() }
        } catch {
            FileHandle.standardError.write(Data((String(describing: error) + "\n").utf8))
            exit(2)
        }
    }
}
