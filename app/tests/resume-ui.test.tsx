import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ResumePage } from "../src/ui/ResumePage";
import { demoWorkspace } from "./fixtures";

const render = (profile = demoWorkspace().profile) =>
  renderToStaticMarkup(
    <ResumePage initial={profile} busy={false} perform={async () => true} />,
  );

describe("resume evidence visibility", () => {
  it("does not expose stale facts after the extractor changes", () => {
    const profile = demoWorkspace().profile;
    profile.cache!.extractorVersion--;
    const html = render(profile);
    expect(html).toContain("Ready for a fresh extraction");
    expect(html).not.toContain("Alex Morgan");
    expect(html).not.toContain("Built and maintained");
    expect(html).toContain("Extract details");
  });

  it.each(["processing", "failed"] as const)(
    "hides old facts while extraction is %s",
    (status) => {
      const profile = demoWorkspace().profile;
      profile.cache!.status = status;
      profile.cache!.error =
        status === "failed" ? "The document needs readable text." : null;
      const html = render(profile);
      expect(html).not.toContain("Alex Morgan");
      expect(html).not.toContain("Built and maintained");
      expect(html).toContain("Retry extraction");
      if (status === "failed")
        expect(html).toContain("The document needs readable text.");
    },
  );

  it("renders original text as text and rejects executable portfolio links", () => {
    const profile = demoWorkspace().profile;
    profile.cache!.facts!.portfolio = "javascript:alert(1)";
    profile.cache!.facts!.evidence[0].text =
      '<script>alert("not instructions")</script>';
    const html = render(profile);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain('href="javascript:');
  });

  it("offers upload without presenting invented facts for an empty workspace", () => {
    const html = render({ email: "", source: null, cache: null });
    expect(html).toContain("Upload resume");
    expect(html).not.toContain("Career details");
    expect(html).not.toContain("Clear extracted details");
  });

  it("does not offer duplicate extraction while the saved attempt is active", () => {
    const profile = demoWorkspace().profile;
    profile.cache!.status = "processing";
    profile.cache!.startedAt = new Date().toISOString();
    profile.cache!.expiresAt = new Date(Date.now() + 300_000).toISOString();
    const html = render(profile);
    expect(html).toContain("Reading your resume");
    expect(html).not.toContain("Retry extraction");
    expect(html).not.toContain("Alex Morgan");
  });

  it("offers recovery when a processing attempt has expired", () => {
    const profile = demoWorkspace().profile;
    profile.cache!.status = "processing";
    profile.cache!.expiresAt = new Date(Date.now() - 1000).toISOString();
    const html = render(profile);
    expect(html).toContain("Extraction didn’t finish");
    expect(html).toContain("Retry extraction");
    expect(html).not.toContain("Reading your resume");
  });

  it("explains legacy timeouts without blaming the source document", () => {
    const profile = demoWorkspace().profile;
    profile.cache!.status = "failed";
    profile.cache!.error = "The operation was aborted due to timeout";
    const html = render(profile);
    expect(html).toContain("The AI service took too long");
    expect(html).toContain("original resume is saved");
    expect(html).not.toContain("Your resume needs another look");
  });

  it("makes partial extraction visible before the notes are expanded", () => {
    const profile = demoWorkspace().profile;
    profile.cache!.warnings = ["One page had no readable text."];
    const html = render(profile);
    expect(html).toContain("Some details may be missing");
    expect(html).toContain("Review extraction notes");
    expect(html).toContain("One page had no readable text.");
    expect(html).not.toContain("Ready to review");
  });

  it("offers replacement rather than a no-op retry when extraction returns no facts", () => {
    const profile = demoWorkspace().profile;
    profile.cache!.facts = {
      name: "",
      portfolio: "",
      sections: [],
      evidence: [],
    };
    const html = render(profile);
    expect(html).toContain("No details could be extracted");
    expect(html).toContain("Replace resume");
    expect(html).not.toContain("Ready to review");
    expect(html).not.toContain("Retry extraction");
  });
});
