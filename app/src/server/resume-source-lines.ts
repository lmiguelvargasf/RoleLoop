export interface ResumeSourceLine {
  id: number;
  text: string;
  start: number;
  end: number;
}

export const MAX_SOURCE_LINE_CHARS = 400;

// Model-facing IDs refer to exact source slices, not generated quotations.
// Long physical lines are split without dropping text or changing offsets.
export function indexResumeText(text: string): ResumeSourceLine[] {
  const lines: ResumeSourceLine[] = [];
  for (const match of text.matchAll(/[^\r\n]+/gu)) {
    let start = match.index;
    const lineEnd = start + match[0].length;
    while (start < lineEnd) {
      while (start < lineEnd && /\s/u.test(text[start])) start++;
      if (start === lineEnd) break;
      let end = Math.min(start + MAX_SOURCE_LINE_CHARS, lineEnd);
      if (end < lineEnd && !/\s/u.test(text[end])) {
        let boundary = end;
        while (boundary > start && !/\s/u.test(text[boundary])) boundary--;
        if (boundary > start) end = boundary;
        // Avoid splitting a surrogate pair in an unbroken token.
        else if (/[\uD800-\uDBFF]/u.test(text[end - 1])) end--;
      }
      while (end > start && /\s/u.test(text[end - 1])) end--;
      lines.push({
        id: lines.length + 1,
        text: text.slice(start, end),
        start,
        end,
      });
      start = end;
    }
  }
  return lines;
}

export function sourceLineRange(
  lines: ResumeSourceLine[],
  startLine: number,
  endLine: number,
) {
  if (
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine ||
    endLine > lines.length
  )
    return null;
  return { start: lines[startLine - 1].start, end: lines[endLine - 1].end };
}
