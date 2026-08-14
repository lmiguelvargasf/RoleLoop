"""Pure workflow rules and freshness calculations."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence

from .models import (
    Answer,
    ApplicationStage,
    ApplicationStatus,
    Decision,
    EligibilityStatus,
    ResumeApprovalStatus,
    ResumeReviewDecision,
    ResumeReviewEvent,
    ResumeRun,
    ResumeStage,
    ResumeStatus,
    ReviewQuestion,
    ReviewStatus,
    ReviewVersion,
    ScreenEvaluation,
    VerificationAnswer,
    VerificationAnswerEvent,
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
    if latest_review.legacy_input_status != "native":
        return ReviewStatus.STALE
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


def answer_set_fingerprint(events: Sequence[VerificationAnswerEvent]) -> str:
    """Fingerprint the latest append-only answer for every stable question key."""

    latest: dict[str, VerificationAnswerEvent] = {}
    for event in events:
        latest[event.question_key] = event
    return stable_fingerprint(
        answers=tuple((key, event.id, event.answer.value) for key, event in sorted(latest.items()))
    )


def screen_set_fingerprint(evaluations: Sequence[ScreenEvaluation]) -> str:
    return stable_fingerprint(
        screens=tuple(
            (item.rule_id, item.id, item.result.value)
            for item in sorted(evaluations, key=lambda item: (item.rule_id, item.id))
        )
    )


def authoritative_review_fingerprint(
    *,
    job_version_id: str,
    profile_version_id: str,
    evidence_version_id: str,
    evidence_source_revision: str,
    answer_fingerprint: str,
    screen_fingerprint: str,
    model: str,
    prompt_version: str,
    prompt_hash: str,
    schema_version: str,
    schema_hash: str,
) -> str:
    return stable_fingerprint(
        job_version_id=job_version_id,
        profile_version_id=profile_version_id,
        evidence_version_id=evidence_version_id,
        evidence_source_revision=evidence_source_revision,
        answer_fingerprint=answer_fingerprint,
        screen_fingerprint=screen_fingerprint,
        model=model,
        prompt_version=prompt_version,
        prompt_hash=prompt_hash,
        schema_version=schema_version,
        schema_hash=schema_hash,
    )


def authoritative_resume_fingerprint(
    *,
    review_version_id: str,
    gate_decision_event_id: str,
    job_version_id: str,
    profile_version_id: str,
    evidence_version_id: str,
    evidence_source_revision: str,
    answer_fingerprint: str,
    model: str,
    prompt_version: str,
    prompt_hash: str,
    schema_version: str,
    schema_hash: str,
    renderer_protocol_version: str,
    renderer_version: str,
    parent_resume_run_id: str | None = None,
    feedback_review_event_id: str | None = None,
) -> str:
    return stable_fingerprint(
        review_version_id=review_version_id,
        gate_decision_event_id=gate_decision_event_id,
        job_version_id=job_version_id,
        profile_version_id=profile_version_id,
        evidence_version_id=evidence_version_id,
        evidence_source_revision=evidence_source_revision,
        answer_fingerprint=answer_fingerprint,
        model=model,
        prompt_version=prompt_version,
        prompt_hash=prompt_hash,
        schema_version=schema_version,
        schema_hash=schema_hash,
        renderer_protocol_version=renderer_protocol_version,
        renderer_version=renderer_version,
        parent_resume_run_id=parent_resume_run_id,
        feedback_review_event_id=feedback_review_event_id,
    )


def may_record_application_stage(
    current: ApplicationStage,
    requested: ApplicationStage,
) -> bool:
    """Allow forward funnel progress and terminal outcomes, never terminal rewrites."""

    if requested is current:
        return current in {
            ApplicationStage.TECHNICAL_INTERVIEW,
            ApplicationStage.FINAL_OR_ONSITE,
        }
    if current.is_terminal or requested is ApplicationStage.SUBMITTED:
        return False
    if requested.is_terminal:
        return True
    funnel = (
        ApplicationStage.SUBMITTED,
        ApplicationStage.ACKNOWLEDGED,
        ApplicationStage.RECRUITER_SCREEN,
        ApplicationStage.HIRING_MANAGER_SCREEN,
        ApplicationStage.ASSESSMENT,
        ApplicationStage.TECHNICAL_INTERVIEW,
        ApplicationStage.FINAL_OR_ONSITE,
    )
    return funnel.index(requested) > funnel.index(current)


def resume_approval_status(
    run: ResumeRun | None,
    latest_review: ResumeReviewEvent | None,
    *,
    is_current: bool,
) -> ResumeApprovalStatus:
    if run is None:
        return ResumeApprovalStatus.NONE
    # Version 005 deliberately leaves the authoritative pin/agent columns empty
    # on pre-v1 runs.  A completed legacy PDF is preserved for human review, but
    # it is not current and cannot satisfy the v1 approval/submission gates.
    # Surface that migration state honestly instead of folding it into STALE.
    if (
        latest_review is None
        and run.stage is ResumeStage.READY
        and run.artifact is not None
        and run.agent_run_id is None
        and run.gate_decision_event_id is None
        and run.job_version_id is None
        and run.profile_version_id is None
    ):
        return ResumeApprovalStatus.NEEDS_REVIEW
    if not is_current:
        return ResumeApprovalStatus.STALE
    if latest_review is None:
        return ResumeApprovalStatus.NEEDS_REVIEW
    return {
        ResumeReviewDecision.APPROVED: ResumeApprovalStatus.APPROVED,
        ResumeReviewDecision.CHANGES_REQUESTED: ResumeApprovalStatus.CHANGES_REQUESTED,
        ResumeReviewDecision.REJECTED: ResumeApprovalStatus.REJECTED,
    }[latest_review.decision]
