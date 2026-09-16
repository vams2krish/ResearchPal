"""The canonical research-paper structure used to organize every processed
paper, so the reader always sees the same map regardless of how the source
PDF labels its own headings ("Related Work" vs "Background", "Experiments"
vs "Experimental Setup", etc).
"""

SECTIONS = [
    "Title and Abstract",
    "Introduction",
    "Methods",
    "Experimental Setup",
    "Results",
    "Related Work",
    "Discussion",
    "Conclusion",
    "References",
    "Appendix",
]

# Sections whose content is worth running through the (slower) explanation +
# formula-extraction LLM pass. References is just a bibliography -- skip it
# to save a meaningful chunk of processing time on every paper.
ANALYZABLE_SECTIONS = [s for s in SECTIONS if s != "References"]

SECTION_ICONS = {
    "Title and Abstract": "📌",
    "Introduction": "🚪",
    "Methods": "🔧",
    "Experimental Setup": "🧪",
    "Results": "📊",
    "Related Work": "🕸️",
    "Discussion": "💬",
    "Conclusion": "🏁",
    "References": "📚",
    "Appendix": "📎",
}
