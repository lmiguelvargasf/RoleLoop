import { load } from "cheerio";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { assessOpportunity } from "../src/domain/rules";
import { recommendationForJob } from "../src/shared/job-recommendations";
import { JobFitDetails } from "../src/ui/JobFitDetails";
import { demoOpportunities, demoWorkspace } from "./fixtures";

describe("job fit details", () => {
  it("keeps restrictions visible and evidence under its own requirement", () => {
    const workspace = demoWorkspace();
    const job = demoOpportunities()[0];
    job.assessment = assessOpportunity(
      job,
      workspace.profile,
      workspace.preferences,
    );
    job.assessment.blockers = ["This role hires in the US only."];
    job.assessment.unknowns = ["Salary period needs confirmation."];
    job.assessment.fitSummary = "A long, repeated AI summary.";
    job.assessment.learningGaps = ["Another repeated AI paragraph."];
    job.assessment.matches[0] = {
      ...job.assessment.matches[0],
      status: "partial",
      evidenceIds: ["demo-e1", "unknown-fact"],
      explanation: "React work is supported; the required scope is not shown.",
    };
    const html = renderToStaticMarkup(
      <JobFitDetails
        opportunity={job}
        profile={workspace.profile}
        fit={recommendationForJob(job, workspace.preferences)}
      />,
    );
    const $ = load(html);
    expect($(".job-fit-notice.excluded").text()).toContain("US only");
    expect($(".job-fit-notice").text()).toContain(
      "Salary period needs confirmation",
    );
    expect($(".job-fit-notice").parents("details")).toHaveLength(0);
    const required = $(".job-fit-required > details");
    expect(required).toHaveLength(1);
    expect($(".job-fit-filters [aria-pressed=true]").text()).toBe("To check 1");
    expect($(".job-fit-filters [aria-pressed=false]").text()).toBe(
      "All required 2",
    );
    expect(required.first().attr("open")).toBeUndefined();
    expect(required.first().find("summary").text()).toContain("Partial");
    expect(required.first().find("summary").text()).not.toContain(
      "React work is supported",
    );
    expect(required.first().find("li")).toHaveLength(1);
    expect(required.first().find("li").text()).toContain("Example Studio");
    expect($(".job-fit-preferred").attr("open")).toBeUndefined();
    expect($(".job-fit-preferred .job-fit-requirement")).toHaveLength(1);
    expect(html).not.toContain("repeated AI");
  });

  it("shows unassessed requirements without inventing a score or a missing match", () => {
    const workspace = demoWorkspace();
    const job = demoOpportunities()[0];
    const $ = load(
      renderToStaticMarkup(
        <JobFitDetails
          opportunity={job}
          profile={workspace.profile}
          fit={recommendationForJob(job, workspace.preferences)}
        />,
      ),
    );
    expect($(".job-fit-score").text()).toBe("Needs AI evaluation");
    expect($(".job-fit-status.pending")).toHaveLength(3);
    expect($(".job-fit-status.missing")).toHaveLength(0);
    expect($(".job-fit-score").text()).not.toContain("%");
  });

  it("leaves requirements without skill tags pending in a partial fallback assessment", () => {
    const workspace = demoWorkspace();
    const job = demoOpportunities()[0];
    job.requirements[0] = {
      ...job.requirements[0],
      text: "Lead cross-functional product delivery",
      skills: [],
    };
    job.assessment = assessOpportunity(
      job,
      workspace.profile,
      workspace.preferences,
    );
    expect(job.assessment.matches[0].status).toBe("missing");
    expect(job.assessment.fitEvaluation?.method).toBe("skills");
    const $ = load(
      renderToStaticMarkup(
        <JobFitDetails
          opportunity={job}
          profile={workspace.profile}
          fit={recommendationForJob(job, workspace.preferences)}
        />,
      ),
    );
    const row = $(".job-fit-required > details").first();
    expect(row.find(".job-fit-status").text()).toBe("Not assessed");
    expect(row.find(".job-fit-evidence").text()).toContain("Re-evaluate fit");
    expect($(".job-fit-score").text()).toBe("Needs AI evaluation");
  });

  it("leaves all requirements pending when the resume has no evidence", () => {
    const workspace = demoWorkspace();
    workspace.profile.cache!.facts!.evidence = [];
    const job = demoOpportunities()[0];
    job.assessment = assessOpportunity(
      job,
      workspace.profile,
      workspace.preferences,
    );
    expect(job.assessment.fitEvaluation?.method).toBe("none");
    const $ = load(
      renderToStaticMarkup(
        <JobFitDetails
          opportunity={job}
          profile={workspace.profile}
          fit={recommendationForJob(job, workspace.preferences)}
        />,
      ),
    );
    expect($(".job-fit-status.pending")).toHaveLength(3);
    expect($(".job-fit-status.missing")).toHaveLength(0);
  });

  it("keeps an assessed semantic evidence gap distinct from a pending requirement", () => {
    const workspace = demoWorkspace();
    const job = demoOpportunities()[0];
    job.requirements[0] = {
      ...job.requirements[0],
      text: "Lead cross-functional product delivery",
      skills: [],
    };
    const fallback = assessOpportunity(
      job,
      workspace.profile,
      workspace.preferences,
    );
    job.assessment = assessOpportunity(
      job,
      workspace.profile,
      workspace.preferences,
      new Date(),
      fallback.matches.map((match) => ({
        ...match,
        status: "missing",
        evidenceIds: [],
        explanation:
          "No product delivery leadership is described in your resume.",
      })),
    );
    expect(job.assessment.fitEvaluation?.method).toBe("semantic");
    const $ = load(
      renderToStaticMarkup(
        <JobFitDetails
          opportunity={job}
          profile={workspace.profile}
          fit={recommendationForJob(job, workspace.preferences)}
        />,
      ),
    );
    const row = $(".job-fit-required > details").first();
    expect(row.find(".job-fit-status").text()).toBe("Not shown");
    expect(row.find(".job-fit-evidence").text()).toContain(
      "No product delivery leadership",
    );
  });
});
