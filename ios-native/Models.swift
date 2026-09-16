// Codable structs mirroring the REST API's JSON shapes (see server.py /
// core/db.py on the Python side). Deliberately a subset of the full schema --
// this stub covers Library, a paper's sections, and Ask This Paper, not
// every analysis tool the web app has (mind maps, diagrams, flashcards,
// Deep Research, etc).

import Foundation

struct Paper: Codable, Identifiable {
    let id: String
    let title: String
    let filename: String
    let addedAt: String
    let status: String
    let oneLiner: String?
    let authors: String?
    let year: String?
    let venue: String?
    let tags: [String]

    enum CodingKeys: String, CodingKey {
        case id, title, filename, status, tags
        case addedAt = "added_at"
        case oneLiner = "one_liner"
        case authors, year, venue
    }
}

struct Section: Codable, Identifiable {
    let id: Int
    let name: String
    let orderIndex: Int
    let explanation: String?
    let isRead: Int

    enum CodingKeys: String, CodingKey {
        case id, name
        case orderIndex = "order_index"
        case explanation
        case isRead = "is_read"
    }
}

/// A deliberately narrow slice of GET /api/papers/{id} -- just enough for
/// this stub's PaperDetailView (title/metadata + sections). The full
/// response also carries equations, images, tables, claims, flashcards,
/// a diagram, glossary, notes, mental models and read progress -- add
/// Codable fields here as this app grows toward parity with the web client.
struct PaperDetail: Codable {
    let paper: Paper
    let sections: [Section]
}

struct ChatMessage: Codable, Identifiable {
    let id: Int
    let paperId: String
    let role: String
    let content: String
    let createdAt: String

    enum CodingKeys: String, CodingKey {
        case id, role, content
        case paperId = "paper_id"
        case createdAt = "created_at"
    }
}

struct AskResponse: Codable {
    let answer: String
    let backend: String
}
