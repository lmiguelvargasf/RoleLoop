"""Pure workflow rules and freshness calculations."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence

from .models import (
    Answer,
    ApplicationStatus,
    Decision,
    EligibilityStatus,
    ResumeRun,
    ResumeStage,
    ResumeStatus,
    ReviewQuestion,
    ReviewStatus,
    ReviewVersion,
    VerificationAnswer,
)


def derive_eligibility(
    questions: Sequence[ReviewQuestion],
    answers: Mapping[str, Answer] | Sequence[VerificationAnswer],
) -> EligibilityStatus:
    """Compute eligibility from required questions and their current answers."""

    if isinstance(answers, Mapping):
        answer_by_id = answers
    else:
        answer_by_id = {item.question_id: item.answer for item in answers}

    unresolved = False
    for question in questions:
        if not question.required:
            continue
        answer = answer_by_id.get(question.id, Answer.UNKNOWN)
        if answer is Answer.UNKNOWN:
            unresolved = True
        elif answer is not question.qualifying_answer:
            return EligibilityStatus.INELIGIBLE
    return EligibilityStatus.UNRESOLVED if unresolved else EligibilityStatus.ELIGIBLE


def stable_fingerprint(**parts: object) -> str:
    """Hash named inputs in a stable, human-debuggable way."""

    encoded = json.dumps(parts, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def review_fingerprint(
    *,
    job_revision: int,
    profile_revision: int,
    evidence_version_id: str | None,
    analyzer_version: str,
) -> str:
    return stable_fingerprint(
        job_revision=job_revision,
        profile_revision=profile_revision,
        evidence_version_id=evidence_version_id,
        analyzer_version=analyzer_version,
    )


def review_status(
    latest_review: ReviewVersion | None,
    *,
    expected_fingerprint: str | None,
) -> ReviewStatus:
    if latest_review is None:
        return ReviewStatus.MISSING
    if expected_fingerprint is not None and latest_review.fingerprint == expected_fingerprint:
        return ReviewStatus.CURRENT
    return ReviewStatus.STALE


def resume_input_fingerprint(
    *,
    review_version_id: str,
    evidence_version_id: str,
    generator_version: str,
    validator_version: str,
    compiler_version: str,
) -> str:
    return stable_fingerprint(
        review_version_id=review_version_id,
        evidence_version_id=evidence_version_id,
        generator_version=generator_version,
        validator_version=validator_version,
        compiler_version=compiler_version,
    )


def resume_status(
    latest_run: ResumeRun | None,
    *,
    expected_fingerprint: str | None,
) -> ResumeStatus:
    if latest_run is None:
        return ResumeStatus.NONE
    if latest_run.stage.is_in_progress:
        return ResumeStatus.IN_PROGRESS
    if expected_fingerprint is None or latest_run.input_fingerprint != expected_fingerprint:
        return ResumeStatus.STALE
    if latest_run.stage is ResumeStage.READY:
        return ResumeStatus.READY
    return ResumeStatus.FAILED


def may_choose_decision(decision: Decision, application_status: ApplicationStatus) -> bool:
    return not (decision is Decision.SKIP and application_status is ApplicationStatus.SUBMITTED)
