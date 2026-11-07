import type { Opportunity, Profile } from "../shared/types";
import {
  hasSupportedStartupContribution,
  startupHighlights,
  startupIndustries,
  startupSummary,
} from "../shared/startup-company";

export function StartupIndustryLabels({
  opportunity,
  showMissing = false,
}: {
  opportunity: Opportunity;
  showMissing?: boolean;
}) {
  const industries = startupIndustries(opportunity);
  if (!industries.labels.length && !showMissing) return null;
  return (
    <span className="startup-industry-labels">
      <span>{industries.listed ? "Industry" : "Industry signals"}</span>
      {industries.labels.length ? (
        industries.labels.map((label) => (
          <span className="startup-sector" key={label}>
            {label}
          </span>
        ))
      ) : (
        <span>Not identified yet</span>
      )}
    </span>
  );
}

export function StartupCompanyOverview({
  opportunity,
}: {
  opportunity: Opportunity;
}) {
  const summary = startupSummary(opportunity);
  const highlights = startupHighlights(opportunity);
  const industries = startupIndustries(opportunity);
  return (
    <section className="startup-company-overview" aria-label="Company overview">
      <StartupIndustryLabels opportunity={opportunity} showMissing />
      <h3>What they do</h3>
      <p className="startup-product-summary">
        {summary ||
          "The saved source does not describe the product yet. Research the company website to learn more."}
      </p>
      {industries.labels.length > 0 && (
        <p className="startup-source-caption">
          {industries.listed
            ? "Industry listed by Seedcamp."
            : "Industry signals inferred from product text."}
        </p>
      )}
      {highlights.length > 0 && (
        <div className="startup-highlights">
          <h3>What stands out</h3>
          <ul>
            {highlights.map((signal) => (
              <li key={signal}>{signal}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export function StartupContributionPreview({
  opportunity,
  profile,
}: {
  opportunity: Opportunity;
  profile: Profile;
}) {
  return hasSupportedStartupContribution(opportunity, profile) &&
    opportunity.assessment?.fitSummary ? (
    <span className="startup-row-contribution">
      <span>Possible contribution</span>
      {opportunity.assessment.fitSummary}
    </span>
  ) : null;
}

export function StartupSignalPreview({
  opportunity,
}: {
  opportunity: Opportunity;
}) {
  const signal = startupHighlights(opportunity)[0];
  return signal ? (
    <span className="startup-row-signal">
      <span>Signal</span> {signal}
    </span>
  ) : null;
}
