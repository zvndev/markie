/** Independent Railway service. Deliberately does not boot the public server. */
import { serve } from "@hono/node-server";
import { installGracefulStop } from "./graceful-stop.ts";
import { createPrivateReleaseGateway } from "./private-releases.ts";

const port = Number(process.env.PORT ?? "8788");
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("Invalid service port");
const server = serve({ fetch: createPrivateReleaseGateway().fetch, hostname: "0.0.0.0", port });
// SIGTERM (docker stop) or SIGINT (Fly): requests in flight get up to 3 s, then
// the process exits. Without this, Node as a container's PID 1 ignores SIGTERM.
installGracefulStop({ name: "markie-nightly", server });
