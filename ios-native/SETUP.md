# iOS native app -- setup

## What this is

Swift/SwiftUI source for a native iOS client: a scoped-down subset of the
web app (paper library, section reader, Ask This Paper chat) talking to the
same backend over your local network, plus a best-effort on-device fallback
via Apple's `FoundationModels` framework for when the backend isn't reachable.

## What this is *not*

**This was written without access to a Mac, Xcode, or an iOS Simulator.**
It has never been compiled or run. Treat it as a well-organized starting
point, not a finished, verified app. Expect to fix small things once Xcode's
compiler and autocomplete show you the real, current API surface -- this is
most likely for `OnDeviceQA.swift`, since `FoundationModels` is a very new
Apple framework and its exact method signatures may have moved since.

## Turning this into a real Xcode project (~2 minutes)

A hand-authored `.xcodeproj` file risks being subtly malformed in a way
that's more confusing than not having one at all, so this ships as plain
`.swift` files instead:

1. On a Mac, open Xcode → **File → New → Project… → iOS → App**.
2. Interface: **SwiftUI**. Name it whatever you like (e.g.
   "ResearchPal"). Language: Swift.
3. Delete the placeholder `ContentView.swift` and `<ProjectName>App.swift`
   Xcode generated.
4. Drag all `.swift` files from this folder into the project navigator
   (check "Copy items if needed").
5. If Xcode generated an app entry point with a different struct name than
   `ResearchPalApp` (in `RootApp.swift`), rename one to match --
   there must be exactly one `@main` in the project.
6. Build & run in the Simulator, or on a real device (needs a free Apple ID
   signing profile for on-device testing).

## Before it's actually useful

- **Set the backend address**: tap the gear icon in Library and enter your
  PC's LAN IP and port (e.g. `http://192.168.1.42:8501`), not `localhost` --
  that would mean the phone itself. Find your PC's LAN IP with `ipconfig`
  (Windows) and make sure Windows Firewall allows inbound connections on
  port 8501, and that the backend is bound to `0.0.0.0` (it already is --
  see `desktop/main.js` / the README's `uvicorn` command).
- **On-device fallback** needs iOS 18.1+ on Apple-Intelligence-capable
  hardware (iPhone 15 Pro or newer at the time this was written), with Apple
  Intelligence turned on in Settings. On anything else it will correctly
  report itself unavailable rather than crash -- `HybridQAProvider` will
  just always use the network path.

## Scope

Deliberately **not** full parity with the web app. Covers: paper list,
section explanations, Ask This Paper (with persisted history, matching the
web app's history feature). Not covered: uploading PDFs, formulas/figures/
tables rendering, the mind map/diagram, flashcards/review, Deep Research,
Human Written Notes, PDF highlighting, audio narration. Adding any of these
follows the same pattern already established: a `Codable` struct in
`Models.swift`, a method on `BackendClient`, and a SwiftUI view.
