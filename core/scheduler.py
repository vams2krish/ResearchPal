import json

from fsrs import Card, Rating, Scheduler

from core import db

_scheduler = Scheduler()

RATING_LABELS = {
    Rating.Again: "Again",
    Rating.Hard: "Hard",
    Rating.Good: "Good",
    Rating.Easy: "Easy",
}


def review_flashcard(flashcard_row, rating: Rating):
    card = Card.from_dict(json.loads(flashcard_row["fsrs_card"]))
    updated_card, _log = _scheduler.review_card(card, rating)
    db.update_flashcard_fsrs(flashcard_row["id"], updated_card.to_dict(), rating.value)
    return updated_card
