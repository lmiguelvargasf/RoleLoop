import { ChevronDown } from "lucide-react";
import type { Opportunity, Preferences } from "../shared/types";
import { jobLocationAssessment } from "../shared/job-matches";
import { explainLocationReason } from "./job-location-copy";
import {
  assessGeography,
  hasUnrestrictedTimezones,
  normalizeCountry,
} from "../domain/geography";
import "./JobLocationDetails.css";

function locationSummary(location: string) {
  const locations = location.split(";").filter((part) => part.trim());
  return {
    long: location.length > 100 || locations.length > 3,
    label: /^\s*remote\b/i.test(location) ? "Remote" : "Location details",
    count:
      locations.length > 1
        ? `${locations.length} listed locations`
        : "View full location",
  };
}

export function JobLocationPreview({ location }: { location: string }) {
  const summary = locationSummary(location);
  return (
    <span className="job-location-preview">
      {summary.long
        ? `${summary.label} · ${summary.count}`
        : location || "Location to confirm"}
    </span>
  );
}

export function JobLocationDetails({ location }: { location: string }) {
  const summary = locationSummary(location);
  return (
    <div className="job-location">
      <small>Location</small>
      {summary.long ? (
        <details key={location} className="job-location-details">
          <summary>
            <span>{summary.label}</span>
            <span className="job-location-count">
              {summary.count}
            </span>
            <ChevronDown size={14} aria-hidden="true" />
          </summary>
          <p
            className="job-location-full"
            tabIndex={0}
            role="region"
            aria-label="Full listed location"
          >
            {location}
          </p>
        </details>
      ) : (
        <span>{location || "Location to confirm"}</span>
      )}
    </div>
  );
}

export function JobHiringLocation({
  opportunity,
  preferences,
}: {
  opportunity: Opportunity;
  preferences: Preferences;
}) {
  const geography = jobLocationAssessment(opportunity, preferences);
  const timezoneOnly =
    geography.status === "review" &&
    geography.reasons.length > 0 &&
    geography.reasons.every((reason) =>
      /UTC offsets|time.zone|working hours/i.test(reason),
    );
  const countrySupported =
    timezoneOnly &&
    assessGeography(
      { ...opportunity, sourceTimezoneRestrictions: [] },
      preferences.country,
    ).status === "eligible";
  const country = preferences.country.trim() || "your country";
  const locationMatches = geography.status === "eligible" || countrySupported;
  const offsets = opportunity.sourceTimezoneRestrictions ?? [];
  const restricted = offsets.length > 0 && !hasUnrestrictedTimezones(offsets);
  const timeZoneNeedsReview =
    restricted &&
    (normalizeCountry(country) !== "ecuador" || !offsets.includes(-5));
  const reasons = countrySupported ? [] : geography.reasons;
  return (
    <div className="job-hiring-location">
      <span className="job-hiring-summary">
        {locationMatches
          ? timeZoneNeedsReview
            ? `${country} listed · Check time zone`
            : `Open to applicants in ${country}`
          : geography.status === "excluded"
            ? `Not open to applicants in ${country}`
            : `Hiring from ${country} needs confirmation`}
      </span>
      {(offsets.length > 0 || reasons.length > 0) && (
        <details className="job-location-details job-hiring-details">
          <summary>
            <span>Location details</span>
            <ChevronDown size={14} aria-hidden="true" />
          </summary>
          <div className="job-hiring-evidence">
            {reasons.length > 0 && (
              <p className="job-location-reason">
                {reasons.map(explainLocationReason).join(" ")}
              </p>
            )}
            <JobTimezoneRequirements offsets={offsets} country={country} />
          </div>
        </details>
      )}
    </div>
  );
}

function JobTimezoneRequirements({
  offsets,
  country,
}: {
  offsets: number[];
  country: string;
}) {
  if (!offsets.length) return null;
  const unrestricted = hasUnrestrictedTimezones(offsets);
  const ecuador = normalizeCountry(country) === "ecuador";
  const ecuadorTime = offsets.includes(-5);
  const summary = unrestricted
    ? "No time-zone restriction listed"
    : ecuador
      ? ecuadorTime
        ? "Ecuador time is supported"
        : "Confirm the time-zone requirement"
      : "Confirm that your local time zone is included";
  return (
    <section
      className="job-timezone-requirements"
      aria-label="Time-zone requirements"
    >
      <p className="job-timezone-summary">{summary}</p>
      <p
        className="job-location-full"
        tabIndex={0}
        role="region"
        aria-label="Time zones listed by the source"
      >
        {offsets
          .map((offset) => {
            const minutes = Math.round(Math.abs(offset) * 60);
            const hours = String(Math.floor(minutes / 60)).padStart(2, "0");
            const remainder = String(minutes % 60).padStart(2, "0");
            return `UTC${offset >= 0 ? "+" : "−"}${hours}:${remainder}`;
          })
          .join(", ")}
      </p>
    </section>
  );
}
