export type AppRoute = "classic" | "workbench";

export function appRoute(search: string, _desktop: boolean, development: boolean): AppRoute {
  const params = new URLSearchParams(search);
  if (development && params.get("documents") === "1") return "workbench";
  return "classic";
}
