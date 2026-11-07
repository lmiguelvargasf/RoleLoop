export function routePage(hash: string) {
  return hash.replace(/^#/, "").split("?")[0];
}

export function routeOpportunity(hash: string) {
  return new URLSearchParams(hash.split("?")[1] || "").get("opportunity");
}
