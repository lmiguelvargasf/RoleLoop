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
  return (
    <div className="job-hiring-location">
      <section className="job-country-eligibility">
        <small>Can I apply from {country}?</small>
        <span>
          {locationMatches
            ? "Location matches the listing"
            : geography.status === "excluded"
              ? "Outside the listed hiring area"
              : "Check with the employer"}
        </span>
        {locationMatches && (
          <p className="job-location-reason">
            The listing includes {country}. Confirm the hiring arrangement with
            the employer.
          </p>
        )}
        {geography.reasons.length > 0 && !countrySupported && (
          <p className="job-location-reason">
            {geography.reasons.map(explainLocationReason).join(" ")}
          </p>
        )}
      </section>
      <JobTimezoneRequirements
        offsets={opportunity.sourceTimezoneRestrictions ?? []}
        country={country}
      />
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
  const mainland = offsets.includes(-5);
  const summary = unrestricted
    ? "No time-zone restriction listed"
    : ecuador
      ? mainland
        ? "Mainland Ecuador time is included"
        : "Mainland Ecuador time is not listed"
      : "Confirm that your local time zone is included";
  return (
    <section
      className="job-timezone-requirements"
      aria-label="Time-zone requirements"
    >
      <small>Time-zone requirements</small>
      <p className="job-timezone-summary">{summary}</p>
      <p className="job-location-reason">
        {unrestricted || (ecuador && mainland)
          ? "Confirm the expected working hours with the employer."
          : "Ask whether your location is accepted, even if you can adapt your working hours."}
      </p>
      <details className="job-location-details job-timezone-details">
        <summary>
          <span>View source time zones</span>
          <ChevronDown size={14} aria-hidden="true" />
        </summary>
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
      </details>
    </section>
  );
}
