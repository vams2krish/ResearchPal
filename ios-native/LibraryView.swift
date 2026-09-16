// Paper list -- a scoped-down counterpart to static/js/views/library.js.
// No upload flow here (picking/uploading a PDF from the phone and streaming
// its processing progress is real scope, deliberately left for later);
// this stub assumes papers are uploaded from the web/desktop app and just
// need to be readable on the phone.

import SwiftUI

struct LibraryView: View {
    @State private var papers: [Paper] = []
    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var showSettings = false
    @AppStorage("backendBaseURL") private var backendBaseURL = "http://192.168.1.100:8501"

    var body: some View {
        Group {
            if isLoading {
                ProgressView("Loading library…")
            } else if let errorMessage {
                ContentUnavailableView(
                    "Can't reach the backend",
                    systemImage: "wifi.slash",
                    description: Text(errorMessage + "\n\nCheck Settings for the right address for your PC.")
                )
            } else {
                List(papers) { paper in
                    NavigationLink(value: paper) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(paper.title).font(.headline)
                            if let oneLiner = paper.oneLiner, !oneLiner.isEmpty {
                                Text(oneLiner).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                            }
                            HStack(spacing: 6) {
                                statusBadge(paper.status)
                                ForEach(paper.tags, id: \.self) { tag in
                                    Text(tag).font(.caption2).padding(.horizontal, 6).padding(.vertical, 2)
                                        .background(.thinMaterial, in: Capsule())
                                }
                            }
                        }
                    }
                }
                .refreshable { await load() }
            }
        }
        .navigationTitle("Library")
        .navigationDestination(for: Paper.self) { PaperDetailView(paper: $0) }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { showSettings = true } label: { Image(systemName: "gearshape") }
            }
        }
        .sheet(isPresented: $showSettings) {
            SettingsSheet(backendBaseURL: $backendBaseURL, onSave: { Task { await load() } })
        }
        .task { await load() }
    }

    private func load() async {
        isLoading = true
        errorMessage = nil
        do {
            papers = try await BackendClient.shared.listPapers()
        } catch {
            errorMessage = "\(error)"
        }
        isLoading = false
    }

    @ViewBuilder
    private func statusBadge(_ status: String) -> some View {
        Text(status.capitalized)
            .font(.caption2).bold()
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(status == "processed" ? Color.green.opacity(0.2) : Color.orange.opacity(0.2), in: Capsule())
            .foregroundStyle(status == "processed" ? .green : .orange)
    }
}

extension Paper: Hashable {
    static func == (lhs: Paper, rhs: Paper) -> Bool { lhs.id == rhs.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
}

struct SettingsSheet: View {
    @Binding var backendBaseURL: String
    var onSave: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var draft = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("Backend address") {
                    TextField("http://192.168.1.42:8501", text: $draft)
                        .keyboardType(.URL)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                    Text("Your PC's LAN address running the server (or the desktop app) -- not \"localhost\", that would mean the phone itself.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Settings")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { backendBaseURL = draft; onSave(); dismiss() }
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .onAppear { draft = backendBaseURL }
    }
}
