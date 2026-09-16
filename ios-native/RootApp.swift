// App entry point. Rename `ResearchPalApp` to match whatever
// Xcode's "New Project" wizard generated if it differs -- see SETUP.md.

import SwiftUI

@main
struct ResearchPalApp: App {
    var body: some Scene {
        WindowGroup {
            NavigationStack {
                LibraryView()
            }
        }
    }
}
