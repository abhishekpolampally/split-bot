// TEMPORARY: diagnosing ERR_REQUIRE_ESM from firebase-admin/auth on Vercel. Runs once per
// server instance, before any route module loads, so it prints even when a route's imports fail.
// Delete this file once the cause is known.
export function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  console.log(
    "[runtime]",
    process.version,
    "require_module:",
    (process.features as { require_module?: boolean }).require_module,
    "execArgv:",
    JSON.stringify(process.execArgv),
    "NODE_OPTIONS:",
    JSON.stringify(process.env.NODE_OPTIONS ?? ""),
  );
}
