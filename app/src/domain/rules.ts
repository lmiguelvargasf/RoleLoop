import { createHash } from "node:crypto";
import { salaryReviewMinimum } from "../shared/salary.js";
import { careerFacts } from "../shared/types.js";
import { matchesTargetRole } from "../shared/discovery.js";
import {
  credentialCondition,
  JOB_RECOMMENDATION_RULES_VERSION,
  recommendationForJob,
} from "../shared/job-recommendations.js";
import { assessGeography, normalizeCountry } from "./geography.js";
import {
  industryPriorityBoost,
  preferredIndustryMatches,
} from "../shared/industries.js";
import type {
  Assessment,
  Draft,
  Opportunity,
  Preferences,
  Profile,
} from "../shared/types.js";

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, canonical(v)]),
        )
      : value;
const hash = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
export const profileFingerprint = (profile: Profile) => hash(profile);
// Bump when eligibility rules change so saved assessments are rechecked.
export const ASSESSMENT_RULES_VERSION = JOB_RECOMMENDATION_RULES_VERSION;
export const preferencesFingerprint = (prefs: Preferences) => {
  // Search expansion does not change a candidate's fit or invalidate drafts.
  const { discoverEmployers: _discovery, ...matchingPreferences } = prefs;
  return hash(matchingPreferences);
};
export const opportunityFingerprint = (op: Opportunity) =>
  hash({
    kind: op.kind,
    company: op.company,
    title: op.title,
    description: op.description,
    ...(op.descriptionTruncated ? { descriptionTruncated: true } : {}),
    ...(op.requirementsTruncated ? { requirementsTruncated: true } : {}),
    url: op.url,
    companyCountry: op.companyCountry,
    remoteScope: op.remoteScope,
    location: op.location,
    salaryMin: op.salaryMin,
    salaryMax: op.salaryMax,
    salaryCurrency: op.salaryCurrency,
    salaryPeriod: op.salaryPeriod,
    publishedAt: op.publishedAt,
    ...(op.sourceExpiresAt ? { sourceExpiresAt: op.sourceExpiresAt } : {}),
    requirements: op.requirements,
    signals: op.signals,
    contactName: op.contactName,
    contactEmail: op.contactEmail,
    contactSource: op.contactSource,
  });
export const draftContentHash = (
  draft: Pick<
    Draft,
    "subject" | "body" | "resume" | "coverLetter" | "answers" | "evidenceIds"
  >,
) =>
  hash({
    subject: draft.subject,
    body: draft.body,
    resume: draft.resume,
    coverLetter: draft.coverLetter,
    answers: draft.answers,
    evidenceIds: draft.evidenceIds,
  });
export function normalizeSkill(s: string): string {
  const value = s.trim().toLowerCase().replace(/\s+/g, " ");
  return (
    (
      {
        ts: "typescript",
        js: "javascript",
        "node.js": "nodejs",
        node: "nodejs",
        postgres: "postgresql",
        "react.js": "react",
        "amazon web services": "aws",
      } as Record<string, string>
    )[value] ?? value
  );
}
// A CV skill/language list is a declaration, not evidence of applying it.
export const isListedClaim = (evidence: { category?: string }) =>
  evidence.category === "skills" || evidence.category === "language";
export function listedClaimExplanation(
  evidence: { category?: string; skills: string[] }[],
  requestedSkills: string[],
): string | null {
  if (evidence.length && evidence.every(isListedClaim))
    return "Listed in the CV, but no supporting example of use was found.";
  const hasListedGap = requestedSkills.some((skill) => {
    const supporting = evidence.filter((entry) =>
      entry.skills.some(
        (value) => normalizeSkill(value) === normalizeSkill(skill),
      ),
    );
    return supporting.length > 0 && supporting.every(isListedClaim);
  });
  return hasListedGap
    ? "Some requested skills are only listed in the CV; supporting examples are missing."
    : null;
}
const unknown = (s: string) =>
  !s.trim() ||
  ["unknown", "unspecified", "not specified", "to confirm"].includes(
    s.trim().toLowerCase(),
  );
export function localDay(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}
export function dateWindow(
  prefs: Pick<Preferences, "lookback" | "lookbackUnit">,
  now = new Date(),
): { start: string; end: string } {
  const end = localDay(now);
  const [y, m, d] = end.split("-").map(Number);
  let start: Date;
  if (prefs.lookbackUnit === "days")
    start = new Date(Date.UTC(y, m - 1, d - prefs.lookback));
  else {
    const target = new Date(Date.UTC(y, m - 1 - prefs.lookback, 1));
    const last = new Date(
      Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
    ).getUTCDate();
    start = new Date(
      Date.UTC(
        target.getUTCFullYear(),
        target.getUTCMonth(),
        Math.min(d, last),
      ),
    );
  }
  return { start: start.toISOString().slice(0, 10), end };
}
export function orderOpportunities(
  opportunities: Opportunity[],
  prefs: Preferences,
  now = new Date(),
): Opportunity[] {
  const window = dateWindow(prefs, now);
  const freshness = (op: Opportunity) => {
    if (!op.publishedAt) return 0;
    const day = localDay(new Date(op.publishedAt));
    return day >= window.start && day <= window.end ? 1 : 0;
  };
  const rank = (op: Opportunity) =>
    op.assessment?.recommendation === "excluded"
      ? 3
      : op.assessment?.recommendation === "ready"
        ? 0
        : 1;
  return opportunities
    .map((op) => {
      const industry = industryPriorityBoost(op, prefs);
      return {
        op,
        rank: rank(op),
        industry,
        priorityScore: (op.assessment?.score || 0) + industry,
        freshness: freshness(op),
        job: op.kind === "job" ? recommendationForJob(op, prefs) : null,
      };
    })
    .sort((a, b) => {
      if (a.op.kind !== b.op.kind) return a.op.kind.localeCompare(b.op.kind);
      if (a.job && b.job)
        return (
          Number(b.job.recommendable) - Number(a.job.recommendable) ||
          b.job.rankScore - a.job.rankScore ||
          b.job.preferredScore - a.job.preferredScore ||
          b.freshness - a.freshness ||
          b.industry - a.industry ||
          (b.op.publishedAt || "").localeCompare(a.op.publishedAt || "") ||
          a.op.id.localeCompare(b.op.id)
        );
      return (
        a.rank - b.rank ||
        b.freshness - a.freshness ||
        b.priorityScore - a.priorityScore ||
        (b.op.assessment?.score || 0) - (a.op.assessment?.score || 0) ||
        (b.op.publishedAt || "").localeCompare(a.op.publishedAt || "")
      );
    })
    .map(({ op }) => op);
}

export function assessOpportunity(
  op: Opportunity,
  profile: Profile,
  prefs: Preferences,
  now = new Date(),
  semanticMatches?: Assessment["matches"],
): Assessment {
  const blockers: string[] = [],
    unknowns: string[] = [],
    reasons: string[] = [];
  const evidence =
    careerFacts(profile)?.evidence.filter((e) => e.verified) || [];
  const industryMatches = preferredIndustryMatches(op, prefs);
  if (industryMatches.length)
    reasons.push(
      `Preferred industry signal: ${industryMatches.join(", ")}. Raises list priority without changing evidence scores; this is a keyword signal, not verified company classification.`,
    );
  if (op.descriptionTruncated)
    unknowns.push(
      "The description was shortened. Review the complete source listing before applying.",
    );
  if (op.requirementsTruncated)
    unknowns.push(
      "Some qualifications were shortened or omitted during extraction. Review the complete job posting before trusting the match.",
    );
  const geography = assessGeography(op, prefs.country);
  blockers.push(...geography.blockers);
  unknowns.push(...geography.unknowns);
  if (prefs.companyCountry && unknown(op.companyCountry))
    unknowns.push("Company headquarters country is not verified.");
  else if (
    prefs.companyCountry &&
    normalizeCountry(op.companyCountry) !==
      normalizeCountry(prefs.companyCountry)
  )
    blockers.push(
      `Company country (${op.companyCountry}) does not match ${prefs.companyCountry}.`,
    );
  if (op.kind === "job") {
    if (op.sourceExpiresAt && new Date(op.sourceExpiresAt) <= now)
      blockers.push("The source's application deadline has passed.");
    if (op.salaryMin === null && op.salaryMax === null) {
      if (prefs.missingSalary === "exclude")
        blockers.push(
          "Salary is undisclosed and your policy excludes undisclosed salaries.",
        );
      else unknowns.push("Salary is undisclosed.");
    } else if (op.salaryCurrency.toUpperCase() !== "USD")
      unknowns.push(
        `Salary is in ${op.salaryCurrency}; no exchange rate has been assumed.`,
      );
    else if (op.salaryPeriod === "hour" || op.salaryPeriod === "unknown")
      unknowns.push(
        "Annual salary cannot be confirmed without contracted hours and pay-period details.",
      );
    else {
      const multiplier = op.salaryPeriod === "month" ? 12 : 1;
      const lower = op.salaryMin === null ? null : op.salaryMin * multiplier;
      const upper = op.salaryMax === null ? null : op.salaryMax * multiplier;
      const minimum = prefs.salaryFlexibility
        ? salaryReviewMinimum(prefs.minimumSalary)
        : prefs.minimumSalary;
      const comparedSalary = prefs.salaryPolicy === "strict" ? lower : upper;
      if (lower !== null && upper !== null && lower > upper)
        unknowns.push("The salary range is inconsistent.");
      else if (prefs.salaryPolicy === "strict" && lower === null)
        unknowns.push(
          "A salary minimum is needed for your strict salary policy.",
        );
      else if (comparedSalary !== null && comparedSalary < minimum)
        blockers.push(
          prefs.salaryPolicy === "strict"
            ? "The advertised salary minimum is below your required floor."
            : "The advertised salary maximum is below your required floor.",
        );
      else if (comparedSalary !== null && comparedSalary < prefs.minimumSalary)
        unknowns.push(
          "Below your minimum; consider benefits. Within your 10% salary flexibility; confirm the full compensation package before proceeding.",
        );
      else if (lower !== null && lower < prefs.minimumSalary)
        unknowns.push(
          "Salary overlaps your floor but would require negotiation.",
        );
      else if (lower === null && prefs.minimumSalary > 0)
        unknowns.push(
          "Only a salary maximum is published; your floor is not guaranteed.",
        );
      else
        reasons.push("The published salary is compatible with your minimum.");
    }
    if (!matchesTargetRole(op.title, prefs.roles, op.company))
      unknowns.push(
        "The title differs from your target roles; review relevance.",
      );
  } else {
    if (op.salaryMin === null)
      unknowns.push(
        "Compensation is to confirm; this remains an exploratory startup lead.",
      );
    if (!op.contactEmail || !op.contactSource)
      unknowns.push(
        "A professional contact address and its public source are needed before outreach.",
      );
  }
  const window = dateWindow(prefs, now);
  const published = op.publishedAt ? new Date(op.publishedAt) : null;
  if (!published || Number.isNaN(published.getTime()))
    unknowns.push(
      op.kind === "job"
        ? "Original posting date is unknown; first discovery is not treated as publication."
        : "The signal date is unknown.",
    );
  else if (published > now)
    unknowns.push("Publication timestamp is in the future.");
  else {
    const day = localDay(published);
    if (day < window.start) {
      if (prefs.dateMode === "strict")
        blockers.push(
          `The ${op.kind === "job" ? "posting" : "signal"} is older than your selected window (${window.start}–${window.end}).`,
        );
      else
        reasons.push(
          "Older than the preferred window; retained with lower freshness priority.",
        );
    } else reasons.push("Within your date window, including today.");
  }
  const policyUnknowns = [...unknowns];
  const matches: Assessment["matches"] = op.requirements.map((req) => {
    const ids = new Set<string>();
    let matched = 0;
    let mentioned = 0;
    for (const skill of req.skills) {
      const found = evidence.filter((e) =>
        e.skills.some((s) => normalizeSkill(s) === normalizeSkill(skill)),
      );
      if (found.length) {
        mentioned++;
        if (found.some((entry) => !isListedClaim(entry))) matched++;
        found.forEach((e) => ids.add(e.id));
      }
    }
    let status: "matched" | "partial" | "missing" =
      req.skills.length && matched === req.skills.length
        ? "matched"
        : mentioned
          ? "partial"
          : "missing";
    const semantic = semanticMatches?.find((m) => m.requirementId === req.id);
    if (semantic) {
      status = semantic.status;
      ids.clear();
      semantic.evidenceIds
        .filter((id) => evidence.some((entry) => entry.id === id))
        .forEach((id) => ids.add(id));
      if (!ids.size && status !== "missing") status = "missing";
    }
    const listedExplanation = listedClaimExplanation(
      evidence.filter((entry) => ids.has(entry.id)),
      req.skills,
    );
    if (listedExplanation && status === "matched") status = "partial";
    const credential = credentialCondition(req.text);
    const quantified =
      !!credential || /\d+\+?\s*(?:years?|yrs?)/i.test(req.text);
    const credentialEvidence = {
      degree:
        /\b(bachelor|master|doctor|phd|ph\.d|bsc|msc|degree|b\.?s\.?|m\.?s\.?)\b/i,
      license: /\b(licen[sc]ed|licen[sc]e|professional engineer)\b/i,
      clearance: /\b(clearance|secret|classified)\b/i,
      citizenship: /\b(citizen|citizenship|nationality)\b/i,
      authorization:
        /\b(work authori[sz]ation|authori[sz]ed to work|work permit|permanent resident)\b/i,
      certification: /\b(certified|certification|certificate)\b/i,
    };
    // A semantic evaluator can establish a stated credential only when its
    // cited verified CV evidence contains that credential (or an expressly
    // allowed experience alternative). Common skill tags cannot do this.
    const confirmedCredential =
      credential &&
      semantic?.status === "matched" &&
      evidence.some(
        (entry) =>
          ids.has(entry.id) &&
          !isListedClaim(entry) &&
          (credentialEvidence[credential.kind].test(entry.text) ||
            (credential.acceptsExperience &&
              (!entry.category ||
                entry.category === "experience" ||
                entry.category === "project"))),
      );
    const conditionUnconfirmed =
      quantified &&
      (!confirmedCredential || /\d+\+?\s*(?:years?|yrs?)/i.test(req.text));
    if (conditionUnconfirmed) {
      if (status === "matched") status = "partial";
      if (req.essential || req.hard)
        unknowns.push(
          `Confirm this stated condition independently: ${req.text}`,
        );
    }
    if (req.hard && status !== "matched")
      unknowns.push(`Mandatory requirement not confirmed: ${req.text}`);
    return {
      requirementId: req.id,
      requirement: req.text,
      essential: req.essential,
      evidenceIds: [...ids],
      status,
      explanation: conditionUnconfirmed
        ? "Capability evidence is shown separately; tenure, credentials, or legal eligibility remain unconfirmed."
        : listedExplanation && status !== "missing"
          ? listedExplanation
          : semantic
            ? semantic.explanation
            : !req.skills.length
              ? "No structured skill evidence is available; review this requirement."
              : status === "matched"
                ? "Supported by verified candidate evidence."
                : status === "partial"
                  ? "Only some requested skills have verified evidence."
                  : "No verified evidence supports this requirement.",
    };
  });
  const coverage = (items: typeof matches) =>
    items.length
      ? Math.round(
          (items.reduce(
            (s, m) =>
              s +
              (m.status === "matched" ? 1 : m.status === "partial" ? 0.5 : 0),
            0,
          ) /
            items.length) *
            100,
        )
      : 0;
  const essentials = matches.filter((m) => m.essential),
    preferred = matches.filter((m) => !m.essential);
  const essentialScore = coverage(essentials);
  const required = op.requirements.filter((req) => req.essential);
  const hasSemantic =
    !!semanticMatches?.length &&
    op.requirements.every((req) =>
      semanticMatches.some((match) => match.requirementId === req.id),
    );
  const assessedRequired = evidence.length
    ? required.filter(
        (req) =>
          semanticMatches?.some((match) => match.requirementId === req.id) ||
          req.skills.length > 0,
      ).length
    : 0;
  const fitConcerns: string[] = [];
  if (op.kind === "job") {
    const appliedExperience = evidence
      .filter((entry) => !isListedClaim(entry))
      .map((entry) => `${entry.role} ${entry.text}`)
      .join("\n");
    const semanticSupports = (scope: RegExp) =>
      op.requirements.some(
        (requirement) =>
          scope.test(requirement.text) &&
          Boolean(semanticMatches?.length) &&
          matches.some(
            (match) =>
              match.requirementId === requirement.id &&
              match.status === "matched" &&
              match.evidenceIds.some((id) =>
                evidence.some(
                  (entry) => entry.id === id && !isListedClaim(entry),
                ),
              ),
          ),
      );
    // A broad engineering title and common tags cannot establish a specialist
    // career fit. These checks require actual CV experience, not a skills list.
    const specialties = [
      [
        /\b(embedded|firmware|kernel)\b/i,
        /\b(embedded|firmware|kernel|device drivers?|rtos|bare[ -]metal)\b/i,
        "embedded systems or kernel engineering",
      ],
      [
        /\b(machine learning|data scientist)\b/i,
        /\b(machine learning|model training|neural networks?|pytorch|tensorflow|data scientist)\b/i,
        "machine learning or data science",
      ],
      [
        /\b(android|ios)\b/i,
        /\b(android|ios|swift|kotlin|mobile applications?)\b/i,
        "native mobile development",
      ],
      [
        /\b(security engineer|security architect)\b/i,
        /\b(security engineer|security architect|application security|threat model|penetration test|cybersecurity)\b/i,
        "security engineering",
      ],
    ] as const;
    for (const [title, experience, label] of specialties)
      if (
        (title.test(op.title) ||
          required.some((requirement) => experience.test(requirement.text))) &&
        !experience.test(appliedExperience) &&
        !semanticSupports(experience)
      )
        fitConcerns.push(
          `Relevant experience in ${label} is not established in your CV.`,
        );
    const leadership =
      /\b(staff|principal|lead|led|architect|managed|mentored|drove|oversaw|coached|technical direction|engineering manager|director|cto)\b/i;
    if (
      /\b(staff|principal|engineering manager|director of engineering|vp of engineering|cto)\b/i.test(
        op.title,
      ) &&
      !leadership.test(appliedExperience) &&
      !semanticSupports(leadership)
    )
      fitConcerns.push(
        "The role's leadership scope is not established in your CV.",
      );
    if (
      /\b(junior|intern|internship|entry[ -]level|graduate)\b/i.test(
        op.title,
      ) &&
      prefs.roles.length > 0 &&
      prefs.roles.every((role) =>
        /\b(senior|lead|staff|principal|manager|director)\b/i.test(role),
      )
    )
      fitConcerns.push("The role is below your selected seniority level.");
    unknowns.push(...fitConcerns);
  }
  // A completed comparison can establish a poor match. Fit concerns affect
  // recommendation, not whether the requirements have been evaluated.
  const fitEvaluation: NonNullable<Assessment["fitEvaluation"]> = {
    method: assessedRequired ? (hasSemantic ? "semantic" : "skills") : "none",
    status: !assessedRequired
      ? "not_evaluated"
      : hasSemantic &&
          assessedRequired === required.length &&
          !op.descriptionTruncated &&
          !op.requirementsTruncated
        ? "complete"
        : "partial",
    assessedRequired,
    totalRequired: required.length,
    concerns: fitConcerns,
  };
  let score =
    essentials.length && preferred.length
      ? Math.round(essentialScore * 0.8 + coverage(preferred) * 0.2)
      : coverage(matches);
  if (op.kind === "job") {
    if (!matches.length)
      unknowns.push(
        "No structured requirements were found. Career fit has not been evaluated.",
      );
    if (!essentials.length)
      unknowns.push("Essential requirements have not been identified.");
    if (fitEvaluation.status === "partial")
      unknowns.push(
        fitEvaluation.method === "skills"
          ? "This comparison uses skill tags; experience-based fit still needs evaluation."
          : "The required experience has only been partially evaluated.",
      );
    if (
      fitEvaluation.status === "complete" &&
      essentialScore < prefs.essentialMatch
    )
      unknowns.push(
        `Verified experience covers ${essentialScore}% of required qualifications; your minimum is ${prefs.essentialMatch}%.`,
      );
  } else {
    const verifiedSkills = new Set(
      evidence
        .filter((e) => !isListedClaim(e))
        .flatMap((e) => e.skills.map(normalizeSkill)),
    );
    const mentioned = [...verifiedSkills].filter((skill) =>
      op.description.toLowerCase().includes(skill),
    );
    score = Math.min(100, mentioned.length * 20);
    reasons.push(
      `Exploratory relevance indicator: ${mentioned.length} evidenced skill${mentioned.length === 1 ? "" : "s"} mentioned. This is not a job requirements score.`,
    );
    if (!op.signals.length)
      unknowns.push("No dated company progress signals have been recorded.");
    if (!mentioned.length)
      unknowns.push(
        "Your specific contribution to this startup still needs supporting evidence.",
      );
  }
  if (!evidence.length)
    unknowns.push(
      "Upload a master CV and finish processing before preparing an application.",
    );
  return {
    ...(op.kind === "job"
      ? {
          geography: {
            status: geography.status,
            workingCountry: prefs.country,
            reasons: [...geography.blockers, ...geography.unknowns],
          },
          fitEvaluation,
        }
      : {}),
    rulesVersion: ASSESSMENT_RULES_VERSION,
    score,
    essentialScore,
    recommendation: blockers.length
      ? "excluded"
      : unknowns.length
        ? "review"
        : "ready",
    reasons: [...new Set(reasons)],
    blockers: [...new Set(blockers)],
    unknowns: [...new Set(unknowns)],
    policyUnknowns: [...new Set(policyUnknowns)],
    matches,
    evaluatedAt: now.toISOString(),
    profileFingerprint: profileFingerprint(profile),
    preferencesFingerprint: preferencesFingerprint(prefs),
    startupSignals: op.signals,
  };
}
