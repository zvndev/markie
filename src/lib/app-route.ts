export type AppRoute = "classic" | "documents" | "workbench";

export function appRoute(search: string, desktop: boolean, development: boolean): AppRoute {
  const params = new URLSearchParams(search);
  if (development && params.get("documents") === "1") return "workbench";
  if (params.get("classic") === "1") return "classic";
  return !desktop || params.get("workspace") === "1" ? "documents" : "classic";
}
