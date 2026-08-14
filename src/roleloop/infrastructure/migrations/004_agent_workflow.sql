CREATE TABLE command_receipts (
    command_id TEXT PRIMARY KEY,
    command_type TEXT NOT NULL,
    result_type TEXT NOT NULL,
    result_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    request_fingerprint TEXT CHECK (
        request_fingerprint IS NULL OR length(request_fingerprint) = 64
    )
);

CREATE TRIGGER command_receipts_require_native_fingerprint
BEFORE INSERT ON command_receipts
WHEN NEW.request_fingerprint IS NULL AND NEW.command_type NOT LIKE 'legacy.%'
BEGIN
    SELECT RAISE(ABORT, 'native command receipt requires request fingerprint');
END;

CREATE TABLE agent_runs (
    id TEXT PRIMARY KEY,
    command_id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('scout', 'reviewer', 'resume')),
    provider TEXT NOT NULL CHECK (provider IN ('openai', 'demo')),
    model TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    output_schema_version TEXT NOT NULL,
    profile_id TEXT NOT NULL REFERENCES profiles(id),
    job_case_id TEXT REFERENCES job_cases(id),
    input_fingerprint TEXT NOT NULL CHECK (length(input_fingerprint) = 64),
    prompt_hash TEXT NOT NULL CHECK (length(prompt_hash) = 64),
    output_schema_hash TEXT NOT NULL CHECK (length(output_schema_hash) = 64),
    provider_response_id TEXT,
    response_model TEXT,
    input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
    output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
    total_tokens INTEGER CHECK (total_tokens IS NULL OR total_tokens >= 0),
    status_detail TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('queued', 'running', 'succeeded', 'failed', 'interrupted')
    ),
    request_artifact_id TEXT REFERENCES artifacts(id),
    response_artifact_id TEXT REFERENCES artifacts(id),
    error_code TEXT,
    error_message TEXT,
    started_at TEXT,
    finished_at TEXT,
    created_at TEXT
);

CREATE TABLE agent_run_source_urls (
    agent_run_id TEXT NOT NULL REFERENCES agent_runs(id),
    position INTEGER NOT NULL CHECK (position >= 0),
    canonical_url TEXT NOT NULL,
    PRIMARY KEY (agent_run_id, position),
    UNIQUE (agent_run_id, canonical_url)
);

CREATE TABLE scout_runs (
    id TEXT PRIMARY KEY,
    agent_run_id TEXT NOT NULL UNIQUE REFERENCES agent_runs(id),
    profile_version_id TEXT NOT NULL REFERENCES search_profile_versions(id),
    mode TEXT NOT NULL CHECK (mode IN ('search', 'url_enrichment')),
    requested_url TEXT,
    result_limit INTEGER NOT NULL CHECK (result_limit > 0),
    created_at TEXT
);

CREATE TABLE scout_candidates (
    scout_run_id TEXT NOT NULL REFERENCES scout_runs(id),
    position INTEGER NOT NULL CHECK (position >= 0),
    job_id TEXT NOT NULL REFERENCES jobs(id),
    job_version_id TEXT NOT NULL REFERENCES job_versions(id),
    dedupe_key TEXT NOT NULL,
    PRIMARY KEY (scout_run_id, position),
    UNIQUE (scout_run_id, job_id)
);

CREATE TABLE screen_evaluations (
    id TEXT PRIMARY KEY,
    job_case_id TEXT NOT NULL REFERENCES job_cases(id),
    job_version_id TEXT NOT NULL REFERENCES job_versions(id),
    profile_version_id TEXT NOT NULL REFERENCES search_profile_versions(id),
    rule_id TEXT NOT NULL REFERENCES hard_blocker_rules(id),
    result TEXT NOT NULL CHECK (result IN ('pass', 'fail', 'unknown')),
    detail TEXT NOT NULL,
    source_snapshot_id TEXT REFERENCES web_source_snapshots(id),
    created_at TEXT,
    UNIQUE (job_case_id, job_version_id, profile_version_id, rule_id)
);

ALTER TABLE review_versions ADD COLUMN agent_run_id TEXT REFERENCES agent_runs(id);
ALTER TABLE review_versions ADD COLUMN job_version_id TEXT REFERENCES job_versions(id);
ALTER TABLE review_versions ADD COLUMN profile_version_id TEXT REFERENCES search_profile_versions(id);
ALTER TABLE review_versions ADD COLUMN evidence_version_id TEXT REFERENCES evidence_versions(id);
ALTER TABLE review_versions ADD COLUMN answer_set_fingerprint TEXT NOT NULL DEFAULT '';
ALTER TABLE review_versions ADD COLUMN screen_set_fingerprint TEXT NOT NULL DEFAULT '';
ALTER TABLE review_versions ADD COLUMN recommended_decision TEXT NOT NULL DEFAULT 'undecided'
    CHECK (recommended_decision IN ('undecided', 'tailor', 'watch', 'skip'));
ALTER TABLE review_versions ADD COLUMN legacy_input_status TEXT NOT NULL
    DEFAULT 'legacy_unreproducible'
    CHECK (legacy_input_status IN ('native', 'legacy_unreproducible'));
ALTER TABLE review_versions ADD COLUMN confidence REAL NOT NULL DEFAULT 0.0
    CHECK (confidence >= 0.0 AND confidence <= 1.0);
ALTER TABLE review_versions ADD COLUMN positioning TEXT NOT NULL DEFAULT '';
ALTER TABLE review_versions ADD COLUMN self_critique TEXT NOT NULL DEFAULT '';

ALTER TABLE review_questions ADD COLUMN source_anchor TEXT NOT NULL DEFAULT '';

CREATE TABLE review_requirements (
    review_version_id TEXT NOT NULL REFERENCES review_versions(id),
    position INTEGER NOT NULL CHECK (position >= 0),
    requirement_key TEXT NOT NULL,
    text_value TEXT NOT NULL,
    evidence TEXT NOT NULL,
    required INTEGER NOT NULL CHECK (required IN (0, 1)),
    source_anchor TEXT NOT NULL,
    PRIMARY KEY (review_version_id, position),
    UNIQUE (review_version_id, requirement_key)
);

CREATE TABLE verification_answer_events (
    id TEXT PRIMARY KEY,
    command_id TEXT NOT NULL UNIQUE,
    job_case_id TEXT NOT NULL REFERENCES job_cases(id),
    question_key TEXT NOT NULL,
    asked_by_review_version_id TEXT NOT NULL REFERENCES review_versions(id),
    answer TEXT NOT NULL CHECK (answer IN ('yes', 'no', 'unknown')),
    actor TEXT NOT NULL CHECK (actor IN ('human', 'system')),
    supersedes_answer_event_id TEXT REFERENCES verification_answer_events(id),
    legacy INTEGER NOT NULL CHECK (legacy IN (0, 1)),
    recorded_at TEXT,
    UNIQUE (job_case_id, question_key, id)
);

CREATE INDEX verification_answer_events_case_question
ON verification_answer_events (job_case_id, question_key, recorded_at, id);

CREATE TABLE case_decision_events (
    id TEXT PRIMARY KEY,
    command_id TEXT NOT NULL UNIQUE,
    job_case_id TEXT NOT NULL REFERENCES job_cases(id),
    decision TEXT NOT NULL CHECK (decision IN ('tailor', 'watch', 'skip')),
    reason TEXT NOT NULL CHECK (reason IN (
        'human_choice', 'deterministic_hard_blocker', 'legacy_unpinned'
    )),
    actor TEXT NOT NULL CHECK (actor IN ('human', 'system')),
    review_version_id TEXT REFERENCES review_versions(id),
    job_version_id TEXT REFERENCES job_versions(id),
    profile_version_id TEXT REFERENCES search_profile_versions(id),
    evidence_version_id TEXT REFERENCES evidence_versions(id),
    answer_set_fingerprint TEXT,
    screen_evaluation_id TEXT REFERENCES screen_evaluations(id),
    supersedes_decision_event_id TEXT REFERENCES case_decision_events(id),
    rationale TEXT NOT NULL,
    decided_at TEXT,
    CHECK (
        reason = 'legacy_unpinned'
        OR (job_version_id IS NOT NULL AND profile_version_id IS NOT NULL)
    ),
    CHECK (
        reason <> 'deterministic_hard_blocker'
        OR (decision = 'skip' AND actor = 'system' AND screen_evaluation_id IS NOT NULL)
    ),
    CHECK (
        reason <> 'human_choice'
        OR actor = 'human'
    )
);

ALTER TABLE job_cases ADD COLUMN current_decision_event_id TEXT REFERENCES case_decision_events(id);

INSERT INTO command_receipts (command_id, command_type, result_type, result_id, created_at)
SELECT 'legacy-decision-command:' || id, 'legacy.decision', 'case_decision_event',
       'legacy-decision:' || id, COALESCE(updated_at, created_at, CURRENT_TIMESTAMP)
FROM job_cases WHERE decision <> 'undecided';

INSERT INTO case_decision_events (
    id, command_id, job_case_id, decision, reason, actor, rationale, decided_at
)
SELECT 'legacy-decision:' || id, 'legacy-decision-command:' || id, id, decision,
       'legacy_unpinned', 'human', 'Imported from the pre-versioned RoleLoop schema',
       COALESCE(updated_at, created_at)
FROM job_cases WHERE decision <> 'undecided';

UPDATE job_cases SET current_decision_event_id = 'legacy-decision:' || id
WHERE decision <> 'undecided';

INSERT INTO command_receipts (command_id, command_type, result_type, result_id, created_at)
SELECT 'legacy-answer-command:' || review_version_id || ':' || question_id,
       'legacy.answer', 'verification_answer_event',
       'legacy-answer:' || review_version_id || ':' || question_id, answered_at
FROM verification_answers;

INSERT INTO verification_answer_events (
    id, command_id, job_case_id, question_key, asked_by_review_version_id,
    answer, actor, legacy, recorded_at
)
SELECT 'legacy-answer:' || a.review_version_id || ':' || a.question_id,
       'legacy-answer-command:' || a.review_version_id || ':' || a.question_id,
       r.job_case_id, a.question_id, a.review_version_id, a.answer, 'human', 1,
       a.answered_at
FROM verification_answers a
JOIN review_versions r ON r.id = a.review_version_id;

CREATE INDEX agent_runs_case_created ON agent_runs (job_case_id, created_at, id);
CREATE INDEX screen_evaluations_case_inputs
ON screen_evaluations (job_case_id, job_version_id, profile_version_id);
CREATE INDEX case_decision_events_case_decided
ON case_decision_events (job_case_id, decided_at, id);

CREATE TRIGGER command_receipts_append_only_update
BEFORE UPDATE ON command_receipts BEGIN
    SELECT RAISE(ABORT, 'command receipts are append-only');
END;

CREATE TRIGGER command_receipts_append_only_delete
BEFORE DELETE ON command_receipts BEGIN
    SELECT RAISE(ABORT, 'command receipts are append-only');
END;

CREATE TRIGGER review_requirements_immutable_update
BEFORE UPDATE ON review_requirements BEGIN
    SELECT RAISE(ABORT, 'review requirements are immutable');
END;

CREATE TRIGGER review_requirements_immutable_delete
BEFORE DELETE ON review_requirements BEGIN
    SELECT RAISE(ABORT, 'review requirements are immutable');
END;

CREATE TRIGGER verification_answer_events_append_only_update
BEFORE UPDATE ON verification_answer_events BEGIN
    SELECT RAISE(ABORT, 'verification answer events are append-only');
END;

CREATE TRIGGER verification_answer_events_append_only_delete
BEFORE DELETE ON verification_answer_events BEGIN
    SELECT RAISE(ABORT, 'verification answer events are append-only');
END;

CREATE TRIGGER case_decision_events_append_only_update
BEFORE UPDATE ON case_decision_events BEGIN
    SELECT RAISE(ABORT, 'case decision events are append-only');
END;

CREATE TRIGGER case_decision_events_append_only_delete
BEFORE DELETE ON case_decision_events BEGIN
    SELECT RAISE(ABORT, 'case decision events are append-only');
END;
