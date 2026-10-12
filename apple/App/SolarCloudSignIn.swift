import Foundation
import AuthenticationServices
import CryptoKit
#if os(macOS)
import AppKit
#else
import UIKit
#endif

@MainActor
final class SolarCloudSignIn: NSObject, ASWebAuthenticationPresentationContextProviding {
    static let shared = SolarCloudSignIn()
    private var session: ASWebAuthenticationSession?
    private var signingIn = false
    private func random() -> String { UUID().uuidString + UUID().uuidString }
    private func base64URL(_ data: Data) -> String { data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        #if os(macOS)
        return NSApp.keyWindow ?? NSApp.windows.first ?? NSWindow()
        #else
        return UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap { $0.windows }.first { $0.isKeyWindow } ?? UIWindow()
        #endif
    }
    func signIn(server: String, plant: String = "") async throws {
        guard !signingIn else { throw URLError(.userAuthenticationRequired) }
        signingIn = true
        defer { signingIn = false; session = nil }
        let root = server.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let base = URL(string: root), base.scheme == "https", base.host != nil else { throw URLError(.badURL) }
        let scheme = (Bundle.main.bundleIdentifier ?? "com.example.felicitysolar").lowercased()
        let redirect = scheme + "://oauth/callback"
        let verifier = base64URL(Data(random().utf8)), state = random()
        let challenge = base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
        var registration = URLRequest(url: base.appendingPathComponent("register"))
        registration.httpMethod = "POST"; registration.setValue("application/json", forHTTPHeaderField: "Content-Type")
        registration.httpBody = try JSONSerialization.data(withJSONObject: ["client_name": "Felicity Solar Widgets", "redirect_uris": [redirect], "grant_types": ["authorization_code", "refresh_token"], "response_types": ["code"], "token_endpoint_auth_method": "none"])
        let (registered, response) = try await URLSession.shared.data(for: registration)
        guard (response as? HTTPURLResponse)?.statusCode == 201,
              let client = (try JSONSerialization.jsonObject(with: registered) as? [String: Any])?["client_id"] as? String else { throw URLError(.userAuthenticationRequired) }
        var authorize = URLComponents(url: base.appendingPathComponent("authorize"), resolvingAgainstBaseURL: false)!
        authorize.queryItems = [URLQueryItem(name: "response_type", value: "code"), URLQueryItem(name: "client_id", value: client), URLQueryItem(name: "redirect_uri", value: redirect), URLQueryItem(name: "scope", value: "widget:read offline_access"), URLQueryItem(name: "state", value: state), URLQueryItem(name: "code_challenge", value: challenge), URLQueryItem(name: "code_challenge_method", value: "S256"), URLQueryItem(name: "resource", value: root)]
        let callback: URL = try await withCheckedThrowingContinuation { continuation in
            let auth = ASWebAuthenticationSession(url: authorize.url!, callbackURLScheme: scheme) { url, error in
                if let url { continuation.resume(returning: url) } else { continuation.resume(throwing: error ?? URLError(.userCancelledAuthentication)) }
            }
            auth.presentationContextProvider = self; self.session = auth
            if !auth.start() { self.session = nil; continuation.resume(throwing: URLError(.cannotLoadFromNetwork)) }
        }
        session = nil
        let query = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
        guard callback.scheme == scheme, callback.host == "oauth", callback.path == "/callback",
              query.first(where: { $0.name == "state" })?.value == state,
              let code = query.first(where: { $0.name == "code" })?.value else { throw URLError(.userAuthenticationRequired) }
        let tokens = try await SolarConnection.exchange(server: root, fields: ["grant_type": "authorization_code", "client_id": client, "code": code, "redirect_uri": redirect, "code_verifier": verifier, "resource": root])
        try SolarConnection.saveOAuth(server: root, plant: plant, clientId: client, tokens: tokens)
    }
}
