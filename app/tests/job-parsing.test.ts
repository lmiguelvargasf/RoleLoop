import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discover,
  extractRequirements,
  remoteScope,
} from "../src/domain/connectors.js";
import type { Source } from "../src/shared/types.js";
import { demoWorkspace } from "./fixtures.js";

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
  ])("preserves remote choices without imposing another team's attendance: %s", (text) => {
    expect(remoteScope(text)).not.toBe("onsite");
  });

  it("retains required office attendance despite remote options on other days", () => {
    expect(
      remoteScope("Candidates can work remotely or use a hybrid work schedule, but must attend our office three days per week."),
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
      vi
        .fn()
        .mockImplementation(
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
