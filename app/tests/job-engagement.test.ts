import { describe, expect, it } from "vitest";
import { jobEngagement } from "../src/shared/job-engagement.js";

const engagement = (description: string, title = "Software Engineer") =>
  jobEngagement({ title, description });

describe("explicit engagement facts", () => {
  it("distinguishes the G2i hourly contract without annualizing or guaranteeing its work", () => {
    expect(engagement("Contract | Remote, worldwide | $100-$200/hour depending on experience and location | 10-20 hrs/week\nHours: 10-20 hours/week, flexible\nProjects run from two weeks to a few months each.")).toEqual({
      kind: "contract", label: "Contract", contract: true,
      hoursPerWeek: { min: 10, max: 20 }, hoursLabel: "10–20 h/week",
    });
  });

  it("retains explicit full-time employment and part-time contracts", () => {
    expect(engagement("Employment type: Full-time\nHours: 40 hours per week")).toMatchObject({ kind: "full_time", hoursLabel: "40 h/week", contract: false });
    expect(engagement("This is a part-time contract role. 15–25 hours/week.")).toMatchObject({ kind: "contract", label: "Part-time contract", hoursLabel: "15–25 h/week" });
  });

  it("does not mistake experience or customer agreements for the position's employment type", () => {
    expect(engagement("Requirements: five years of full-time engineering experience. Build tools for contract management and client billing.")).toMatchObject({ kind: "unknown", hoursPerWeek: null, contract: false });
    expect(engagement("This is not a contract role. Employment type: Full-time.")).toMatchObject({ kind: "full_time", contract: false });
    expect(engagement("Build enterprise procurement software.", "Contract Management Engineer")).toMatchObject({ kind: "unknown", contract: false });
  });

  it("keeps unknown, bounded and conflicting hours from becoming guaranteed ranges", () => {
    expect(engagement("Contract position. Up to 20 hours/week.").hoursPerWeek).toBeNull();
    expect(engagement("Hours: 10–20 hours/week\nHours: 30–40 hours/week").hoursPerWeek).toBeNull();
    expect(engagement("Provide customer support coverage 168 hours/week.").hoursPerWeek).toBeNull();
    expect(engagement("Full-time role. No hours stated.").hoursPerWeek).toBeNull();
  });
});
