import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { careerFacts, type Opportunity, type Profile } from "../shared/types";
import type { JobRecommendation } from "../shared/job-recommendations";
import "./JobFitDetails.css";

const matchLabels = {
  matched: "Supported",
  partial: "Partial",
  missing: "Not shown",
  pending: "Not assessed",
};

export function JobFitDetails({
  opportunity,
  profile,
  fit,
}: {
  opportunity: Opportunity;
  profile: Profile;
  fit?: JobRecommendation;
}) {
  const [showAll, setShowAll] = useState(false);
  const assessment = opportunity.assessment;
  const evidence =
    careerFacts(profile)?.evidence.filter((fact) => fact.verified) ?? [];
  const matches = new Map(
    assessment?.matches.map((match) => [match.requirementId, match]),
  );
  const required = opportunity.requirements.filter(
    (requirement) => requirement.essential,
  );
  const preferred = opportunity.requirements.filter(
    (requirement) => !requirement.essential,
  );
  const blockers = [...new Set(assessment?.blockers ?? [])];
  if (assessment?.recommendation === "excluded" && blockers.length === 0)
    blockers.push("This job does not meet your saved search criteria.");
  const questions = [...new Set(assessment?.unknowns ?? [])].filter(
    (question) => !blockers.includes(question),
  );

  function requirementMatch(requirement: Opportunity["requirements"][number]) {
    const method = assessment?.fitEvaluation?.method;
    const assessed =
      evidence.length > 0 &&
      (method === "semantic" ||
        (method === "skills" && requirement.skills.length > 0));
    // The local fallback creates missing entries even for requirements it
    // cannot assess. Those entries must not imply a demonstrated evidence gap.
    return assessed ? matches.get(requirement.id) : undefined;
  }
  const attention = required.filter(
    (requirement) => requirementMatch(requirement)?.status !== "matched",
  );
  const canFilter = attention.length > 0 && attention.length < required.length;
  const visible = canFilter && !showAll ? attention : required;

  function requirementRow(requirement: Opportunity["requirements"][number]) {
    const match = requirementMatch(requirement);
    const status = match?.status ?? "pending";
    const facts = evidence.filter((fact) =>
      match?.evidenceIds.includes(fact.id),
    );
    return (
      <details className="job-fit-requirement" key={requirement.id}>
        <summary>
          <span className="job-fit-requirement-text">{requirement.text}</span>
          <span className={`job-fit-status ${status}`}>
            {matchLabels[status]}
          </span>
          <ChevronDown size={14} aria-hidden="true" />
        </summary>
        <div className="job-fit-evidence">
          <p>
            {match?.explanation ||
              "Re-evaluate fit to compare this requirement with your resume."}
          </p>
          {facts.length > 0 && (
            <ul aria-label="Supporting resume evidence">
              {facts.map((fact) => (
                <li key={fact.id}>
                  {(fact.role || fact.company) && (
                    <strong>
                      {[fact.role, fact.company].filter(Boolean).join(" · ")}
                    </strong>
                  )}
                  <p>{fact.text}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </details>
    );
  }

  return (
    <section className="job-fit" aria-label="Job fit">
      {blockers.length > 0 && (
        <div className="job-fit-notice excluded">
          <h3>Outside your criteria</h3>
          <ul>
            {blockers.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}
      {questions.length > 0 && (
        <div className="job-fit-notice">
          <h3>To confirm</h3>
          <ul>
            {questions.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="job-fit-heading">
        <h3>Requirements</h3>
        <span className="job-fit-score">
          {fit?.score != null ? (
            <>
              <strong>{Math.round(fit.score)}%</strong> required match
            </>
          ) : (
            fit?.fitLabel || "Not evaluated"
          )}
        </span>
      </div>
      <p className="job-fit-caption">
        Based on your resume. Open a requirement for evidence.
      </p>
      {canFilter && (
        <div
          className="job-fit-filters"
          role="group"
          aria-label="Filter required qualifications"
        >
          <button
            type="button"
            aria-pressed={!showAll}
            onClick={() => setShowAll(false)}
          >
            To check <span>{attention.length}</span>
          </button>
          <button
            type="button"
            aria-pressed={showAll}
            onClick={() => setShowAll(true)}
          >
            All required <span>{required.length}</span>
          </button>
        </div>
      )}
      {required.length > 0 ? (
        <div className="job-fit-required">{visible.map(requirementRow)}</div>
      ) : (
        <p className="job-fit-empty">
          No required qualifications extracted. Edit the job details to add
          them.
        </p>
      )}
      {preferred.length > 0 && (
        <details className="job-fit-preferred">
          <summary>
            Preferred qualifications <span>{preferred.length}</span>
            <ChevronDown size={14} aria-hidden="true" />
          </summary>
          {preferred.map(requirementRow)}
        </details>
      )}
      {opportunity.requirements.length > 0 && (
        <p className="job-fit-caption job-fit-legend">
          “Not shown” means no supporting resume evidence.
        </p>
      )}
    </section>
  );
}
