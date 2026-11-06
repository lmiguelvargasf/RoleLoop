export const MAX_DOCUMENT_LINK_CANDIDATES = 500;
export const MAX_DOCUMENT_LINKS = 50;
export const MAX_DOCUMENT_URL_CHARS = 1000;
export const MAX_DOCUMENT_LINK_CONTEXT_CHARS = 6000;
export const MAX_RESUME_TEXT_CHARS = 60000;
export const DOCUMENT_LINK_CONTEXT_HEADER =
  "\n\nEmbedded document links (hyperlink targets, not additional career evidence):\n";

// These are targets stored inside the document. Never request their contents.
export function appendDocumentLinks(
  text: string,
  candidates: Iterable<unknown>,
) {
  const seen = new Set<string>();
  const urls: string[] = [];
  let examined = 0;
  let truncated = false;
  let remaining =
    Math.min(
      MAX_DOCUMENT_LINK_CONTEXT_CHARS,
      MAX_RESUME_TEXT_CHARS - text.length,
    ) - DOCUMENT_LINK_CONTEXT_HEADER.length;
  for (const candidate of candidates) {
    if (++examined > MAX_DOCUMENT_LINK_CANDIDATES) {
      truncated = true;
      break;
    }
    if (
      typeof candidate !== "string" ||
      /[\u0000-\u001f\u007f]/u.test(candidate)
    )
      continue;
    if (candidate.length > MAX_DOCUMENT_URL_CHARS) {
      truncated = true;
      continue;
    }
    let url: URL;
    try {
      url = new URL(candidate.trim());
    } catch {
      continue;
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password
    )
      continue;
    const value = url.href;
    if (seen.has(value) || text.includes(value)) continue;
    seen.add(value);
    if (
      value.length > MAX_DOCUMENT_URL_CHARS ||
      urls.length >= MAX_DOCUMENT_LINKS ||
      value.length + 1 > remaining
    ) {
      truncated = true;
      continue;
    }
    urls.push(value);
    remaining -= value.length + 1;
  }
  return {
    text: urls.length
      ? text + DOCUMENT_LINK_CONTEXT_HEADER + urls.join("\n")
      : text,
    truncated,
  };
}
