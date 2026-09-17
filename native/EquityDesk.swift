import Cocoa
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    let smokeTest = CommandLine.arguments.contains("--smoke-test")

    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu(title: "EquityDesk")
        appMenu.addItem(withTitle: "Quit EquityDesk", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu; menu.addItem(appItem)
        let edit = NSMenuItem(); let editMenu = NSMenu(title: "Edit")
        for (title, action, key) in [("Undo", "undo:", "z"), ("Cut", "cut:", "x"), ("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
            editMenu.addItem(withTitle: title, action: Selector(action), keyEquivalent: key)
        }
        edit.submenu = editMenu; menu.addItem(edit)
        let viewItem = NSMenuItem(); let viewMenu = NSMenu(title: "View")
        viewMenu.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
        viewItem.submenu = viewMenu; menu.addItem(viewItem)
        NSApplication.shared.mainMenu = menu
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 860),
            styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "EquityDesk"
        window.minSize = NSSize(width: 720, height: 560)
        window.setFrameAutosaveName("EquityDeskMainWindow")
        window.center()
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
        startServer()
        if smokeTest { DispatchQueue.main.asyncAfter(deadline: .now() + 30) { print("Mac startup check timed out"); exit(1) } }
    }
    @objc func reload() { webView.reload() }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if smokeTest { print("Mac window loaded EquityDesk successfully"); exit(0) }
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if smokeTest { print("Mac page failed to load: " + String((error as NSError).code)); exit(1) }
    }
    func startServer() {
        let parent = Bundle.main.bundleURL.deletingLastPathComponent()
        let savedPath = (try? String(contentsOf: Bundle.main.resourceURL!.appendingPathComponent("workspace.txt"), encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines)
        let root = FileManager.default.fileExists(atPath: parent.appendingPathComponent("launcher.py").path) ? parent : URL(fileURLWithPath: savedPath ?? parent.path)
        DispatchQueue.global(qos: .userInitiated).async {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
            process.arguments = [root.appendingPathComponent("launcher.py").path, "--no-open"]
            process.currentDirectoryURL = root
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            var success = false
            do { try process.run(); process.waitUntilExit(); success = process.terminationStatus == 0 } catch {}
            DispatchQueue.main.async {
                if success {
                    self.webView.load(URLRequest(url: URL(string: "http://127.0.0.1:8765/")!))
                } else {
                    let alert = NSAlert()
                    alert.messageText = "EquityDesk could not open"
                    alert.informativeText = "Keep the Stock Tool folder in Documents. Try Launch EquityDesk.command in that folder, or ask Codex to check the app."
                    alert.addButton(withTitle: "OK"); alert.runModal()
                }
            }
        }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if url.scheme == "http" && url.host == "127.0.0.1" && url.port == 8765 {
            decisionHandler(.allow)
        } else {
            if url.scheme == "https" { NSWorkspace.shared.open(url) }
            decisionHandler(.cancel)
        }
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, url.scheme == "https" { NSWorkspace.shared.open(url) }
        return nil
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
