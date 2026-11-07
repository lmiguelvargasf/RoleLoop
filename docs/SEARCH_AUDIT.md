# Job search audit — 7 November 2026

The search has a sound separation between source discovery, eligibility checks,
career evidence, ranking and application preparation. The audit found defects
that could hide relevant jobs, overstate incomplete matches, or report a failed
evaluation as successful. Those defects are corrected in this change. No user
job search, paid model evaluation, application submission or outreach was run.

## Findings and changes

| Area | Finding | Change |
| --- | --- | --- |
| Requirement extraction | Qualification prose could disappear beside bullets; mixed required/preferred clauses could make an entire requirement optional; unfamiliar headings were missed. | Preserve substantive qualification prose, recognize additional headings, and separate mixed qualification clauses. |
| Extraction limits | Long requirements and lists beyond the extraction limit were shortened without a warning. | Track incomplete extraction and keep the result partial/review; never present it as a complete percentage. |
| Score confidence | Skill-tag comparisons could look fully assessed, and partial ranking divided by only the assessed subset. | Only complete semantic comparisons show a percentage. All required qualifications count toward the minimum. |
| Ranking | Preferred qualifications changed an internal score but never affected job order. | Use preferred coverage to break required-fit ties, before freshness and industry preferences. |
| AI context | The model received a preliminary keyword-derived recommendation and qualification concerns before doing its own comparison. | Supply policy constraints separately; remove the preliminary career verdict to reduce anchoring. |
| Evidence | Resume traceability was described as verification; compound requirements and transferable work needed clearer boundaries. | Prompt v5 distinguishes traceability from verification, handles AND/OR alternatives and negation, and requires specific support and limitations. |
| AI output | Invalid or incomplete IDs were rejected only after generation; blank facts could pass the standalone validator. | Restrict generation to supplied IDs and exact requirement count; reject blank facts and keep canonical requirement order. |
| ATS data | Ashby secondary locations/countries, Lever additional locations and compensation prose were omitted. Missing currency could become USD. | Preserve those fields and keep unspecified currency unknown. |
| Source failures | Invalid ATS response shapes could become an apparently successful empty board. Failed feed refreshes could replay old cached jobs as healthy. | Reject invalid board envelopes and report failed cached refreshes as source failures. |
| Source breadth | Initial coverage had nine employer boards plus one remote feed. | Add the permitted We Work Remotely RSS feed with attribution, shared hourly caching, country checks and expiry handling. |
| Employer discovery | Only the first three target roles were searched; one role could exhaust the website research budget. | Rotate the three-role window across searches and interleave employer candidates by role. |
| Time | Saved assessments could outlive date-window boundaries or a publisher's expiry date. | Recheck date-sensitive policy locally; expired postings cannot qualify. |
| Concurrent edits | An evaluation or source refresh could overwrite an edit or archive made while it ran. | Apply derived updates only if the original saved version is still current. |
| Observability | A fallback after an AI failure could still leave a search labeled successful. | Count failed AI evaluations separately, show partial results, and record retry guidance in Activity. |

## Source portfolio

| Resource | Role and value | Limits and treatment |
| --- | --- | --- |
| Ashby, Greenhouse and Lever | Employer-controlled job descriptions and application links. Nine researched starting employers: GitLab, Mozilla, Automattic, Buffer, Zapier, Ashby, Linear, Kraken and Superside. | Each connector covers one employer, not every company using that ATS. Employer location does not prove candidate eligibility. |
| Himalayas | Finds additional employers using target roles and working country; observed company careers links lead to supported ATS boards. | Employer discovery only. Current job records still come from the employer ATS. At most three roles, two directory pages per role, twelve employer checks and five new boards per run; fifty connected sources maximum. |
| Jobicy | Cross-employer remote job feed. | Seven-day feed window, bounded pagination and shared hourly refresh. Missing salary/headquarters stay unknown. |
| We Work Remotely — added | Another cross-employer remote feed, including employers outside the three supported ATS platforms. | Public RSS with original links and attribution. Preserve published date, region/country/state and explicit expiry. Share hourly refreshes; do not equate feed absence with closure. |

Existing source choices remain intact. The migration adds WWR only to existing
workspaces with automatic employer discovery enabled, an active job source, and
capacity below fifty. An existing paused WWR connection remains paused. New
accounts receive both feeds with the nine employer boards.

Official references checked during the audit:

- [Ashby public job posting API](https://developers.ashbyhq.com/docs/public-job-posting-api): secondary locations, country metadata, compensation and workplace fields.
- [Lever postings API](https://github.com/lever/postings-api/blob/master/README.md): additional locations and salary description fields.
- [Greenhouse Job Board API](https://developers.greenhouse.io/job-board.html): employer board listing/content contract.
- [Jobicy API](https://github.com/Jobicy/remote-jobs-api): feed window, pagination and request guidance.
- [WWR RSS feeds](https://weworkremotely.com/remote-job-rss-feed): public reuse with attribution and original-source links.
- [Himalayas API](https://himalayas.app/api): discovery/search coverage and usage conditions.

## Prompt and workflow contract

1. Resume extraction selects original source lines and reconstructs quotations
   on the server. Listed skills and languages remain separate from demonstrated
   experience. An outdated or failed extraction supplies no career facts.
2. Connectors collect public postings. The parser separates required and
   preferred qualifications and exposes truncation. Local role checks avoid
   evaluating obviously unrelated jobs.
3. Local rules check country, workplace restrictions, salary, company country,
   date window and explicit expiry before requesting AI fit. Unresolved facts
   remain review items; confirmed policy conflicts cannot be overridden by AI.
4. AI compares the supplied evidence with each extracted requirement. AND
   requires every component; OR allows a complete stated alternative. Transfer
   requires concrete relevant work. Tenure, legal eligibility, credentials,
   scale and leadership cannot be invented from a title or tool name.
5. The server validates IDs, uniqueness, completeness and listed-claim limits,
   then calculates coverage and applies policy independently. The model does
   not supply a hiring probability or control the numeric threshold.
6. Ranking considers practical eligibility and required fit first, then
   preferred qualifications, freshness and industry preferences. Unknown
   geography is a visible question with a ranking penalty.
7. Search imports and evaluates jobs. It does not prepare job applications.
   Preparation remains an explicit action on the Applications board, followed
   by review. This app does not submit applications or send outreach.

Prompt versions invalidate the next eligible AI-fit cache. Local rule and parser
versions refresh saved assessments without automatically buying new inference.
Manual requirement corrections, archives and application history are preserved.

## Remaining limits and useful next work

- **Live ranking accuracy is not yet measured.** Offline tests prove the tested
  contracts and regressions; they do not prove that a model correctly interprets
  every posting. Structured Outputs guarantees structure, not semantic truth,
  as the [OpenAI documentation](https://developers.openai.com/api/docs/guides/structured-outputs)
  explains. After the user-run search, label a representative sample of top
  recommendations, near misses and excluded jobs. Measure useful jobs in the
  top ten, known-country violations, unsupported match claims, duplicate rate
  and relevant jobs missed. Compare prompt/model changes on the same sample.
- **Extraction is heuristic.** Unusual prose, non-English headings and implicit
  requirements can still be missed. Truncation is now explicit, but a complete
  parser result is not a guarantee that every employer expectation was captured.
- **Repeated postings across providers are not merged.** Stable provider IDs
  prevent repeat imports from the same source. Cross-provider merging should
  require a verified common application URL or employer job ID; company/title
  matching alone can collapse distinct roles.
- **Direct Himalayas job imports are a promising next expansion.** They would
  avoid losing employers whose ATS is unsupported. Validate the full display,
  attribution, application-link, expiry and deletion lifecycle before enabling
  this separately from the current employer-discovery use.
- **SmartRecruiters is a candidate next ATS connector.** Confirm the appropriate
  public endpoint/authentication scope and research actual eligible employers
  before adding it. See its [Posting API](https://developers.smartrecruiters.com/docs/posting-api).
- **Do not add sources merely for volume.** Remotive's API has additional display
  restrictions, a publication delay and request guidance; see its
  [official API terms](https://github.com/remotive-com/remote-jobs-api/blob/main/README.md).
  LinkedIn, Wellfound and YC are not automatic integrations in this change.
- A malformed individual ATS record can still fail its board import. Activity
  reports that failure. A future connector result type should support valid
  records plus per-record warnings without silently hiding rejected records.

## Verification

Verification uses sanitized fixtures and temporary local database records.
Network source documentation checks do not import jobs into the user's workspace.
The local WWR migration was applied without resetting data.

- Full suite with local database integration enabled: **807 tests passed across
  49 files**. No tests skipped.
- After the final cache-lifetime correction and its added regression: **60 tests
  passed across the five affected workflow/database test files**.
- TypeScript and the production build passed. Vite retains its bundle-size
  advisory; it is not a build failure.
- No live model calls were used for verification. Source documentation and
  public feed checks were read-only; the user will run Search jobs.
