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

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    return Response.json(data, { status: res.status });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
