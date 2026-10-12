import Foundation
import Security

enum SolarDate {
    static func parse(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
}
struct SolarDay: Codable { let date: String; let hours: Double?; let observed: Double }
struct SolarSnapshot: Codable {
    let plant: String
    let updated: String?
    let gridOn: Bool?
    let gridVoltage: Double?
    let battery: Double?
    let pvWatts: Double?
    let todayKwh: Double?
    let gridHours: Double?
    let nextWindow: String?
    let probability: Double?
    let observedAt: String?
    let daily: [SolarDay]?
    var gridOnSince: String? = nil
    var lastGridAt: String? = nil
    var gridTimingLabel: String {
        let on = !stale && gridOn == true
        guard let raw = on ? gridOnSince : lastGridAt, let date = SolarDate.parse(raw) else { return on ? "Grid on · start time unknown" : "Last grid power: unknown" }
        let minutes = max(0, Int(Date().timeIntervalSince(date) / 60))
        let elapsed = minutes >= 60 ? "\(minutes / 60)h \(minutes % 60)m ago" : "\(minutes)m ago"
        return (on ? "Grid observed ON: " : "Last grid power: ") + date.formatted(date: .abbreviated, time: .shortened) + "\n" + elapsed
    }
    var currentPvLabel: String? {
        guard !stale, let watts = pvWatts, watts > 0 else { return nil }
        return watts >= 1000 ? String(format: "%.1f kW", watts / 1000) : String(format: "%.0f W", watts)
    }
    var observedDate: Date? { observedAt.flatMap { SolarDate.parse($0) } }
    var stale: Bool { observedDate.map { Date().timeIntervalSince($0) > 900 } ?? true }
    var gridLabel: String { stale ? "Stale readings" : gridOn.map { $0 ? "Grid is on" : "Grid outage" } ?? "Grid unknown" }
    static let empty = SolarSnapshot(plant: "Connect your dashboard", updated: nil, gridOn: nil, gridVoltage: nil, battery: nil, pvWatts: nil, todayKwh: nil, gridHours: nil, nextWindow: nil, probability: nil, observedAt: nil, daily: nil)
}

enum SolarConnection {
    struct OAuthRecord: Codable {
        let server: String; let clientId: String; let accessToken: String; let refreshToken: String?; let expiresAt: Date
    }
    static let defaults = UserDefaults(suiteName: "group.com.blessing.FelicitySolar")!
    static var server: String { defaults.string(forKey: "server") ?? "http://127.0.0.1:4317" }
    static var plant: String { defaults.string(forKey: "plant") ?? "" }
    static func keyQuery() -> [String: Any] {
        var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "FelicitySolarDashboard", kSecAttrAccount as String: "dashboard-key"]
        if let group = Bundle.main.object(forInfoDictionaryKey: "SolarKeychainGroup") as? String,
           group.range(of: "^[A-Z0-9]{10}\\.", options: .regularExpression) != nil { q[kSecAttrAccessGroup as String] = group }
        return q
    }
    static var storedCredential: String {
        var q = keyQuery(); q[kSecReturnData as String] = true
        var result: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return "" }
        return String(data: data, encoding: .utf8) ?? ""
    }
    static var oauth: OAuthRecord? { try? JSONDecoder().decode(OAuthRecord.self, from: Data(storedCredential.utf8)) }
    static var accessKey: String { oauth?.accessToken ?? storedCredential }
    static func exchange(server: String, fields: [String: String]) async throws -> [String: Any] {
        guard let u = URL(string: server + "/oauth/token"), u.scheme == "https" else { throw URLError(.badURL) }
        var request = URLRequest(url: u); request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        let formCharacters = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        request.httpBody = fields.map { key, value in
            key.addingPercentEncoding(withAllowedCharacters: formCharacters)! + "=" + value.addingPercentEncoding(withAllowedCharacters: formCharacters)!
        }.joined(separator: "&").data(using: .utf8)
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200,
              let result = try JSONSerialization.jsonObject(with: data) as? [String: Any], result["access_token"] is String else { throw URLError(.userAuthenticationRequired) }
        return result
    }
    static func saveOAuth(server: String, plant: String, clientId: String, tokens: [String: Any]) throws {
        guard let access = tokens["access_token"] as? String else { throw URLError(.userAuthenticationRequired) }
        let root = server.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let previous = oauth.flatMap { $0.server == root && $0.clientId == clientId ? $0 : nil }
        let record = OAuthRecord(server: root, clientId: clientId, accessToken: access, refreshToken: tokens["refresh_token"] as? String ?? previous?.refreshToken, expiresAt: Date().addingTimeInterval((tokens["expires_in"] as? Double) ?? 3600))
        let credential = String(data: try JSONEncoder().encode(record), encoding: .utf8)!
        try save(server: server, plant: plant, key: credential)
    }
    static func save(server: String, plant: String, key: String) throws {
        guard let u = URL(string: server), ["http", "https"].contains(u.scheme ?? ""), u.host != nil else { throw URLError(.badURL) }
        let q = keyQuery()
        if !key.isEmpty {
            let attributes: [String: Any] = [kSecValueData as String: Data(key.utf8), kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
            var status = SecItemUpdate(q as CFDictionary, attributes as CFDictionary)
            if status == errSecItemNotFound {
                let add = q.merging(attributes) { _, new in new }
                status = SecItemAdd(add as CFDictionary, nil)
            }
            guard status == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
        } else {
            let status = SecItemDelete(q as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
        }
        defaults.set(server.trimmingCharacters(in: CharacterSet(charactersIn: "/")), forKey: "server")
        defaults.set(plant, forKey: "plant")
    }
    static func fetch() async throws -> SolarSnapshot {
        if let record = oauth {
            guard record.server == server, server.hasPrefix("https://") else { throw URLError(.userAuthenticationRequired) }
            if record.expiresAt.timeIntervalSinceNow < 90, let refresh = record.refreshToken {
                let tokens = try await exchange(server: server, fields: ["grant_type": "refresh_token", "refresh_token": refresh, "client_id": record.clientId, "resource": server])
                try saveOAuth(server: server, plant: plant, clientId: record.clientId, tokens: tokens)
            }
        }
        guard var components = URLComponents(string: server + "/api/widget") else { throw URLError(.badURL) }
        if !plant.isEmpty { components.queryItems = [URLQueryItem(name: "plant", value: plant)] }
        guard let url = components.url else { throw URLError(.badURL) }
        var request = URLRequest(url: url); request.timeoutInterval = 15
        let key = accessKey
        if !key.isEmpty { request.setValue("Bearer " + key, forHTTPHeaderField: "Authorization") }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.userAuthenticationRequired) }
        let snapshot = try JSONDecoder().decode(SolarSnapshot.self, from: data)
        defaults.set(data, forKey: "lastSnapshot")
        return snapshot
    }
    static var cached: SolarSnapshot { defaults.data(forKey: "lastSnapshot").flatMap { try? JSONDecoder().decode(SolarSnapshot.self, from: $0) } ?? .empty }
}
