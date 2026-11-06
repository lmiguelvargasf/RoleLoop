ALTER TABLE evidence_versions ADD COLUMN contract_schema_version TEXT;
ALTER TABLE evidence_versions ADD COLUMN canonical_evidence_artifact_id TEXT REFERENCES artifacts(id);
ALTER TABLE evidence_versions ADD COLUMN source_bundle_artifact_id TEXT REFERENCES artifacts(id);
ALTER TABLE evidence_versions ADD COLUMN renderer_protocol_version TEXT;
ALTER TABLE evidence_versions ADD COLUMN renderer_version TEXT;
ALTER TABLE evidence_versions ADD COLUMN contract_checksum TEXT;

CREATE TABLE resume_review_events (
    id TEXT PRIMARY KEY,
    command_id TEXT NOT NULL UNIQUE,
    resume_run_id TEXT NOT NULL REFERENCES resume_runs(id),
    decision TEXT NOT NULL CHECK (decision IN ('approved', 'changes_requested', 'rejected')),
    actor TEXT NOT NULL CHECK (actor = 'human'),
    feedback TEXT NOT NULL,
    pdf_artifact_id TEXT REFERENCES artifacts(id),
    pdf_checksum TEXT,
    created_at TEXT,
    CHECK (
        (decision = 'approved' AND pdf_artifact_id IS NOT NULL
            AND pdf_checksum IS NOT NULL AND length(pdf_checksum) = 64)
        OR
        (decision <> 'approved' AND pdf_artifact_id IS NULL AND pdf_checksum IS NULL)
    ),
    CHECK (decision <> 'changes_requested' OR feedback <> '')
);

ALTER TABLE resume_runs ADD COLUMN agent_run_id TEXT REFERENCES agent_runs(id);
ALTER TABLE resume_runs ADD COLUMN parent_resume_run_id TEXT REFERENCES resume_runs(id);
ALTER TABLE resume_runs ADD COLUMN feedback_review_event_id TEXT REFERENCES resume_review_events(id);
ALTER TABLE resume_runs ADD COLUMN gate_decision_event_id TEXT REFERENCES case_decision_events(id);
ALTER TABLE resume_runs ADD COLUMN job_version_id TEXT REFERENCES job_versions(id);
ALTER TABLE resume_runs ADD COLUMN profile_version_id TEXT REFERENCES search_profile_versions(id);
ALTER TABLE resume_runs ADD COLUMN answer_set_fingerprint TEXT NOT NULL DEFAULT '';
ALTER TABLE resume_runs ADD COLUMN headline TEXT;
ALTER TABLE resume_runs ADD COLUMN selection_artifact_id TEXT REFERENCES artifacts(id);
ALTER TABLE resume_runs ADD COLUMN tailored_source_bundle_artifact_id TEXT REFERENCES artifacts(id);
ALTER TABLE resume_runs ADD COLUMN render_receipt_artifact_id TEXT REFERENCES artifacts(id);
ALTER TABLE resume_runs ADD COLUMN review_file_artifact_id TEXT REFERENCES artifacts(id);
ALTER TABLE resume_runs ADD COLUMN compile_log_artifact_id TEXT REFERENCES artifacts(id);
ALTER TABLE resume_runs ADD COLUMN ats_text_artifact_id TEXT REFERENCES artifacts(id);
ALTER TABLE resume_runs ADD COLUMN rendered_page_count INTEGER
    CHECK (rendered_page_count IS NULL OR rendered_page_count > 0);
ALTER TABLE resume_runs ADD COLUMN renderer_source_revision TEXT;
ALTER TABLE resume_runs ADD COLUMN render_tool_versions_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE resume_runs ADD COLUMN render_output_checksums_json TEXT NOT NULL DEFAULT '{}';

CREATE TABLE resume_selected_experiences (
    resume_run_id TEXT NOT NULL REFERENCES resume_runs(id),
    position INTEGER NOT NULL CHECK (position >= 0),
    experience_id TEXT NOT NULL,
    PRIMARY KEY (resume_run_id, position),
    UNIQUE (resume_run_id, experience_id)
);

CREATE TABLE resume_selected_bullets (
    resume_run_id TEXT NOT NULL,
    experience_position INTEGER NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    bullet_id TEXT NOT NULL,
    PRIMARY KEY (resume_run_id, experience_position, position),
    UNIQUE (resume_run_id, bullet_id),
    FOREIGN KEY (resume_run_id, experience_position)
        REFERENCES resume_selected_experiences(resume_run_id, position)
);

CREATE TABLE resume_selected_skills (
    resume_run_id TEXT NOT NULL REFERENCES resume_runs(id),
    position INTEGER NOT NULL CHECK (position >= 0),
    skill_id TEXT NOT NULL,
    PRIMARY KEY (resume_run_id, position),
    UNIQUE (resume_run_id, skill_id)
);

CREATE INDEX resume_review_events_run_created
ON resume_review_events (resume_run_id, created_at, id);

CREATE TRIGGER evidence_contract_provenance_insert
BEFORE INSERT ON evidence_versions
WHEN NOT (
    (NEW.contract_schema_version IS NULL
        AND NEW.canonical_evidence_artifact_id IS NULL
        AND NEW.source_bundle_artifact_id IS NULL
        AND NEW.renderer_protocol_version IS NULL
        AND NEW.renderer_version IS NULL
        AND NEW.contract_checksum IS NULL)
    OR
    (NEW.contract_schema_version IS NOT NULL
        AND NEW.canonical_evidence_artifact_id IS NOT NULL
        AND NEW.source_bundle_artifact_id IS NOT NULL
        AND NEW.renderer_protocol_version IS NOT NULL
        AND NEW.renderer_version IS NOT NULL
        AND NEW.contract_checksum IS NOT NULL
        AND length(NEW.contract_checksum) = 64)
)
BEGIN
    SELECT RAISE(ABORT, 'resume contract provenance must be complete');
END;

CREATE TRIGGER resume_review_events_append_only_update
BEFORE UPDATE ON resume_review_events BEGIN
    SELECT RAISE(ABORT, 'resume review events are append-only');
END;

CREATE TRIGGER resume_review_events_append_only_delete
BEFORE DELETE ON resume_review_events BEGIN
    SELECT RAISE(ABORT, 'resume review events are append-only');
END;

CREATE TRIGGER resume_selected_experiences_immutable_update
BEFORE UPDATE ON resume_selected_experiences BEGIN
    SELECT RAISE(ABORT, 'resume selections are immutable');
END;

CREATE TRIGGER resume_selected_experiences_immutable_delete
BEFORE DELETE ON resume_selected_experiences BEGIN
    SELECT RAISE(ABORT, 'resume selections are immutable');
END;

CREATE TRIGGER resume_selected_bullets_immutable_update
BEFORE UPDATE ON resume_selected_bullets BEGIN
    SELECT RAISE(ABORT, 'resume selections are immutable');
END;

CREATE TRIGGER resume_selected_bullets_immutable_delete
BEFORE DELETE ON resume_selected_bullets BEGIN
    SELECT RAISE(ABORT, 'resume selections are immutable');
END;

CREATE TRIGGER resume_selected_skills_immutable_update
BEFORE UPDATE ON resume_selected_skills BEGIN
    SELECT RAISE(ABORT, 'resume selections are immutable');
END;

CREATE TRIGGER resume_selected_skills_immutable_delete
BEFORE DELETE ON resume_selected_skills BEGIN
    SELECT RAISE(ABORT, 'resume selections are immutable');
END;
