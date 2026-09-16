"""Deep Research Chat: a small ReAct-style agent loop grounded in selected
papers that can also search and read the live web -- free and keyless
(DuckDuckGo via ddgs for search, requests+BeautifulSoup for page text), to
supplement, verify, or extend what the paper(s) themselves say. No paid
search APIs, matching the rest of this project's free/local-first design.
"""

import requests
from bs4 import BeautifulSoup
from ddgs import DDGS

from core import llm, vectorstore

MAX_STEPS = 6
SEARCH_MAX_RESULTS = 6
FETCH_MAX_CHARS = 5000

_HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ResearchPal/1.0"}


def web_search(query: str) -> list[dict]:
    try:
        results = DDGS().text(query, max_results=SEARCH_MAX_RESULTS)
    except Exception as e:  # noqa: BLE001 - surfaced to the agent as an observation, not a crash
        return [{"title": "search failed", "href": "", "body": str(e)}]
    return [{"title": r.get("title", ""), "href": r.get("href", ""), "body": r.get("body", "")} for r in results]


def fetch_url(url: str) -> str:
    try:
        resp = requests.get(url, timeout=10, headers=_HEADERS)
        resp.raise_for_status()
    except Exception as e:  # noqa: BLE001 - a dead/blocked link shouldn't kill the whole research run
        return f"Could not fetch {url}: {e}"
    soup = BeautifulSoup(resp.text, "html.parser")
    for tag in soup(["script", "style", "nav", "footer", "header", "aside"]):
        tag.decompose()
    text = soup.get_text(" ", strip=True)
    return text[:FETCH_MAX_CHARS]


def _clean_answer_text(text: str) -> str:
    """Models occasionally over-escape newlines inside their JSON answer
    string (emitting a literal backslash-backslash-n instead of a plain
    backslash-n), which survives JSON parsing as a literal two-character
    "\\n" instead of a real line break. Normalize both forms to real
    newlines so paragraph breaks actually render as breaks."""
    return text.replace("\\n", "\n")


def _paper_context(paper_ids: list[str], question: str) -> str:
    hits = vectorstore.search(question, paper_ids=paper_ids, top_k=6)
    if not hits:
        return "(no indexed excerpts found for the selected papers)"
    return "\n\n---\n\n".join(f"[{row['paper_title']}]\n{row['chunk_text']}" for _score, row in hits)


SYSTEM_PROMPT = """You are a deep-research assistant helping evaluate and extend a research paper with live, current web information. You have two tools:

- search: look up a query on the web. action_input is the search query string.
- fetch: read the full text of one specific URL (usually one returned by a
  previous search). action_input is the URL.

You also have grounding excerpts from the paper(s) the user selected (given
to you below) -- use them as your starting point, and use the web to verify,
update, extend, or find real-world context/critique/follow-up work the
paper(s) don't cover themselves (e.g. has this been superseded, replicated,
challenged; what's the current state of the art; real-world adoption or
results since publication).

Respond with ONLY a JSON object each turn, no prose outside it:
{"thought": "your reasoning, one or two sentences", "action": "search" | "fetch" | "answer", "action_input": "the search query or URL (omit/empty if action is answer)", "answer": "your final answer (only when action is answer)"}

Call "answer" as soon as you have enough to give a grounded, well-cited
answer -- don't pad with unnecessary steps. When you answer, write a clear,
well-organized answer citing sources inline like [1], [2] matching the
sources you've gathered, and explicitly note where the web information
agrees with, updates, or contradicts the paper."""


def run_agent(paper_ids: list[str], question: str, history: list[dict] | None = None):
    """Generator yielding step events as the agent works, ending with exactly
    one {"type": "answer", ...} event. Step events:
      {"type": "thought", "text": ...}
      {"type": "search", "query": ..., "results": [...]}
      {"type": "fetch", "url": ..., "excerpt": ...}
      {"type": "answer", "text": ..., "sources": [...], "steps": [...]}
    `steps` (included on the final answer event) is the full trace, persisted
    alongside the message so reopening a session shows the whole run, not
    just the final answer -- the session's durable "memory" of this turn."""
    paper_context = _paper_context(paper_ids, question)
    convo = ""
    if history:
        convo = "\n".join(f"{h['role'].upper()}: {h['content']}" for h in history[-6:])

    transcript: list[str] = []
    sources: list[dict] = []
    steps: list[dict] = []
    seen_urls: set[str] = set()

    for step_num in range(1, MAX_STEPS + 1):
        force_answer = step_num == MAX_STEPS
        convo_block = f"PRIOR CONVERSATION:\n{convo}\n" if convo else ""
        research_block = "RESEARCH SO FAR:\n" + "\n\n".join(transcript) if transcript else ""
        force_block = 'You are out of steps -- you MUST respond with action "answer" now, using everything gathered so far.' if force_answer else ""
        prompt = f"""{convo_block}
PAPER EXCERPTS:
{paper_context}

QUESTION: {question}

{research_block}

{force_block}
"""
        try:
            decision = llm.generate_json(prompt, system=SYSTEM_PROMPT)
        except llm.LLMError as e:
            yield {"type": "answer", "text": f"Research stopped early: {e}", "sources": sources, "steps": steps}
            return
        if not isinstance(decision, dict):
            decision = {"action": "answer", "answer": str(decision)}

        thought = _clean_answer_text(decision.get("thought", ""))
        action = decision.get("action", "answer")
        action_input = (decision.get("action_input") or "").strip()

        if thought:
            yield {"type": "thought", "text": thought}
            steps.append({"type": "thought", "text": thought})

        if action == "search" and action_input:
            results = web_search(action_input)
            yield {"type": "search", "query": action_input, "results": results}
            steps.append({"type": "search", "query": action_input, "results": results})
            for r in results:
                if r["href"] and r["href"] not in seen_urls:
                    seen_urls.add(r["href"])
                    sources.append({"title": r["title"], "url": r["href"]})
            observation = "\n".join(f"- {r['title']}: {r['body']} ({r['href']})" for r in results) or "No results found."
            transcript.append(f'SEARCH "{action_input}" RESULTS:\n{observation}')

        elif action == "fetch" and action_input:
            excerpt = fetch_url(action_input)
            yield {"type": "fetch", "url": action_input, "excerpt": excerpt[:400]}
            steps.append({"type": "fetch", "url": action_input, "excerpt": excerpt[:400]})
            if action_input not in seen_urls:
                seen_urls.add(action_input)
                sources.append({"title": action_input, "url": action_input})
            transcript.append(f"FETCHED {action_input}:\n{excerpt}")

        else:
            answer = _clean_answer_text(decision.get("answer") or "") or thought or "I wasn't able to find a grounded answer."
            yield {"type": "answer", "text": answer, "sources": sources, "steps": steps}
            return

    # Loop exhausted without an explicit "answer" action (shouldn't normally
    # happen given force_answer, but guards against a model ignoring it).
    yield {"type": "answer", "text": "Research stopped after reaching the step limit.", "sources": sources, "steps": steps}
