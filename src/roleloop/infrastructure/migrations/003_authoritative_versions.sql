CREATE TABLE artifacts (
    id TEXT PRIMARY KEY,
    checksum TEXT NOT NULL,
    uri TEXT NOT NULL,
    media_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
    created_at TEXT,
    legacy INTEGER NOT NULL CHECK (legacy IN (0, 1)),
    CHECK (legacy = 1 OR length(checksum) = 64)
);

ALTER TABLE resume_sources ADD COLUMN trust_acknowledged_at TEXT;

INSERT OR IGNORE INTO artifacts (
    id, checksum, uri, media_type, size_bytes, created_at, legacy
)
SELECT artifact_id, artifact_checksum, artifact_uri, artifact_media_type,
       artifact_size_bytes, created_at, 1
FROM evidence_versions;

INSERT OR IGNORE INTO artifacts (
    id, checksum, uri, media_type, size_bytes, created_at, legacy
)
SELECT artifact_id, artifact_checksum, artifact_uri, artifact_media_type,
       artifact_size_bytes, created_at, 1
FROM resume_runs
WHERE artifact_id IS NOT NULL;

CREATE TABLE search_profile_versions (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL REFERENCES profiles(id),
    version_number INTEGER NOT NULL CHECK (version_number > 0),
    name TEXT NOT NULL,
    target_roles_json TEXT NOT NULL,
    locations_json TEXT NOT NULL,
    remote_preference TEXT NOT NULL
        CHECK (remote_preference IN ('any', 'remote', 'hybrid', 'onsite')),
    employment_types_json TEXT NOT NULL,
    seniority_json TEXT NOT NULL,
    annual_salary_floor INTEGER CHECK (annual_salary_floor IS NULL OR annual_salary_floor >= 0),
    salary_currency TEXT NOT NULL,
    include_keywords_json TEXT NOT NULL,
    exclude_keywords_json TEXT NOT NULL,
    constraints_text TEXT NOT NULL,
    agent_provider TEXT NOT NULL CHECK (agent_provider IN ('openai', 'demo')),
    residence_country TEXT NOT NULL,
    timezone TEXT NOT NULL,
    target_hq_countries_json TEXT NOT NULL,
    startup_required INTEGER NOT NULL CHECK (startup_required IN (0, 1)),
    accepted_remote_arrangements_json TEXT NOT NULL,
    accepted_hiring_arrangements_json TEXT NOT NULL,
    search_queries_json TEXT NOT NULL,
    paper_size TEXT NOT NULL CHECK (paper_size IN ('a4paper', 'letterpaper')),
    page_limit INTEGER NOT NULL CHECK (page_limit BETWEEN 1 AND 5),
    legacy_input_status TEXT NOT NULL CHECK (legacy_input_status IN ('native', 'legacy_unverified')),
    created_at TEXT,
    UNIQUE (profile_id, version_number)
);

CREATE TABLE hard_blocker_rules (
    id TEXT PRIMARY KEY,
    profile_version_id TEXT NOT NULL REFERENCES search_profile_versions(id),
    rule_key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN (
        'closed', 'hq_country', 'startup', 'work_authorization', 'remote_hiring',
        'remote_arrangement', 'salary_maximum'
    )),
    operator TEXT NOT NULL CHECK (operator IN ('equals', 'contains', 'at_least', 'required')),
    text_value TEXT,
    integer_value INTEGER,
    boolean_value INTEGER CHECK (boolean_value IS NULL OR boolean_value IN (0, 1)),
    position INTEGER NOT NULL CHECK (position >= 0),
    UNIQUE (profile_version_id, rule_key),
    UNIQUE (profile_version_id, position),
    CHECK (
        (text_value IS NOT NULL) + (integer_value IS NOT NULL) + (boolean_value IS NOT NULL) = 1
    )
);

CREATE TABLE profile_agent_configurations (
    profile_version_id TEXT NOT NULL REFERENCES search_profile_versions(id),
    agent_kind TEXT NOT NULL CHECK (agent_kind IN ('scout', 'reviewer', 'resume')),
    provider TEXT NOT NULL CHECK (provider IN ('openai', 'demo')),
    model TEXT NOT NULL,
    reasoning_effort TEXT NOT NULL,
    PRIMARY KEY (profile_version_id, agent_kind)
);

ALTER TABLE profiles ADD COLUMN current_version_id TEXT;

INSERT INTO search_profile_versions (
    id, profile_id, version_number, name, target_roles_json, locations_json,
    remote_preference, employment_types_json, seniority_json, annual_salary_floor,
    salary_currency, include_keywords_json, exclude_keywords_json, constraints_text,
    agent_provider, residence_country, timezone, target_hq_countries_json,
    startup_required, accepted_remote_arrangements_json,
    accepted_hiring_arrangements_json, search_queries_json, paper_size, page_limit,
    legacy_input_status, created_at
)
SELECT
    'legacy-profile-version:' || id,
    id,
    1,
    name,
    COALESCE((SELECT json_group_array(value) FROM (
        SELECT value FROM profile_target_roles r WHERE r.profile_id = profiles.id ORDER BY position
    )), '[]'),
    COALESCE((SELECT json_group_array(value) FROM (
        SELECT value FROM profile_locations r WHERE r.profile_id = profiles.id ORDER BY position
    )), '[]'),
    remote_preference,
    COALESCE((SELECT json_group_array(value) FROM (
        SELECT value FROM profile_employment_types r WHERE r.profile_id = profiles.id ORDER BY position
    )), '[]'),
    COALESCE((SELECT json_group_array(value) FROM (
        SELECT value FROM profile_seniority r WHERE r.profile_id = profiles.id ORDER BY position
    )), '[]'),
    annual_salary_floor,
    salary_currency,
    COALESCE((SELECT json_group_array(value) FROM (
        SELECT value FROM profile_include_keywords r WHERE r.profile_id = profiles.id ORDER BY position
    )), '[]'),
    COALESCE((SELECT json_group_array(value) FROM (
        SELECT value FROM profile_exclude_keywords r WHERE r.profile_id = profiles.id ORDER BY position
    )), '[]'),
    constraints_text,
    'demo',
    'Ecuador',
    'America/Guayaquil',
    '[]',
    0,
    '[]',
    '[]',
    '[]',
    'a4paper',
    2,
    'legacy_unverified',
    created_at
FROM profiles;

INSERT INTO profile_agent_configurations (
    profile_version_id, agent_kind, provider, model, reasoning_effort
)
SELECT 'legacy-profile-version:' || id, 'scout', 'demo', 'gpt-5.6-terra', 'medium'
FROM profiles;

INSERT INTO profile_agent_configurations (
    profile_version_id, agent_kind, provider, model, reasoning_effort
)
SELECT 'legacy-profile-version:' || id, 'reviewer', 'demo', 'gpt-5.6-terra', 'medium'
FROM profiles;

INSERT INTO profile_agent_configurations (
    profile_version_id, agent_kind, provider, model, reasoning_effort
)
SELECT 'legacy-profile-version:' || id, 'resume', 'demo', 'gpt-5.6-terra', 'medium'
FROM profiles;

UPDATE profiles SET current_version_id = 'legacy-profile-version:' || id;

CREATE TABLE job_versions (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(id),
    version_number INTEGER NOT NULL CHECK (version_number > 0),
    content_fingerprint TEXT NOT NULL CHECK (length(content_fingerprint) = 64),
    canonical_url TEXT NOT NULL,
    title TEXT NOT NULL,
    company TEXT NOT NULL,
    location TEXT NOT NULL,
    description TEXT NOT NULL,
    source TEXT NOT NULL,
    employment_type TEXT NOT NULL,
    seniority TEXT NOT NULL,
    salary_min INTEGER,
    salary_max INTEGER,
    salary_currency TEXT,
    external_requisition_id TEXT,
    listing_closed INTEGER CHECK (listing_closed IS NULL OR listing_closed IN (0, 1)),
    hq_country TEXT,
    startup INTEGER CHECK (startup IS NULL OR startup IN (0, 1)),
    work_authorization_required INTEGER CHECK (
        work_authorization_required IS NULL OR work_authorization_required IN (0, 1)
    ),
    us_only INTEGER CHECK (us_only IS NULL OR us_only IN (0, 1)),
    remote_from_ecuador INTEGER CHECK (
        remote_from_ecuador IS NULL OR remote_from_ecuador IN (0, 1)
    ),
    remote_arrangement TEXT,
    hiring_arrangement TEXT,
    legacy_input_status TEXT NOT NULL CHECK (legacy_input_status IN ('native', 'legacy_unverified')),
    observed_at TEXT,
    UNIQUE (job_id, version_number),
    UNIQUE (job_id, content_fingerprint),
    CHECK (salary_min IS NULL OR salary_min >= 0),
    CHECK (salary_max IS NULL OR salary_max >= 0),
    CHECK (salary_min IS NULL OR salary_max IS NULL OR salary_min <= salary_max)
);

ALTER TABLE jobs ADD COLUMN current_version_id TEXT;

INSERT INTO job_versions (
    id, job_id, version_number, content_fingerprint, canonical_url, title, company,
    location, description, source, employment_type, seniority, salary_min,
    salary_max, salary_currency, external_requisition_id, listing_closed,
    hq_country, startup, work_authorization_required, us_only, remote_from_ecuador,
    remote_arrangement, hiring_arrangement, legacy_input_status, observed_at
)
SELECT
    'legacy-job-version:' || id,
    id,
    1,
    printf('%064x', jobs.rowid),
    canonical_url, title, company, location, description, source, '', '',
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    'legacy_unverified', updated_at
FROM jobs;

UPDATE jobs SET current_version_id = 'legacy-job-version:' || id;

CREATE TABLE web_source_snapshots (
    id TEXT PRIMARY KEY,
    canonical_url TEXT NOT NULL,
    source_kind TEXT NOT NULL CHECK (source_kind IN (
        'company', 'ats', 'aggregator', 'search', 'other'
    )),
    title TEXT NOT NULL,
    publisher TEXT NOT NULL,
    retrieved_at TEXT NOT NULL,
    content_checksum TEXT NOT NULL CHECK (length(content_checksum) = 64),
    quoted_evidence TEXT NOT NULL,
    content_artifact_id TEXT REFERENCES artifacts(id),
    UNIQUE (canonical_url, content_checksum)
);

CREATE TABLE job_version_sources (
    job_version_id TEXT NOT NULL REFERENCES job_versions(id),
    source_snapshot_id TEXT NOT NULL REFERENCES web_source_snapshots(id),
    position INTEGER NOT NULL CHECK (position >= 0),
    PRIMARY KEY (job_version_id, source_snapshot_id),
    UNIQUE (job_version_id, position)
);

CREATE TABLE job_identity_keys (
    key TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(id),
    key_kind TEXT NOT NULL CHECK (key_kind IN ('canonical_url', 'requisition', 'heuristic')),
    created_at TEXT
);

INSERT OR IGNORE INTO job_identity_keys (key, job_id, key_kind, created_at)
SELECT 'url:' || canonical_url, id, 'canonical_url', created_at FROM jobs;

CREATE INDEX search_profile_versions_profile_version
ON search_profile_versions (profile_id, version_number DESC);

CREATE INDEX job_versions_job_version
ON job_versions (job_id, version_number DESC);

CREATE INDEX web_source_snapshots_url_retrieved
ON web_source_snapshots (canonical_url, retrieved_at DESC);

CREATE TRIGGER search_profile_versions_immutable_update
BEFORE UPDATE ON search_profile_versions BEGIN
    SELECT RAISE(ABORT, 'search profile versions are immutable');
END;

CREATE TRIGGER search_profile_versions_immutable_delete
BEFORE DELETE ON search_profile_versions BEGIN
    SELECT RAISE(ABORT, 'search profile versions are immutable');
END;

CREATE TRIGGER hard_blocker_rules_immutable_update
BEFORE UPDATE ON hard_blocker_rules BEGIN
    SELECT RAISE(ABORT, 'hard blocker rules are immutable');
END;

CREATE TRIGGER hard_blocker_rules_immutable_delete
BEFORE DELETE ON hard_blocker_rules BEGIN
    SELECT RAISE(ABORT, 'hard blocker rules are immutable');
END;

CREATE TRIGGER profile_agent_configurations_immutable_update
BEFORE UPDATE ON profile_agent_configurations BEGIN
    SELECT RAISE(ABORT, 'profile agent configurations are immutable');
END;

CREATE TRIGGER profile_agent_configurations_immutable_delete
BEFORE DELETE ON profile_agent_configurations BEGIN
    SELECT RAISE(ABORT, 'profile agent configurations are immutable');
END;

CREATE TRIGGER job_versions_immutable_update
BEFORE UPDATE ON job_versions BEGIN
    SELECT RAISE(ABORT, 'job versions are immutable');
END;

CREATE TRIGGER job_versions_immutable_delete
BEFORE DELETE ON job_versions BEGIN
    SELECT RAISE(ABORT, 'job versions are immutable');
END;

CREATE TRIGGER web_source_snapshots_immutable_update
BEFORE UPDATE ON web_source_snapshots BEGIN
    SELECT RAISE(ABORT, 'web source snapshots are immutable');
END;

CREATE TRIGGER web_source_snapshots_immutable_delete
BEFORE DELETE ON web_source_snapshots BEGIN
    SELECT RAISE(ABORT, 'web source snapshots are immutable');
END;
