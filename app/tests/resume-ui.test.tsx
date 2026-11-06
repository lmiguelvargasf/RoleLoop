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
    expect(html).toContain("Extract career details");
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
});
