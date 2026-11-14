import Foundation
import Network

/// Tiny HTTP server bound to 127.0.0.1. It serves the web folder (a "localhost" page is a secure
/// context, which the in-page camera + MediaPipe WebAssembly need) and accepts POST /save for
/// photos and videos — only with the per-launch token, so other local pages can't write files.
final class LocalServer {
    private var listener: NWListener?
    private let queue = DispatchQueue(label: "minime.server")
    private let root: () -> URL
    let token = UUID().uuidString
    private(set) var port: UInt16 = 0
    /// Called with (file name, data); returns where it was saved.
    var onSave: ((String, Data, Bool) -> URL?)?

    init(root: @escaping () -> URL) { self.root = root }

    func start(preferredPort: UInt16, ready: @escaping (UInt16) -> Void) {
        func attempt(_ p: UInt16) {
            let params = NWParameters.tcp
            params.allowLocalEndpointReuse = true
            params.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: NWEndpoint.Port(rawValue: p) ?? .any)
            guard let l = try? NWListener(using: params) else { if p != 0 { attempt(0) }; return }
            l.newConnectionHandler = { [weak self] c in self?.handle(c) }
            l.stateUpdateHandler = { [weak self] state in
                switch state {
                case .ready:
                    let port = l.port?.rawValue ?? p
                    self?.port = port
                    DispatchQueue.main.async { ready(port) }
                case .failed:
                    l.cancel()
                    if p != 0 { attempt(0) }
                default: break
                }
            }
            listener = l
            l.start(queue: queue)
        }
        attempt(preferredPort)
    }

    // MARK: connection handling

    private func handle(_ c: NWConnection) {
        c.start(queue: queue)
        receiveHead(c, buffer: Data())
    }

    private func receiveHead(_ c: NWConnection, buffer: Data) {
        c.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, done, err in
            guard let self else { return }
            var buf = buffer
            if let data { buf.append(data) }
            if let r = buf.range(of: Data("\r\n\r\n".utf8)) {
                let head = String(decoding: buf[..<r.lowerBound], as: UTF8.self)
                let rest = buf[r.upperBound...]
                self.route(c, head: head, body: Data(rest))
            } else if done || err != nil || buf.count > 65536 {
                c.cancel()
            } else {
                self.receiveHead(c, buffer: buf)
            }
        }
    }

    private func route(_ c: NWConnection, head: String, body: Data) {
        let lines = head.components(separatedBy: "\r\n")
        let parts = (lines.first ?? "").split(separator: " ")
        guard parts.count >= 2 else { return reply(c, 400, "bad request") }
        let method = String(parts[0]), target = String(parts[1])
        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            if let i = line.firstIndex(of: ":") {
                headers[line[..<i].lowercased()] = line[line.index(after: i)...].trimmingCharacters(in: .whitespaces)
            }
        }
        let comps = URLComponents(string: target)
        let path = comps?.path ?? "/"

        if method == "POST" && path == "/save" {
            guard headers["x-minime-token"] == token else { return reply(c, 403, "forbidden") }
            let length = Int(headers["content-length"] ?? "") ?? -1
            guard length >= 0, length < 400_000_000 else { return reply(c, 411, "length required") }
            let name = comps?.queryItems?.first(where: { $0.name == "name" })?.value ?? "MiniMe"
            let test = comps?.queryItems?.contains(where: { $0.name == "test" }) ?? false
            readBody(c, have: body, length: length) { data in
                let url = self.onSave?(name, data, test)
                self.reply(c, url == nil ? 500 : 200, url?.path ?? "save failed")
            }
            return
        }
        guard method == "GET" || method == "HEAD" else { return reply(c, 405, "method not allowed") }
        serveFile(c, path: path, headOnly: method == "HEAD")
    }

    private func readBody(_ c: NWConnection, have: Data, length: Int, done: @escaping (Data) -> Void) {
        if have.count >= length { return done(have.prefix(length)) }
        c.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] data, _, fin, err in
            var buf = have
            if let data { buf.append(data) }
            if err != nil || (fin && buf.count < length) { c.cancel(); return }
            self?.readBody(c, have: buf, length: length, done: done)
        }
    }

    private static let types: [String: String] = [
        "html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8",
        "mjs": "text/javascript; charset=utf-8", "cjs": "text/javascript; charset=utf-8", "css": "text/css; charset=utf-8",
        "json": "application/json", "wasm": "application/wasm", "png": "image/png",
        "jpg": "image/jpeg", "jpeg": "image/jpeg", "svg": "image/svg+xml", "task": "application/octet-stream",
    ]

    private func serveFile(_ c: NWConnection, path: String, headOnly: Bool) {
        let base = root().standardizedFileURL
        var rel = (path.removingPercentEncoding ?? path)
        if rel.hasSuffix("/") { rel += "index.html" }
        let url = base.appendingPathComponent(String(rel.drop(while: { $0 == "/" }))).standardizedFileURL
        guard url.path.hasPrefix(base.path + "/"), let data = try? Data(contentsOf: url) else {
            return reply(c, 404, "not found")
        }
        let type = Self.types[url.pathExtension.lowercased()] ?? "application/octet-stream"
        var head = "HTTP/1.1 200 OK\r\nContent-Type: \(type)\r\nContent-Length: \(data.count)\r\n"
        head += "Cache-Control: no-store\r\nConnection: close\r\n\r\n"
        var out = Data(head.utf8)
        if !headOnly { out.append(data) }
        c.send(content: out, completion: .contentProcessed { _ in c.cancel() })
    }

    private func reply(_ c: NWConnection, _ code: Int, _ text: String) {
        let body = Data(text.utf8)
        let head = "HTTP/1.1 \(code) \(code == 200 ? "OK" : "Error")\r\nContent-Type: text/plain\r\n"
            + "Content-Length: \(body.count)\r\nConnection: close\r\n\r\n"
        c.send(content: Data(head.utf8) + body, completion: .contentProcessed { _ in c.cancel() })
    }
}
