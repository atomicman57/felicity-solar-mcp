import SwiftUI
import WidgetKit

#if os(macOS)
import AppKit
@main
struct MacFelicitySolarMain {
    static func main() {
        let app = NSApplication.shared
        let delegate = MenuBarController()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        withExtendedLifetime(delegate) { app.run() }
    }
}
#else
@main
struct FelicitySolarApp: App {
    var body: some Scene { WindowGroup { SolarHome() } }
}
#endif

struct SolarHome: View {
    @State private var snapshot = SolarConnection.cached
    @State private var server = SolarConnection.server
    @State private var plant = SolarConnection.plant
    @State private var key = SolarConnection.accessKey
    @State private var message = ""
    @State private var updating = false
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                Label("Felicity Solar", systemImage: "sun.max.fill").font(.largeTitle.bold()).foregroundStyle(.green)
                Text("Your home's energy, at a glance.").foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 15) {
                    Text(snapshot.plant).font(.caption).foregroundStyle(.secondary)
                    Label(snapshot.gridLabel, systemImage: snapshot.gridOn == true ? "bolt.fill" : "bolt.slash").font(.title2.bold())
                    HStack(spacing: 25) {
                        reading("Battery", snapshot.battery.map { String(format: "%.0f%%", $0) } ?? "—")
                        reading("Solar today", snapshot.todayKwh.map { String(format: "%.1f kWh", $0) } ?? "—")
                        reading("Grid hours", snapshot.gridHours.map { String(format: "%.1f h", $0) } ?? "—")
                    }
                    if let date = snapshot.observedDate { Text("Measured \(date.formatted(date: .abbreviated, time: .shortened))").font(.caption).foregroundStyle(.secondary) }
                }.padding(24).frame(maxWidth: .infinity, alignment: .leading).background(Color.green.opacity(0.12), in: RoundedRectangle(cornerRadius: 20))
                HStack {
                    Button(updating ? "Updating…" : "Refresh") { Task { await update() } }.disabled(updating)
                    if let url = URL(string: SolarConnection.server) { Link("Open full dashboard ↗", destination: url) }
                }.buttonStyle(.borderedProminent)
                GroupBox("Dashboard connection") {
                    VStack(alignment: .leading, spacing: 12) {
                        TextField("Server URL", text: $server).textFieldStyle(.roundedBorder)
                        TextField("Plant ID (optional)", text: $plant).textFieldStyle(.roundedBorder)
                        SecureField("Dashboard access key (for network access)", text: $key).textFieldStyle(.roundedBorder)
                        Text("Use your cloud dashboard address, then sign in. Your widgets stay connected without a server running on your Mac.").font(.caption).foregroundStyle(.secondary)
                        Button("Sign in to cloud dashboard") {
                            Task { do { try await SolarCloudSignIn.shared.signIn(server: server, plant: plant); key = SolarConnection.accessKey; await update() } catch { message = error.localizedDescription } }
                        }.buttonStyle(.borderedProminent)
                        Button("Save connection & refresh widgets") {
                            do { try SolarConnection.save(server: server, plant: plant, key: key == SolarConnection.accessKey ? SolarConnection.storedCredential : key); Task { await update() } }
                            catch { message = error.localizedDescription }
                        }.buttonStyle(.bordered)
                    }.padding(8)
                }
                if !message.isEmpty { Text(message).font(.caption).foregroundStyle(.secondary) }
                Text("Add Felicity Solar from your device's widget gallery. Widgets refresh on Apple's schedule; open the dashboard for current readings.").font(.caption).foregroundStyle(.secondary)
            }.padding(28).frame(maxWidth: 700)
        }.task { await update() }
        #if os(macOS)
        .frame(minWidth: 550, minHeight: 600)
        #endif
    }
    func reading(_ label: String, _ value: String) -> some View { VStack(alignment: .leading) { Text(label).font(.caption).foregroundStyle(.secondary); Text(value).font(.headline) } }
    @MainActor func update() async {
        updating = true
        do { snapshot = try await SolarConnection.fetch(); message = "Updated."; WidgetCenter.shared.reloadAllTimelines() }
        catch { message = "Cannot reach dashboard: \(error.localizedDescription). Showing the last saved snapshot." }
        updating = false
    }
}
