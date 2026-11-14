import Cocoa
import WebKit
import AVFoundation
import ServiceManagement

/// Borderless window that lives at the desktop (wallpaper) level, under the desktop icons.
final class WallpaperWindow: NSWindow {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate,
                         WKScriptMessageHandler, NSMenuDelegate {
    private var window: WallpaperWindow!
    private var webView: WKWebView!
    private var statusItem: NSStatusItem!
    private let defaults = UserDefaults.standard
    private lazy var server = LocalServer(root: { [unowned self] in self.webDir })
    private var pageReady = false
    private var cameraProblem: String?
    private var recording = false

    /// Fallback tracker (Apple Vision) used only if MediaPipe can't start in the page.
    private let visionTracker = FaceTracker()
    private var useVisionFallback = false

    // Things that decide whether the camera should be on.
    private var windowVisible = true
    private var screensAwake = true
    private var sessionLocked = false
    private var hideWorkItem: DispatchWorkItem?

    private var character: String {
        get { defaults.string(forKey: "character") ?? "girl" }
        set { defaults.set(newValue, forKey: "character"); pushSettings() }
    }
    private var mirror: Bool {
        get { defaults.object(forKey: "mirror") as? Bool ?? true }
        set { defaults.set(newValue, forKey: "mirror"); pushSettings() }
    }
    private var paused: Bool {
        get { defaults.bool(forKey: "paused") }
        set { defaults.set(newValue, forKey: "paused"); updateTracking(); pushSettings() }
    }
    private var debug: Bool {
        get { defaults.bool(forKey: "debug") }
        set { defaults.set(newValue, forKey: "debug"); pushSettings() }
    }
    private var timeOfDay: String {   // auto | day | night
        get { defaults.string(forKey: "timeOfDay") ?? "auto" }
        set { defaults.set(newValue, forKey: "timeOfDay"); pushSettings() }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildWindow()
        buildStatusItem()
        server.onSave = { [weak self] name, data, test in self?.saveToDesktop(name: name, data: data, test: test) }
        server.start(preferredPort: 47821) { [weak self] _ in self?.loadPage() }

        visionTracker.onFrame = { [weak self] frame in self?.sendVisionFrame(frame) }
        visionTracker.onError = { [weak self] err in self?.cameraProblem = err; self?.pushSettings() }

        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(occlusionChanged),
                       name: NSWindow.didChangeOcclusionStateNotification, object: window)
        nc.addObserver(self, selector: #selector(screensChanged),
                       name: NSApplication.didChangeScreenParametersNotification, object: nil)
        let ws = NSWorkspace.shared.notificationCenter
        for (name, awake) in [(NSWorkspace.screensDidSleepNotification, false), (NSWorkspace.screensDidWakeNotification, true),
                              (NSWorkspace.willSleepNotification, false), (NSWorkspace.didWakeNotification, true)] {
            ws.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                self?.screensAwake = awake; self?.updateTracking()
            }
        }
        let dnc = DistributedNotificationCenter.default()
        for (name, locked) in [("com.apple.screenIsLocked", true), ("com.apple.screenIsUnlocked", false)] {
            dnc.addObserver(forName: .init(name), object: nil, queue: .main) { [weak self] _ in
                self?.sessionLocked = locked; self?.updateTracking()
            }
        }
        // Developer hooks (off unless `defaults write com.minime.wallpaper devHooks -bool true`), because any
        // local process can post these notifications: `snapshot` saves the rendered wallpaper to the caches
        // folder, `reload` reloads the page, `testrec` records a 2 s clip into the caches folder.
        if defaults.bool(forKey: "devHooks") {
            dnc.addObserver(forName: .init("com.minime.snapshot"), object: nil, queue: .main) { [weak self] _ in
                self?.saveSnapshot()
            }
            dnc.addObserver(forName: .init("com.minime.reload"), object: nil, queue: .main) { [weak self] _ in
                self?.loadPage()
            }
            dnc.addObserver(forName: .init("com.minime.testrec"), object: nil, queue: .main) { [weak self] _ in
                self?.js("window.rig && rig.record({seconds: 2, layout: 'split', test: true, noCountdown: true})")
            }
        }
    }

    // MARK: files

    private lazy var cacheDir: URL = {
        let u = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("com.minime.wallpaper", isDirectory: true)
        try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        return u
    }()

    private func saveSnapshot() {
        let url = cacheDir.appendingPathComponent("snapshot.png")
        webView.takeSnapshot(with: nil) { image, _ in
            guard let image, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
                  let png = rep.representation(using: .png, properties: [:]) else { return }
            try? png.write(to: url)
        }
    }

    /// Saves a photo/video sent by the page to the Desktop (called on the server queue).
    private func saveToDesktop(name: String, data: Data, test: Bool = false) -> URL? {
        let allowed = ["mp4", "mov", "webm", "png", "jpg"]
        let clean = name.components(separatedBy: CharacterSet(charactersIn: "/\\:")).joined()
        let ext = (clean as NSString).pathExtension.lowercased()
        guard allowed.contains(ext), !data.isEmpty else { return nil }
        let desktop = test ? cacheDir : FileManager.default.urls(for: .desktopDirectory, in: .userDomainMask)[0]
        var url = desktop.appendingPathComponent(clean)
        var n = 2
        while FileManager.default.fileExists(atPath: url.path) {
            url = desktop.appendingPathComponent("\((clean as NSString).deletingPathExtension)-\(n).\(ext)"); n += 1
        }
        do { try data.write(to: url) } catch { return nil }
        if !test { DispatchQueue.main.async { NSWorkspace.shared.activateFileViewerSelecting([url]) } }
        return url
    }

    private func appendLog(_ line: String) {
        let url = cacheDir.appendingPathComponent("web.log")
        let stamp = ISO8601DateFormatter().string(from: Date())
        let data = Data("\(stamp) \(line)\n".utf8)
        if let h = try? FileHandle(forWritingTo: url) {
            h.seekToEndOfFile(); h.write(data); try? h.close()
            if (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0) ?? 0 > 2_000_000 {
                try? FileManager.default.removeItem(at: url)
            }
        } else {
            try? data.write(to: url)
        }
    }

    // MARK: window & web view

    private var targetScreen: NSScreen { NSScreen.screens.first ?? NSScreen.main! }
    private let desktopLevel = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.desktopWindow)))

    private func buildWindow() {
        let frame = targetScreen.frame
        window = WallpaperWindow(contentRect: frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.level = desktopLevel
        window.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
        window.ignoresMouseEvents = true
        window.isOpaque = true
        window.hasShadow = false
        window.backgroundColor = NSColor(red: 0.98, green: 0.93, blue: 0.88, alpha: 1)
        window.isReleasedWhenClosed = false

        let config = WKWebViewConfiguration()
        config.suppressesIncrementalRendering = true
        config.websiteDataStore = .nonPersistent()          // no disk cache: edits to the web files show up on reload
        config.mediaTypesRequiringUserActionForPlayback = []
        let ucc = config.userContentController
        ucc.add(self, name: "minime")
        ucc.addUserScript(WKUserScript(source: "window.MINIME = {token: '\(server.token)', native: true};",
                                       injectionTime: .atDocumentStart, forMainFrameOnly: true))
        webView = WKWebView(frame: NSRect(origin: .zero, size: frame.size), configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        window.contentView = webView
        window.setFrame(frame, display: true)
        window.orderFront(nil)
    }

    /// Web assets come from the app bundle, unless `defaults write com.minime.wallpaper webDir <path>`
    /// points at a development copy.
    private var webDir: URL {
        if let dev = defaults.string(forKey: "webDir"),
           FileManager.default.fileExists(atPath: (dev as NSString).appendingPathComponent("index.html")) {
            return URL(fileURLWithPath: dev, isDirectory: true)
        }
        return Bundle.main.resourceURL!.appendingPathComponent("web", isDirectory: true)
    }

    private func loadPage() {
        guard server.port != 0 else { return }
        pageReady = false
        if useVisionFallback { visionTracker.stop(); useVisionFallback = false }
        let url = URL(string: "http://127.0.0.1:\(server.port)/index.html?t=\(Int(Date().timeIntervalSince1970))")!
        webView.configuration.websiteDataStore.removeData(
            ofTypes: [WKWebsiteDataTypeMemoryCache, WKWebsiteDataTypeDiskCache], modifiedSince: .distantPast) { [weak self] in
            self?.webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData))
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        pageReady = true
        pushSettings()
        updateTracking()
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        appendLog("[native] web content process terminated — reloading")
        loadPage()
    }

    /// The page asks for the camera: allow it for our own localhost page only.
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        let ours = origin.host == "127.0.0.1" && origin.port == Int(server.port)
        decisionHandler(ours && type == .camera ? .grant : .deny)
    }

    private func js(_ code: String) {
        guard pageReady else { return }
        webView.evaluateJavaScript(code, completionHandler: nil)
    }

    private func pushSettings() {
        js("window.rig && rig.configure({character:'\(character)', debug:\(debug), mirror:\(mirror), tracking:\(!paused), timeOfDay:'\(timeOfDay)', lang:'\(L10n.isPersian ? "fa" : "en")'})")
    }

    // MARK: messages from the page

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "log":
            appendLog("[\(body["level"] as? String ?? "log")] \(body["msg"] as? String ?? "")")
        case "status":
            if let data = try? JSONSerialization.data(withJSONObject: body["data"] ?? [:], options: [.prettyPrinted, .sortedKeys]) {
                try? data.write(to: cacheDir.appendingPathComponent("status.json"))
            }
        case "camera":
            let state = body["state"] as? String ?? ""
            cameraProblem = state == "denied" ? "denied" : state == "nocamera" ? "nocamera" : nil
        case "trackerFailed":
            appendLog("[native] MediaPipe failed (\(body["error"] as? String ?? "?")) — using Apple Vision")
            useVisionFallback = true
            updateTracking()
        case "recording":
            setRecording(body["active"] as? Bool ?? false)
        default: break
        }
    }

    /// While recording, lift the wallpaper above other windows so it keeps rendering (and you can see it).
    private func setRecording(_ active: Bool) {
        recording = active
        if active {
            window.level = .floating
            window.orderFrontRegardless()
        } else {
            window.level = desktopLevel
            window.orderFront(nil)
        }
        updateTracking()
    }

    @objc private func screensChanged() {
        window.setFrame(targetScreen.frame, display: true)
    }

    @objc private func occlusionChanged() {
        let visible = window.occlusionState.contains(.visible)
        hideWorkItem?.cancel()
        if visible {
            windowVisible = true
            updateTracking()
        } else {
            // Wait a moment so quick window shuffles don't flicker the camera on/off.
            let item = DispatchWorkItem { [weak self] in self?.windowVisible = false; self?.updateTracking() }
            hideWorkItem = item
            DispatchQueue.main.asyncAfter(deadline: .now() + 3, execute: item)
        }
    }

    // MARK: tracking

    private var lastTrackingState: Bool?
    private func updateTracking() {
        let shouldRun = !paused && screensAwake && !sessionLocked && (windowVisible || recording)
        if shouldRun != lastTrackingState {
            lastTrackingState = shouldRun
            appendLog("[native] camera \(shouldRun ? "on" : "off") (visible=\(windowVisible) paused=\(paused) awake=\(screensAwake) locked=\(sessionLocked) rec=\(recording))")
        }
        if useVisionFallback {
            if shouldRun { visionTracker.start() } else { visionTracker.stop() }
        } else {
            js("window.tracker && tracker.setActive(\(shouldRun))")
        }
    }

    /// Translates the Apple Vision fallback output into the page's face format.
    private func sendVisionFrame(_ frame: FaceFrame?) {
        guard let f = frame else { js("window.rig && rig.setFace(null)"); return }
        let m = mirror
        let smile = max(f.smile, 0), frown = max(-f.smile, 0)
        let d: [String: Double] = [
            "yaw": (m ? -f.yaw : f.yaw) * 0.6, "pitch": f.pitch * 0.4, "roll": m ? -f.roll : f.roll,
            "eyeL": m ? f.eyeR : f.eyeL, "eyeR": m ? f.eyeL : f.eyeR,
            "browL": m ? f.browR : f.browL, "browR": m ? f.browL : f.browR,
            "jaw": f.mouthOpen, "smileL": smile, "smileR": smile, "frown": frown,
            "gx": m ? -f.gazeX : f.gazeX, "gy": f.gazeY, "px": m ? -f.posX : f.posX, "py": f.posY, "lean": f.lean,
        ]
        let json = d.map { "\"\($0.key)\":\(String(format: "%.4f", $0.value))" }.joined(separator: ",")
        js("window.rig && rig.setFace({\(json)})")
    }

    // MARK: menu bar

    private func buildStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let img = NSImage(systemSymbolName: "face.smiling", accessibilityDescription: "MiniMe") {
            img.isTemplate = true
            statusItem.button?.image = img
        } else {
            statusItem.button?.title = "🙂"
        }
        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        @discardableResult func item(_ title: String, _ action: Selector, on: Bool = false, key: String = "",
                                     to target: NSMenu? = nil) -> NSMenuItem {
            let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
            i.target = self
            i.state = on ? .on : .off
            (target ?? menu).addItem(i)
            return i
        }
        if cameraProblem == "denied" {
            item(L10n.tr("cameraDenied"), #selector(openCameraSettings))
            menu.addItem(.separator())
        } else if cameraProblem == "nocamera" {
            item(L10n.tr("noCamera"), #selector(noop)).isEnabled = false
            menu.addItem(.separator())
        }
        item(L10n.tr("recordSplit"), #selector(recordSplit))
        item(L10n.tr("recordScene"), #selector(recordScene))
        item(L10n.tr("photo"), #selector(photo))
        menu.addItem(.separator())
        item(L10n.tr("girl"), #selector(pickGirl), on: character == "girl")
        item(L10n.tr("boy"), #selector(pickBoy), on: character == "boy")
        menu.addItem(.separator())
        let tod = NSMenu()
        item(L10n.tr("todAuto"), #selector(todAuto), on: timeOfDay == "auto", to: tod)
        item(L10n.tr("todDay"), #selector(todDay), on: timeOfDay == "day", to: tod)
        item(L10n.tr("todNight"), #selector(todNight), on: timeOfDay == "night", to: tod)
        let todItem = NSMenuItem(title: L10n.tr("timeOfDay"), action: nil, keyEquivalent: "")
        todItem.submenu = tod
        menu.addItem(todItem)
        item(L10n.tr("calibrate"), #selector(calibrate))
        item(L10n.tr("mirror"), #selector(toggleMirror), on: mirror)
        item(L10n.tr("pause"), #selector(togglePause), on: paused)
        item(L10n.tr("debug"), #selector(toggleDebug), on: debug)
        item(L10n.tr("login"), #selector(toggleLogin), on: SMAppService.mainApp.status == .enabled)
        menu.addItem(.separator())
        item(L10n.tr("reload"), #selector(reload), key: "r")
        item(L10n.tr("quit"), #selector(quit), key: "q")
    }

    @objc private func noop() {}
    @objc private func pickGirl() { character = "girl" }
    @objc private func pickBoy() { character = "boy" }
    @objc private func toggleMirror() { mirror.toggle() }
    @objc private func togglePause() { paused.toggle() }
    @objc private func toggleDebug() { debug.toggle() }
    @objc private func todAuto() { timeOfDay = "auto" }
    @objc private func todDay() { timeOfDay = "day" }
    @objc private func todNight() { timeOfDay = "night" }
    @objc private func calibrate() { js("window.tracker && tracker.calibrate()") }
    @objc private func recordSplit() { startRecording(layout: "split") }
    @objc private func recordScene() { startRecording(layout: "scene") }
    @objc private func photo() { js("window.rig && rig.photo('split')") }
    @objc private func reload() { loadPage() }
    @objc private func quit() { NSApp.terminate(nil) }

    private func startRecording(layout: String) {
        guard !recording else { return }
        setRecording(true)
        js("window.rig && rig.record({seconds: 10, layout: '\(layout)'})")
    }

    @objc private func toggleLogin() {
        do {
            if SMAppService.mainApp.status == .enabled { try SMAppService.mainApp.unregister() }
            else { try SMAppService.mainApp.register() }
        } catch {
            let alert = NSAlert()
            alert.messageText = L10n.tr("loginFailed")
            alert.informativeText = error.localizedDescription
            alert.runModal()
        }
    }

    @objc private func openCameraSettings() {
        cameraProblem = nil
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera") {
            NSWorkspace.shared.open(url)
        }
        updateTracking()
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
