import {
  OpportunitySchema,
  type Opportunity,
  type Workspace,
} from "../src/shared/types.js";

export function demoWorkspace(): Workspace {
  return {
    profile: {
      name: "Alex Morgan",
      headline: "Software engineer · sample profile",
      email: "alex@example.com",
      location: "Quito, Ecuador",
      country: "Ecuador",
      summary:
        "Demo candidate profile for testing the application. Replace these sample facts with your verified experience.",
      portfolio: "https://example.com/alex",
      skills: ["TypeScript", "React", "Node.js", "PostgreSQL", "Testing"],
      isDemo: true,
      evidence: [
        {
          id: "demo-e1",
          text: "Built and maintained a TypeScript and React application for an internal operations team.",
          skills: ["TypeScript", "React"],
          verified: true,
          role: "Software engineer",
          company: "Example Studio (fictional)",
          period: "2022–2024",
        },
        {
          id: "demo-e2",
          text: "Developed Node.js services and PostgreSQL data models with automated integration tests.",
          skills: ["Node.js", "PostgreSQL", "Testing"],
          verified: true,
          role: "Backend engineer",
          company: "Example Works (fictional)",
          period: "2024–2026",
        },
        {
          id: "demo-e3",
          text: "Collaborated asynchronously with designers and engineers across time zones.",
          skills: ["Communication", "Remote work"],
          verified: true,
          role: "Software engineer",
          company: "Example Works (fictional)",
          period: "2024–2026",
        },
      ],
    },
    preferences: {
      roles: ["Software Engineer", "Full Stack Engineer"],
      minimumSalary: 90000,
      targetSalary: 120000,
      salaryPolicy: "overlap",
      missingSalary: "review",
      lookback: 30,
      lookbackUnit: "days",
      dateMode: "emphasize",
      timezone: "America/Guayaquil",
      minimumMatch: 85,
      essentialMatch: 90,
      country: "Ecuador",
      companyCountry: "United States",
      industries: ["Developer tools", "B2B software"],
      scheduleEnabled: false,
      scheduleMinutes: 120,
      dailyLimit: 10,
      modelMode: "templates",
      ollamaModel: "",
    },
    sources: [
      {
        id: "hn-startups",
        provider: "hackernews",
        label: "Show HN · startup leads",
        board: "",
        enabled: true,
      },
    ],
  };
}
export function demoOpportunities(now = new Date()): Opportunity[] {
  const date = (days: number) =>
    new Date(now.getTime() - days * 86400000).toISOString();
  const base = {
    firstSeenAt: date(0),
    updatedAt: date(0),
    isDemo: true,
    source: "Sample opportunity",
    companyCountry: "United States",
    sourceId: "demo",
    remoteScope: "worldwide",
    location: "Remote · worldwide",
    salaryCurrency: "USD",
    salaryPeriod: "year",
    stage: "new",
  };
  const req = (
    id: string,
    text: string,
    skills: string[],
    essential = true,
  ) => ({ id, text, skills, essential, hard: false });
  return [
    OpportunitySchema.parse({
      ...base,
      id: "demo-job-northstar",
      kind: "job",
      company: "Northstar Tools",
      title: "Senior Full Stack Engineer",
      description:
        "Fictional role for testing. Build developer workflows with TypeScript, React, Node.js, and PostgreSQL. Required: TypeScript, React, Node.js and PostgreSQL. Preferred: automated testing. Fully remote worldwide; international contractors accepted.",
      url: "https://example.com/northstar/jobs/full-stack",
      sourceKey: "demo:northstar",
      salaryMin: 100000,
      salaryMax: 140000,
      publishedAt: date(0),
      requirements: [
        req("ns-1", "Build interfaces with TypeScript and React", [
          "TypeScript",
          "React",
        ]),
        req("ns-2", "Develop services with Node.js and PostgreSQL", [
          "Node.js",
          "PostgreSQL",
        ]),
        req("ns-3", "Write automated tests", ["Testing"], false),
      ],
      signals: ["Fictional sample: expanding the developer-tools team."],
    }),
    OpportunitySchema.parse({
      ...base,
      id: "demo-job-payload",
      kind: "job",
      company: "Payload Grove",
      title: "Software Engineer",
      description:
        "Fictional role for testing unknown facts. Build TypeScript services and AWS infrastructure. The remote hiring countries and salary are not yet published.",
      url: "https://example.com/payload/jobs/engineer",
      sourceKey: "demo:payload",
      remoteScope: "unknown",
      location: "Remote location to confirm",
      companyCountry: "Unknown",
      salaryMin: null,
      salaryMax: null,
      publishedAt: date(4),
      requirements: [
        req("pg-1", "Build TypeScript services", ["TypeScript"]),
        req("pg-2", "Maintain AWS infrastructure", ["AWS"]),
      ],
    }),
    OpportunitySchema.parse({
      ...base,
      id: "demo-job-signal",
      kind: "job",
      company: "Signal Harbor",
      title: "Frontend Engineer",
      description:
        "Fictional US-only remote role. Requires React. Work must be performed within the United States.",
      url: "https://example.com/signal/jobs/frontend",
      sourceKey: "demo:signal",
      remoteScope: "us",
      location: "Remote · United States only",
      salaryMin: 80000,
      salaryMax: 95000,
      publishedAt: date(2),
      requirements: [req("sh-1", "Build React interfaces", ["React"])],
    }),
    OpportunitySchema.parse({
      ...base,
      id: "demo-startup-orbit",
      kind: "startup",
      company: "Orbit Notes",
      title: "Engineering opportunity",
      description:
        "Fictional startup developing collaborative documentation for distributed teams. The product uses TypeScript, React and PostgreSQL. Example of a startup prospect without a published vacancy.",
      url: "https://example.com/orbit",
      companyUrl: "https://example.com/orbit",
      sourceKey: "demo:orbit",
      publishedAt: date(3),
      signals: [
        "Fictional sample: launched a collaborative editor for remote teams.",
      ],
      contactName: "Sam Example",
      contactEmail: "sam@example.com",
      contactSource: "https://example.com/orbit/team",
    }),
    OpportunitySchema.parse({
      ...base,
      id: "demo-startup-field",
      kind: "startup",
      company: "Fieldwork Labs",
      title: "Engineering opportunity",
      description:
        "Fictional startup building Node.js workflow software for small service businesses. Company location, remote policy and founder contact have not yet been verified.",
      url: "https://example.com/fieldwork",
      companyUrl: "https://example.com/fieldwork",
      sourceKey: "demo:fieldwork",
      companyCountry: "Unknown",
      remoteScope: "unknown",
      location: "Location and remote eligibility to confirm",
      publishedAt: date(8),
      signals: ["Fictional sample: published a product demonstration."],
    }),
  ];
}
