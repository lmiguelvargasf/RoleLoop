import { z } from "zod";

export const CareerCategorySchema = z.enum([
  "experience",
  "project",
  "education",
  "certification",
  "skills",
  "language",
  "other",
]);
export const EvidenceSchema = z.object({
  id: z.string(),
  text: z.string().min(1).max(2000),
  skills: z.array(z.string()),
  verified: z.boolean(),
  role: z.string().default(""),
  company: z.string().default(""),
  period: z.string().default(""),
  category: CareerCategorySchema.optional(),
  // UTF-16 offsets into the text read from the original document.
  source: z
    .object({ start: z.number().int().min(0), end: z.number().int().min(1) })
    .optional(),
});
export const CareerSectionSchema = z.object({
  id: z.string(),
  category: CareerCategorySchema,
  role: z.string(),
  company: z.string(),
  period: z.string(),
  sourceText: z.string().min(1),
  evidenceIds: z.array(z.string()).min(1),
});
export const CareerFactsSchema = z.object({
  name: z.string().max(200),
  portfolio: z.string().max(500),
  evidence: z.array(EvidenceSchema),
  sections: z.array(CareerSectionSchema).default([]),
});
export const CV_EXTRACTOR_VERSION = 2;
export const ProfileSchema = z.object({
  // Resolved from the workspace owner's account; never persisted here.
  email: z.string().max(200).default(""),
  source: z
    .object({
      id: z.string().uuid(),
      name: z.string().max(200),
      kind: z.enum(["pdf", "docx"]),
      importedAt: z.string(),
      sha256: z.string().length(64).optional(),
    })
    .nullable()
    .default(null),
  cache: z
    .object({
      id: z.string().uuid(),
      sourceId: z.string().uuid(),
      extractorVersion: z.number().int(),
      status: z.enum(["processing", "ready", "failed"]),
      facts: CareerFactsSchema.nullable(),
      warnings: z.array(z.string()),
      error: z.string().nullable(),
      errorCode: z.string().optional(),
      processedAt: z.string().nullable(),
      startedAt: z.string().optional(),
      expiresAt: z.string().optional(),
    })
    .nullable()
    .default(null),
});
// All consumers use this gate, including templates and offline matching.
export function careerFacts(profile: z.infer<typeof ProfileSchema>) {
  const cache = profile.cache;
  return cache?.status === "ready" &&
    cache.sourceId === profile.source?.id &&
    cache.extractorVersion === CV_EXTRACTOR_VERSION
    ? cache.facts
    : null;
}
export const PreferencesSchema = z.object({
  roles: z.array(z.string()),
  minimumSalary: z.number().min(0),
  targetSalary: z.number().min(0).nullable().default(null),
  salaryPolicy: z.enum(["overlap", "strict"]),
  salaryFlexibility: z.boolean().default(false),
  missingSalary: z.preprocess(
    (value) => (value === "include" ? "review" : value),
    z.enum(["review", "exclude"]),
  ),
  lookback: z.number().int().min(0).max(365),
  lookbackUnit: z.enum(["days", "months"]),
  dateMode: z.enum(["strict", "emphasize"]),
  essentialMatch: z.number().min(0).max(100),
  country: z.string(),
  companyCountry: z.string().default("United States"),
  industries: z.array(z.string()),
  industryPreference: z.enum(["any", "prefer"]).default("prefer"),
  topIndustries: z.array(z.string()).default([]),
  scheduleEnabled: z.boolean().default(false),
  discoverEmployers: z.boolean().default(true),
  scheduleMinutes: z.number().int().min(15).max(1440).default(120),
  dailyLimit: z.number().int().min(1).max(100).default(10),
});
export const CompanySchema = z.object({
  id: z.string(),
  name: z.string(),
  country: z.string().default("Unknown"),
  countrySource: z.string().nullable().default(null),
  website: z.string().nullable().default(null),
});
export type Company = z.infer<typeof CompanySchema>;
export const SourceSchema = z.object({
  id: z.string(),
  catalogId: z.string().optional(),
  kind: z.enum(["company_board", "job_feed", "startup_feed"]).optional(),
  companyId: z.string().optional(),
  companyName: z.string().optional(),
  provider: z.enum(["ashby", "greenhouse", "lever", "hackernews", "jobicy"]),
  label: z.string(),
  board: z.string(),
  enabled: z.boolean(),
  companyCountry: z.string().max(100).optional(),
  countrySource: z.string().url().max(2000).optional(),
  discoveredFrom: z.string().url().max(2000).optional(),
  discoveredAt: z.string().datetime().optional(),
});
export const RequirementSchema = z.object({
  id: z.string(),
  text: z.string(),
  skills: z.array(z.string()),
  essential: z.boolean(),
  hard: z.boolean().default(false),
});
export const JobGeographySchema = z.object({
  status: z.enum(["eligible", "review", "excluded"]),
  workingCountry: z.string(),
  reasons: z.array(z.string()),
});
export const AssessmentSchema = z.object({
  // Geography is derived data. Incomplete older snapshots must be rechecked,
  // not prevent the entire workspace from loading or imply eligibility.
  geography: JobGeographySchema.optional().catch(undefined),
  fitEvaluation: z
    .object({
      method: z.enum(["semantic", "skills", "none"]),
      status: z.enum(["complete", "partial", "not_evaluated"]),
      assessedRequired: z.number().int().nonnegative(),
      totalRequired: z.number().int().nonnegative(),
      concerns: z.array(z.string()).optional(),
    })
    .optional()
    .catch(undefined),
  fitSummary: z.string().optional(),
  learningGaps: z.array(z.string()).optional(),
  relevantEvidenceIds: z.array(z.string()).optional(),
  score: z.number(),
  essentialScore: z.number(),
  recommendation: z.enum(["ready", "review", "excluded"]),
  reasons: z.array(z.string()),
  blockers: z.array(z.string()),
  unknowns: z.array(z.string()),
  matches: z.array(
    z.object({
      requirementId: z.string(),
      requirement: z.string(),
      essential: z.boolean(),
      evidenceIds: z.array(z.string()),
      status: z.enum(["matched", "partial", "missing"]),
      explanation: z.string(),
    }),
  ),
  evaluatedAt: z.string(),
  rulesVersion: z.number().int().nonnegative().default(0),
  profileFingerprint: z.string(),
  preferencesFingerprint: z.string().optional(),
  startupSignals: z.array(z.string()).default([]),
});
export const OpportunitySchema = z.object({
  id: z.string(),
  kind: z.enum(["job", "startup"]),
  company: z.string(),
  companyId: z.string().optional(),
  title: z.string(),
  description: z.string().max(50000),
  descriptionTruncated: z.boolean().default(false),
  requirementsVersion: z.number().int().nonnegative().optional(),
  url: z.string().max(2000),
  companyUrl: z.string().default(""),
  source: z.string(),
  sourceId: z.string().default(""),
  sourceKey: z.string(),
  isDemo: z.boolean().default(false),
  location: z.string().default("Unknown"),
  companyCountry: z.string().default("Unknown"),
  companyCountrySource: z.string().url().max(2000).optional(),
  remoteScope: z
    .enum(["worldwide", "latam", "us", "onsite", "unknown"])
    .default("unknown"),
  salaryMin: z.number().nullable().default(null),
  salaryMax: z.number().nullable().default(null),
  salaryCurrency: z.string().default("USD"),
  salaryPeriod: z.enum(["year", "month", "hour", "unknown"]).default("year"),
  publishedAt: z
    .string()
    .refine((value) => Number.isFinite(Date.parse(value)), "Use a valid date")
    .nullable()
    .default(null),
  firstSeenAt: z.string(),
  updatedAt: z.string(),
  requirements: z.array(RequirementSchema).default([]),
  signals: z.array(z.string()).default([]),
  contactName: z.string().default(""),
  contactEmail: z.string().default(""),
  contactSource: z.string().default(""),
  stage: z
    .enum([
      "new",
      "review",
      "ready",
      "drafted",
      "approved",
      "tested",
      "archived",
    ])
    .default("new"),
  application: z
    .object({
      status: z
        .enum([
          "saved",
          "applied",
          "interview",
          "offer",
          "rejected",
          "withdrawn",
        ])
        .default("saved"),
      appliedAt: z.string().datetime().nullable().default(null),
      interviewAt: z.string().datetime().nullable().optional(),
      offerAt: z.string().datetime().nullable().optional(),
      nextAction: z.string().max(1000).default(""),
      followUpOn: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .nullable()
        .default(null),
      notes: z.string().max(10000).default(""),
    })
    .optional(),
  assessment: AssessmentSchema.nullable().default(null),
  notes: z.string().default(""),
});
export const DraftSchema = z.object({
  id: z.string(),
  opportunityId: z.string(),
  kind: z.enum(["application", "outreach"]),
  subject: z.string(),
  body: z.string(),
  resume: z.string(),
  coverLetter: z.string(),
  answers: z.array(z.object({ question: z.string(), answer: z.string() })),
  evidenceIds: z.array(z.string()),
  warnings: z.array(z.string()),
  status: z.enum(["draft", "approved", "tested"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  profileFingerprint: z.string(),
  opportunityFingerprint: z.string(),
  preferencesFingerprint: z.string().default(""),
  contentHash: z.string(),
  artifactPath: z.string().nullable().default(null),
  testReceipt: z.string().nullable().default(null),
  generator: z
    .enum(["templates", "openai", "legacy"])
    .catch("legacy")
    .default("templates"),
});
export type Profile = z.infer<typeof ProfileSchema>;
export type Preferences = z.infer<typeof PreferencesSchema>;
export type Source = z.infer<typeof SourceSchema>;
export type Opportunity = z.infer<typeof OpportunitySchema>;
export type Assessment = z.infer<typeof AssessmentSchema>;
export type Draft = z.infer<typeof DraftSchema>;
export type Requirement = z.infer<typeof RequirementSchema>;
export type RunAction =
  "discover" | "analyze" | "draft" | "simulate" | "research";
export interface Run {
  requestedBy?: string;
  id: string;
  workspaceId?: string;
  action: RunAction;
  opportunityId?: string;
  sourceId?: string;
  discoveryScope?: "jobs" | "startups";
  draftId?: string;
  status: "queued" | "running" | "completed" | "failed";
  progress: number;
  message: string;
  outcome?: "success" | "partial";
  summary?: {
    evaluated: number;
    newOpportunities: number;
    existingOpportunities: number;
    draftsCreated: number;
    sourcesChecked: number;
    sourcesFailed: number;
    companiesConnected: number;
    draftFailures: number;
  };
  createdAt: string;
  updatedAt: string;
}
export interface Activity {
  id: string;
  message: string;
  kind: "info" | "success" | "warning" | "error";
  opportunityId?: string;
  runId?: string;
  category?:
    | "search"
    | "evaluation"
    | "research"
    | "draft"
    | "resume"
    | "preferences"
    | "application"
    | "workspace";
  createdAt: string;
}
export interface Workspace {
  profile: Profile;
  preferences: Preferences;
  sources: Source[];
  sourcesRevision?: number;
  companies?: Company[];
}
export interface WorkspaceAccess {
  id: string;
  name: string;
  role: "owner";
  ownerUserId: string;
}
export interface AccountContext {
  user: { id: string; email: string; name: string };
  isAdmin: boolean;
  workspaces: WorkspaceAccess[];
}
export interface AuthConfig {
  supabaseUrl: string;
  anonKey: string;
}
export interface SourceHealth {
  checkedAt: string;
  status: "success" | "error";
  found: number;
  evaluated: number;
  error?: string;
}
export interface EmployerDiscoveryReport {
  checkedAt: string;
  status: "success" | "partial" | "error" | "needs_preferences";
  message: string;
  companiesFound: number;
  boardsConnected: number;
  boardsChecked: number;
}
export interface Bootstrap extends Workspace {
  sourceHealth?: Record<string, SourceHealth>;
  employerDiscovery?: EmployerDiscoveryReport;
  opportunities: Opportunity[];
  drafts: Draft[];
  runs: Run[];
  events: Activity[];
  status: {
    database: boolean;
    worker: boolean;
    testMode: true;
    openaiConfigured: boolean;
    openaiModel: string;
    studioUrl: string;
    mailpitUrl: string;
  };
}

export interface ChatGPTConnection {
  modelsError?: string;
  mode: "api" | "chatgpt";
  activeId?: string;
  apiConfigured: boolean;
  pending: boolean;
  error?: string;
  profiles: {
    id: string;
    label: string;
    email?: string;
    connected: boolean;
    planEnabled: boolean;
    model?: string;
    error?: string;
    models: { slug: string; displayName: string }[];
  }[];
}
