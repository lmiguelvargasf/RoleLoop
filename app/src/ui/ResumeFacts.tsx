import { useState } from "react";
import { ChevronDown, Search, X } from "lucide-react";
import type { Profile } from "../shared/types";

type Facts = NonNullable<NonNullable<Profile["cache"]>["facts"]>;
// One small registry controls ordering and language across the review surface.
export const resumeCategories = [
  { id: "experience", label: "Experience", singular: "Role" },
  { id: "project", label: "Projects", singular: "Project" },
  { id: "education", label: "Education", singular: "Education" },
  { id: "certification", label: "Certifications", singular: "Certification" },
  { id: "skills", label: "Listed skills", singular: "Listed skills" },
  { id: "language", label: "Languages", singular: "Languages" },
  { id: "other", label: "Other details", singular: "Career detail" },
] as const;

export function ResumeFacts({ facts }: { facts: Facts }) {
  const [category, setCategory] = useState("all");
  const [query, setQuery] = useState("");
  const evidence = new Map(facts.evidence.map((item) => [item.id, item]));
  // A compatibility view keeps imported fixtures and earlier records inspectable.
  const sections = facts.sections.length
    ? facts.sections
    : facts.evidence.map((item) => ({
        id: item.id,
        category: item.category || "other",
        role: item.role,
        company: item.company,
        period: item.period,
        sourceText: item.text,
        evidenceIds: [item.id],
      }));
  const search = query.trim().toLocaleLowerCase();
  const matching = sections.filter((section) =>
    [
      section.role,
      section.company,
      section.period,
      ...section.evidenceIds.flatMap((id) => {
        const item = evidence.get(id);
        return item ? [item.text, ...item.skills] : [];
      }),
    ]
      .join(" ")
      .toLocaleLowerCase()
      .includes(search),
  );
  const visible = matching.filter(
    (section) => category === "all" || category === section.category,
  );
  const counts = new Map(
    resumeCategories.map(({ id }) => [
      id,
      matching.filter((section) => section.category === id).length,
    ]),
  );
  const skills = new Set(
    facts.evidence.flatMap((item) =>
      item.skills.map((skill) => skill.toLocaleLowerCase()),
    ),
  );

  return (
    <section className="resume-facts" aria-labelledby="resume-facts-title">
      <header className="resume-facts-heading">
        <div>
          <h2 id="resume-facts-title">{facts.name || "Career details"}</h2>
          <p>
            {sections.length} career{" "}
            {sections.length === 1 ? "record" : "records"}{" "}
            <span aria-hidden="true">·</span> {skills.size}{" "}
            {skills.size === 1 ? "skill" : "skills"} linked to source text
          </p>
        </div>
        <label className="resume-search">
          <Search size={16} aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a role, company or skill"
            aria-label="Search career details"
          />
          {query && (
            <button
              className="icon-button"
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear search"
            >
              <X size={14} />
            </button>
          )}
        </label>
      </header>
      <div className="resume-facts-layout">
        <nav className="resume-section-nav" aria-label="Resume sections">
          <button
            type="button"
            aria-pressed={category === "all"}
            onClick={() => setCategory("all")}
          >
            <span>All details</span>
            <span>{matching.length}</span>
          </button>
          {resumeCategories
            .filter(({ id }) =>
              sections.some((section) => section.category === id),
            )
            .map(({ id, label }) => (
              <button
                key={id}
                type="button"
                aria-pressed={category === id}
                onClick={() => setCategory(id)}
              >
                <span>{label}</span>
                <span>{counts.get(id)}</span>
              </button>
            ))}
        </nav>
        <div className="resume-records">
          <p className="resume-evidence-note">
            Original statements from your resume. Expand a record to inspect its
            evidence.
          </p>
          <span className="sr-only" role="status">
            {visible.length} records shown
          </span>
          {!visible.length && (
            <div className="resume-no-results">
              <h3>No matching details</h3>
              <p>Try another term or view all sections.</p>
              <button
                type="button"
                className="button"
                onClick={() => {
                  setQuery("");
                  setCategory("all");
                }}
              >
                Show all details
              </button>
            </div>
          )}
          {resumeCategories.map(({ id, label, singular }) => {
            const group = visible.filter((section) => section.category === id);
            if (!group.length) return null;
            return (
              <section
                key={id}
                className="resume-record-group"
                aria-label={label}
              >
                <h3 className="resume-group-label">{label}</h3>
                {(id === "skills" || id === "language") && (
                  <p className="resume-listed-note">
                    Listed in your resume; not treated as demonstrated work
                    experience.
                  </p>
                )}
                {group.map((section, index) => {
                  const statements = section.evidenceIds.flatMap((key) =>
                    evidence.has(key) ? [evidence.get(key)!] : [],
                  );
                  const linkedSkills = [
                    ...new Map(
                      statements
                        .flatMap((item) => item.skills)
                        .map((skill) => [skill.toLocaleLowerCase(), skill]),
                    ).values(),
                  ];
                  return (
                    <details
                      className="resume-record"
                      key={section.id}
                      open={index === 0}
                    >
                      <summary>
                        <div className="resume-record-identity">
                          <strong>
                            {section.role || section.company || singular}
                          </strong>
                          {section.role && section.company && (
                            <span>{section.company}</span>
                          )}
                        </div>
                        {id !== "skills" && id !== "language" && (
                          <span className="resume-record-period">
                            {section.period || "Date not specified"}
                          </span>
                        )}
                        <ChevronDown size={16} aria-hidden="true" />
                      </summary>
                      <div className="resume-record-body">
                        <ul className="resume-statements">
                          {statements.map((item) => (
                            <li key={item.id}>{item.text}</li>
                          ))}
                        </ul>
                        {!!linkedSkills.length && (
                          <p className="resume-linked-skills">
                            <span>Skills in these statements</span>
                            {linkedSkills.join(" · ")}
                          </p>
                        )}
                        <details className="resume-source-passage">
                          <summary>View source passage</summary>
                          <blockquote>{section.sourceText}</blockquote>
                        </details>
                      </div>
                    </details>
                  );
                })}
              </section>
            );
          })}
        </div>
      </div>
    </section>
  );
}
