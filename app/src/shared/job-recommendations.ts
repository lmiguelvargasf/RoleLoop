import {
  assessGeography,
  normalizeCountry,
  type GeographyAssessment,
} from "../domain/geography.js";
import { matchesTargetRole } from "./discovery.js";
import type { Opportunity, Preferences } from "./types.js";

export const JOB_RECOMMENDATION_RULES_VERSION = 8;

export function credentialCondition(text: string): {
  kind:
    | "degree"
    | "license"
    | "clearance"
    | "citizenship"
    | "authorization"
    | "certification";
  acceptsExperience: boolean;
} | null {
  if (
    /\bdegree\b/i.test(text) &&
    !/\bdegree of (?:autonomy|freedom|complexity|responsibility)\b/i.test(text)
  )
    return {
      kind: "degree",
      acceptsExperience:
        /\b(?:equivalent|comparable)\b.{0,70}\bexperience\b/i.test(text),
    };
  const patterns = [
    ["clearance", /\b(?:security )?clearance\b/i],
    ["citizenship", /\bcitizen(?:ship)?\b/i],
    ["authorization", /\bwork authori[sz]ation\b|\bauthori[sz]ed to work\b/i],
    ["license", /\blicen[sc](?:e|ed)\b/i],
    ["certification", /\bcertification|\bcertified\b/i],
  ] as const;
  for (const [kind, pattern] of patterns) {
    if (!pattern.test(text)) continue;
    if (
      kind === "license" &&
      /\b(?:software|open[ -]source) licen[sc]|\blicen[sc]ed software\b/i.test(
        text,
      )
    )
      continue;
    return { kind, acceptsExperience: false };
  }
  return null;
}
const geographyCache = new WeakMap<
  Opportunity,
  {
    country: string;
    location: string;
    description: string;
    remoteScope: Opportunity["remoteScope"];
    title: string;
    value: GeographyAssessment;
  }
>();

function currentGeography(
  opportunity: Opportunity,
  preferences: Preferences,
): GeographyAssessment {
  const assessment = opportunity.assessment;
  const saved = assessment?.geography;
  // Bootstrap refreshes derived assessments before returning the collection.
  // Reusing that result avoids parsing every long listing again on each poll.
  if (
    saved &&
    assessment!.rulesVersion >= JOB_RECOMMENDATION_RULES_VERSION &&
    normalizeCountry(saved.workingCountry) ===
      normalizeCountry(preferences.country)
  )
    return {
      status: saved.status,
      blockers: saved.status === "excluded" ? saved.reasons : [],
      unknowns: saved.status === "review" ? saved.reasons : [],
    };
  const cached = geographyCache.get(opportunity);
  if (
    cached &&
    cached.country === preferences.country &&
    cached.location === opportunity.location &&
    cached.description === opportunity.description &&
    cached.remoteScope === opportunity.remoteScope &&
    cached.title === opportunity.title
  )
    return cached.value;
  const value = assessGeography(opportunity, preferences.country);
  geographyCache.set(opportunity, {
    country: preferences.country,
    location: opportunity.location,
    description: opportunity.description,
    remoteScope: opportunity.remoteScope,
    title: opportunity.title,
    value,
  });
  return value;
}

export type JobRecommendation = {
  recommendable: boolean;
  reason: string;
  question?: string;
  fitLabel: string;
  /** Assessed required-qualification coverage, never a hiring probability. */
  score: number | null;
  /** Internal practical-fit ordering; intentionally not shown as a percentage. */
  rankScore: number;
};

/** Shared by server ordering and the browser. Requires no Node-only imports. */
export function recommendationForJob(
  opportunity: Opportunity,
  preferences: Preferences,
): JobRecommendation {
  const assessment = opportunity.assessment;
  const quality = assessment?.fitEvaluation;
  const required = opportunity.requirements.filter(
    (requirement) => requirement.essential,
  );
  const complete = quality?.status === "complete" && required.length > 0;
  const score = complete ? assessment!.essentialScore : null;
  const fitLabel = complete
    ? "Required match"
    : quality?.status === "partial"
      ? "Partial assessment"
      : "Not evaluated";
  const result: JobRecommendation = {
    recommendable: false,
    reason:
      "Your experience has not been evaluated against the required qualifications.",
    fitLabel,
    score,
    rankScore: -100,
  };
  if (opportunity.kind !== "job") return result;

  const geography = currentGeography(opportunity, preferences);
  if (
    geography.status === "excluded" ||
    assessment?.recommendation === "excluded" ||
    assessment?.blockers.length
  ) {
    return {
      ...result,
      reason:
        geography.blockers[0] ||
        assessment?.blockers[0] ||
        "Outside your current preferences.",
      rankScore: -200,
    };
  }
  if (
    !matchesTargetRole(
      opportunity.title,
      preferences.roles,
      opportunity.company,
    )
  )
    return {
      ...result,
      reason: "The role is outside your selected career targets.",
      rankScore: -150,
    };
  if (quality?.concerns?.length)
    return { ...result, reason: quality.concerns[0], rankScore: -50 };
  if (!assessment || !quality || !quality.assessedRequired || !required.length)
    return result;

  const assessed = required.filter(
    (requirement) =>
      quality.method === "semantic" || requirement.skills.length > 0,
  );
  const matches = assessed.map((requirement) =>
    assessment.matches.find((match) => match.requirementId === requirement.id),
  );
  const supported = matches.filter(
    (match) =>
      match && match.status !== "missing" && match.evidenceIds.length > 0,
  );
  const coverage = assessed.length
    ? (matches.reduce(
        (total, match) =>
          total +
          (match?.evidenceIds.length
            ? match.status === "matched"
              ? 1
              : match.status === "partial"
                ? 0.5
                : 0
            : 0),
        0,
      ) /
        assessed.length) *
      100
    : 0;
  const completeness = Math.min(1, quality.assessedRequired / required.length);
  // Partial parsing may identify a promising role, but cannot imply a complete
  // evaluation or outrank an equally strong, thoroughly assessed role.
  const fit = complete ? score! : Math.min(75, coverage * completeness);
  const mandatoryGap = required.some((requirement) => {
    const match = assessment.matches.find(
      (entry) => entry.requirementId === requirement.id,
    );
    // Tenure can be a reasonable confirmation question. Required credentials
    // and legal conditions cannot be substituted with unrelated common skills.
    const credential = credentialCondition(requirement.text);
    return (
      (requirement.hard && match?.status === "missing") ||
      (credential &&
        !credential.acceptsExperience &&
        match?.status !== "matched")
    );
  });
  const condition = assessment.unknowns.find((unknown) =>
    /^(Confirm this stated condition independently:|Mandatory requirement not confirmed:)/.test(
      unknown,
    ),
  );
  const salaryQuestion = assessment.unknowns.find((unknown) =>
    /salary|compensation|pay-period/i.test(unknown),
  );
  const countryQuestion =
    geography.status === "review"
      ? `Confirm hiring from ${preferences.country || "your working country"}.`
      : undefined;
  const missingEssential = complete
    ? required.find((requirement) =>
        assessment.matches.some(
          (match) =>
            match.requirementId === requirement.id &&
            match.status === "missing",
        ),
      )
    : undefined;
  const experienceQuestion = missingEssential
    ? `Required experience not evidenced: ${missingEssential.text.replace(/[.!]$/, "")}.`
    : undefined;
  const question =
    countryQuestion ||
    condition ||
    (!complete ? "Review the remaining required experience." : undefined) ||
    experienceQuestion ||
    salaryQuestion ||
    assessment.unknowns.find((unknown) => /headquarters/i.test(unknown));
  const recommendable =
    opportunity.stage !== "archived" &&
    !mandatoryGap &&
    supported.length > 0 &&
    (complete
      ? score! >= preferences.essentialMatch
      : coverage >= preferences.essentialMatch && completeness >= 0.5);
  const firstSupport =
    supported.find(
      (match) =>
        match?.status === "matched" &&
        required.some(
          (requirement) =>
            requirement.id === match.requirementId &&
            requirement.skills.length > 0,
        ),
    ) ||
    supported.find((match) => match?.status === "matched") ||
    supported[0];
  const firstSentence = (text: string) => text.split(/(?<=[.!?])\s+/)[0];
  const summary =
    quality.method === "semantic" && assessment.fitSummary
      ? firstSentence(assessment.fitSummary)
      : undefined;
  const requirement =
    firstSupport &&
    firstSentence(firstSupport.requirement).replace(/[.!]$/, "");
  return {
    recommendable,
    reason:
      summary && summary.length <= 350
        ? summary
        : requirement
          ? `${firstSupport?.status === "matched" ? "Your experience supports" : "Your experience partly supports"}: ${requirement}.`
          : "The required experience is not supported by your CV.",
    question,
    fitLabel,
    score,
    rankScore:
      fit -
      (countryQuestion ? 12 : 0) -
      (condition ? 6 : 0) -
      (salaryQuestion ? 2 : 0) -
      (mandatoryGap ? 20 : 0),
  };
}
