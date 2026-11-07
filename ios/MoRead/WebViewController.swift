//
//  WebViewController.swift
//  墨读 iOS
//
//  页面来自应用内 127.0.0.1 的本地服务（LocalServer），不是 file://，
//  所以 localStorage / IndexedDB / fetch 的行为和浏览器里完全一致，
//  网页版（web/bridge-web.js）那份「原生桥」可以原样复用。
//
//  这里只补三件浏览器做不了的事：
//   · 下载（备份导出、书源 JSON 落盘）→ UIActivityViewController 存到「文件」
//   · 新窗口链接 → 交给系统浏览器
//   · 原生 alert / confirm / prompt（页面里少数兜底调用）
//

import UIKit
import WebKit

final class WebViewController: UIViewController {

    private var webView: WKWebView!
    private let server = LocalServer.shared

    /// WKDownload → 落盘路径（下载完成后再弹分享面板）
    private var downloadPaths: [ObjectIdentifier: URL] = [:]

    // MARK: - 生命周期

    override func viewDidLoad() {
        super.viewDidLoad()

        view.backgroundColor = UIColor(red: 0.933, green: 0.941, blue: 0.957, alpha: 1)

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()          // 书架存在这里（IndexedDB），必须用 default
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        config.preferences.javaScriptCanOpenWindowsAutomatically = true

        let wv = WKWebView(frame: view.bounds, configuration: config)
        wv.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        wv.navigationDelegate = self
        wv.uiDelegate = self
        wv.allowsBackForwardNavigationGestures = false
        wv.scrollView.bounces = false
        wv.scrollView.contentInsetAdjustmentBehavior = .never
        wv.isOpaque = false
        wv.backgroundColor = .clear
        if #available(iOS 16.4, *) {
            wv.isInspectable = true
        }
        view.addSubview(wv)
        webView = wv

        guard let port = server.start() else {
            showFatal("本地服务启动失败：8765–8785 端口都被占用。请关掉后台同类应用后重开。")
            return
        }
        // index.html 里 viewport-fit=cover，安全区交给 css env() 处理
        let url = URL(string: "http://127.0.0.1:\(port)/index.html")!
        wv.load(URLRequest(url: url))
    }

    override var preferredStatusBarStyle: UIStatusBarStyle {
        return .default
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        webView?.frame = view.bounds
    }

    override func didReceiveMemoryWarning() {
        super.didReceiveMemoryWarning()
        downloadPaths.removeAll()
    }

    // MARK: - 启动失败兜底

    private func showFatal(_ message: String) {
        let label = UILabel()
        label.numberOfLines = 0
        label.textAlignment = .center
        label.textColor = UIColor(red: 0.35, green: 0.37, blue: 0.42, alpha: 1)
        label.font = UIFont.systemFont(ofSize: 15)
        label.text = message
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            label.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 32),
            label.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -32)
        ])
    }

    // MARK: - 分享

    private func presentShare(_ file: URL) {
        let activity = UIActivityViewController(activityItems: [file], applicationActivities: nil)
        if let pop = activity.popoverPresentationController {
            pop.sourceView = view
            pop.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.maxY - 60, width: 1, height: 1)
        }
        present(activity, animated: true, completion: nil)
    }
}

// MARK: - 导航与下载

extension WebViewController: WKNavigationDelegate {

    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if navigationAction.shouldPerformDownload {
            decisionHandler(.download)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if !navigationResponse.canShowMIMEType {
            decisionHandler(.download)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }
}

// MARK: - 原生面板 + 新窗口

extension WebViewController: WKUIDelegate {

    func webView(_ webView: WKWebView,
                 runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping () -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "好", style: .default) { _ in completionHandler() })
        present(alert, animated: true, completion: nil)
    }

    func webView(_ webView: WKWebView,
                 runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (Bool) -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "取消", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "确定", style: .default) { _ in completionHandler(true) })
        present(alert, animated: true, completion: nil)
    }

    func webView(_ webView: WKWebView,
                 runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        alert.addTextField { field in field.text = defaultText }
        alert.addAction(UIAlertAction(title: "取消", style: .cancel) { _ in completionHandler(nil) })
        alert.addAction(UIAlertAction(title: "确定", style: .default) { _ in
            completionHandler(alert.textFields?.first?.text)
        })
        present(alert, animated: true, completion: nil)
    }

    /// target="_blank" / window.open：交给系统浏览器（关于页的 GitHub 链接走这条）
    func webView(_ webView: WKWebView,
                 createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url {
            UIApplication.shared.open(url, options: [:], completionHandler: nil)
        }
        return nil
    }
}

// MARK: - 下载落盘

extension WebViewController: WKDownloadDelegate {

    func download(_ download: WKDownload,
                  decideDestinationUsing response: URLResponse,
                  suggestedFilename: String,
                  completionHandler: @escaping (URL?) -> Void) {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("moread-export", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var name = suggestedFilename
        if name.isEmpty { name = "moread-export.bin" }
        var target = dir.appendingPathComponent(name)
        var n = 1
        while FileManager.default.fileExists(atPath: target.path) {
            let base = (name as NSString).deletingPathExtension
            let ext = (name as NSString).pathExtension
            let suffix = ext.isEmpty ? "" : ".\(ext)"
            target = dir.appendingPathComponent("\(base)-\(n)\(suffix)")
            n += 1
        }
        downloadPaths[ObjectIdentifier(download)] = target
        completionHandler(target)
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let file = downloadPaths.removeValue(forKey: ObjectIdentifier(download)) else { return }
        presentShare(file)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloadPaths.removeValue(forKey: ObjectIdentifier(download))
        let alert = UIAlertController(title: "导出失败", message: error.localizedDescription,
                                      preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "好", style: .default, handler: nil))
        present(alert, animated: true, completion: nil)
    }
}
