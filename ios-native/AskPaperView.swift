// Chat UI wired to HybridQAProvider (network-first, on-device fallback) --
// the native counterpart to renderAskView in static/js/views/paper.js,
// including loading the same persisted history from GET /api/papers/{id}/chat
// so a conversation started on the web/desktop app is visible here too.

import SwiftUI

private struct DisplayMessage: Identifiable {
    let id = UUID()
    let role: String
    var content: String
}

struct AskPaperView: View {
    let paper: Paper
    let sectionContext: String

    @State private var messages: [DisplayMessage] = []
    @State private var draft = ""
    @State private var isSending = false
    private let qa = HybridQAProvider()

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(messages) { message in
                            bubble(message)
                        }
                    }
                    .padding()
                }
                .onChange(of: messages.count) {
                    if let last = messages.last?.id {
                        withAnimation { proxy.scrollTo(last, anchor: .bottom) }
                    }
                }
            }
            Divider()
            HStack {
                TextField("Ask a question about this paper…", text: $draft, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                Button {
                    Task { await send() }
                } label: {
                    Image(systemName: "arrow.up.circle.fill").font(.title2)
                }
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSending)
            }
            .padding()
        }
        .navigationTitle("Ask This Paper")
        .navigationBarTitleDisplayMode(.inline)
        .task { await loadHistory() }
    }

    @ViewBuilder
    private func bubble(_ message: DisplayMessage) -> some View {
        HStack {
            if message.role == "user" { Spacer(minLength: 40) }
            Text(message.content)
                .padding(10)
                .background(message.role == "user" ? Color.accentColor : Color(.secondarySystemBackground),
                            in: RoundedRectangle(cornerRadius: 12))
                .foregroundStyle(message.role == "user" ? .white : .primary)
            if message.role != "user" { Spacer(minLength: 40) }
        }
        .id(message.id)
    }

    private func loadHistory() async {
        guard let history = try? await BackendClient.shared.getChatHistory(paperId: paper.id) else { return }
        messages = history.map { DisplayMessage(role: $0.role, content: $0.content) }
    }

    private func send() async {
        let question = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !question.isEmpty else { return }
        draft = ""
        messages.append(DisplayMessage(role: "user", content: question))
        let placeholderIndex = messages.count
        messages.append(DisplayMessage(role: "assistant", content: "…"))
        isSending = true
        defer { isSending = false }
        do {
            let answer = try await qa.answer(question: question, paperId: paper.id, context: sectionContext)
            messages[placeholderIndex].content = answer
        } catch {
            messages[placeholderIndex].content = "Sorry, I couldn't answer that: \(error)"
        }
    }
}
