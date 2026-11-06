export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
type ApiContext = {
  token: string | null;
  workspaceId: string | null;
  userId: string | null;
};
let context: ApiContext = { token: null, workspaceId: null, userId: null };
export function setApiContext(next: ApiContext) {
  if (
    context.token !== next.token ||
    context.workspaceId !== next.workspaceId ||
    context.userId !== next.userId
  )
    context = next;
}
export function clearApiContext() {
  context = { token: null, workspaceId: null, userId: null };
}
async function request(path: string, options?: RequestInit) {
  const captured = context;
  const headers = new Headers(options?.headers);
  if (!headers.has("Content-Type"))
    headers.set("Content-Type", "application/json");
  if (captured.token) headers.set("Authorization", `Bearer ${captured.token}`);
  if (captured.workspaceId) headers.set("X-Workspace-Id", captured.workspaceId);
  const response = await fetch(`/api${path}`, { ...options, headers });
  if (captured !== context)
    throw new DOMException(
      "The active account or workspace changed.",
      "AbortError",
    );
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    if (captured !== context)
      throw new DOMException(
        "The active account or workspace changed.",
        "AbortError",
      );
    const message =
      typeof data.error === "string"
        ? data.error
        : data.message || `Request failed (${response.status})`;
    if (
      captured.token &&
      (response.status === 401 ||
        (response.status === 403 && data.code === "WORKSPACE_ACCESS_DENIED"))
    )
      window.dispatchEvent(
        new CustomEvent("roleloop-access-error", {
          detail: {
            status: response.status,
            workspaceId: captured.workspaceId,
          },
        }),
      );
    throw new ApiError(message, response.status);
  }
  return response;
}
export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const captured = context;
  const result = (await (await request(path, options)).json()) as T;
  if (captured !== context)
    throw new DOMException(
      "The active account or workspace changed.",
      "AbortError",
    );
  return result;
}
export async function downloadFile(path: string, fallbackName: string) {
  const captured = context;
  const response = await request(path);
  const blob = await response.blob();
  if (captured !== context)
    throw new DOMException(
      "The active account or workspace changed.",
      "AbortError",
    );
  const name =
    response.headers
      .get("content-disposition")
      ?.match(/filename="([^"]+)"/)?.[1] || fallbackName;
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const write = <T>(path: string, body: unknown = {}, method = "POST") =>
  api<T>(path, { method, body: JSON.stringify(body) });
export const uid = () => crypto.randomUUID();
export const words = (text: string) =>
  text
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
export const date = (value: string | null) =>
  value && Number.isFinite(Date.parse(value))
    ? new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
      }).format(new Date(value))
    : "Date unknown";
export const safeUrl = (value: string) => {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
};
