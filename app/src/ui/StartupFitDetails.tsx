import { careerFacts, type Opportunity, type Profile } from "../shared/types";

export function StartupFitDetails({
  opportunity,
  profile,
}: {
  opportunity: Opportunity;
  profile: Profile;
}) {
  const assessment = opportunity.assessment;
  const evidence =
    careerFacts(profile)?.evidence.filter(
      (fact) =>
        fact.verified && assessment?.relevantEvidenceIds?.includes(fact.id),
    ) ?? [];
  const hasAllEvidence =
    !!assessment?.relevantEvidenceIds?.length &&
    assessment.relevantEvidenceIds.every((id) =>
      evidence.some((fact) => fact.id === id),
    );
  const supported =
    assessment?.startupFit?.method === "semantic" &&
    assessment.startupFit.status === "potential" &&
    hasAllEvidence;
  const staleContribution =
    assessment?.startupFit?.method === "semantic" &&
    assessment.startupFit.status === "potential" &&
    !hasAllEvidence;
  return (
    <section
      className="startup-contribution-details"
      aria-label="Potential contribution"
    >
      <h3>
        {supported ? "How you could contribute" : "Connection to explore"}
      </h3>
      <p>
        {staleContribution
          ? "Your supporting CV experience has changed. Research and evaluate this company again to update the contribution."
          : assessment?.fitSummary ||
            "Research this company to connect its product with specific experience from your CV."}
      </p>
      {assessment?.startupFit?.failureReason && (
        <p className="match-note">{assessment.startupFit.failureReason}</p>
      )}
      {evidence.length > 0 && (
        <details>
          <summary>Supporting CV experience · {evidence.length}</summary>
          <ul aria-label="Supporting CV experience">
            {evidence.map((fact) => (
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
        </details>
      )}
      <small>
        A possible contribution still needs a conversation with the team.
      </small>
    </section>
  );
}
