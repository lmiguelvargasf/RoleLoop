CREATE TABLE profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    remote_preference TEXT NOT NULL
        CHECK (remote_preference IN ('any', 'remote', 'hybrid', 'onsite')),
    annual_salary_floor INTEGER CHECK (annual_salary_floor IS NULL OR annual_salary_floor >= 0),
    salary_currency TEXT NOT NULL,
    constraints_text TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    is_active INTEGER NOT NULL CHECK (is_active IN (0, 1)),
    active_evidence_version_id TEXT,
    created_at TEXT,
    updated_at TEXT,
    FOREIGN KEY (active_evidence_version_id) REFERENCES evidence_versions(id)
);

CREATE UNIQUE INDEX profiles_one_active
ON profiles (is_active)
WHERE is_active = 1;

CREATE TABLE profile_target_roles (
    profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (profile_id, position)
);

CREATE TABLE profile_locations (
    profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (profile_id, position)
);

CREATE TABLE profile_employment_types (
    profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (profile_id, position)
);

CREATE TABLE profile_seniority (
    profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (profile_id, position)
);

CREATE TABLE profile_include_keywords (
    profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (profile_id, position)
);

CREATE TABLE profile_exclude_keywords (
    profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (profile_id, position)
);

CREATE TABLE evidence_versions (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL REFERENCES profiles(id),
    source_kind TEXT NOT NULL CHECK (source_kind IN ('pdf', 'text_file', 'pasted_text')),
    source_name TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    artifact_checksum TEXT NOT NULL,
    artifact_uri TEXT NOT NULL,
    artifact_media_type TEXT NOT NULL,
    artifact_size_bytes INTEGER NOT NULL CHECK (artifact_size_bytes >= 0),
    extracted_text TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX evidence_versions_profile_created
ON evidence_versions (profile_id, created_at, id);

CREATE TRIGGER evidence_versions_are_immutable_update
BEFORE UPDATE ON evidence_versions
BEGIN
    SELECT RAISE(ABORT, 'evidence versions are immutable');
END;

CREATE TRIGGER evidence_versions_are_immutable_delete
BEFORE DELETE ON evidence_versions
BEGIN
    SELECT RAISE(ABORT, 'evidence versions are immutable');
END;

CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    canonical_url TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    company TEXT NOT NULL,
    location TEXT NOT NULL,
    description TEXT NOT NULL,
    source TEXT NOT NULL,
    source_metadata_json TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    created_at TEXT,
    updated_at TEXT
);

CREATE TABLE job_cases (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL REFERENCES profiles(id),
    job_id TEXT NOT NULL REFERENCES jobs(id),
    decision TEXT NOT NULL CHECK (decision IN ('undecided', 'tailor', 'watch', 'skip')),
    application_status TEXT NOT NULL
        CHECK (application_status IN ('not_submitted', 'submitted')),
    current_outcome TEXT CHECK (
        current_outcome IS NULL OR current_outcome IN (
            'interviewing', 'offer', 'rejected', 'withdrawn', 'no_response'
        )
    ),
    submitted_at TEXT,
    submitted_artifact_id TEXT,
    revision INTEGER NOT NULL CHECK (revision > 0),
    created_at TEXT,
    updated_at TEXT,
    UNIQUE (profile_id, job_id)
);

CREATE INDEX job_cases_profile_updated
ON job_cases (profile_id, updated_at, id);

CREATE TABLE review_versions (
    id TEXT PRIMARY KEY,
    job_case_id TEXT NOT NULL REFERENCES job_cases(id),
    fingerprint TEXT NOT NULL,
    analyzer_version TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX review_versions_case_created
ON review_versions (job_case_id, created_at, id);

CREATE TABLE review_findings (
    review_version_id TEXT NOT NULL REFERENCES review_versions(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('match', 'skeptic')),
    position INTEGER NOT NULL CHECK (position >= 0),
    summary TEXT NOT NULL,
    detail TEXT NOT NULL,
    source_anchor TEXT NOT NULL,
    PRIMARY KEY (review_version_id, kind, position)
);

CREATE TABLE review_questions (
    review_version_id TEXT NOT NULL REFERENCES review_versions(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    position INTEGER NOT NULL,
    prompt TEXT NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('eligibility', 'verification')),
    required INTEGER NOT NULL CHECK (required IN (0, 1)),
    qualifying_answer TEXT NOT NULL CHECK (qualifying_answer IN ('yes', 'no')),
    PRIMARY KEY (review_version_id, id),
    UNIQUE (review_version_id, position)
);

CREATE TABLE verification_answers (
    review_version_id TEXT NOT NULL,
    question_id TEXT NOT NULL,
    answer TEXT NOT NULL CHECK (answer IN ('yes', 'no', 'unknown')),
    answered_at TEXT NOT NULL,
    PRIMARY KEY (review_version_id, question_id),
    FOREIGN KEY (review_version_id, question_id)
        REFERENCES review_questions(review_version_id, id)
);

CREATE TRIGGER review_versions_are_immutable_update
BEFORE UPDATE ON review_versions
BEGIN
    SELECT RAISE(ABORT, 'review versions are immutable');
END;

CREATE TRIGGER review_versions_are_immutable_delete
BEFORE DELETE ON review_versions
BEGIN
    SELECT RAISE(ABORT, 'review versions are immutable');
END;

CREATE TRIGGER review_questions_are_immutable_update
BEFORE UPDATE ON review_questions
BEGIN
    SELECT RAISE(ABORT, 'review questions are immutable');
END;

CREATE TRIGGER review_questions_are_immutable_delete
BEFORE DELETE ON review_questions
BEGIN
    SELECT RAISE(ABORT, 'review questions are immutable');
END;

CREATE TRIGGER review_findings_are_immutable_update
BEFORE UPDATE ON review_findings
BEGIN
    SELECT RAISE(ABORT, 'review findings are immutable');
END;

CREATE TRIGGER review_findings_are_immutable_delete
BEFORE DELETE ON review_findings
BEGIN
    SELECT RAISE(ABORT, 'review findings are immutable');
END;

CREATE TABLE resume_runs (
    id TEXT PRIMARY KEY,
    job_case_id TEXT NOT NULL REFERENCES job_cases(id),
    review_version_id TEXT NOT NULL REFERENCES review_versions(id),
    evidence_version_id TEXT NOT NULL REFERENCES evidence_versions(id),
    input_fingerprint TEXT NOT NULL,
    stage TEXT NOT NULL CHECK (
        stage IN (
            'queued', 'drafting', 'validating', 'compiling',
            'ready', 'failed', 'interrupted'
        )
    ),
    generator_version TEXT NOT NULL,
    validator_version TEXT NOT NULL,
    compiler_version TEXT NOT NULL,
    artifact_id TEXT,
    artifact_checksum TEXT,
    artifact_uri TEXT,
    artifact_media_type TEXT,
    artifact_size_bytes INTEGER CHECK (
        artifact_size_bytes IS NULL OR artifact_size_bytes >= 0
    ),
    error_message TEXT,
    created_at TEXT,
    updated_at TEXT,
    CHECK (
        (artifact_id IS NULL AND artifact_checksum IS NULL AND artifact_uri IS NULL
            AND artifact_media_type IS NULL AND artifact_size_bytes IS NULL)
        OR
        (artifact_id IS NOT NULL AND artifact_checksum IS NOT NULL AND artifact_uri IS NOT NULL
            AND artifact_media_type IS NOT NULL AND artifact_size_bytes IS NOT NULL)
    )
);

CREATE INDEX resume_runs_case_created
ON resume_runs (job_case_id, created_at, id);

CREATE INDEX resume_runs_stage
ON resume_runs (stage);

CREATE UNIQUE INDEX resume_runs_one_in_progress_per_case
ON resume_runs (job_case_id)
WHERE stage IN ('queued', 'drafting', 'validating', 'compiling');

CREATE TABLE resume_draft_nodes (
    resume_run_id TEXT NOT NULL REFERENCES resume_runs(id) ON DELETE CASCADE,
    node_id INTEGER NOT NULL,
    parent_node_id INTEGER,
    position INTEGER NOT NULL CHECK (position >= 0),
    map_key TEXT,
    node_type TEXT NOT NULL CHECK (
        node_type IN ('mapping', 'list', 'tuple', 'string', 'integer', 'real', 'boolean', 'null')
    ),
    text_value TEXT,
    integer_value INTEGER,
    real_value REAL,
    PRIMARY KEY (resume_run_id, node_id),
    UNIQUE (resume_run_id, parent_node_id, position),
    FOREIGN KEY (resume_run_id, parent_node_id)
        REFERENCES resume_draft_nodes(resume_run_id, node_id) ON DELETE CASCADE,
    CHECK (
        (node_type = 'string' AND text_value IS NOT NULL
            AND integer_value IS NULL AND real_value IS NULL)
        OR (node_type IN ('integer', 'boolean') AND text_value IS NULL
            AND integer_value IS NOT NULL AND real_value IS NULL)
        OR (node_type = 'real' AND text_value IS NULL
            AND integer_value IS NULL AND real_value IS NOT NULL)
        OR (node_type IN ('mapping', 'list', 'tuple', 'null')
            AND text_value IS NULL AND integer_value IS NULL AND real_value IS NULL)
    )
);

CREATE UNIQUE INDEX resume_draft_nodes_one_root
ON resume_draft_nodes (resume_run_id)
WHERE parent_node_id IS NULL;

CREATE TABLE resume_provenance (
    resume_run_id TEXT NOT NULL REFERENCES resume_runs(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position >= 0),
    claim TEXT NOT NULL,
    evidence_anchor TEXT NOT NULL,
    PRIMARY KEY (resume_run_id, position)
);

CREATE TABLE resume_validation_findings (
    resume_run_id TEXT NOT NULL REFERENCES resume_runs(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position >= 0),
    severity TEXT NOT NULL CHECK (severity IN ('error', 'warning', 'info')),
    message TEXT NOT NULL,
    location TEXT NOT NULL,
    PRIMARY KEY (resume_run_id, position)
);

CREATE TABLE application_submissions (
    id TEXT PRIMARY KEY,
    job_case_id TEXT NOT NULL UNIQUE REFERENCES job_cases(id),
    decision_at_submission TEXT NOT NULL
        CHECK (decision_at_submission IN ('undecided', 'tailor', 'watch')),
    artifact_id TEXT,
    submitted_at TEXT NOT NULL
);

CREATE TRIGGER application_submissions_are_immutable_update
BEFORE UPDATE ON application_submissions
BEGIN
    SELECT RAISE(ABORT, 'application submissions are immutable');
END;

CREATE TRIGGER application_submissions_are_immutable_delete
BEFORE DELETE ON application_submissions
BEGIN
    SELECT RAISE(ABORT, 'application submissions are immutable');
END;

CREATE TABLE outcome_events (
    id TEXT PRIMARY KEY,
    job_case_id TEXT NOT NULL REFERENCES job_cases(id),
    outcome TEXT NOT NULL CHECK (
        outcome IN ('interviewing', 'offer', 'rejected', 'withdrawn', 'no_response')
    ),
    recorded_at TEXT NOT NULL
);

CREATE INDEX outcome_events_case_recorded
ON outcome_events (job_case_id, recorded_at, id);

CREATE TRIGGER outcome_events_are_immutable_update
BEFORE UPDATE ON outcome_events
BEGIN
    SELECT RAISE(ABORT, 'outcome events are immutable');
END;

CREATE TRIGGER outcome_events_are_immutable_delete
BEFORE DELETE ON outcome_events
BEGIN
    SELECT RAISE(ABORT, 'outcome events are immutable');
END;

CREATE TABLE workflow_events (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    profile_id TEXT NOT NULL REFERENCES profiles(id),
    job_case_id TEXT REFERENCES job_cases(id),
    metadata_json TEXT NOT NULL
);

CREATE INDEX workflow_events_case_occurred
ON workflow_events (job_case_id, occurred_at, id);

CREATE TRIGGER workflow_events_are_append_only_update
BEFORE UPDATE ON workflow_events
BEGIN
    SELECT RAISE(ABORT, 'workflow events are append-only');
END;

CREATE TRIGGER workflow_events_are_append_only_delete
BEFORE DELETE ON workflow_events
BEGIN
    SELECT RAISE(ABORT, 'workflow events are append-only');
END;
