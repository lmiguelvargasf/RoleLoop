import { randomUUID } from "node:crypto";
import { careerFacts } from "../shared/types.js";
import type {
  Assessment,
  Draft,
  Opportunity,
  Preferences,
  Profile,
} from "../shared/types.js";
import {
  draftContentHash,
  isListedClaim,
  normalizeSkill,
  opportunityFingerprint,
  preferencesFingerprint,
  profileFingerprint,
} from "./rules.js";

export function createDraft(
  op: Opportunity,
  profile: Profile,
  prefs: Preferences,
  assessment: Assessment,
): Draft {
  const career = careerFacts(profile);
  if (!career)
    throw new Error(
      "Upload a master CV and finish processing before drafting.",
    );
  if (!career.name.trim())
    throw new Error(
      "Your name could not be read from the master CV. Update and replace the CV before drafting.",
    );
  const eligible = career.evidence.filter((e) => e.verified);
  if (!eligible.length)
    throw new Error(
      "No verified career facts are available. Update and replace your master CV before drafting.",
    );
  const requested = new Set(
    op.requirements.flatMap((r) => r.skills.map(normalizeSkill)),
  );
  const preferredIds = assessment.relevantEvidenceIds || [];
  const relevant = eligible.filter(
    (e) =>
      preferredIds.includes(e.id) ||
      e.skills.some(
        (s) =>
          requested.has(normalizeSkill(s)) ||
          op.description.toLowerCase().includes(s.toLowerCase()),
      ),
  );
  const selected = [...(relevant.length ? relevant : eligible)]
    .sort(
      (a, b) =>
        (preferredIds.includes(b.id) ? 1 : 0) -
          (preferredIds.includes(a.id) ? 1 : 0) ||
        b.skills.filter((s) => requested.has(normalizeSkill(s))).length -
          a.skills.filter((s) => requested.has(normalizeSkill(s))).length,
    )
    .slice(0, 8);
  const related = selected.filter(
    (e) =>
      preferredIds.includes(e.id) ||
      e.skills.some((s) => requested.has(normalizeSkill(s))) ||
      e.skills.some((s) =>
        op.description.toLowerCase().includes(s.toLowerCase()),
      ),
  );
  const supported = (related.length ? related : selected).filter(
    (entry) => !isListedClaim(entry),
  );
  const highlights = (supported.length ? supported : selected).slice(0, 3);
  const facts = highlights.map((e) => e.text);
  const skills = [
    ...new Set(
      selected
        .filter((entry) => !isListedClaim(entry))
        .flatMap((e) => e.skills),
    ),
  ];
  const hasExperience = highlights.some(
    (entry) =>
      !entry.category ||
      entry.category === "experience" ||
      entry.category === "project",
  );
  const backgroundLabel = hasExperience
    ? "Relevant experience"
    : supported.length
      ? "Relevant background"
      : "Listed in my CV";
  const labels: Record<string, string> = {
    experience: "EXPERIENCE",
    project: "PROJECTS",
    education: "EDUCATION",
    certification: "CERTIFICATIONS",
    skills: "LISTED SKILLS",
    language: "LANGUAGES",
    other: "ADDITIONAL BACKGROUND",
  };
  const sections = new Map<string, Map<string, typeof selected>>();
  for (const entry of selected) {
    const heading = labels[entry.category || ""] || "CAREER HIGHLIGHTS";
    const group = career.sections?.find((section) =>
      section.evidenceIds.includes(entry.id),
    );
    const identity =
      group?.id || JSON.stringify([entry.role, entry.company, entry.period]);
    const records = sections.get(heading) || new Map<string, typeof selected>();
    records.set(identity, [...(records.get(identity) || []), entry]);
    sections.set(heading, records);
  }
  const careerSections = [...sections].map(
    ([heading, records]) =>
      heading +
      "\n" +
      [...records.values()]
        .map((entries) =>
          [
            [entries[0].role, entries[0].company, entries[0].period]
              .filter(Boolean)
              .join(" · "),
            ...entries.map((entry) => "- " + entry.text),
          ]
            .filter(Boolean)
            .join("\n"),
        )
        .join("\n\n"),
  );
  const workingCountry = prefs.country.trim();
  const header = [
    career.name,
    op.kind === "job"
      ? `Application: ${op.title} at ${op.company}`
      : `Profile: ${op.title} at ${op.company}`,
    [workingCountry, profile.email, career.portfolio]
      .filter(Boolean)
      .join(" · "),
  ]
    .filter(Boolean)
    .join("\n");
  const resume = [
    header,
    `SUMMARY\n${backgroundLabel} for ${op.title} at ${op.company}: ` +
      facts.slice(0, 2).join(" "),
    ...careerSections,
    skills.length ? "SKILLS\n" + skills.join(" · ") : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const signature = [career.name, profile.email, career.portfolio]
    .filter(Boolean)
    .join("\n");
  const companyHook = op.signals[0]
    ? `I noticed this update from ${op.company}: ${op.signals[0]}`
    : `I am interested in learning more about the engineering work at ${op.company}.`;
  const subject =
    op.kind === "startup"
      ? `Engineering opportunities at ${op.company} — ${career.name}`
      : `Application: ${op.title} — ${career.name}`;
  const salutation = op.contactName ? `Hi ${op.contactName},` : "Hello,";
  const body =
    op.kind === "startup"
      ? [
          salutation,
          companyHook,
          `${backgroundLabel}:\n${facts.map((f) => "- " + f).join("\n")}`,
          `I would welcome a conversation about whether my background could help your team. Are you considering remote engineering collaborators${workingCountry ? ` based in ${workingCountry}` : ""}?`,
          career.portfolio ? `Relevant work: ${career.portfolio}` : "",
          `Best,\n${signature}`,
        ]
          .filter(Boolean)
          .join("\n\n")
      : [
          salutation,
          `I am applying for the ${op.title} role at ${op.company}.`,
          `${backgroundLabel}:\n${facts.map((f) => "- " + f).join("\n")}`,
          [
            workingCountry ? `I am based in ${workingCountry}.` : "",
            "I would be glad to discuss the role and your remote hiring arrangements.",
          ]
            .filter(Boolean)
            .join(" "),
          `Best,\n${signature}`,
        ].join("\n\n");
  const coverLetter = [
    `Dear ${op.company} hiring team,`,
    `I am interested in the ${op.title} position. ${backgroundLabel}:\n\n${facts.map((f) => "- " + f).join("\n")}`,
    `I would welcome the opportunity to discuss how my background relates to your priorities.`,
    `Sincerely,\n${career.name}`,
  ].join("\n\n");
  const answers = [
    {
      question: hasExperience
        ? "What relevant experience would you bring?"
        : "What relevant background would you bring?",
      answer: supported.length
        ? facts.join("\n\n")
        : "Listed in my CV:\n\n" + facts.join("\n\n"),
    },
    {
      question: "Where are you based?",
      answer: workingCountry || "To confirm.",
    },
    {
      question: "What are your salary expectations?",
      answer:
        prefs.targetSalary === null
          ? "I am open to discussing base compensation based on the role, responsibilities, and employment arrangement."
          : `My target is USD ${prefs.targetSalary.toLocaleString("en-US")} annually in base compensation, subject to the role and employment arrangement.`,
    },
  ];
  const stamp = new Date().toISOString();
  const draft: Draft = {
    id: randomUUID(),
    opportunityId: op.id,
    kind: op.kind === "startup" ? "outreach" : "application",
    subject,
    body,
    resume,
    coverLetter: op.kind === "job" ? coverLetter : "",
    answers: op.kind === "job" ? answers : [],
    evidenceIds: selected.map((e) => e.id),
    warnings: [
      ...(op.isDemo
        ? [
            "Sample data: replace the demo profile and opportunity before real use.",
          ]
        : []),
      ...assessment.blockers,
      ...assessment.unknowns,
      ...(assessment.learningGaps || []).map((gap) => `Learning gap: ${gap}`),
      "Generated from evidence templates. Review wording and employer-specific questions.",
    ],
    status: "draft",
    createdAt: stamp,
    updatedAt: stamp,
    profileFingerprint: profileFingerprint(profile),
    opportunityFingerprint: opportunityFingerprint(op),
    preferencesFingerprint: preferencesFingerprint(prefs),
    contentHash: "",
    artifactPath: null,
    testReceipt: null,
    generator: "templates",
  };
  draft.contentHash = draftContentHash(draft);
  return draft;
}
