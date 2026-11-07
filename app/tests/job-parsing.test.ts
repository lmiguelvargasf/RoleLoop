import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discover,
  extractRequirementDetails,
  extractRequirements,
  plainText,
  remoteScope,
} from "../src/domain/connectors.js";
import type { Source } from "../src/shared/types.js";
import { assessOpportunity } from "../src/domain/rules.js";
import { recommendationForJob } from "../src/shared/job-recommendations.js";
import { demoOpportunities, demoWorkspace } from "./fixtures.js";

afterEach(() => vi.unstubAllGlobals());

describe("practical job requirement parsing", () => {
  it("separates required and preferred qualifications without scoring headings or responsibilities", () => {
    const requirements = extractRequirements(
      [
        "## Required qualifications:",
        "- Experience building production services with TypeScript",
        "- Must hold an active professional license",
        "Preferred qualifications:",
        "- Kubernetes experience is a plus",
        "What you'll do:",
        "Build our new Python integration",
        "Benefits:",
        "Annual learning allowance",
      ].join("\n"),
    );
    expect(
      requirements.map(({ text, essential, hard }) => ({
        text,
        essential,
        hard,
      })),
    ).toEqual([
      {
        text: "Experience building production services with TypeScript",
        essential: true,
        hard: false,
      },
      {
        text: "Must hold an active professional license",
        essential: true,
        hard: true,
      },
      {
        text: "Kubernetes experience is a plus",
        essential: false,
        hard: false,
      },
    ]);
  });

  it("retains inline qualifications and does not make waived or optional conditions mandatory", () => {
    const requirements = extractRequirements(
      [
        "Minimum qualifications: Experience supporting enterprise customers",
        "No degree required",
        "SQL is a plus",
        "Preferred: Minimum two years of Python experience",
      ].join("\n"),
    );
    expect(
      requirements.map(({ essential, hard }) => [essential, hard]),
    ).toEqual([
      [true, false],
      [false, false],
      [false, false],
      [false, false],
    ]);
    expect(requirements[0].text).toBe(
      "Experience supporting enterprise customers",
    );
    expect(requirements[3].skills).toContain("Python");
  });

  it("preserves substantive qualification prose when the same section also has bullets", () => {
    const { requirements, requirementsTruncated } = extractRequirementDetails(
      "Requirements\nYou have five years of production ownership.\n- Experience with TypeScript\nJoin our team and help shape the future!",
    );
    expect(requirements.map((requirement) => requirement.text)).toEqual([
      "You have five years of production ownership.",
      "Experience with TypeScript",
    ]);
    expect(requirementsTruncated).toBe(false);
  });

  it("reads OpenTrain-style qualifications without counting perks and pay as capped duties", () => {
    const { requirements, requirementsTruncated } = extractRequirementDetails([
      "What you'll do",
      "• Create and solve realistic full-stack tasks involving user-facing features and APIs",
      "• Trace requests and data across browsers and back-end services",
      "• Write professional reference solutions across front-end and back-end systems",
      "• Review AI-generated code for security, performance and maintainability",
      "Why this is worth your time",
      "• Earn $50–$100 per hour equivalent for accepted tasks",
      "• Review AI-generated code across front-end and back-end systems",
      "• Use your full-stack experience across unfamiliar codebases",
      "• Fully remote and flexible, no fixed shifts, no commute",
      "Who this is for",
      "• Strong professional experience building production full-stack applications",
      "• Strong full-stack systems knowledge covering browser applications, APIs and databases",
      "• Professional fluency in English; experience with software-system architecture and debugging",
      "• No AI experience needed. Experience reviewing AI-generated code is helpful.",
      "Pay and details",
      "• $50–$100 per hour equivalent; pay is per accepted task",
      "• Part-time, under 20 hours a week; fully remote, United States",
      "How to apply",
      "Complete a short application on the hiring platform.",
    ].join("\n"));

    expect(requirements).toHaveLength(4);
    expect(requirements.map((requirement) => requirement.essential)).toEqual([
      true, true, true, false,
    ]);
    expect(requirements.every((requirement) => !requirement.hard)).toBe(true);
    expect(requirements[3].text).toContain("No AI experience needed");
    expect(requirementsTruncated).toBe(false);
    expect(requirements.map((requirement) => requirement.text).join(" "))
      .not.toMatch(/Earn|per hour|no commute|Complete a short application/);
  });

  it.each([
    "TypeScript experience is required; Kubernetes is a plus.",
    "Experience providing executive-level administrative support. Public company or Office of the CFO experience is a plus.",
  ])("keeps the required part of a mixed optional bullet: %s", (bullet) => {
    const requirements = extractRequirements(`Requirements\n- ${bullet}`);
    expect(requirements).toHaveLength(2);
    expect(requirements.map((requirement) => requirement.essential)).toEqual([true, false]);
  });

  it("keeps an optional sentence attached when it qualifies the preceding statement", () => {
    const requirements = extractRequirements("Requirements\n- Experience with Kubernetes. This is preferred, not required.");
    expect(requirements).toHaveLength(1);
    expect(requirements[0].essential).toBe(false);
  });

  it("discloses text and list limits rather than silently claiming complete coverage", () => {
    const long = extractRequirementDetails(`Requirements\n- ${"Production TypeScript experience. ".repeat(23)} Must hold a professional license.`);
    expect(long.requirements[0].text).toHaveLength(700);
    expect(long.requirementsTruncated).toBe(true);
    const list = extractRequirementDetails("Requirements\n" + Array.from(
      { length: 31 }, (_, i) => `- Qualification number ${i + 1} must be demonstrated`,
    ).join("\n"));
    expect(list.requirements).toHaveLength(30);
    expect(list.requirementsTruncated).toBe(true);
    const duties = extractRequirementDetails("Responsibilities\n" + Array.from(
      { length: 13 }, (_, i) => `- Deliver customer project number ${i + 1}`,
    ).join("\n"));
    expect(duties.requirements).toHaveLength(12);
    expect(duties.requirementsTruncated).toBe(true);
  });

  it("cannot report a complete fit even when every retained requirement is matched", () => {
    const workspace = demoWorkspace();
    const job = { ...demoOpportunities()[0], requirementsTruncated: true };
    const matches = job.requirements.map((requirement) => ({
      requirementId: requirement.id,
      requirement: requirement.text,
      essential: requirement.essential,
      status: "matched" as const,
      evidenceIds: ["demo-e1", "demo-e2"],
      explanation: "The retained qualification has supporting evidence.",
    }));
    job.assessment = assessOpportunity(job, workspace.profile, workspace.preferences, new Date(), matches);
    expect(job.assessment.fitEvaluation?.status).toBe("partial");
    expect(job.assessment.recommendation).toBe("review");
    expect(job.assessment.policyUnknowns?.join(" ")).toContain("qualifications were shortened or omitted");
    expect(recommendationForJob(job, workspace.preferences).score).toBeNull();
  });
});

describe("requirement extraction from real board formats", () => {
  it("recognizes Karat's experience heading without turning preferred interviewing experience into a minimum", () => {
    const { requirements, requirementsTruncated } = extractRequirementDetails([
      "## What Interview Engineers do:",
      "• Facilitate technical interviews with software developers.",
      "• Provide input on candidate performance and coding approach.",
      "## The experience you will bring:",
      "• 3+ years of experience as a Software Developer or Engineer",
      "• Excellent English communication skills with a high level of professionalism",
      "• Reliable access to a working webcam, microphone, and a stable Internet connection",
      "• Experience conducting technical interviews is preferred (e.g., data structures, algorithms)",
      "While we review your application, learn more about life as an Interview Engineer!",
    ].join("\n"));

    expect(requirements).toHaveLength(4);
    expect(requirements.map((requirement) => requirement.essential)).toEqual([
      true, true, true, false,
    ]);
    expect(requirements[0].text).toContain("3+ years");
    expect(requirements[3].text).toContain("preferred");
    expect(requirementsTruncated).toBe(false);
  });

  it("recognizes additional employer qualification headings", () => {
    const requirements = extractRequirements(
      "<p><strong>What you’ll bring</strong></p><ul><li>Experience supporting executive leadership</li></ul><p><span><strong>Strongly preferred</strong></span></p><ul><li>Experience supporting a public company</li></ul>",
    );
    expect(requirements.map((requirement) => requirement.essential)).toEqual([true, false]);
  });
  it("reads HTML qualifications under a conversational heading and excludes the legal footer", () => {
    const description = `
      <p><strong>Enough about us, let's talk about you. Working here might be a good fit if:</strong></p>
      <ul>
        <li>You have production experience with several programming languages.</li>
        <li>You have experience operating services at scale.</li>
      </ul>
      <p>Join our team and help shape the future of our products!</p>
      <p><strong>What to Expect:</strong></p>
      <p>Applicants must complete our online application form.</p>
      <p><em>All qualified applicants receive consideration without regard to race.
      We participate in verification programs as required by law.</em></p>`;
    const requirements = extractRequirements(description);
    expect(extractRequirements(plainText(description))).toEqual(requirements);
    expect(requirements.map((requirement) => requirement.text)).toEqual([
      "You have production experience with several programming languages.",
      "You have experience operating services at scale.",
    ]);
    expect(
      requirements.every(
        (requirement) => requirement.essential && !requirement.hard,
      ),
    ).toBe(true);
  });

  it("does not inflate essential fit with an informational technology stack", () => {
    const requirements = extractRequirements(
      [
        "What we’re looking for",
        "- Strong React and TypeScript fundamentals",
        "- Experience shipping end-to-end customer features",
        "Our tech",
        "You are not expected to have experience with everything listed.",
        "- Kubernetes, PostgreSQL, GraphQL and Redis",
        "What we offer",
        "- Paid vacation",
      ].join("\n"),
    );
    expect(requirements).toHaveLength(2);
    expect(requirements[0].skills).toEqual(["TypeScript", "React"]);
    expect(
      requirements.some((requirement) =>
        /looking for|Our tech|Kubernetes|vacation/.test(requirement.text),
      ),
    ).toBe(false);
  });

  it("retains specialty qualifications and separates additional skills", () => {
    const requirements = extractRequirements(
      [
        "What your day will look like",
        "Integrate operating systems with new hardware platforms",
        "What we are looking for in you",
        "You have experience with Linux packaging",
        "You have experience working with C, C++",
        "Additional skills that you might also bring",
        "Experience with graphics stacks",
        "Some experience with Docker containers",
        "What we offer you",
        "Annual bonuses",
      ].join("\n"),
    );
    expect(requirements.map((requirement) => requirement.essential)).toEqual([
      true,
      true,
      false,
      false,
    ]);
    expect(requirements.map((requirement) => requirement.text)).toContain(
      "You have experience working with C, C++",
    );
  });

  it("recognizes conversational fit headings and keeps inline bonus criteria optional", () => {
    const requirements = extractRequirements(
      [
        "About Example Company",
        "We build a developer platform.",
        "What You’ll Be Responsible For",
        "Build and maintain the Python SDK",
        "You Might Be a Good Fit If You",
        "Know modern Python typing deeply",
        "Have maintained a public library with external users",
        "Are fluent in asyncio",
        "Bonus points if you: have led a public package migration",
        "What We Offer",
        "Flexible work and an education allowance",
      ].join("\n"),
    );
    expect(
      requirements.map(({ text, essential }) => ({ text, essential })),
    ).toEqual([
      { text: "Know modern Python typing deeply", essential: true },
      {
        text: "Have maintained a public library with external users",
        essential: true,
      },
      { text: "Are fluent in asyncio", essential: true },
      { text: "have led a public package migration", essential: false },
    ]);
  });

  it("recognizes the responsible-for heading for duty-only postings", () => {
    const requirements = extractRequirements(
      [
        "About Example Company",
        "We build developer tools.",
        "What You'll Be Responsible For",
        "Build and maintain customer-facing integrations",
        "What We Offer",
        "Competitive benefits",
      ].join("\n"),
    );
    expect(requirements.map((requirement) => requirement.text)).toEqual([
      "Build and maintain customer-facing integrations",
    ]);
  });

  it("decodes escaped markup before classifying sections and keeps stable IDs", () => {
    const html =
      "<h2>Required qualifications</h2><ul><li>Experience with TypeScript</li></ul><h2>Benefits</h2><p>All employees must use our benefits portal.</p>";
    const escaped = html.replace(/</g, "&lt;").replace(/>/g, "&gt;");
    expect(extractRequirements(escaped)).toEqual(extractRequirements(html));
    expect(extractRequirements(html)).toHaveLength(1);
    expect(extractRequirements(html)[0]).toEqual(
      extractRequirements(
        "Required qualifications\nExperience with TypeScript",
      )[0],
    );
  });

  it("uses responsibilities as fallback when qualifications are absent", () => {
    const requirements = extractRequirements(
      [
        "What you'll do:",
        "- Build customer-facing TypeScript products",
        "- Lead technical design with product and design partners",
        "Benefits:",
        "Annual learning allowance",
      ].join("\n"),
    );
    expect(requirements).toHaveLength(2);
    expect(
      requirements.every(
        (requirement) => requirement.essential && !requirement.hard,
      ),
    ).toBe(true);
  });

  it("does not turn a legal requirement in a company paragraph into job qualifications", () => {
    expect(
      extractRequirements(
        "<p>All qualified applicants receive consideration for employment. Our verification process is required by law.</p>",
      ),
    ).toEqual([]);
    expect(
      extractRequirements("Requirements\nSQL\nReact").map(
        (requirement) => requirement.text,
      ),
    ).toEqual(["SQL", "React"]);
  });
});

describe("remote work evidence", () => {
  it.each([
    "We are a global company with remote collaboration benefits.",
    "Our global customers use remote software.",
    "Remote anywhere in India",
    "This role is no longer fully remote worldwide.",
  ])("does not invent worldwide hiring from %s", (text) => {
    expect(remoteScope(text)).toBe("unknown");
  });

  it.each([
    "Remote worldwide",
    "Fully remote role, worldwide",
    "Work remotely from anywhere in the world",
    "Global remote",
    "Remote worldwide. Build hybrid cloud infrastructure.",
  ])("retains explicit worldwide remote work: %s", (text) => {
    expect(remoteScope(text)).toBe("worldwide");
  });

  it("does not let a general remote benefit cancel required office attendance", () => {
    expect(
      remoteScope(
        "This is a hybrid role. Other teams are fully remote worldwide.",
      ),
    ).toBe("onsite");
    expect(remoteScope("Hybrid — Bangalore")).toBe("onsite");
    expect(
      remoteScope("This is not a hybrid role. Fully remote worldwide."),
    ).toBe("worldwide");
  });

  it.each([
    "This is a fully remote worldwide position. On-site work is not required.",
    "This role is fully remote worldwide. Our other teams have hybrid work schedules.",
    "Candidates can work remotely worldwide or use a hybrid work schedule.",
  ])(
    "preserves remote choices without imposing another team's attendance: %s",
    (text) => {
      expect(remoteScope(text)).not.toBe("onsite");
    },
  );

  it("retains required office attendance despite remote options on other days", () => {
    expect(
      remoteScope(
        "Candidates can work remotely or use a hybrid work schedule, but must attend our office three days per week.",
      ),
    ).toBe("onsite");
  });

  const source = (provider: Source["provider"]): Source => ({
    id: `parsing-${provider}`,
    provider,
    label: "Parsing employer",
    board: "parsing",
    enabled: true,
  });
  const respond = (payload: unknown) =>
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        async () =>
          new Response(JSON.stringify(payload), {
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

  it("does not invent a remote Ashby role from a location when work mode is missing", async () => {
    respond({
      jobs: [
        {
          id: "one",
          title: "Engineer",
          location: "Worldwide",
          descriptionPlain: "Build tools.",
        },
      ],
    });
    const [job] = await discover(source("ashby"), demoWorkspace().preferences);
    expect(job.remoteScope).toBe("unknown");
    respond({
      jobs: [
        {
          id: "one",
          title: "Engineer",
          location: "Worldwide",
          workplaceType: "Remote",
          descriptionPlain: "Build tools.",
        },
      ],
    });
    const [remoteJob] = await discover(
      source("ashby"),
      demoWorkspace().preferences,
    );
    expect(remoteJob.remoteScope).toBe("worldwide");
    expect(remoteJob.location).toBe("Remote — Worldwide");
  });

  it("respects Greenhouse's hybrid location label despite remote company boilerplate", async () => {
    respond({
      jobs: [
        {
          id: 1,
          title: "Engineer",
          location: { name: "Bangalore (Hybrid)" },
          content: "Our other teams are fully remote worldwide.",
        },
      ],
    });
    const [job] = await discover(
      source("greenhouse"),
      demoWorkspace().preferences,
    );
    expect(job.remoteScope).toBe("onsite");
  });

  it("uses Lever's explicit remote workplace mode without inventing worldwide eligibility", async () => {
    respond([
      {
        id: "one",
        text: "Engineer",
        workplaceType: "remote",
        categories: { location: "India" },
        descriptionPlain: "Build tools.",
      },
    ]);
    const [india] = await discover(
      source("lever"),
      demoWorkspace().preferences,
    );
    expect(india.remoteScope).toBe("unknown");
    expect(india.location).toBe("Remote — India");
    respond([
      {
        id: "two",
        text: "Engineer",
        workplaceType: "remote",
        categories: { location: "LATAM" },
        descriptionPlain: "Build tools.",
      },
    ]);
    const [latam] = await discover(
      source("lever"),
      demoWorkspace().preferences,
    );
    expect(latam.remoteScope).toBe("latam");
  });

  it("does not accept an onsite Jobicy listing just because its feed geography says worldwide", async () => {
    respond({
      jobs: [
        {
          id: "one",
          url: "https://jobicy.com/jobs/one",
          jobTitle: "Engineer",
          jobGeo: "Worldwide",
          jobDescription: "This is an on-site role in Bangalore.",
        },
      ],
    });
    const [job] = await discover(source("jobicy"), demoWorkspace().preferences);
    expect(job.remoteScope).toBe("onsite");
  });
});
