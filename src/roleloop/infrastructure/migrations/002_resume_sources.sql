CREATE TABLE resume_sources (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL UNIQUE REFERENCES profiles(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('local_git', 'remote_git')),
    repository TEXT NOT NULL CHECK (repository <> ''),
    ref TEXT NOT NULL CHECK (ref <> ''),
    document_path TEXT NOT NULL CHECK (document_path <> ''),
    last_synced_revision TEXT,
    last_synced_checksum TEXT CHECK (
        last_synced_checksum IS NULL OR length(last_synced_checksum) = 64
    ),
    last_synced_evidence_version_id TEXT REFERENCES evidence_versions(id),
    last_synced_at TEXT,
    revision INTEGER NOT NULL CHECK (revision > 0),
    created_at TEXT,
    updated_at TEXT,
    CHECK (
        (last_synced_revision IS NULL AND last_synced_checksum IS NULL
            AND last_synced_evidence_version_id IS NULL AND last_synced_at IS NULL)
        OR
        (last_synced_revision IS NOT NULL AND last_synced_checksum IS NOT NULL
            AND last_synced_evidence_version_id IS NOT NULL AND last_synced_at IS NOT NULL)
    )
);

ALTER TABLE evidence_versions
ADD COLUMN resume_source_id TEXT REFERENCES resume_sources(id);

ALTER TABLE evidence_versions
ADD COLUMN source_revision TEXT;

ALTER TABLE evidence_versions
ADD COLUMN resume_source_kind TEXT CHECK (
    resume_source_kind IS NULL OR resume_source_kind IN ('local_git', 'remote_git')
);

ALTER TABLE evidence_versions
ADD COLUMN source_repository TEXT;

ALTER TABLE evidence_versions
ADD COLUMN source_ref TEXT;

ALTER TABLE evidence_versions
ADD COLUMN source_document_path TEXT;

CREATE INDEX evidence_versions_resume_source_revision
ON evidence_versions (resume_source_id, source_revision);

CREATE TRIGGER evidence_versions_source_provenance_insert
BEFORE INSERT ON evidence_versions
WHEN NOT (
    (NEW.resume_source_id IS NULL AND NEW.source_revision IS NULL
        AND NEW.resume_source_kind IS NULL AND NEW.source_repository IS NULL
        AND NEW.source_ref IS NULL AND NEW.source_document_path IS NULL)
    OR
    (NEW.resume_source_id IS NOT NULL AND NEW.source_revision IS NOT NULL
        AND NEW.resume_source_kind IS NOT NULL AND NEW.source_repository IS NOT NULL
        AND NEW.source_ref IS NOT NULL AND NEW.source_document_path IS NOT NULL)
)
BEGIN
    SELECT RAISE(ABORT, 'evidence source provenance must be complete');
END;
