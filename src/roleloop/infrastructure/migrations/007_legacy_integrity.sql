CREATE TABLE legacy_import_batches (
    id TEXT PRIMARY KEY,
    command_id TEXT NOT NULL UNIQUE,
    profile_id TEXT NOT NULL REFERENCES profiles(id),
    source_checksum TEXT NOT NULL CHECK (length(source_checksum) = 64),
    imported_jobs INTEGER NOT NULL CHECK (imported_jobs >= 0),
    imported_events INTEGER NOT NULL CHECK (imported_events >= 0),
    created_at TEXT NOT NULL,
    UNIQUE (profile_id, source_checksum)
);

CREATE TABLE legacy_import_items (
    batch_id TEXT NOT NULL REFERENCES legacy_import_batches(id),
    legacy_key TEXT NOT NULL,
    entity_type TEXT NOT NULL CHECK (entity_type IN (
        'job', 'job_case', 'decision', 'application', 'stage', 'workflow_event'
    )),
    entity_id TEXT NOT NULL,
    PRIMARY KEY (batch_id, legacy_key, entity_type)
);

CREATE TABLE legacy_import_sources (
    batch_id TEXT NOT NULL REFERENCES legacy_import_batches(id),
    position INTEGER NOT NULL CHECK (position >= 0),
    database_name TEXT NOT NULL,
    source_checksum TEXT NOT NULL CHECK (length(source_checksum) = 64),
    size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
    job_count INTEGER NOT NULL CHECK (job_count >= 0),
    event_count INTEGER NOT NULL CHECK (event_count >= 0),
    PRIMARY KEY (batch_id, position),
    UNIQUE (batch_id, database_name)
);

CREATE INDEX legacy_import_items_entity
ON legacy_import_items (entity_type, entity_id);

CREATE TRIGGER legacy_import_batches_append_only_update
BEFORE UPDATE ON legacy_import_batches BEGIN
    SELECT RAISE(ABORT, 'legacy import batches are append-only');
END;

CREATE TRIGGER legacy_import_batches_append_only_delete
BEFORE DELETE ON legacy_import_batches BEGIN
    SELECT RAISE(ABORT, 'legacy import batches are append-only');
END;

CREATE TRIGGER legacy_import_items_append_only_update
BEFORE UPDATE ON legacy_import_items BEGIN
    SELECT RAISE(ABORT, 'legacy import items are append-only');
END;

CREATE TRIGGER legacy_import_items_append_only_delete
BEFORE DELETE ON legacy_import_items BEGIN
    SELECT RAISE(ABORT, 'legacy import items are append-only');
END;

CREATE TRIGGER legacy_import_sources_append_only_update
BEFORE UPDATE ON legacy_import_sources BEGIN
    SELECT RAISE(ABORT, 'legacy import sources are append-only');
END;

CREATE TRIGGER legacy_import_sources_append_only_delete
BEFORE DELETE ON legacy_import_sources BEGIN
    SELECT RAISE(ABORT, 'legacy import sources are append-only');
END;

CREATE TRIGGER profiles_current_version_complete_update
BEFORE UPDATE OF current_version_id ON profiles
WHEN NEW.current_version_id IS NOT NULL AND (
    SELECT count(*) FROM profile_agent_configurations
    WHERE profile_version_id = NEW.current_version_id
) <> 3
BEGIN
    SELECT RAISE(ABORT, 'profile version must configure exactly three agents');
END;

CREATE TRIGGER resume_child_lineage_insert
BEFORE INSERT ON resume_runs
WHEN NOT (
    (NEW.parent_resume_run_id IS NULL AND NEW.feedback_review_event_id IS NULL)
    OR
    (NEW.parent_resume_run_id IS NOT NULL AND NEW.feedback_review_event_id IS NOT NULL)
)
BEGIN
    SELECT RAISE(ABORT, 'child resume runs require a feedback review event');
END;

CREATE TRIGGER tracked_application_pdf_matches_approval_insert
BEFORE INSERT ON tracked_applications
WHEN NEW.legacy = 0 AND NOT EXISTS (
    SELECT 1 FROM resume_review_events r
    WHERE r.id = NEW.approved_resume_review_event_id
      AND r.resume_run_id = NEW.resume_run_id
      AND r.decision = 'approved'
      AND r.pdf_artifact_id = NEW.pdf_artifact_id
      AND r.pdf_checksum = NEW.pdf_checksum
)
BEGIN
    SELECT RAISE(ABORT, 'application requires the explicitly approved RoleLoop PDF');
END;

CREATE TRIGGER tracked_application_provenance_immutable_update
BEFORE UPDATE ON tracked_applications
WHEN NEW.id IS NOT OLD.id
    OR NEW.command_id IS NOT OLD.command_id
    OR NEW.job_id IS NOT OLD.job_id
    OR NEW.job_case_id IS NOT OLD.job_case_id
    OR NEW.approved_resume_review_event_id IS NOT OLD.approved_resume_review_event_id
    OR NEW.resume_run_id IS NOT OLD.resume_run_id
    OR NEW.pdf_artifact_id IS NOT OLD.pdf_artifact_id
    OR NEW.pdf_checksum IS NOT OLD.pdf_checksum
    OR NEW.job_version_id IS NOT OLD.job_version_id
    OR NEW.profile_version_id IS NOT OLD.profile_version_id
    OR NEW.evidence_version_id IS NOT OLD.evidence_version_id
    OR NEW.review_version_id IS NOT OLD.review_version_id
    OR NEW.gate_decision_event_id IS NOT OLD.gate_decision_event_id
    OR NEW.submitted_at IS NOT OLD.submitted_at
    OR NEW.legacy IS NOT OLD.legacy
    OR NEW.created_at IS NOT OLD.created_at
BEGIN
    SELECT RAISE(ABORT, 'tracked application provenance is immutable');
END;

CREATE TRIGGER tracked_application_pdf_matches_approval_update
BEFORE UPDATE ON tracked_applications
WHEN NEW.legacy = 0 AND NOT EXISTS (
    SELECT 1 FROM resume_review_events r
    WHERE r.id = NEW.approved_resume_review_event_id
      AND r.resume_run_id = NEW.resume_run_id
      AND r.decision = 'approved'
      AND r.pdf_artifact_id = NEW.pdf_artifact_id
      AND r.pdf_checksum = NEW.pdf_checksum
)
BEGIN
    SELECT RAISE(ABORT, 'application requires the explicitly approved RoleLoop PDF');
END;

CREATE TRIGGER tracked_application_revision_monotonic_update
BEFORE UPDATE ON tracked_applications
WHEN NEW.revision <> OLD.revision + 1
BEGIN
    SELECT RAISE(ABORT, 'tracked application revision must increase by one');
END;
