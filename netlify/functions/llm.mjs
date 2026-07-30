export default async (req) => {
  try {
    if (req.method !== "POST")
      return Response.json({ error: "POST only" }, { status: 405 });
    if (!process.env.OPENROUTER_API_KEY)
      return Response.json(
        { error: "OPENROUTER_API_KEY is not set in Netlify environment variables" },
        { status: 500 }
      );
    const { prompt } = await req.json();
    if (!prompt) return Response.json({ error: "missing prompt" }, { status: 400 });

    const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.LLM_MODEL || "anthropic/claude-sonnet-4.5",
        temperature: 0.2,
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await upstream.json();
    if (!upstream.ok)
      return Response.json(
        { error: data?.error?.message || `upstream HTTP ${upstream.status}` },
        { status: 502 }
      );
    return Response.json({
      text: data.choices?.[0]?.message?.content ?? "",
      model: data.model || process.env.LLM_MODEL || "openrouter",
    });
  } catch (e) {
    return Response.json({ error: String(e?.message || e) }, { status: 500 });
  }
};

export const config = { path: "/api/llm" };
