import { createDraft } from "../domain/templates.js";
import { draftContentHash } from "../domain/rules.js";
import type { Assessment, Opportunity, Workspace } from "../shared/types.js";

export async function generateDraft(
  op: Opportunity,
  workspace: Workspace,
  assessment: Assessment,
) {
  // OpenAI fit assessments already select the relevant confirmed career facts.
  const draft = createDraft(
    op,
    workspace.profile,
    workspace.preferences,
    assessment,
  );
  if (assessment.fitSummary) {
    draft.generator = "openai";
    draft.warnings.push(
      "OpenAI selected relevant career facts. Evidence templates rendered the text; review the final wording.",
    );
    draft.contentHash = draftContentHash(draft);
  }
  return draft;
}
