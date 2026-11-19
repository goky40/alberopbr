export default {
  async fetch(request, env, ctx) {
    const allowedOrigin = "https://goky40.github.io";
    const statusUrl = "https://goky40.github.io/alberopbr/status.json";
    const origin = request.headers.get("Origin") || "";

    const corsHeaders = {
      "Access-Control-Allow-Origin": origin === allowedOrigin ? allowedOrigin : allowedOrigin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== "POST" || origin !== allowedOrigin) {
      return new Response(JSON.stringify({ error: "Forbidden origin or method" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    try {
      const statusResp = await fetch(statusUrl, { cf: { cacheTtl: 60, cacheEverything: true } });
      if (statusResp.ok) {
        const statusData = await statusResp.json();
        if (statusData.maintenance === true || statusData.ai_enabled === false) {
          return new Response(
            JSON.stringify({
              error: statusData.message || "الخدمة الذكية متوقفة مؤقتاً للصيانة.",
              maintenance: true,
            }),
            {
              status: 503,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            }
          );
        }
      }

      const body = await request.json();
      const issueType = String(body.issueType || "general").trim().slice(0, 80);
      const contextSummary = String(body.contextSummary || "").trim().slice(0, 2000);
      const userMessage = String(body.message || "").trim().slice(0, 1500);

      if (!userMessage && !contextSummary) {
        return new Response(JSON.stringify({ error: "Empty query" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const normalizedPayload = `${issueType}|${contextSummary.toLowerCase()}|${userMessage.toLowerCase().replace(/\s+/g, " ")}`;
      const cacheKey = await sha256Hex(normalizedPayload);
      const kvKey = `alber_q:${cacheKey}`;

      if (env.ALBER_CACHE) {
        const cachedReply = await env.ALBER_CACHE.get(kvKey);
        if (cachedReply) {
          return new Response(
            JSON.stringify({
              reply: cachedReply,
              cached: true,
            }),
            {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            }
          );
        }
      }

      const systemInstruction = String(env.SKILL_PROMPT || "").trim();
      if (!env.GEMINI_API_KEY || !systemInstruction) {
        return new Response(JSON.stringify({ error: "Worker secrets not configured" }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const geminiModel = env.GEMINI_MODEL || "gemini-2.5-flash";
      const promptText = [
        `Issue Type: ${issueType}`,
        contextSummary ? `Diagnostic Context:\n${contextSummary}` : "",
        `User Request:\n${userMessage}`,
      ]
        .filter(Boolean)
        .join("\n\n");

      const geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${env.GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            systemInstruction: {
              parts: [{ text: systemInstruction }],
            },
            contents: [
              {
                role: "user",
                parts: [{ text: promptText }],
              },
            ],
            generationConfig: {
              temperature: 0.25,
              maxOutputTokens: 900,
            },
          }),
        }
      );

      if (!geminiRes.ok) {
        const errText = await geminiRes.text();
        return new Response(
          JSON.stringify({ error: "Gemini API error", details: errText.slice(0, 300) }),
          {
            status: 502,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      const geminiJson = await geminiRes.json();
      const replyText =
        geminiJson?.candidates?.[0]?.content?.parts
          ?.map((p) => p.text || "")
          .join("")
          .trim() || "تعذر توليد رد مناسب حالياً.";

      if (env.ALBER_CACHE && replyText) {
        ctx.waitUntil(
          env.ALBER_CACHE.put(kvKey, replyText, { expirationTtl: 604800 })
        );
      }

      return new Response(
        JSON.stringify({
          reply: replyText,
          cached: false,
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    } catch (err) {
      return new Response(
        JSON.stringify({ error: "Internal worker error", message: String(err?.message || err) }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
