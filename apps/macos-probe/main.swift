// NSTask IPC probe for @workspace/p2p-runtime Phase 3b.
//
// Validates that Swift's Process (= NSTask) can:
//   1. Spawn `node --experimental-strip-types child-bin.ts`
//   2. Speak the same line-delimited JSON-RPC protocol as the Node parent
//   3. Receive correct responses (init DID, createLog handle, append/get)
//
// Run from the repo root:
//   swift apps/macos-probe/main.swift
//
// This proves the mechanism without needing a full React Native project.
// The macOS TurboModule (P2PRuntimeModule.mm) is a direct translation of
// this logic into Obj-C++.

import Foundation

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func currentFilePath() -> String {
    // __FILE__ gives us the source path at compile time (script mode).
    return #file
}

/// Absolute path to the ipc/child-bin.ts entrypoint.
/// Assumes the script is run from the repo root:  swift apps/macos-probe/main.swift
func childBinPath() -> String {
    let cwd = FileManager.default.currentDirectoryPath
    return (cwd as NSString).appendingPathComponent(
        "packages/p2p-runtime/src/ipc/child-bin.ts"
    )
}

func nodePath() -> String {
    // Use `which node` to find the active Node binary.
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/bin/which")
    task.arguments = ["node"]
    let pipe = Pipe()
    task.standardOutput = pipe
    try! task.run()
    task.waitUntilExit()
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    return String(data: data, encoding: .utf8)!.trimmingCharacters(in: .whitespacesAndNewlines)
}

// ---------------------------------------------------------------------------
// Line-splitting buffer (mirrors ipc/framing.ts LineDecoder)
// ---------------------------------------------------------------------------

class LineBuffer {
    private var buf = ""

    func feed(_ chunk: String) -> [String] {
        buf += chunk
        var lines = buf.components(separatedBy: "\n")
        buf = lines.removeLast() // incomplete tail
        return lines.filter { !$0.isEmpty }
    }
}

// ---------------------------------------------------------------------------
// Minimal JSON helpers
// ---------------------------------------------------------------------------

func toJSON(_ obj: Any) -> String {
    let data = try! JSONSerialization.data(withJSONObject: obj)
    return String(data: data, encoding: .utf8)! + "\n"
}

func fromJSON(_ s: String) -> Any {
    let data = s.data(using: .utf8)!
    return try! JSONSerialization.jsonObject(with: data)
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

class Probe {
    private let process = Process()
    private let inPipe = Pipe()
    private let outPipe = Pipe()
    private let buffer = LineBuffer()
    private var nextId = 1

    // Pending requests: id → continuation
    private var pending: [Int: CheckedContinuation<Any, Error>] = [:]
    private var messageHandler: ((Any) -> Void)?

    func start(nodeBin: String, scriptPath: String) {
        process.executableURL = URL(fileURLWithPath: nodeBin)
        process.arguments = ["--experimental-strip-types", "--no-warnings", scriptPath]
        process.standardInput = inPipe
        process.standardOutput = outPipe
        process.standardError = FileHandle.standardError

        // Read stdout asynchronously
        outPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            guard let self else { return }
            let data = handle.availableData
            guard !data.isEmpty else { return }
            let chunk = String(data: data, encoding: .utf8) ?? ""
            let lines = self.buffer.feed(chunk)
            for line in lines {
                let msg = fromJSON(line)
                self.dispatch(msg)
            }
        }

        try! process.run()
        print("  ✓ child spawned (pid \(process.processIdentifier))")
    }

    private func dispatch(_ msg: Any) {
        guard let obj = msg as? [String: Any] else { return }

        // Event (no `id` field)
        if let event = obj["event"] as? String {
            print("  → event: \(event) key=\(obj["key"] ?? "?") length=\(obj["length"] ?? "?")")
            return
        }

        // RPC response
        guard let id = obj["id"] as? Int else { return }
        if let cont = pending.removeValue(forKey: id) {
            if let ok = obj["ok"] as? Bool, ok {
                cont.resume(returning: obj["result"] as Any)
            } else {
                let msg = (obj["error"] as? [String: Any])?["message"] as? String ?? "IPC error"
                cont.resume(throwing: NSError(domain: "P2PRPC", code: -1,
                                              userInfo: [NSLocalizedDescriptionKey: msg]))
            }
        }
    }

    func rpc(_ params: [String: Any]) async throws -> Any {
        let id = nextId; nextId += 1
        let req: [String: Any] = ["id": id, "method": params["method"] as! String, "params": params]
        let line = toJSON(req)

        return try await withCheckedThrowingContinuation { cont in
            pending[id] = cont
            inPipe.fileHandleForWriting.write(line.data(using: .utf8)!)
        }
    }

    func stop() {
        inPipe.fileHandleForWriting.closeFile()
        process.waitUntilExit()
        print("  ✓ child exited (code \(process.terminationStatus))")
    }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let node = nodePath()
let script = childBinPath()
print("node:   \(node)")
print("child:  \(script)\n")

let probe = Probe()
probe.start(nodeBin: node, scriptPath: script)

// Run assertions in a Task so we can use async/await
let sema = DispatchSemaphore(value: 0)
var failed = false

Task {
    do {
        // 1. init
        print("test: init")
        let initResult = try await probe.rpc(["method": "init", "storage": NSNull()]) as! [String: Any]
        let did = initResult["did"] as! String
        guard did.hasPrefix("did:key:z") else { throw NSError(domain: "assert", code: 1,
            userInfo: [NSLocalizedDescriptionKey: "bad DID: \(did)"]) }
        print("  ✓ DID: \(did)")

        // 2. createLog
        print("test: createLog")
        let logHandle = try await probe.rpc(["method": "createLog"]) as! [String: Any]
        let key = logHandle["key"] as! String
        let writable = logHandle["writable"] as! Bool
        let length0 = logHandle["length"] as! Int
        guard writable && length0 == 0 else { throw NSError(domain: "assert", code: 2,
            userInfo: [NSLocalizedDescriptionKey: "bad log handle"]) }
        print("  ✓ key=\(key.prefix(16))… writable=\(writable) length=\(length0)")

        // 3. appendBlock
        print("test: appendBlock x2")
        let hello = "hello".data(using: .utf8)!.map { String(format: "%02x", $0) }.joined()
        let world = "world".data(using: .utf8)!.map { String(format: "%02x", $0) }.joined()

        let r1 = try await probe.rpc(["method": "appendBlock", "key": key, "blockHex": hello]) as! [String: Any]
        guard (r1["length"] as! Int) == 1 else { throw NSError(domain: "assert", code: 3,
            userInfo: [NSLocalizedDescriptionKey: "expected length 1, got \(r1["length"]!)"]) }

        let r2 = try await probe.rpc(["method": "appendBlock", "key": key, "blockHex": world]) as! [String: Any]
        guard (r2["length"] as! Int) == 2 else { throw NSError(domain: "assert", code: 4,
            userInfo: [NSLocalizedDescriptionKey: "expected length 2, got \(r2["length"]!)"]) }
        print("  ✓ length after 2 appends: 2")

        // 4. getBlock round-trip
        print("test: getBlock")
        let g0 = try await probe.rpc(["method": "getBlock", "key": key, "index": 0]) as! [String: Any]
        let g1 = try await probe.rpc(["method": "getBlock", "key": key, "index": 1]) as! [String: Any]
        let decoded0 = Data(hex: g0["blockHex"] as! String).map { String(UnicodeScalar($0)) }.joined()
        let decoded1 = Data(hex: g1["blockHex"] as! String).map { String(UnicodeScalar($0)) }.joined()
        guard decoded0 == "hello" && decoded1 == "world" else {
            throw NSError(domain: "assert", code: 5,
                userInfo: [NSLocalizedDescriptionKey: "round-trip mismatch: \(decoded0) \(decoded1)"])
        }
        print("  ✓ getBlock[0]='\(decoded0)' getBlock[1]='\(decoded1)'")

        // 5. error surface
        print("test: IPC error (unknown log)")
        do {
            _ = try await probe.rpc(["method": "getBlock", "key": "deadbeef".repeat(8), "index": 0])
            throw NSError(domain: "assert", code: 6,
                userInfo: [NSLocalizedDescriptionKey: "expected rejection for unknown log"])
        } catch let e as NSError where e.domain == "P2PRPC" {
            print("  ✓ rejected: \(e.localizedDescription)")
        }

        // 6. shutdown
        print("test: shutdown")
        _ = try await probe.rpc(["method": "shutdown"])
        print("  ✓ shutdown RPC ok")

        print("\n✅  All NSTask IPC checks passed — TurboModule mechanism is viable.")
    } catch {
        print("\n❌  FAILED: \(error)")
        failed = true
    }

    probe.stop()
    sema.signal()
}

sema.wait()
exit(failed ? 1 : 0)

// ---------------------------------------------------------------------------
// Data hex helpers
// ---------------------------------------------------------------------------

extension Data {
    init(hex: String) {
        var data = Data()
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            data.append(UInt8(hex[index..<next], radix: 16)!)
            index = next
        }
        self = data
    }
}

extension String {
    func `repeat`(_ n: Int) -> String { String(repeating: self, count: n) }
}
