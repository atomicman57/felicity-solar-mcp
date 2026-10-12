#if os(macOS)
import AppKit
import SwiftUI
import WidgetKit

@MainActor
final class MenuBarController: NSObject, NSApplicationDelegate {
    private var item: NSStatusItem!
    private var refreshTimer: Timer?
    private var snapshot = SolarConnection.cached
    private var failed = false
    private var fetching = false
    private var window: NSWindow?
    private var backend: Process?
    private var connectionWindow: NSWindow?
    private let cloudServer = NSTextField(string: "")
    private let cloudPlant = NSTextField(string: "")
    private let connectionMessage = NSTextField(wrappingLabelWithString: "")
    private let statusLabel = NSTextField(labelWithString: "Checking grid…")
    private let detailLabel = NSTextField(wrappingLabelWithString: "")

    func applicationDidFinishLaunching(_ notification: Notification) {
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.autosaveName = "FelicitySolarGrid"
        createWindow()
        render()
        Task { await refresh() }
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.refresh() }
        }
    }
    func applicationWillTerminate(_ notification: Notification) { refreshTimer?.invalidate() }
    private func render() {
        let unknown = failed || snapshot.stale || snapshot.gridOn == nil
        let on = !unknown && snapshot.gridOn == true
        let color: NSColor = unknown ? .secondaryLabelColor : on ? .systemGreen : .systemRed
        let label = unknown ? "Grid ?" : on ? "Grid ON" : "Grid OFF"
        if let button = item?.button {
            button.title = " " + (snapshot.battery.map { String(format: "%.0f%%", $0) } ?? "—%")
            if !failed, let pv = snapshot.currentPvLabel { button.title += " · ☀ " + pv }
            button.font = .monospacedDigitSystemFont(ofSize: 11, weight: .medium)
            let image = NSImage(size: NSSize(width: 12, height: 12), flipped: false) { rect in
                color.setFill(); NSBezierPath(ovalIn: rect.insetBy(dx: 2, dy: 2)).fill(); return true
            }
            image.isTemplate = false; button.image = image
            button.imagePosition = .imageLeading
            button.toolTip = unknown ? "Grid status unavailable: readings are missing, stale or the dashboard is offline." : on ? "Grid electricity is available." : "Grid electricity is off."
            button.setAccessibilityLabel(label + ", battery " + button.title)
        }
        let menu = NSMenu()
        let heading = NSMenuItem(title: snapshot.plant, action: nil, keyEquivalent: ""); heading.isEnabled = false; menu.addItem(heading)
        let status = NSMenuItem(title: unknown ? "Grid status unknown" : on ? "● Grid electricity is ON" : "● Grid electricity is OFF", action: nil, keyEquivalent: ""); status.isEnabled = false; menu.addItem(status)
        for text in snapshot.gridTimingLabel.components(separatedBy: "\n") { let row = NSMenuItem(title: text, action: nil, keyEquivalent: ""); row.isEnabled = false; menu.addItem(row) }
        if let date = snapshot.observedDate { let row = NSMenuItem(title: "Measured: " + date.formatted(date: .abbreviated, time: .shortened), action: nil, keyEquivalent: ""); row.isEnabled = false; menu.addItem(row) }
        let readings = NSMenuItem(title: String(format: "Battery: %@   •   Solar today: %@", snapshot.battery.map { String(format: "%.0f%%", $0) } ?? "—", snapshot.todayKwh.map { String(format: "%.1f kWh", $0) } ?? "—"), action: nil, keyEquivalent: ""); readings.isEnabled = false; menu.addItem(readings)
        if !failed, let pv = snapshot.currentPvLabel { let row = NSMenuItem(title: "Solar generating now: " + pv, action: nil, keyEquivalent: ""); row.isEnabled = false; menu.addItem(row) }
        menu.addItem(.separator())
        for (title, action) in [("Open dashboard", #selector(openDashboard)), ("Connection settings…", #selector(openConnection)), ("Open Felicity Solar", #selector(openApp)), ("Refresh indicator", #selector(refreshNow)), ("Quit Felicity Solar", #selector(quit))] {
            let row = NSMenuItem(title: title, action: action, keyEquivalent: ""); row.target = self; menu.addItem(row)
        }
        item?.menu = menu
        statusLabel.stringValue = label
        statusLabel.textColor = color
        let currentPV = !failed ? snapshot.currentPvLabel.map { "\nSolar generating now: " + $0 } ?? "" : ""
        detailLabel.stringValue = (snapshot.battery.map { String(format: "Battery: %.0f%%", $0) } ?? "Battery: unknown") + "\n\n" + snapshot.gridTimingLabel + "\n\n" + (snapshot.todayKwh.map { String(format: "Solar today: %.1f kWh", $0) } ?? "Solar today: unknown") + currentPV

    }
    private func createWindow() {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 270), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "Felicity Solar"; window.isReleasedWhenClosed = false; window.center()
        let stack = NSStackView(); stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 10; stack.translatesAutoresizingMaskIntoConstraints = false
        statusLabel.font = .systemFont(ofSize: 23, weight: .bold)
        detailLabel.font = .systemFont(ofSize: 13)
        stack.addArrangedSubview(statusLabel); stack.addArrangedSubview(detailLabel)
        let buttons = NSStackView(); buttons.orientation = .horizontal; buttons.spacing = 10
        buttons.addArrangedSubview(NSButton(title: "Open dashboard", target: self, action: #selector(openDashboard)))
        buttons.addArrangedSubview(NSButton(title: "Refresh", target: self, action: #selector(refreshNow)))
        buttons.addArrangedSubview(NSButton(title: "Cloud connection", target: self, action: #selector(openConnection)))
        stack.addArrangedSubview(buttons)
        let note = NSTextField(wrappingLabelWithString: "Green: grid ON · Red: OFF · Gray: unknown. Times are first/last observed readings.")
        note.font = .systemFont(ofSize: 11); note.textColor = .secondaryLabelColor; stack.addArrangedSubview(note)
        window.contentView!.addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor, constant: 18), stack.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor, constant: -18), stack.topAnchor.constraint(equalTo: window.contentView!.topAnchor, constant: 18)])
        self.window = window; window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
    }
    private func refresh() async {
        guard !fetching else { return }; fetching = true
        do { snapshot = try await SolarConnection.fetch(); failed = false } catch { failed = true; startLocalBackendIfNeeded() }
        render(); fetching = false
    }
    @objc private func refreshNow() { Task { await refresh() } }
    @objc private func openDashboard() { if let url = URL(string: SolarConnection.server) { NSWorkspace.shared.open(url) } }
    @objc private func openApp() { NSApp.activate(ignoringOtherApps: true); window?.makeKeyAndOrderFront(nil) }
    @objc private func quit() { NSApp.terminate(nil) }
    @objc private func openConnection() {
        cloudServer.stringValue = SolarConnection.server; cloudPlant.stringValue = SolarConnection.plant
        if connectionWindow == nil {
            let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 480, height: 280), styleMask: [.titled, .closable], backing: .buffered, defer: false)
            w.title = "Felicity Solar connection"; w.isReleasedWhenClosed = false; w.center()
            let stack = NSStackView(); stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 10; stack.translatesAutoresizingMaskIntoConstraints = false
            let intro = NSTextField(wrappingLabelWithString: "Enter your cloud dashboard address, then sign in. Collection and history continue when your Mac is off.")
            cloudServer.placeholderString = "https://your-dashboard.workers.dev"; cloudServer.setAccessibilityLabel("Cloud dashboard address")
            cloudPlant.placeholderString = "Plant ID (optional)"; cloudPlant.setAccessibilityLabel("Plant ID")
            stack.addArrangedSubview(intro); stack.addArrangedSubview(cloudServer); stack.addArrangedSubview(cloudPlant)
            stack.addArrangedSubview(NSButton(title: "Sign in to cloud dashboard", target: self, action: #selector(signInCloud)))
            stack.addArrangedSubview(connectionMessage)
            w.contentView!.addSubview(stack)
            NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: w.contentView!.leadingAnchor, constant: 22), stack.trailingAnchor.constraint(equalTo: w.contentView!.trailingAnchor, constant: -22), stack.topAnchor.constraint(equalTo: w.contentView!.topAnchor, constant: 22), cloudServer.widthAnchor.constraint(equalTo: stack.widthAnchor), cloudPlant.widthAnchor.constraint(equalTo: stack.widthAnchor)])
            connectionWindow = w
        }
        NSApp.activate(ignoringOtherApps: true); connectionWindow?.makeKeyAndOrderFront(nil)
    }
    @objc private func signInCloud() {
        let server = cloudServer.stringValue, plant = cloudPlant.stringValue
        connectionMessage.stringValue = "Opening secure sign-in…"
        Task { do {
            try await SolarCloudSignIn.shared.signIn(server: server, plant: plant)
            connectionMessage.stringValue = "Connected. Your widgets use the cloud dashboard."
            WidgetCenter.shared.reloadAllTimelines(); await refresh()
        } catch { connectionMessage.stringValue = "Could not connect: " + error.localizedDescription } }
    }
    private func startLocalBackendIfNeeded() {
        guard SolarConnection.server == "http://127.0.0.1:4317", backend?.isRunning != true else { return }
        // When installed, launchd owns restart recovery; avoid starting a competing server.
        let agent = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/LaunchAgents/com.blessing.felicity-solar.server.plist")
        guard !FileManager.default.fileExists(atPath: agent.path) else { return }
        let project = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Documents/personal projects/felicity solar", isDirectory: true)
        guard FileManager.default.fileExists(atPath: project.appendingPathComponent("server.mjs").path), let node = ["/opt/homebrew/bin/node", "/usr/local/bin/node"].first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else { return }
        let process = Process(); process.executableURL = URL(fileURLWithPath: node); process.arguments = [project.appendingPathComponent("server.mjs").path]; process.currentDirectoryURL = project
        process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
        do { try process.run(); backend = process } catch { }
    }
}
#endif
