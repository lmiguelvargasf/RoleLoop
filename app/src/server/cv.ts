import { createHash, randomUUID } from "node:crypto";
import {
  CV_EXTRACTOR_VERSION,
  careerFacts,
  type Profile,
} from "../shared/types.js";
import { extractFacts, readResume } from "./resume-import.js";
import type { WorkspaceStore } from "./store.js";

export async function processCV(
  store: WorkspaceStore,
  profile: Profile,
  text: string,
  userId: string,
) {
  if (!profile.source) throw new Error("Upload a master CV first.");
  const processing: Profile = {
    email: profile.email,
    source: profile.source,
    cache: {
      id: randomUUID(),
      sourceId: profile.source.id,
      extractorVersion: CV_EXTRACTOR_VERSION,
      status: "processing",
      facts: null,
      warnings: [],
      error: null,
      processedAt: null,
    },
  };
  await store.updateWorkspace({ profile: processing }, profile);
  let cache = processing.cache!;
  try {
    const result = await extractFacts(text, userId);
    cache = {
      ...cache,
      status: "ready",
      facts: result.facts,
      warnings: result.warnings,
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    cache = {
      ...cache,
      status: "failed",
      error:
        error instanceof Error
          ? error.message
          : "CV processing failed. Try again.",
      processedAt: new Date().toISOString(),
    };
  }
  // A newer upload or retry wins, even if this request finishes later.
  const saved = await store.updateWorkspace(
    { profile: { ...processing, cache } },
    processing,
  );
  await store.event(
    cache.status === "ready"
      ? "Master CV processed. Career facts are ready for matching and drafts."
      : "Master CV processing failed. Retry processing or replace the CV.",
    cache.status === "ready" ? "success" : "error",
  );
  return saved.profile;
}

export async function uploadCV(
  store: WorkspaceStore,
  name: string,
  buffer: Buffer,
  userId: string,
) {
  // Reject unreadable files before replacing the active CV.
  const { text, kind } = await readResume(name, buffer);
  const previous = (await store.getWorkspace()).profile;
  const source: NonNullable<Profile["source"]> = {
    id: randomUUID(),
    name,
    kind,
    importedAt: new Date().toISOString(),
    sha256: createHash("sha256").update(buffer).digest("hex"),
  };
  const uploaded = await store.db.storage
    .from("documents")
    .upload(
      `${store.workspaceId}/resumes/${source.id}/original.${kind}`,
      buffer,
      { contentType: cvContentType(kind) },
    );
  if (uploaded.error)
    throw new Error("The original CV could not be saved. Try again.");
  // Activate the source before extraction; the previous facts are removed immediately.
  const activated = await store.updateWorkspace(
    { profile: { email: previous.email, source, cache: null } },
    previous,
  );
  return processCV(store, activated.profile, text, userId);
}

export async function retryCV(store: WorkspaceStore, userId: string) {
  const profile = (await store.getWorkspace()).profile;
  if (careerFacts(profile)) return profile;
  if (!profile.source)
    throw Object.assign(new Error("Upload a master CV first."), {
      statusCode: 400,
    });
  const buffer = await originalCV(
    store,
    profile.source.id,
    profile.source.kind,
  );
  const { text } = await readResume(profile.source.name, buffer);
  return processCV(store, profile, text, userId);
}

export async function originalCV(
  store: WorkspaceStore,
  id: string,
  kind: "pdf" | "docx",
) {
  const result = await store.db.storage
    .from("documents")
    .download(`${store.workspaceId}/resumes/${id}/original.${kind}`);
  if (result.error || !result.data)
    throw Object.assign(new Error("This CV was not found in your workspace."), {
      statusCode: 404,
    });
  return Buffer.from(await result.data.arrayBuffer());
}
export const cvContentType = (kind: "pdf" | "docx") =>
  kind === "pdf"
    ? "application/pdf"
    : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
