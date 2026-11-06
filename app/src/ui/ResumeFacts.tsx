import { ChevronDown } from "lucide-react";
import type { Profile } from "../shared/types";

type Facts = NonNullable<NonNullable<Profile["cache"]>["facts"]>;
type Statement = Facts["evidence"][number];
type Section = Facts["sections"][number];
type Skill = {
  name: string;
  demonstrated: boolean;
  statements: Statement[];
};

const normalize = (text: string) =>
  text.trim().replace(/\s+/g, " ").toLocaleLowerCase();
const countLabel = (count: number, singular: string, plural = `${singular}s`) =>
  `${count} ${count === 1 ? singular : plural}`;

// Retain older facts and any ungrouped statements without inventing a category.
export function resumeReview(facts: Facts) {
  const linked = new Set(
    facts.sections.flatMap((section) => section.evidenceIds),
  );
  const sections: Section[] = [
    ...facts.sections,
    ...facts.evidence
      .filter((item) => !linked.has(item.id))
      .map((item) => ({
        id: `statement-${item.id}`,
        category: item.category || ("other" as const),
        role: item.role,
        company: item.company,
        period: item.period,
        sourceText: item.text,
        evidenceIds: [item.id],
      })),
  ];
  const sectionByStatement = new Map(
    sections.flatMap((section) =>
      section.evidenceIds.map((id) => [id, section] as const),
    ),
  );
  const skills = new Map<string, Skill>();
  for (const statement of facts.evidence) {
    const category =
      statement.category || sectionByStatement.get(statement.id)?.category;
    const demonstrated =
      statement.verified && category !== "skills" && category !== "language";
    for (const value of statement.skills) {
      const name = value.trim().replace(/\s+/g, " ");
      const key = normalize(name);
      if (!key) continue;
      const existing = skills.get(key);
      if (existing) {
        existing.demonstrated ||= demonstrated;
        if (!existing.statements.some((item) => item.id === statement.id))
          existing.statements.push(statement);
      } else skills.set(key, { name, demonstrated, statements: [statement] });
    }
  }
  return {
    sections,
    sectionByStatement,
    skills: [...skills.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

function SourcePassage({ text }: { text: string }) {
  return (
    <details className="resume-source-passage">
      <summary>View source passage</summary>
      <blockquote>{text}</blockquote>
    </details>
  );
}

function ResumeEntry({
  section,
  evidence,
}: {
  section: Section;
  evidence: Map<string, Statement>;
}) {
  const statements = section.evidenceIds.flatMap((id) =>
    evidence.has(id) ? [evidence.get(id)!] : [],
  );
  const fallback = statements[0]?.text || section.sourceText;
  const title =
    (section.category !== "language" && (section.role || section.company)) ||
    (fallback.length > 100 ? `${fallback.slice(0, 100).trimEnd()}…` : fallback);
  return (
    <details className="resume-record">
      <summary>
        <div className="resume-record-identity">
          <strong>{title}</strong>
          {section.role && section.company && <span>{section.company}</span>}
        </div>
        {section.period && (
          <span className="resume-record-period">{section.period}</span>
        )}
        <ChevronDown size={16} aria-hidden="true" />
      </summary>
      <div className="resume-record-body">
        <ul className="resume-statements">
          {statements.map((item) => (
            <li key={item.id}>{item.text}</li>
          ))}
        </ul>
        <SourcePassage text={section.sourceText} />
      </div>
    </details>
  );
}

export function ResumeFacts({ facts }: { facts: Facts }) {
  const { sections, skills, sectionByStatement } = resumeReview(facts);
  const evidence = new Map(facts.evidence.map((item) => [item.id, item]));
  const experience = sections.filter(
    (section) =>
      section.category === "experience" || section.category === "project",
  );
  const qualifications = sections.filter((section) =>
    ["education", "certification", "language"].includes(section.category),
  );
  const additional = sections.filter((section) => section.category === "other");
  const listedSections = sections.filter(
    (section) => section.category === "skills",
  );
  const demonstrated = skills.filter((skill) => skill.demonstrated);
  const listed = skills.filter((skill) => !skill.demonstrated);
  const roleCount = sections.filter(
    (section) => section.category === "experience",
  ).length;
  const projectCount = sections.filter(
    (section) => section.category === "project",
  ).length;
  const qualificationCount = sections.filter((section) =>
    ["education", "certification"].includes(section.category),
  ).length;
  const summary = [
    roleCount ? countLabel(roleCount, "role") : "",
    projectCount ? countLabel(projectCount, "project") : "",
    countLabel(skills.length, "skill"),
    qualificationCount ? countLabel(qualificationCount, "qualification") : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const group = (items: Section[], title: string) =>
    items.length > 0 && (
      <div className="resume-entry-group">
        <h4>
          {title} {title !== "Languages" && <span>{items.length}</span>}
        </h4>
        {items.map((section) => (
          <ResumeEntry key={section.id} section={section} evidence={evidence} />
        ))}
      </div>
    );
  const skillGroup = (items: Skill[], title: string, description: string) => (
    <div className="resume-skill-group">
      <h4>
        {title} <span>{items.length}</span>
      </h4>
      <p className="resume-group-description">{description}</p>
      {items.length ? (
        <div className="resume-skill-list">
          {items.map((skill) => (
            <details className="resume-skill" key={normalize(skill.name)}>
              <summary>
                <strong>{skill.name}</strong>
                <ChevronDown size={15} aria-hidden="true" />
              </summary>
              <div className="resume-skill-evidence">
                {skill.statements.map((statement) => (
                  <div className="resume-skill-example" key={statement.id}>
                    {(statement.role || statement.company) && (
                      <p className="resume-skill-context">
                        {[statement.role, statement.company]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    )}
                    <p>{statement.text}</p>
                    <SourcePassage
                      text={
                        sectionByStatement.get(statement.id)?.sourceText ||
                        statement.text
                      }
                    />
                  </div>
                ))}
              </div>
            </details>
          ))}
        </div>
      ) : (
        <p className="resume-section-empty">
          {title === "Demonstrated skills"
            ? "No skills with supporting examples were extracted."
            : "No additional skills were found only in lists."}
        </p>
      )}
    </div>
  );

  return (
    <section className="resume-facts" aria-labelledby="resume-facts-title">
      <header className="form-section resume-facts-heading">
        <div className="form-section-heading">
          <h2 id="resume-facts-title">Extracted details</h2>
          <p>Expand any detail to check its source.</p>
        </div>
        <div className="resume-facts-summary">
          {facts.name && <h3>{facts.name}</h3>}
          <p>{summary}</p>
        </div>
      </header>
      <div className="resume-review-sections">
        <section
          className="form-section resume-review-section"
          aria-labelledby="resume-experience-heading"
        >
          <div className="form-section-heading">
            <h3 id="resume-experience-heading">Experience</h3>
          </div>
          <div className="resume-section-content">
            {group(
              experience.filter((section) => section.category === "experience"),
              "Roles",
            )}
            {group(
              experience.filter((section) => section.category === "project"),
              "Projects",
            )}
            {!experience.length && (
              <p className="resume-section-empty">
                No roles or projects were extracted. Check the original
                resume if you expected to see them here.
              </p>
            )}
          </div>
        </section>
        <section
          className="form-section resume-review-section"
          aria-labelledby="resume-skills-heading"
        >
          <div className="form-section-heading">
            <h3 id="resume-skills-heading">Skills</h3>
          </div>
          <div className="resume-section-content">
            {skillGroup(
              demonstrated,
              "Demonstrated skills",
              "Examples in your experience or qualifications can support stronger matches.",
            )}
            {skillGroup(
              listed,
              "Listed skills",
              "Named in your resume without a supporting example. These can support a partial match.",
            )}
            {listedSections.length > 0 && (
              <details className="resume-listed-statements">
                <summary>Review original skill lists</summary>
                {listedSections.map((section) => (
                  <ResumeEntry
                    key={section.id}
                    section={section}
                    evidence={evidence}
                  />
                ))}
              </details>
            )}
          </div>
        </section>
        <section
          className="form-section resume-review-section"
          aria-labelledby="resume-qualifications-heading"
        >
          <div className="form-section-heading">
            <h3 id="resume-qualifications-heading">Qualifications</h3>
          </div>
          <div className="resume-section-content">
            {group(
              qualifications.filter((section) => section.category === "education"),
              "Education",
            )}
            {group(
              qualifications.filter(
                (section) => section.category === "certification",
              ),
              "Certifications",
            )}
            {group(
              qualifications.filter((section) => section.category === "language"),
              "Languages",
            )}
            {group(additional, "Additional details")}
            {!qualifications.length && !additional.length && (
              <p className="resume-section-empty">
                No education, certifications or languages were extracted.
              </p>
            )}
          </div>
        </section>
      </div>
    </section>
  );
}
