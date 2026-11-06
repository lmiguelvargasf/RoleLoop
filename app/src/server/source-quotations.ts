// Match whitespace and Unicode presentation differences while retaining the original
// spelling and offsets. These offsets are relative to extracted text, not PDF bytes.
export function indexSourceText(text: string) {
  let normalized = "";
  const starts: number[] = [];
  const ends: number[] = [];
  const segments = new Intl.Segmenter(undefined, {
    granularity: "grapheme",
  }).segment(text);
  for (const { segment, index } of segments) {
    for (const character of segment.normalize("NFKC").toLowerCase()) {
      if (/\s/u.test(character)) {
        if (!normalized) continue;
        if (normalized.endsWith(" ")) {
          ends[ends.length - 1] = index + segment.length;
          continue;
        }
        normalized += " ";
        starts.push(index);
        ends.push(index + segment.length);
      } else {
        normalized += character;
        // String indices use UTF-16 code units, including surrogate pairs.
        for (let i = 0; i < character.length; i++) {
          starts.push(index);
          ends.push(index + segment.length);
        }
      }
    }
  }
  if (normalized.endsWith(" ")) {
    normalized = normalized.slice(0, -1);
    starts.pop();
    ends.pop();
  }
  return { text, normalized, starts, ends };
}

export function findSourceQuotation(
  source: ReturnType<typeof indexSourceText>,
  quotation: string,
) {
  const normalized = quotation
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  const index = source.normalized.indexOf(normalized);
  if (index < 0) return null;
  const start = source.starts[index];
  const end = source.ends[index + normalized.length - 1];
  return { start, end, text: source.text.slice(start, end) };
}
