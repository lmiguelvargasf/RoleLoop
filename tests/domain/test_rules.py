from datetime import UTC, datetime

from roleloop.domain import (
    Answer,
    EligibilityStatus,
    QuestionCategory,
    ResumeRun,
    ResumeStage,
    ResumeStatus,
    ReviewQuestion,
    ReviewStatus,
    ReviewVersion,
    derive_eligibility,
    resume_status,
    review_fingerprint,
    review_status,
)


def question(question_id: str, qualifying: Answer = Answer.YES) -> ReviewQuestion:
    return ReviewQuestion(
        id=question_id,
        prompt=question_id,
        category=QuestionCategory.ELIGIBILITY,
        required=True,
        qualifying_answer=qualifying,
    )


def test_eligibility_is_unresolved_until_all_required_answers_are_known() -> None:
    questions = (question("sponsorship", Answer.NO), question("location"))

    assert derive_eligibility(questions, {}) is EligibilityStatus.UNRESOLVED
    assert derive_eligibility(questions, {"sponsorship": Answer.NO}) is EligibilityStatus.UNRESOLVED
    assert (
        derive_eligibility(
            questions,
            {"sponsorship": Answer.NO, "location": Answer.YES},
        )
        is EligibilityStatus.ELIGIBLE
    )


def test_one_unfavorable_required_answer_is_ineligible() -> None:
    assert (
        derive_eligibility((question("work_authorization"),), {"work_authorization": Answer.NO})
        is EligibilityStatus.INELIGIBLE
    )


def test_review_freshness_is_a_deterministic_input_snapshot() -> None:
    fingerprint = review_fingerprint(
        job_revision=3,
        profile_revision=2,
        evidence_version_id="evidence-1",
        analyzer_version="analyzer-v1",
    )
    review = ReviewVersion(
        id="review-1",
        job_case_id="case-1",
        fingerprint=fingerprint,
        analyzer_version="analyzer-v1",
        match_evidence=(),
        skeptic_findings=(),
        questions=(),
        created_at=datetime(2026, 1, 1, tzinfo=UTC),
    )

    assert review_status(review, expected_fingerprint=fingerprint) is ReviewStatus.CURRENT
    changed = review_fingerprint(
        job_revision=4,
        profile_revision=2,
        evidence_version_id="evidence-1",
        analyzer_version="analyzer-v1",
    )
    assert review_status(review, expected_fingerprint=changed) is ReviewStatus.STALE


def test_in_progress_resume_remains_in_progress_but_finished_mismatch_is_stale() -> None:
    run = ResumeRun(
        id="run-1",
        job_case_id="case-1",
        review_version_id="review-1",
        evidence_version_id="evidence-1",
        input_fingerprint="old",
        stage=ResumeStage.DRAFTING,
        generator_version="g1",
        validator_version="v1",
        compiler_version="c1",
    )
    assert resume_status(run, expected_fingerprint="new") is ResumeStatus.IN_PROGRESS
    ready = ResumeRun(
        id=run.id,
        job_case_id=run.job_case_id,
        review_version_id=run.review_version_id,
        evidence_version_id=run.evidence_version_id,
        input_fingerprint=run.input_fingerprint,
        stage=ResumeStage.READY,
        generator_version=run.generator_version,
        validator_version=run.validator_version,
        compiler_version=run.compiler_version,
    )
    assert resume_status(ready, expected_fingerprint="new") is ResumeStatus.STALE
