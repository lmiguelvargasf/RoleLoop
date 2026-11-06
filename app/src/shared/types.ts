import { z } from "zod";

export const EvidenceSchema = z.object({
  id: z.string(),
  text: z.string().min(1).max(2000),
  skills: z.array(z.string()),
  verified: z.boolean(),
  role: z.string().default(""),
  company: z.string().default(""),
  period: z.string().default(""),
  category: z
    .enum(["experience", "project", "education", "certification", "other"])
    .optional(),
});
export const CareerFactsSchema = z.object({
  name: z.string().max(200),
  portfolio: z.string().max(500),
  evidence: z.array(EvidenceSchema),
});
export const CV_EXTRACTOR_VERSION = 1;
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
      processedAt: z.string().nullable(),
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
  scheduleMinutes: z.number().int().min(15).max(1440).default(120),
  dailyLimit: z.number().int().min(1).max(100).default(10),
});
export const SourceSchema = z.object({
  id: z.string(),
  provider: z.enum(["ashby", "greenhouse", "lever", "hackernews"]),
  label: z.string(),
  board: z.string(),
  enabled: z.boolean(),
});
export const RequirementSchema = z.object({
  id: z.string(),
  text: z.string(),
  skills: z.array(z.string()),
  essential: z.boolean(),
  hard: z.boolean().default(false),
});
export const AssessmentSchema = z.object({
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
  profileFingerprint: z.string(),
  startupSignals: z.array(z.string()).default([]),
});
export const OpportunitySchema = z.object({
  id: z.string(),
  kind: z.enum(["job", "startup"]),
  company: z.string(),
  title: z.string(),
  description: z.string().max(50000),
  url: z.string().max(2000),
  companyUrl: z.string().default(""),
  source: z.string(),
  sourceId: z.string().default(""),
  sourceKey: z.string(),
  isDemo: z.boolean().default(false),
  location: z.string().default("Unknown"),
  companyCountry: z.string().default("Unknown"),
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
  | "discover"
  | "analyze"
  | "draft"
  | "simulate"
  | "research";
export interface Run {
  requestedBy?: string;
  id: string;
  workspaceId?: string;
  action: RunAction;
  opportunityId?: string;
  sourceId?: string;
  draftId?: string;
  status: "queued" | "running" | "completed" | "failed";
  progress: number;
  message: string;
  createdAt: string;
  updatedAt: string;
}
export interface Activity {
  id: string;
  message: string;
  kind: "info" | "success" | "warning" | "error";
  opportunityId?: string;
  createdAt: string;
}
export interface Workspace {
  profile: Profile;
  preferences: Preferences;
  sources: Source[];
}
export interface WorkspaceAccess {
  id: string;
  name: string;
  role: "owner" | "manager";
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
  setupAvailable: boolean;
}
export interface Bootstrap extends Workspace {
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
