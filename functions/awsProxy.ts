import { createClientFromRequest } from 'npm:@base44/sdk@0.8.21';

const AWS_API_URL = Deno.env.get("AWS_API_URL") || "https://1h4kpspbs6.execute-api.us-east-1.amazonaws.com/prod";
const AWS_API_KEY = Deno.env.get("AWS_API_KEY") || "";

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const { method = "GET", path, payload } = body;

    console.log("[awsProxy] method:", method, "path:", path);

    if (!path) {
      return Response.json({ error: "Missing path" }, { status: 400 });
    }

    const url = `${AWS_API_URL}${path}`;

    const fetchOptions: RequestInit = {
      method,
      headers: {
        "x-api-key": AWS_API_KEY,
        "Content-Type": "application/json",
      },
    };

    if (method !== "GET" && method !== "DELETE" && payload) {
      fetchOptions.body = JSON.stringify(payload);
    }

    const res = await fetch(url, fetchOptions);
    const text = await res.text();
    console.log("[awsProxy] AWS status:", res.status, "body:", text.substring(0, 300));

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    // Always return 200 to callFunction — embed the real status in the response
    // so the frontend doesn't get errors for 201, 204, etc.
    if (res.status >= 200 && res.status < 300) {
      return Response.json(data, { status: 200 });
    } else {
      return Response.json({ error: data?.error || data?.message || text, aws_status: res.status }, { status: res.status });
    }
  } catch (error) {
    console.error("[awsProxy] Error:", error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
});
