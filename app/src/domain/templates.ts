import { randomUUID } from "node:crypto";
import type {
  Assessment,
  Draft,
  Opportunity,
  Preferences,
  Profile,
} from "../shared/types.js";
import {
  draftContentHash,
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
  if (!profile.name.trim())
    throw new Error("Add your name to the profile before drafting.");
  const eligible = profile.evidence.filter((e) => e.verified);
  if (!eligible.length)
    throw new Error(
      "Add at least one verified experience item before drafting.",
    );
  const requested = new Set(
    op.requirements.flatMap((r) => r.skills.map(normalizeSkill)),
  );
  const selected = [...eligible]
    .sort(
      (a, b) =>
        b.skills.filter((s) => requested.has(normalizeSkill(s))).length -
        a.skills.filter((s) => requested.has(normalizeSkill(s))).length,
    )
    .slice(0, 8);
  const related = selected.filter(
    (e) =>
      e.skills.some((s) => requested.has(normalizeSkill(s))) ||
      e.skills.some((s) =>
        op.description.toLowerCase().includes(s.toLowerCase()),
      ),
  );
  const highlights = (related.length ? related : selected).slice(0, 3);
  const facts = highlights.map((e) => e.text);
  const skills = [...new Set(selected.flatMap((e) => e.skills))];
  const header = [
    profile.name,
    profile.headline,
    [profile.location, profile.email, profile.portfolio]
      .filter(Boolean)
      .join(" · "),
  ]
    .filter(Boolean)
    .join("\n");
  const resume = [
    header,
    profile.summary ? "SUMMARY\n" + profile.summary : "",
    "VERIFIED EXPERIENCE\n" +
      selected
        .map((e) =>
          [
            [e.role, e.company, e.period].filter(Boolean).join(" · "),
            "- " + e.text,
          ]
            .filter(Boolean)
            .join("\n"),
        )
        .join("\n\n"),
    "SKILLS\n" + skills.join(" · "),
  ]
    .filter(Boolean)
    .join("\n\n");
  const signature = [profile.name, profile.email, profile.portfolio]
    .filter(Boolean)
    .join("\n");
  const companyHook = op.signals[0]
    ? `I noticed this update from ${op.company}: ${op.signals[0]}`
    : `I am interested in learning more about the engineering work at ${op.company}.`;
  const subject =
    op.kind === "startup"
      ? `Engineering opportunities at ${op.company} — ${profile.name}`
      : `Application: ${op.title} — ${profile.name}`;
  const salutation = op.contactName ? `Hi ${op.contactName},` : "Hello,";
  const body =
    op.kind === "startup"
      ? [
          salutation,
          companyHook,
          `My relevant experience includes:\n${facts.map((f) => "- " + f).join("\n")}`,
          `I would welcome a conversation about whether this experience could help your team. Are you considering remote engineering collaborators based in ${profile.location || profile.country || "my location"}?`,
          profile.portfolio ? `Relevant work: ${profile.portfolio}` : "",
          `Best,\n${signature}`,
        ]
          .filter(Boolean)
          .join("\n\n")
      : [
          salutation,
          `I am applying for the ${op.title} role at ${op.company}.`,
          `Relevant experience:\n${facts.map((f) => "- " + f).join("\n")}`,
          `I am based in ${profile.location || profile.country || "[location to confirm]"}. I would be glad to discuss the role and your remote hiring arrangements.`,
          `Best,\n${signature}`,
        ].join("\n\n");
  const coverLetter = [
    `Dear ${op.company} hiring team,`,
    `I am interested in the ${op.title} position. My experience relevant to your team includes:\n\n${facts.map((f) => "- " + f).join("\n")}`,
    `I would welcome the opportunity to discuss how this work relates to your priorities.`,
    `Sincerely,\n${profile.name}`,
  ].join("\n\n");
  const answers = [
    {
      question: "What relevant experience would you bring?",
      answer: facts.join("\n\n"),
    },
    {
      question: "Where are you based?",
      answer: profile.location || profile.country || "To confirm.",
    },
    {
      question: "What are your salary expectations?",
      answer: `My target is USD ${prefs.targetSalary.toLocaleString("en-US")} annually in base compensation, subject to the role and employment arrangement.`,
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
      ...(profile.isDemo || op.isDemo
        ? [
            "Sample data: replace the demo profile and opportunity before real use.",
          ]
        : []),
      ...assessment.blockers,
      ...assessment.unknowns,
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
