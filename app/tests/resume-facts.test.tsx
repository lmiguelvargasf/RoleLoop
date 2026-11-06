import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ResumeFacts, resumeReview } from "../src/ui/ResumeFacts";
import type { Profile } from "../src/shared/types";

type Facts = NonNullable<NonNullable<Profile["cache"]>["facts"]>;
const statement = (
  id: string,
  category?: Facts["evidence"][number]["category"],
) => ({
  id,
  category,
  text: `Original statement ${id}`,
  skills: ["TypeScript"],
  verified: true,
  role: "",
  company: "",
  period: "",
});
const facts = (
  evidence: Facts["evidence"],
  sections: Facts["sections"] = [],
): Facts => ({
  name: "Alex Morgan",
  portfolio: "",
  evidence,
  sections,
});

describe("resume review", () => {
  it("does not present skill and language lists as demonstrated experience", () => {
    const review = resumeReview(
      facts([
        { ...statement("list", "skills"), skills: ["TypeScript", "Python"] },
        { ...statement("language", "language"), skills: ["Spanish"] },
      ]),
    );
    expect(
      review.skills.map((skill) => [skill.name, skill.demonstrated]),
    ).toEqual([
      ["Python", false],
      ["Spanish", false],
      ["TypeScript", false],
    ]);
  });

  it("counts a skill once and preserves its listed and demonstrated sources", () => {
    const review = resumeReview(
      facts([
        {
          ...statement("list", "skills"),
          skills: [" TypeScript ", "typescript"],
        },
        statement("work", "experience"),
      ]),
    );
    expect(review.skills).toHaveLength(1);
    expect(review.skills[0].demonstrated).toBe(true);
    expect(review.skills[0].statements.map((item) => item.id)).toEqual([
      "list",
      "work",
    ]);
  });

  it("uses a section's category when older statements omit it", () => {
    const review = resumeReview(
      facts(
        [statement("list")],
        [
          {
            id: "skills",
            category: "skills",
            role: "Skills",
            company: "",
            period: "",
            sourceText: "Listed TypeScript",
            evidenceIds: ["list"],
          },
        ],
      ),
    );
    expect(review.skills[0].demonstrated).toBe(false);
  });

  it("keeps ungrouped and legacy statements inspectable alongside current sections", () => {
    const source = facts(
      [statement("current", "experience"), statement("legacy")],
      [
        {
          id: "role",
          category: "experience",
          role: "Engineer",
          company: "Studio",
          period: "2022–2024",
          sourceText: "Engineer at Studio. Original statement current",
          evidenceIds: ["current"],
        },
      ],
    );
    const review = resumeReview(source);
    expect(review.sections.flatMap((section) => section.evidenceIds)).toEqual([
      "current",
      "legacy",
    ]);
    expect(review.sections[1].category).toBe("other");
    const html = renderToStaticMarkup(<ResumeFacts facts={source} />);
    expect(html).toContain("Original statement legacy");
    expect(html).toContain("1 role · 1 skill");
    expect(html).toContain("Additional details");
    expect(html).not.toContain("career records");
    expect(html).not.toContain('open=""');
    expect(html).toContain('id="resume-experience-heading"');
    expect(html).toContain('id="resume-skills-heading"');
    expect(html).toContain('id="resume-qualifications-heading"');
  });

  it("does not promote unverified statements to demonstrated skills", () => {
    const review = resumeReview(
      facts([{ ...statement("unchecked", "experience"), verified: false }]),
    );
    expect(review.skills[0].demonstrated).toBe(false);
  });
});
