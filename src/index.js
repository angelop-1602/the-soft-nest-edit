
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Test whether the D1 database is connected.
    if (url.pathname === "/api/health") {
      if (request.method !== "GET") {
        return new Response("Method not allowed", { status: 405 });
      }

      try {
        if (!env.DB) {
          throw new Error("D1 binding missing");
        }

        const result = await env.DB
          .prepare("SELECT 1 AS connected")
          .first();

        return Response.json(
          { ok: result?.connected === 1, database: "connected" },
          { headers: { "Cache-Control": "no-store" } }
        );
      } catch {
        return Response.json(
          { ok: false, database: "unavailable" },
          {
            status: 503,
            headers: { "Cache-Control": "no-store" }
          }
        );
      }
    }

    // Future PayPal and CJ API endpoints will go here.
    if (url.pathname.startsWith("/api/")) {
      return Response.json(
        { error: "Not found" },
        { status: 404 }
      );
    }

    // Keep serving the existing website normally.
    return env.ASSETS.fetch(request);
  }
};
