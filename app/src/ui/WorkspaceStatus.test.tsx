import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { WorkspaceStatus } from "./WorkspaceStatus";

const render = (failure: Error | null) =>
  renderToStaticMarkup(
    <WorkspaceStatus failure={failure} onRetry={() => {}} />,
  );

describe("workspace loading failures", () => {
  it("reports a rejected workspace response without claiming the server is offline", () => {
    const error =
      "profile.name: Invalid input: expected string, received undefined";
    const html = render(new ApiError(error, 400));
    expect(html).toContain("Couldn’t load your workspace.");
    expect(html).toContain("The server responded");
    expect(html).toContain("restart RoleLoop");
    expect(html).toMatch(
      /<details[^>]*><summary>Technical details<\/summary><p>profile.name:/,
    );
    expect(html).not.toContain("Cannot reach");
    expect(html).not.toContain("npm run setup");
  });
  it("gives startup guidance when the network cannot reach the server", () => {
    const html = render(new TypeError("Failed to fetch"));
    expect(html).toContain("RoleLoop is unavailable.");
    expect(html).toContain("Cannot reach the local server.");
    expect(html).toContain("npm run dev");
    expect(html).not.toContain("The server responded");
  });
  it("handles application errors separately from proxy connection errors", () => {
    expect(render(new ApiError("Database unavailable", 500))).toContain(
      "The server responded",
    );
    expect(render(new ApiError("Bad Gateway", 502))).toContain(
      "Cannot reach the local server.",
    );
  });
  it("shows loading without error or recovery actions before the first response", () => {
    const html = render(null);
    expect(html).toContain("Opening your workspace…");
    expect(html).not.toContain("Technical details");
    expect(html).not.toContain("Try again");
  });
});
