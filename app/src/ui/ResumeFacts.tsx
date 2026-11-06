import { useRef, useState } from "react";
import { ChevronDown, Search, X } from "lucide-react";
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
  const [query, setQuery] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);
  const { sections, skills, sectionByStatement } = resumeReview(facts);
  const evidence = new Map(facts.evidence.map((item) => [item.id, item]));
  const search = normalize(query);
  const sectionText = (section: Section) =>
    [
      section.role,
      section.company,
      section.period,
      section.sourceText,
      ...section.evidenceIds.flatMap((id) => {
        const item = evidence.get(id);
        return item ? [item.text, ...item.skills] : [];
      }),
    ].join(" ");
  const matching = sections.filter((section) =>
    normalize(sectionText(section)).includes(search),
  );
  const matchingSkills = skills.filter((skill) =>
    normalize(
      [
        skill.name,
        ...skill.statements.flatMap((item) => [
          item.text,
          item.role,
          item.company,
          item.period,
          sectionByStatement.get(item.id)?.sourceText || "",
        ]),
      ].join(" "),
    ).includes(search),
  );
  const experience = matching.filter(
    (section) =>
      section.category === "experience" || section.category === "project",
  );
  const qualifications = matching.filter((section) =>
    ["education", "certification", "language"].includes(section.category),
  );
  const additional = matching.filter((section) => section.category === "other");
  const listedSections = matching.filter(
    (section) => section.category === "skills",
  );
  const demonstrated = matchingSkills.filter((skill) => skill.demonstrated);
  const listed = matchingSkills.filter((skill) => !skill.demonstrated);
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
  const noResults = !matching.length && !matchingSkills.length;
  const clearSearch = () => {
    setQuery("");
    searchInput.current?.focus();
  };
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
          {search
            ? "No skills match this search."
            : title === "Demonstrated skills"
              ? "No skills with supporting examples were extracted."
              : "No additional skills were found only in lists."}
        </p>
      )}
    </div>
  );

  return (
    <section className="resume-facts" aria-labelledby="resume-facts-title">
      <header className="resume-facts-heading">
        <div>
          <h2 id="resume-facts-title">{facts.name || "Extracted details"}</h2>
          <p>{summary}</p>
        </div>
        <div className="resume-search">
          <Search size={16} aria-hidden="true" />
          <input
            ref={searchInput}
            type="search"
            name="resume-search"
            autoComplete="off"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a role, company or skill…"
            aria-label="Search resume details"
          />
          {query && (
            <button
              className="icon-button"
              type="button"
              onClick={clearSearch}
              aria-label="Clear search"
            >
              <X size={14} aria-hidden="true" />
            </button>
          )}
        </div>
      </header>
      <p className="resume-evidence-note">
        Expand any detail to check its source.
      </p>
      <span className="sr-only" role="status" aria-atomic="true">
        {search
          ? noResults
            ? "No matching details"
            : `${countLabel(matching.length, "resume entry", "resume entries")} and ${countLabel(matchingSkills.length, "skill")} match your search.`
          : "Showing all resume details."}
      </span>
      {noResults && search ? (
        <div className="resume-no-results">
          <h3>No matching details</h3>
          <p>
            No roles, skills or qualifications match “{query.trim()}”. Try
            another term.
          </p>
          <button type="button" className="button" onClick={clearSearch}>
            Clear search
          </button>
        </div>
      ) : (
        <div className="resume-review-sections">
          {(!search || experience.length > 0) && (
            <section
              className="resume-review-section"
              aria-labelledby="resume-experience-heading"
            >
              <h3 id="resume-experience-heading">Experience</h3>
              {group(
                experience.filter(
                  (section) => section.category === "experience",
                ),
                "Roles",
              )}
              {group(
                experience.filter((section) => section.category === "project"),
                "Projects",
              )}
              {!experience.length && (
                <p className="resume-section-empty">
                  No roles or projects were extracted. Check the original resume
                  if you expected to see them here.
                </p>
              )}
            </section>
          )}
          {(!search ||
            matchingSkills.length > 0 ||
            listedSections.length > 0) && (
            <section
              className="resume-review-section"
              aria-labelledby="resume-skills-heading"
            >
              <h3 id="resume-skills-heading">Skills</h3>
              {(!search || demonstrated.length > 0) &&
                skillGroup(
                  demonstrated,
                  "Demonstrated skills",
                  "Examples in your experience or qualifications can support stronger matches.",
                )}
              {(!search || listed.length > 0) &&
                skillGroup(
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
            </section>
          )}
          {(!search || qualifications.length > 0 || additional.length > 0) && (
            <section
              className="resume-review-section"
              aria-labelledby="resume-qualifications-heading"
            >
              <h3 id="resume-qualifications-heading">Qualifications</h3>
              {group(
                qualifications.filter(
                  (section) => section.category === "education",
                ),
                "Education",
              )}
              {group(
                qualifications.filter(
                  (section) => section.category === "certification",
                ),
                "Certifications",
              )}
              {group(
                qualifications.filter(
                  (section) => section.category === "language",
                ),
                "Languages",
              )}
              {group(additional, "Additional details")}
              {!qualifications.length && !additional.length && (
                <p className="resume-section-empty">
                  No education, certifications or languages were extracted.
                </p>
              )}
            </section>
          )}
        </div>
      )}
    </section>
  );
}
