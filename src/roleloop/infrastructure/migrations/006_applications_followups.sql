CREATE TABLE tracked_applications (
    id TEXT PRIMARY KEY,
    command_id TEXT NOT NULL UNIQUE,
    job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id),
    job_case_id TEXT NOT NULL REFERENCES job_cases(id),
    current_stage TEXT NOT NULL CHECK (current_stage IN (
        'submitted', 'acknowledged', 'recruiter_screen', 'hiring_manager_screen',
        'assessment', 'technical_interview', 'final_or_onsite', 'offer',
        'rejected', 'withdrawn', 'no_response'
    )),
    approved_resume_review_event_id TEXT REFERENCES resume_review_events(id),
    resume_run_id TEXT REFERENCES resume_runs(id),
    pdf_artifact_id TEXT REFERENCES artifacts(id),
    pdf_checksum TEXT,
    job_version_id TEXT REFERENCES job_versions(id),
    profile_version_id TEXT REFERENCES search_profile_versions(id),
    evidence_version_id TEXT REFERENCES evidence_versions(id),
    review_version_id TEXT REFERENCES review_versions(id),
    gate_decision_event_id TEXT REFERENCES case_decision_events(id),
    submitted_at TEXT NOT NULL,
    legacy INTEGER NOT NULL CHECK (legacy IN (0, 1)),
    revision INTEGER NOT NULL CHECK (revision > 0),
    created_at TEXT,
    updated_at TEXT,
    CHECK (
        (legacy = 1)
        OR
        (approved_resume_review_event_id IS NOT NULL AND resume_run_id IS NOT NULL
            AND pdf_artifact_id IS NOT NULL AND pdf_checksum IS NOT NULL
            AND length(pdf_checksum) = 64 AND job_version_id IS NOT NULL
            AND profile_version_id IS NOT NULL AND evidence_version_id IS NOT NULL
            AND review_version_id IS NOT NULL AND gate_decision_event_id IS NOT NULL)
    )
);

CREATE TABLE application_stage_events (
    id TEXT PRIMARY KEY,
    command_id TEXT NOT NULL UNIQUE,
    application_id TEXT NOT NULL REFERENCES tracked_applications(id),
    stage TEXT NOT NULL CHECK (stage IN (
        'submitted', 'acknowledged', 'recruiter_screen', 'hiring_manager_screen',
        'assessment', 'technical_interview', 'final_or_onsite', 'offer',
        'rejected', 'withdrawn', 'no_response'
    )),
    actor TEXT NOT NULL CHECK (actor IN ('human', 'system')),
    occurred_at TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    note TEXT NOT NULL
);

CREATE TABLE application_follow_ups (
    id TEXT PRIMARY KEY,
    command_id TEXT NOT NULL UNIQUE,
    application_id TEXT NOT NULL REFERENCES tracked_applications(id),
    due_at TEXT NOT NULL,
    note TEXT NOT NULL,
    trigger_stage_event_id TEXT REFERENCES application_stage_events(id),
    supersedes_follow_up_id TEXT REFERENCES application_follow_ups(id),
    created_at TEXT,
    UNIQUE (supersedes_follow_up_id)
);

CREATE TABLE follow_up_resolutions (
    id TEXT PRIMARY KEY,
    command_id TEXT NOT NULL UNIQUE,
    follow_up_id TEXT NOT NULL UNIQUE REFERENCES application_follow_ups(id),
    disposition TEXT NOT NULL CHECK (disposition IN ('completed', 'dismissed', 'rescheduled')),
    replacement_follow_up_id TEXT REFERENCES application_follow_ups(id),
    note TEXT NOT NULL,
    resolved_at TEXT,
    CHECK (
        (disposition = 'rescheduled' AND replacement_follow_up_id IS NOT NULL)
        OR (disposition <> 'rescheduled' AND replacement_follow_up_id IS NULL)
    )
);

CREATE TABLE legacy_application_aliases (
    legacy_job_case_id TEXT PRIMARY KEY REFERENCES job_cases(id),
    application_id TEXT NOT NULL REFERENCES tracked_applications(id),
    reason TEXT NOT NULL
);

INSERT INTO command_receipts (command_id, command_type, result_type, result_id, created_at)
SELECT 'legacy-application-command:' || s.id, 'legacy.application', 'tracked_application',
       'legacy-application:' || s.id, s.submitted_at
FROM application_submissions s
WHERE s.rowid = (
    SELECT MIN(s2.rowid)
    FROM application_submissions s2
    JOIN job_cases c2 ON c2.id = s2.job_case_id
    WHERE c2.job_id = (SELECT c.job_id FROM job_cases c WHERE c.id = s.job_case_id)
);

INSERT INTO tracked_applications (
    id, command_id, job_id, job_case_id, current_stage,
    approved_resume_review_event_id, resume_run_id, pdf_artifact_id, pdf_checksum,
    job_version_id, profile_version_id, evidence_version_id, review_version_id,
    gate_decision_event_id, submitted_at, legacy, revision, created_at, updated_at
)
SELECT 'legacy-application:' || s.id, 'legacy-application-command:' || s.id,
       c.job_id, s.job_case_id,
       COALESCE((
           SELECT CASE o.outcome
               WHEN 'interviewing' THEN 'technical_interview'
               WHEN 'offer' THEN 'offer'
               WHEN 'rejected' THEN 'rejected'
               WHEN 'withdrawn' THEN 'withdrawn'
               WHEN 'no_response' THEN 'no_response'
               ELSE 'submitted'
           END
           FROM outcome_events o WHERE o.job_case_id = s.job_case_id
           ORDER BY o.recorded_at DESC, o.rowid DESC LIMIT 1
       ), 'submitted'),
       NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
       s.submitted_at, 1, 1, s.submitted_at,
       COALESCE((
           SELECT o.recorded_at
           FROM outcome_events o WHERE o.job_case_id = s.job_case_id
           ORDER BY o.recorded_at DESC, o.rowid DESC LIMIT 1
       ), s.submitted_at)
FROM application_submissions s
JOIN job_cases c ON c.id = s.job_case_id
WHERE s.rowid = (
    SELECT MIN(s2.rowid)
    FROM application_submissions s2
    JOIN job_cases c2 ON c2.id = s2.job_case_id
    WHERE c2.job_id = c.job_id
);

INSERT INTO legacy_application_aliases (legacy_job_case_id, application_id, reason)
SELECT s.job_case_id, 'legacy-application:' || first_submission.id,
       'Multiple legacy profile cases referred to the same global job'
FROM application_submissions s
JOIN job_cases c ON c.id = s.job_case_id
JOIN application_submissions first_submission ON first_submission.rowid = (
    SELECT MIN(s2.rowid)
    FROM application_submissions s2
    JOIN job_cases c2 ON c2.id = s2.job_case_id
    WHERE c2.job_id = c.job_id
)
WHERE s.id <> first_submission.id;

INSERT INTO command_receipts (command_id, command_type, result_type, result_id, created_at)
SELECT 'legacy-stage-command:' || a.id, 'legacy.application_stage',
       'application_stage_event', 'legacy-stage:' || a.id, a.submitted_at
FROM tracked_applications a;

INSERT INTO application_stage_events (
    id, command_id, application_id, stage, actor, occurred_at, recorded_at, note
)
SELECT 'legacy-stage:' || id, 'legacy-stage-command:' || id, id, 'submitted',
       'human', submitted_at, submitted_at, 'Imported legacy submission'
FROM tracked_applications;

INSERT INTO command_receipts (command_id, command_type, result_type, result_id, created_at)
SELECT 'legacy-outcome-stage-command:' || o.id, 'legacy.application_stage',
       'application_stage_event', 'legacy-outcome-stage:' || o.id, o.recorded_at
FROM outcome_events o
JOIN tracked_applications a ON a.job_case_id = o.job_case_id
ORDER BY o.recorded_at, o.rowid;

INSERT INTO application_stage_events (
    id, command_id, application_id, stage, actor, occurred_at, recorded_at, note
)
SELECT 'legacy-outcome-stage:' || o.id,
       'legacy-outcome-stage-command:' || o.id,
       a.id,
       CASE o.outcome
           WHEN 'interviewing' THEN 'technical_interview'
           WHEN 'offer' THEN 'offer'
           WHEN 'rejected' THEN 'rejected'
           WHEN 'withdrawn' THEN 'withdrawn'
           WHEN 'no_response' THEN 'no_response'
       END,
       'human', o.recorded_at, o.recorded_at,
       'Imported legacy outcome: ' || o.outcome
FROM outcome_events o
JOIN tracked_applications a ON a.job_case_id = o.job_case_id
ORDER BY o.recorded_at, o.rowid;

CREATE INDEX application_stage_events_application_occurred
ON application_stage_events (application_id, occurred_at, id);

CREATE INDEX application_follow_ups_due
ON application_follow_ups (due_at, application_id);

CREATE TRIGGER application_stage_events_append_only_update
BEFORE UPDATE ON application_stage_events BEGIN
    SELECT RAISE(ABORT, 'application stage events are append-only');
END;

CREATE TRIGGER application_stage_events_append_only_delete
BEFORE DELETE ON application_stage_events BEGIN
    SELECT RAISE(ABORT, 'application stage events are append-only');
END;

CREATE TRIGGER application_follow_ups_append_only_update
BEFORE UPDATE ON application_follow_ups BEGIN
    SELECT RAISE(ABORT, 'application follow-ups are append-only');
END;

CREATE TRIGGER application_follow_ups_append_only_delete
BEFORE DELETE ON application_follow_ups BEGIN
    SELECT RAISE(ABORT, 'application follow-ups are append-only');
END;

CREATE TRIGGER follow_up_resolutions_append_only_update
BEFORE UPDATE ON follow_up_resolutions BEGIN
    SELECT RAISE(ABORT, 'follow-up resolutions are append-only');
END;

CREATE TRIGGER follow_up_resolutions_append_only_delete
BEFORE DELETE ON follow_up_resolutions BEGIN
    SELECT RAISE(ABORT, 'follow-up resolutions are append-only');
END;
