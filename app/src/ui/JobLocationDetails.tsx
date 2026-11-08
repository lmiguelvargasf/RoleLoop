import { ChevronDown } from "lucide-react";
import type { Opportunity, Preferences } from "../shared/types";
import { jobLocationAssessment } from "../shared/job-matches";
import { assessGeography } from "../domain/geography";
import "./JobLocationDetails.css";

export function JobLocationDetails({ location }: { location: string }) {
  const locations = location.split(";").filter((part) => part.trim());
  const long = location.length > 100 || locations.length > 3;
  return (
    <div className="job-location">
      <small>Location</small>
      {long ? (
        <details key={location} className="job-location-details">
          <summary>
            <span>
              {/^\s*remote\b/i.test(location) ? "Remote" : "Location details"}
            </span>
            <span className="job-location-count">
              {locations.length > 1
                ? `${locations.length} listed locations`
                : "View full location"}
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
  return (
    <div className="job-hiring-location">
      <small>Hiring from {preferences.country || "your country"}</small>
      <span>
        {geography.status === "eligible"
          ? "Eligible location"
          : geography.status === "excluded"
            ? "Outside hiring area"
            : countrySupported
              ? "Confirm time zone"
              : "Needs confirmation"}
      </span>
      {geography.reasons.length > 0 && (
        <p className="job-location-reason">
          {countrySupported
            ? "The country is supported. Check that your local UTC offset is allowed."
            : geography.reasons.join(" ")}
        </p>
      )}
      {opportunity.sourceTimezoneRestrictions?.length ? (
        <details className="job-location-details job-timezone-details">
          <summary>
            <span>Allowed UTC offsets</span>
            <ChevronDown size={14} aria-hidden="true" />
          </summary>
          <p
            className="job-location-full"
            tabIndex={0}
            role="region"
            aria-label="Allowed UTC offsets"
          >
            {opportunity.sourceTimezoneRestrictions
              .map((offset) => {
                const minutes = Math.round(Math.abs(offset) * 60);
                const hours = String(Math.floor(minutes / 60)).padStart(2, "0");
                const remainder = String(minutes % 60).padStart(2, "0");
                return `UTC${offset >= 0 ? "+" : "−"}${hours}:${remainder}`;
              })
              .join(", ")}
          </p>
        </details>
      ) : null}
    </div>
  );
}
