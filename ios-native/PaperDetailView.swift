// Sections + explanations for one paper -- a scoped-down counterpart to
// static/js/views/paper.js's section reader (no formulas/figures/tables/
// mind map/diagram/highlighting here; just the plain-language explanations
// and a way into Ask This Paper).

import SwiftUI

struct PaperDetailView: View {
    let paper: Paper
    @State private var detail: PaperDetail?
    @State private var errorMessage: String?

    var body: some View {
        Group {
            if let errorMessage {
                ContentUnavailableView("Couldn't load this paper", systemImage: "exclamationmark.triangle", description: Text(errorMessage))
            } else if let detail {
                List {
                    Section {
                        if let oneLiner = detail.paper.oneLiner, !oneLiner.isEmpty {
                            Text(oneLiner).font(.headline)
                        }
                        if let authors = detail.paper.authors {
                            Text(authors).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    Section("Sections") {
                        ForEach(detail.sections.sorted(by: { $0.orderIndex < $1.orderIndex })) { section in
                            DisclosureGroup(section.name) {
                                Text(section.explanation ?? "No explanation generated for this section.")
                                    .font(.body)
                            }
                        }
                    }
                    Section {
                        NavigationLink("💬 Ask This Paper") {
                            AskPaperView(paper: paper, sectionContext: contextText(detail))
                        }
                    }
                }
            } else {
                ProgressView("Loading…")
            }
        }
        .navigationTitle(paper.title)
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private func load() async {
        do {
            detail = try await BackendClient.shared.getPaperDetail(id: paper.id)
        } catch {
            errorMessage = "\(error)"
        }
    }

    /// Concatenated section explanations -- the context OnDeviceQAProvider
    /// needs since it has no server-side retrieval of its own to fall back
    /// on. RemoteQAProvider ignores this (the backend does its own
    /// embedding-based retrieval instead).
    private func contextText(_ detail: PaperDetail) -> String {
        detail.sections.compactMap(\.explanation).joined(separator: "\n\n")
    }
}
