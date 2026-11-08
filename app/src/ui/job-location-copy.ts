export function explainLocationReason(reason: string): string {
  return reason.includes("specific UTC offsets")
    ? "Confirm that your working location and expected hours meet the employer’s time-zone requirements."
    : reason;
}
