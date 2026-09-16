// URLSession client against the same REST API static/js/api.js already
// talks to (see server.py). The backend runs on your PC (or the Electron
// desktop app), not on the phone -- point this at that machine's LAN IP.
// Unverified: written without Xcode/Simulator access, see ../ios-native/SETUP.md.

import Foundation

enum BackendError: Error {
    case badResponse
    case http(Int)
}

final class BackendClient {
    static let shared = BackendClient()

    /// e.g. "http://192.168.1.42:8501" -- your PC's LAN address, not
    /// "localhost" (that would mean the phone itself). Settable from the
    /// app's Settings sheet; defaults to a placeholder that will obviously
    /// fail until configured.
    @UserDefault(key: "backendBaseURL", defaultValue: "http://192.168.1.100:8501")
    var baseURLString: String

    private var baseURL: URL { URL(string: baseURLString)! }

    func listPapers() async throws -> [Paper] {
        try await get([Paper].self, path: "/api/papers")
    }

    func getPaperDetail(id: String) async throws -> PaperDetail {
        try await get(PaperDetail.self, path: "/api/papers/\(id)")
    }

    func getChatHistory(paperId: String) async throws -> [ChatMessage] {
        try await get([ChatMessage].self, path: "/api/papers/\(paperId)/chat")
    }

    func askPaper(paperId: String, question: String) async throws -> AskResponse {
        var request = URLRequest(url: baseURL.appendingPathComponent("/api/papers/\(paperId)/ask"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(["question": question])
        return try await send(AskResponse.self, request)
    }

    private func get<T: Decodable>(_ type: T.Type, path: String) async throws -> T {
        try await send(type, URLRequest(url: baseURL.appendingPathComponent(path)))
    }

    private func send<T: Decodable>(_ type: T.Type, _ request: URLRequest) async throws -> T {
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw BackendError.badResponse }
        guard (200...299).contains(http.statusCode) else { throw BackendError.http(http.statusCode) }
        let decoder = JSONDecoder()
        return try decoder.decode(T.self, from: data)
    }

    /// True if the backend answers quickly -- used by HybridQAProvider to
    /// decide whether to use the network or fall back on-device.
    func isReachable(timeout: TimeInterval = 2.5) async -> Bool {
        var request = URLRequest(url: baseURL.appendingPathComponent("/api/status"))
        request.timeoutInterval = timeout
        return (try? await URLSession.shared.data(for: request)) != nil
    }
}

/// Tiny UserDefaults-backed property wrapper -- avoids pulling in a
/// persistence library for one string.
@propertyWrapper
struct UserDefault<T> {
    let key: String
    let defaultValue: T
    var wrappedValue: T {
        get { UserDefaults.standard.object(forKey: key) as? T ?? defaultValue }
        set { UserDefaults.standard.set(newValue, forKey: key) }
    }
}
