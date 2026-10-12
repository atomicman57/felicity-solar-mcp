import SwiftUI
import WidgetKit

struct SolarEntry: TimelineEntry { let date: Date; let snapshot: SolarSnapshot; let failed: Bool }
struct SolarProvider: TimelineProvider {
    func placeholder(in context: Context) -> SolarEntry { SolarEntry(date: Date(), snapshot: .empty, failed: false) }
    func getSnapshot(in context: Context, completion: @escaping (SolarEntry) -> Void) { completion(SolarEntry(date: Date(), snapshot: SolarConnection.cached, failed: false)) }
    func getTimeline(in context: Context, completion: @escaping (Timeline<SolarEntry>) -> Void) {
        Task {
            var failed = false
            let snapshot: SolarSnapshot
            do { snapshot = try await SolarConnection.fetch() } catch { snapshot = SolarConnection.cached; failed = true }
            let entry = SolarEntry(date: Date(), snapshot: snapshot, failed: failed)
            completion(Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(15 * 60))))
        }
    }
}

struct SolarWidgetView: View {
    let entry: SolarEntry
    @Environment(\.widgetFamily) var family
    private var s: SolarSnapshot { entry.snapshot }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack { Label("FELICITY SOLAR", systemImage: "sun.max.fill").font(.system(size: 10, weight: .bold)); Spacer(); Circle().fill(entry.failed || s.stale ? .orange : s.gridOn == true ? .green : .gray).frame(width: 7, height: 7) }
            Text(entry.failed ? "Dashboard offline" : s.gridLabel).font(.headline)
            HStack(alignment: .firstTextBaseline) {
                Text(s.battery.map { String(format: "%.0f%%", $0) } ?? "—").font(.system(size: family == .systemSmall ? 30 : 38, weight: .bold, design: .rounded))
                Text("battery").font(.caption).foregroundStyle(.secondary)
                if family != .systemSmall { Spacer(); VStack(alignment: .trailing) { Text(s.todayKwh.map { String(format: "%.1f kWh", $0) } ?? "—").font(.title3.bold()); Text("solar today").font(.caption).foregroundStyle(.secondary) } }
            }
            if !entry.failed, let pv = s.currentPvLabel { Text("☀ Generating now · " + pv).font(.caption.bold()) }
            if family == .systemSmall { Text(s.todayKwh.map { String(format: "Solar today · %.1f kWh", $0) } ?? "Waiting for data").font(.caption) }
            if family != .systemSmall {
                HStack { Text(s.gridHours.map { String(format: "AC today · %.1f h", $0) } ?? "AC hours unknown"); Spacer(); Text(s.pvWatts.map { String(format: "PV · %.1f kW", $0 / 1000) } ?? "PV unknown") }.font(.caption).foregroundStyle(.secondary)
            }
            if family != .systemSmall { Text(s.gridTimingLabel).font(.caption).foregroundStyle(.secondary) }
            if family == .systemLarge {
                Divider()
                Text("NEXT LIKELY GRID WINDOW").font(.caption2.bold())
                if let raw = s.nextWindow, let next = SolarDate.parse(raw) {
                    Text(next.formatted(date: .abbreviated, time: .shortened)).font(.title3.bold())
                    Text(s.probability.map { String(format: "%.0f%% historical availability", $0 * 100) } ?? "Still learning").font(.caption)
                } else { Text("Still learning from your history").font(.caption) }
                Text("A historical probability, not a guaranteed schedule.").font(.caption2).foregroundStyle(.secondary)
                Divider()
                Text("POWER HOURS · LAST 7 DAYS").font(.caption2.bold())
                VStack(spacing: 4) {
                    ForEach(s.daily ?? [], id: \.date) { day in
                        HStack(spacing: 8) {
                            Text(String(day.date.suffix(5))).font(.system(size: 9)).frame(width: 32, alignment: .leading)
                            GeometryReader { geometry in
                                Capsule().fill(Color.green.opacity(0.12))
                                    .overlay(alignment: .leading) { Capsule().fill(Color.green).frame(width: geometry.size.width * min(1, max(0, (day.hours ?? 0) / 24))) }
                            }.frame(height: 5)
                            Text(day.hours.map { String(format: "%.1fh", $0) } ?? "—").font(.system(size: 9)).frame(width: 35, alignment: .trailing)
                        }
                    }
                }
            }
            if let measured = s.observedDate { Text("Measured \(measured.formatted(date: s.stale ? .abbreviated : .omitted, time: .shortened))").font(.system(size: 9)).foregroundStyle(.secondary) }
        }.containerBackground(Color(red: 0.87, green: 0.93, blue: 0.77), for: .widget)
    }
}

@main
struct FelicitySolarWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "FelicitySolarWidget", provider: SolarProvider()) { SolarWidgetView(entry: $0) }
            .configurationDisplayName("Felicity Solar")
            .description("Grid status, battery reserve, solar yield and your next likely power window.")
            .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}
