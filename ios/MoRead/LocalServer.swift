//
//  LocalServer.swift
//  墨读 iOS
//
//  为什么需要一个本地 HTTP 服务：
//  1) WKWebView 用 file:// 加载时是「不透明源」，localStorage / IndexedDB 都不稳定，
//     Service Worker 也不注册。起一个 127.0.0.1 的 HTTP 服务，页面就有真实的
//     http://127.0.0.1:port 源，网页版那份 IndexedDB 虚拟文件系统可以原样跑。
//  2) 书源抓取在浏览器里受同源策略限制（网页版是靠用户自填的「书源代理」绕过的）。
//     手机上没有外网服务可用，于是把 /fetch 做成原生 URLSession 代理，
//     由 WKWebView 注入的 <meta name="moread-proxy"> 自动指过来 —— 和自建网关同一套协议。
//  3) 只监听 127.0.0.1，仅本机可访问，不监听局域网。
//

import Foundation
import Network
import UIKit
import CoreFoundation

/// 版本 / UA 之类的小常量
enum AppInfo {
    static var version: String {
        let v = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0"
        return v
    }
    static var build: String {
        Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "0"
    }
    /// 书源站点多半按 UA 给不同页面，这里报一个移动 Safari
    static var userAgent: String {
        let sys = UIDevice.current.systemVersion
        return "Mozilla/5.0 (iPhone; CPU iPhone OS \(sys.replacingOccurrences(of: ".", with: "_")) like Mac OS X) "
            + "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
    }
}

final class LocalServer {

    static let shared = LocalServer()

    private let queue = DispatchQueue(label: "moread.http", qos: .userInitiated)
    private let webRoot: URL
    private var listener: NWListener?
    private(set) var port: UInt16 = 0

    /// 抓取代理用的会话：默认配置（保留 cookie，书源登录态才不会丢）
    private lazy var session: URLSession = {
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 20
        cfg.timeoutIntervalForResource = 30
        cfg.httpShouldSetCookies = true
        cfg.httpCookieAcceptPolicy = .always
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: cfg)
    }()

    private init() {
        if let u = Bundle.main.url(forResource: "web", withExtension: nil) {
            webRoot = u
        } else {
            webRoot = Bundle.main.bundleURL
        }
    }

    // MARK: - 启动

    /// 端口写在 http 源里，端口一变 IndexedDB（书架）就等于换了个人，
    /// 所以按固定区间顺序试，尽量每次都拿到 8765。
    func start() -> UInt16? {
        if port != 0 { return port }
        var p: UInt16 = 8765
        while p <= 8785 {
            if let ok = tryStart(p) { return ok }
            p += 1
        }
        return nil
    }

    private func tryStart(_ candidate: UInt16) -> UInt16? {
        guard let nwPort = NWEndpoint.Port(rawValue: candidate) else { return nil }
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        params.requiredLocalEndpoint = NWEndpoint.hostPort(host: .ipv4(.loopback), port: nwPort)
        guard let l = try? NWListener(using: params) else { return nil }

        let sem = DispatchSemaphore(value: 0)
        var ready: UInt16?
        l.stateUpdateHandler = { state in
            // 注意：NWListener.State 不是 Optional，别写 guard let / case .failed?
            switch state {
            case .ready:
                ready = l.port?.rawValue ?? candidate
                sem.signal()
            case .failed, .cancelled:
                sem.signal()
            default:
                break
            }
        }
        l.newConnectionHandler = { [weak self] conn in
            self?.accept(conn)
        }
        l.start(queue: queue)
        _ = sem.wait(timeout: .now() + 3)
        if let r = ready, r != 0 {
            listener = l
            port = r
            return r
        }
        l.cancel()
        return nil
    }

    // MARK: - 连接处理

    private func accept(_ conn: NWConnection) {
        var buffer = Data()
        conn.stateUpdateHandler = { state in
            if case .failed = state { conn.cancel() }
        }
        conn.start(queue: queue)

        func readMore() {
            conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, isComplete, error in
                if let d = data, !d.isEmpty { buffer.append(d) }
                if let req = HTTPRequest.parse(buffer) {
                    self.route(req, on: conn)
                    return
                }
                if isComplete || error != nil || buffer.count > 2 * 1024 * 1024 {
                    conn.cancel()
                    return
                }
                readMore()
            }
        }
        readMore()
    }

    // MARK: - 路由

    private func route(_ req: HTTPRequest, on conn: NWConnection) {
        let pieces = req.target.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
        let path = pieces.isEmpty ? "/" : String(pieces[0])
        let query = pieces.count > 1 ? LocalServer.parseQuery(String(pieces[1])) : [:]

        if path == "/health" {
            let json = "{\"ok\":true,\"app\":\"moread-ios\",\"version\":\"\(AppInfo.version)\",\"build\":\"\(AppInfo.build)\"}"
            send(conn, status: 200, type: "application/json; charset=utf-8", body: Data(json.utf8))
            return
        }
        if path == "/fetch" {
            proxy(query, method: req.method, body: req.body, on: conn)
            return
        }
        if path == "/__shutdown" {
            send(conn, status: 200, type: "text/plain; charset=utf-8", body: Data("bye".utf8))
            return
        }

        // 静态文件
        var rel = path.hasPrefix("/") ? String(path.dropFirst()) : path
        if rel.isEmpty || rel == "/" { rel = "index.html" }
        if rel.contains("..") {
            send(conn, status: 403, type: "text/plain; charset=utf-8", body: Data("forbidden".utf8))
            return
        }
        let file = webRoot.appendingPathComponent(rel)
        guard let raw = try? Data(contentsOf: file) else {
            send(conn, status: 404, type: "text/plain; charset=utf-8", body: Data("not found: \(rel)".utf8))
            return
        }

        var body = raw
        if rel.hasSuffix(".html"), let text = String(data: raw, encoding: .utf8) {
            body = Data(LocalServer.injectProxyMeta(text).utf8)
        }
        send(conn, status: 200, type: LocalServer.mime(rel), body: body)
    }

    /// 和自建网关（server/gateway.js）注入的是同一个 meta，
    /// 网页版读到它就默认把跨域请求发到本站 /fetch。
    private static func injectProxyMeta(_ html: String) -> String {
        if html.contains("name=\"moread-proxy\"") { return html }
        let meta = "<meta name=\"moread-proxy\" content=\"/fetch?format=text\">"
        if let r = html.range(of: "</head>") {
            return html.replacingCharacters(in: r, with: meta + "\n</head>")
        }
        return html + meta
    }

    // MARK: - /fetch 代理

    private func proxy(_ q: [String: String], method: String, body: Data, on conn: NWConnection) {
        guard let raw = q["url"], let url = URL(string: raw),
              let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
            send(conn, status: 400, type: "text/plain; charset=utf-8", body: Data("bad url".utf8))
            return
        }
        var request = URLRequest(url: url)
        request.httpMethod = method == "POST" ? "POST" : "GET"
        request.timeoutInterval = 20
        request.setValue(AppInfo.userAgent, forHTTPHeaderField: "User-Agent")
        request.setValue("gzip, deflate", forHTTPHeaderField: "Accept-Encoding")
        if request.httpMethod == "POST", !body.isEmpty {
            request.httpBody = body
        }

        if let hv = q["h"], let headers = LocalServer.decodeHeaders(hv) {
            for (k, v) in headers {
                let lk = k.lowercased()
                if lk == "host" || lk == "content-length" || lk == "accept-encoding"
                    || lk == "connection" || lk == "origin" || lk == "referer" { continue }
                request.setValue(v, forHTTPHeaderField: k)
            }
        }

        session.dataTask(with: request) { data, resp, err in
            if let e = err {
                self.send(conn, status: 502, type: "text/plain; charset=utf-8",
                          body: Data("fetch failed: \(e.localizedDescription)".utf8))
                return
            }
            let http = resp as? HTTPURLResponse
            let body = data ?? Data()
            /* 取图（漫画）：代理不能按文本解码，直接回 base64 JSON，
               前端 bridge-web 看到 b64 就还原成原始字节。 */
            if q["b64"] == "1" {
                let ct = (http?.value(forHTTPHeaderField: "Content-Type") ?? "").lowercased()
                let mime = ct.split(separator: ";").first.map(String.init) ?? "application/octet-stream"
                let pack: [String: Any] = [
                    "status": http?.statusCode ?? 200,
                    "mime": mime.isEmpty ? "application/octet-stream" : mime,
                    "b64": body.base64EncodedString(),
                    "bytes": body.count,
                    "url": http?.url?.absoluteString ?? raw
                ]
                let json = (try? JSONSerialization.data(withJSONObject: pack)) ?? Data("{}".utf8)
                self.send(conn, status: http?.statusCode ?? 200,
                          type: "application/json; charset=utf-8", body: json)
                return
            }
            let charset = self.charset(response: http, body: body, hint: q["charset"] ?? "auto")
            let text = self.decode(body, charset: charset)
            self.send(conn, status: http?.statusCode ?? 200,
                      type: "text/plain; charset=utf-8", body: Data(text.utf8))
        }.resume()
    }

    private static func decodeHeaders(_ b64url: String) -> [String: String]? {
        var s = b64url.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while s.count % 4 != 0 { s += "=" }
        guard let data = Data(base64Encoded: s, options: .ignoreUnknownCharacters),
              let json = try? JSONSerialization.jsonObject(with: data),
              let obj = json as? [String: Any] else { return nil }
        var out: [String: String] = [:]
        for (k, v) in obj { out[k] = "\(v)" }
        return out
    }

    // MARK: - 字符集

    private func charset(response: HTTPURLResponse?, body: Data, hint: String) -> String {
        let h = hint.lowercased()
        if !h.isEmpty && h != "auto" { return h }
        if let ct = response?.value(forHTTPHeaderField: "Content-Type")?.lowercased(),
           let r = ct.range(of: "charset=") {
            var v = String(ct[r.upperBound...])
            if let semi = v.firstIndex(of: ";") { v = String(v[v.startIndex..<semi]) }
            v = v.trimmingCharacters(in: CharacterSet(charactersIn: "\"' "))
            if !v.isEmpty { return v }
        }
        // 从 HTML 头里嗅探 <meta charset=...>
        let head = String(data: body.prefix(2048), encoding: .isoLatin1)?.lowercased() ?? ""
        for key in ["charset=", "charset=\""] {
            if let r = head.range(of: key) {
                var v = String(head[r.upperBound...])
                if let stop = v.firstIndex(where: { $0 == "\"" || $0 == ">" || $0 == ";" || $0 == " " || $0 == "/" }) {
                    v = String(v[v.startIndex..<stop])
                }
                v = v.trimmingCharacters(in: .whitespacesAndNewlines)
                if !v.isEmpty { return v }
            }
        }
        return "utf-8"
    }

    private func decode(_ data: Data, charset: String) -> String {
        let cs = charset.lowercased()
        if cs.contains("gb") || cs.contains("gbk") || cs.contains("gb2312") || cs.contains("gb18030") {
            let enc = CFStringConvertEncodingToNSStringEncoding(CFStringEncoding(CFStringEncodings.GB_18030_2000.rawValue))
            if let s = String(data: data, encoding: String.Encoding(rawValue: enc)) { return s }
        }
        if let s = String(data: data, encoding: .utf8) { return s }
        let enc = CFStringConvertEncodingToNSStringEncoding(CFStringEncoding(CFStringEncodings.GB_18030_2000.rawValue))
        if let s = String(data: data, encoding: String.Encoding(rawValue: enc)) { return s }
        return String(data: data, encoding: .isoLatin1) ?? ""
    }

    // MARK: - 响应

    private func send(_ conn: NWConnection, status: Int, type: String, body: Data) {
        var head = "HTTP/1.1 \(status) \(LocalServer.reason(status))\r\n"
        head += "Content-Type: \(type)\r\n"
        head += "Content-Length: \(body.count)\r\n"
        head += "Cache-Control: no-store\r\n"
        head += "Access-Control-Allow-Origin: *\r\n"
        head += "Connection: close\r\n\r\n"
        var out = Data(head.utf8)
        out.append(body)
        conn.send(content: out, contentContext: .defaultMessage, isComplete: true,
                  completion: .contentProcessed { _ in conn.cancel() })
    }

    private static func reason(_ code: Int) -> String {
        switch code {
        case 200: return "OK"
        case 204: return "No Content"
        case 400: return "Bad Request"
        case 403: return "Forbidden"
        case 404: return "Not Found"
        case 502: return "Bad Gateway"
        default: return "OK"
        }
    }

    private static func mime(_ path: String) -> String {
        let ext = (path as NSString).pathExtension.lowercased()
        switch ext {
        case "html", "htm": return "text/html; charset=utf-8"
        case "js": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json", "webmanifest": return "application/json; charset=utf-8"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "svg": return "image/svg+xml"
        case "webp": return "image/webp"
        case "woff2": return "font/woff2"
        case "woff": return "font/woff"
        case "ttf": return "font/ttf"
        case "ico": return "image/x-icon"
        case "txt", "md": return "text/plain; charset=utf-8"
        default: return "application/octet-stream"
        }
    }

    private static func parseQuery(_ s: String) -> [String: String] {
        var out: [String: String] = [:]
        for pair in s.split(separator: "&") {
            let kv = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            guard let k = kv.first else { continue }
            let rawK = String(k).replacingOccurrences(of: "+", with: " ")
            let rawV = kv.count > 1 ? String(kv[1]).replacingOccurrences(of: "+", with: " ") : ""
            let key = rawK.removingPercentEncoding ?? rawK
            out[key] = rawV.removingPercentEncoding ?? rawV
        }
        return out
    }
}

// MARK: - 极简请求解析

struct HTTPRequest {
    let method: String
    let target: String
    let headers: [String: String]
    let body: Data

    /// 收满「请求头 + Content-Length 声明的主体」才返回，否则返回 nil 继续收。
    static func parse(_ data: Data) -> HTTPRequest? {
        guard let headRange = data.range(of: Data([13, 10, 13, 10])) else { return nil }
        guard let head = String(data: data.subdata(in: 0..<headRange.lowerBound), encoding: .utf8) else { return nil }
        var lines = head.components(separatedBy: "\r\n")
        guard !lines.isEmpty else { return nil }
        let first = lines.removeFirst().split(separator: " ")
        guard first.count >= 2 else { return nil }

        var headers: [String: String] = [:]
        for line in lines {
            guard let idx = line.firstIndex(of: ":") else { continue }
            let key = String(line[line.startIndex..<idx]).trimmingCharacters(in: .whitespaces).lowercased()
            let val = String(line[line.index(after: idx)...]).trimmingCharacters(in: .whitespaces)
            headers[key] = val
        }
        let len = Int(headers["content-length"] ?? "0") ?? 0
        let start = headRange.upperBound
        guard data.count >= start + len else { return nil }
        let body = len > 0 ? data.subdata(in: start..<(start + len)) : Data()
        return HTTPRequest(method: String(first[0]), target: String(first[1]), headers: headers, body: body)
    }
}
