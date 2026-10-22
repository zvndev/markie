/** Independent Railway service. Deliberately does not boot the public server. */
import { serve } from "@hono/node-server";
import { createPrivateReleaseGateway } from "./private-releases.ts";

const port = Number(process.env.PORT ?? "8788");
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("Invalid service port");
serve({ fetch: createPrivateReleaseGateway().fetch, hostname: "0.0.0.0", port });
