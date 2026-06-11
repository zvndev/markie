import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { auth } from "./auth.ts";
import { docs } from "./docs.ts";
import { shares } from "./shares.ts";
import { comments } from "./comments.ts";
import { attachCollab } from "./collab.ts";

const app = new Hono();

app.use(
  "*",
  cors({
    origin: ["app://markie", "http://localhost:3000"],
    credentials: true,
    exposeHeaders: ["set-auth-token"],
  })
);

app.get("/health", (c) =>
  c.json({ ok: true, service: "markie-api", version: "0.1.0" })
);

app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

app.route("/api/docs", docs);
app.route("/api/docs", shares);
app.route("/api/docs", comments);

app.get("/api/me", async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ user: null });
  return c.json({
    user: {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
    },
  });
});

const port = Number(process.env.PORT ?? 8787);
const server = serve({ fetch: app.fetch, port });
attachCollab(server as Parameters<typeof attachCollab>[0]);
console.log(`markie-api listening on :${port}`);
