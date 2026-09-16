// Network-first, on-device-fallback Q&A, per the project's chosen iOS AI
// strategy. RemoteQAProvider is a thin wrapper over BackendClient (the real,
// working path). OnDeviceQAProvider targets Apple's on-device
// `FoundationModels` framework -- written to the best of my knowledge of its
// publicly announced shape, but genuinely UNVERIFIED: no macOS/Xcode/
// Simulator was available to compile or run this. It needs iOS 18.1+ on
// Apple-Intelligence-capable hardware, and its exact API will likely need
// small fixes once opened in a real Xcode (autocomplete/compiler errors will
// show the real signatures). See SETUP.md.

import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

protocol QAProvider {
    /// Answers a question about one paper's sections. `context` is the
    /// already-fetched section text/explanations for that paper (the
    /// network path lets the backend do its own retrieval instead and
    /// ignores this, but the on-device path has no server-side retrieval to
    /// fall back on, so it needs the text handed to it directly).
    func answer(question: String, paperId: String, context: String) async throws -> String
}

struct RemoteQAProvider: QAProvider {
    func answer(question: String, paperId: String, context: String) async throws -> String {
        try await BackendClient.shared.askPaper(paperId: paperId, question: question).answer
    }
}

enum OnDeviceError: Error {
    case unavailable(String)
}

struct OnDeviceQAProvider: QAProvider {
    func answer(question: String, paperId: String, context: String) async throws -> String {
        #if canImport(FoundationModels)
        guard #available(iOS 18.1, *) else {
            throw OnDeviceError.unavailable("This iOS version doesn't support on-device Apple Intelligence models.")
        }
        let model = SystemLanguageModel.default
        guard model.availability == .available else {
            throw OnDeviceError.unavailable("On-device model unavailable (needs Apple Intelligence enabled on supported hardware).")
        }
        // Truncated the same way the web app clips section text before
        // handing it to a model (core/pipeline.py's MAX_CHARS_PER_SECTION) --
        // on-device context windows are smaller than a cloud model's.
        let clippedContext = String(context.prefix(6000))
        let session = LanguageModelSession(
            instructions: "Answer using only the excerpts below. If they don't cover it, say so plainly instead of guessing."
        )
        let prompt = "EXCERPTS:\n\(clippedContext)\n\nQUESTION: \(question)"
        let response = try await session.respond(to: prompt)
        return response.content
        #else
        throw OnDeviceError.unavailable("FoundationModels isn't available in this SDK.")
        #endif
    }
}

/// Prefers the network (full retrieval + your configured cloud/local LLM
/// backend); falls back to on-device only when the backend can't be
/// reached at all, e.g. away from your home network.
struct HybridQAProvider: QAProvider {
    let remote = RemoteQAProvider()
    let onDevice = OnDeviceQAProvider()

    func answer(question: String, paperId: String, context: String) async throws -> String {
        if await BackendClient.shared.isReachable() {
            do {
                return try await remote.answer(question: question, paperId: paperId, context: context)
            } catch {
                // Network looked reachable but the request itself failed --
                // still worth trying on-device before giving up entirely.
            }
        }
        return try await onDevice.answer(question: question, paperId: paperId, context: context)
    }
}
