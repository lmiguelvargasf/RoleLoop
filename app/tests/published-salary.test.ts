import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discover,
  plainText,
  publishedSalary,
} from "../src/domain/connectors.js";
import { assessOpportunity } from "../src/domain/rules.js";
import { demoWorkspace } from "./fixtures.js";

afterEach(() => vi.unstubAllGlobals());

const enumeratedHtml =
  '<div class="content-pay-transparency"><div class="pay-input"><div class="title">Total monthly compensation:</div><div class="pay-range"><span>$3,200</span><span class="divider">&mdash;</span><span>$3,700 USD</span></div></div></div>';
const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

describe("published salary text", () => {
  it("reads the Automattic posting's published USD range without inventing a pay period", () => {
    expect(
      publishedSalary(
        "Experienced Software Engineer",
        "Salary range: $70,000-$170,000 USD. Salary ranges are global and paid in local currency.",
      ),
    ).toEqual({
      salaryMin: 70000,
      salaryMax: 170000,
      salaryCurrency: "USD",
      salaryPeriod: "unknown",
    });
  });
  it("reads CXT's explicit annual USD title salary", () => {
    expect(
      publishedSalary("SaaSOps Engineer ($80,000/year USD), @CXT Software", ""),
    ).toEqual({
      salaryMin: 80000,
      salaryMax: 80000,
      salaryCurrency: "USD",
      salaryPeriod: "year",
    });
  });

  it("keeps the stated CAD currency without conversion", () => {
    expect(
      publishedSalary(
        "AI-Native VP of Software Engineering, Canada-based (CAD $260,000/year)",
        "",
      ),
    ).toEqual({
      salaryMin: 260000,
      salaryMax: 260000,
      salaryCurrency: "CAD",
      salaryPeriod: "year",
    });
  });

  it("reads monthly pay from a labelled HTML widget after decoding escaped markup", () => {
    const description = plainText(escapeHtml(enumeratedHtml));
    expect(description).toBe("Total monthly compensation:\n$3,200—$3,700 USD");
    expect(publishedSalary("Full Stack Developer", description)).toEqual({
      salaryMin: 3200,
      salaryMax: 3700,
      salaryCurrency: "USD",
      salaryPeriod: "month",
    });
  });

  it("preserves an unstated pay period even when the amount looks annual", () => {
    expect(
      publishedSalary(
        "Software Engineer",
        "<p>Raised over $4 billion in donations.</p><li>Salary: $52,200-$58,000 USD, depending on experience and location</li><li>Reimbursement for home office expenses, up to $1.5k</li>",
      ),
    ).toEqual({
      salaryMin: 52200,
      salaryMax: 58000,
      salaryCurrency: "USD",
      salaryPeriod: "unknown",
    });
  });

  it.each([
    ["Engineer (OTE $150,000/year USD)", ""],
    ["Sales Manager", "On-target compensation: USD 150,000 per year"],
    ["Engineer", "Salary and benefits\nUSD 5,000 annual home-office allowance"],
    ["Engineer", "We manage an annual salary budget of USD 500,000."],
    [
      "Engineer",
      "Annual salary depends on experience.\nBenefits: USD 1,000 monthly reimbursement.",
    ],
    ["Engineer", "Compensation: USD 150,000/year including commission"],
    ["Engineer", "Annual revenue: USD 5,000,000.\nTeam budget: USD 200,000."],
  ])(
    "does not turn ambiguous or unrelated amounts into base salary: %s / %s",
    (title, description) => {
      expect(publishedSalary(title, description)).toBeNull();
    },
  );

  it.each([
    "Contract | Remote, worldwide | $100-$200/hour depending on experience and location | 10-20 hrs/week",
    "Rate: $100-$200/hour depending on experience and location",
  ])("preserves hourly contract pay without inventing its currency: %s", (description) => {
    expect(publishedSalary("Senior Software Engineer, AI Training", description)).toEqual({
      salaryMin: 100,
      salaryMax: 200,
      salaryCurrency: "Unknown",
      salaryPeriod: "hour",
    });
  });

  it("retains a dollar-denominated annual range with unknown currency", () => {
    expect(publishedSalary("Engineer", "Salary: $90,000-$120,000 per year")).toEqual({
      salaryMin: 90000,
      salaryMax: 120000,
      salaryCurrency: "Unknown",
      salaryPeriod: "year",
    });
  });

  it("does not interpret a published customer rate as employee pay", () => {
    expect(publishedSalary("Engineer", "Customer subscription rate: $100/hour.")).toBeNull();
  });

  it("extracts an explicit base component separately from bonus or OTE", () => {
    expect(
      publishedSalary(
        "Engineer",
        "Annual base salary: USD 100,000-120,000, plus a performance bonus and equity.",
      ),
    ).toEqual({
      salaryMin: 100000,
      salaryMax: 120000,
      salaryCurrency: "USD",
      salaryPeriod: "year",
    });
  });

  it.each([
    [
      "Pay: EUR 40–50 per hour",
      {
        salaryMin: 40,
        salaryMax: 50,
        salaryCurrency: "EUR",
        salaryPeriod: "hour",
      },
    ],
    [
      "Salary: GBP 60k–80k annually",
      {
        salaryMin: 60000,
        salaryMax: 80000,
        salaryCurrency: "GBP",
        salaryPeriod: "year",
      },
    ],
    [
      "Monthly salary: USD 3,000 to 4,000",
      {
        salaryMin: 3000,
        salaryMax: 4000,
        salaryCurrency: "USD",
        salaryPeriod: "month",
      },
    ],
    [
      "Salary: up to USD 120,000/year",
      {
        salaryMin: null,
        salaryMax: 120000,
        salaryCurrency: "USD",
        salaryPeriod: "year",
      },
    ],
    [
      "Salary starts at USD 100,000/year",
      {
        salaryMin: 100000,
        salaryMax: null,
        salaryCurrency: "USD",
        salaryPeriod: "year",
      },
    ],
  ])("preserves the stated unit and bounds: %s", (description, expected) => {
    expect(publishedSalary("Engineer", description as string)).toEqual(
      expected,
    );
  });

  it("does not choose arbitrarily between conflicting textual ranges", () => {
    expect(
      publishedSalary(
        "Engineer (USD 90,000/year)",
        "Salary: USD 120,000 per year",
      ),
    ).toBeNull();
  });

  it("strips known escaped markup and scripts while retaining requirement lines", () => {
    expect(
      plainText(
        escapeHtml(
          "<h2>Requirements</h2><p>React experience</p><script>hidden()</script><p>SQL experience</p>",
        ),
      ),
    ).toBe("Requirements\nReact experience\nSQL experience");
  });
});

describe("salary fallback in employer imports", () => {
  const state = demoWorkspace();
  const source = (provider: "ashby" | "lever" | "greenhouse") => ({
    id: "salary-check",
    provider,
    label: "Employer",
    board: "employer",
    enabled: true,
  });

  it("reads compensation after the stored description limit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            jobs: [
              {
                id: 1,
                title: "Experienced Software Engineer",
                content: `<p>${"Role information. ".repeat(3200)}</p><p>Salary range: $70,000-$170,000 USD.</p>`,
                absolute_url: "https://example.com/jobs/1",
              },
            ],
          }),
        ),
      ),
    );
    const [op] = await discover(source("greenhouse"), state.preferences);
    expect(op).toMatchObject({
      salaryMin: 70000,
      salaryMax: 170000,
      salaryCurrency: "USD",
      salaryPeriod: "unknown",
      descriptionTruncated: true,
    });
    expect(op.description).not.toContain("Salary range");
  });

  it("uses the published salary when a Jobicy feed omits structured amounts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            jobs: [
              {
                id: 1,
                jobTitle: "Software Engineer",
                jobDescription: "Annual base salary: USD 100,000–120,000.",
                url: "https://jobicy.com/jobs/1",
              },
            ],
          }),
        ),
      ),
    );
    const [op] = await discover(
      { ...source("greenhouse"), provider: "jobicy" },
      state.preferences,
    );
    expect(op).toMatchObject({
      salaryMin: 100000,
      salaryMax: 120000,
      salaryCurrency: "USD",
      salaryPeriod: "year",
    });
  });

  it("excludes the real low-pay title example using the existing salary policy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify([
            {
              id: "one",
              text: "SaaSOps Engineer ($80,000/year USD), @CXT Software",
              descriptionPlain: "Remote worldwide.",
              hostedUrl: "https://jobs.lever.co/employer/one",
              categories: { location: "Remote worldwide" },
            },
          ]),
        ),
      ),
    );
    const [op] = await discover(source("lever"), state.preferences);
    expect(op.salaryMax).toBe(80000);
    expect(op.salaryPeriod).toBe("year");
    expect(
      assessOpportunity(op, state.profile, state.preferences).blockers,
    ).toContain("The advertised salary maximum is below your required floor.");
    expect(op.publishedAt).toBeNull();
  });

  it("extracts the monthly Greenhouse example without inventing a posting date", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            jobs: [
              {
                id: 1,
                title: "Full Stack Developer",
                content: escapeHtml(enumeratedHtml),
                absolute_url:
                  "https://job-boards.greenhouse.io/employer/jobs/1",
                updated_at: new Date().toISOString(),
              },
            ],
          }),
        ),
      ),
    );
    const [op] = await discover(source("greenhouse"), state.preferences);
    expect(op).toMatchObject({
      salaryMin: 3200,
      salaryMax: 3700,
      salaryCurrency: "USD",
      salaryPeriod: "month",
      publishedAt: null,
    });
    expect(
      assessOpportunity(op, state.profile, state.preferences).blockers,
    ).toContain("The advertised salary maximum is below your required floor.");
    expect(op.description).not.toContain("<div");
  });

  it("preserves a missing Greenhouse salary period as unknown", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            jobs: [
              {
                id: 1,
                title: "Software Engineer",
                content: escapeHtml(
                  "<li>Salary: $52,200-$58,000 USD, depending on experience and location</li>",
                ),
              },
            ],
          }),
        ),
      ),
    );
    const [op] = await discover(source("greenhouse"), state.preferences);
    expect(op).toMatchObject({
      salaryMin: 52200,
      salaryMax: 58000,
      salaryPeriod: "unknown",
    });
    expect(
      assessOpportunity(op, state.profile, state.preferences).unknowns,
    ).toContain(
      "Annual salary cannot be confirmed without contracted hours and pay-period details.",
    );
  });

  it("uses Ashby text only when no structured salary amount exists", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          jobs: [
            {
              id: "one",
              title: "Engineer ($80,000/year USD)",
              descriptionPlain: "Remote worldwide.",
            },
          ],
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(
      (await discover(source("ashby"), state.preferences))[0].salaryMin,
    ).toBe(80000);
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          jobs: [
            {
              id: "two",
              title: "Engineer ($80,000/year USD)",
              compensation: {
                summaryComponents: [
                  {
                    compensationType: "Salary",
                    currencyCode: "USD",
                    interval: "1 YEAR",
                    minValue: 100000,
                    maxValue: 120000,
                  },
                ],
              },
            },
          ],
        }),
      ),
    );
    expect(
      (await discover(source("ashby"), state.preferences))[0],
    ).toMatchObject({
      salaryMin: 100000,
      salaryMax: 120000,
      salaryPeriod: "year",
    });
  });

  it("keeps a partial structured Lever range instead of filling it from conflicting text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify([
            {
              id: "one",
              text: "Engineer ($80,000/year USD)",
              salaryRange: {
                min: null,
                max: 140000,
                currency: "USD",
                interval: "per-year-salary",
              },
            },
          ]),
        ),
      ),
    );
    expect(
      (await discover(source("lever"), state.preferences))[0],
    ).toMatchObject({
      salaryMin: null,
      salaryMax: 140000,
      salaryPeriod: "year",
    });
  });
});
