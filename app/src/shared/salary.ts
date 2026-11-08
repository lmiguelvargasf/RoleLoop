import type { Opportunity } from "./types.js";

export function salaryReviewMinimum(minimumSalary: number) {
  return Math.round(minimumSalary * 90) / 100;
}

export function formatOpportunitySalary(o: Opportunity) {
  if (o.salaryMin === null && o.salaryMax === null) return "Salary to confirm";
  const currency = o.salaryCurrency || "Unknown";
  const amount = (n: number | null) => {
    if (n === null) return "?";
    try {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency,
        maximumFractionDigits: 0,
        notation: n >= 1000 ? "compact" : "standard",
      }).format(n);
    } catch {
      return n.toLocaleString();
    }
  };
  const range =
    o.salaryMin === null
      ? `Up to ${amount(o.salaryMax)}`
      : o.salaryMax === null
        ? `${amount(o.salaryMin)}+`
        : o.salaryMin === o.salaryMax
          ? amount(o.salaryMin)
          : `${amount(o.salaryMin)}–${amount(o.salaryMax)}`;
  const formatted =
    o.salaryPeriod === "unknown"
      ? `${range} · period unconfirmed`
      : `${range} / ${o.salaryPeriod}`;
  return !currency || /^unknown$/i.test(currency)
    ? `${formatted} · currency unconfirmed`
    : formatted;
}
