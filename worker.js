let cachedSkillPrompt = null;

export default {
  async fetch(request, env, ctx) {
    const allowedOrigin = "https://goky40.github.io";
    const statusUrl = "https://goky40.github.io/alberopbr/status.json";
    const origin = request.headers.get("Origin") || "";

    const corsHeaders = {
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== "POST" || origin !== allowedOrigin) {
      return new Response(JSON.stringify({ error: "Forbidden", origin }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    try {
      const st = await fetch(statusUrl, { cf: { cacheTtl: 30, cacheEverything: false } });
      if (st.ok) {
        const s = await st.json().catch(() => ({}));
        if (s.maintenance === true || s.ai_enabled === false) {
          return new Response(
            JSON.stringify({ error: s.message || "الخدمة متوقفة مؤقتاً للصيانة.", maintenance: true }),
            { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
      }

      const body = await request.json().catch(() => ({}));
      const issueType = String(body.issueType || "general").trim().slice(0, 80);
      const contextSummary = String(body.contextSummary || "").trim().slice(0, 1500);
      const userMessage = String(body.message || "").trim().slice(0, 1200);

      if (!userMessage && !contextSummary) {
        return new Response(JSON.stringify({ error: "Empty query" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (!cachedSkillPrompt) {
        const fromEnv = String(env.SKILL_PROMPT || "").trim();
        const fromKv = env.ALBER_CACHE
          ? String((await env.ALBER_CACHE.get("alber_skill_prompt")) || "").trim()
          : "";
        cachedSkillPrompt = fromEnv || fromKv;
      }

      if (!env.GEMINI_API_KEY || !cachedSkillPrompt) {
        return new Response(
          JSON.stringify({
            error: "Missing secrets or skill prompt",
            hasKey: Boolean(env.GEMINI_API_KEY),
            hasPrompt: Boolean(cachedSkillPrompt),
          }),
          {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      const rawKey = `${issueType}|${contextSummary.toLowerCase()}|${userMessage.toLowerCase().replace(/\s+/g, " ")}`;
      const kvKey = `alber_q:${await sha256Hex(rawKey)}`;

      if (env.ALBER_CACHE) {
        const cached = await env.ALBER_CACHE.get(kvKey);
        if (cached) {
          return new Response(JSON.stringify({ reply: cached, cached: true }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }

      const primaryModel = env.GEMINI_MODEL || "gemini-3.8-flash";
      const modelsToTry = [...new Set([primaryModel, "gemini-2.5-flash-lite", "gemini-2.5-pro"])];

      const prompt = [
        `Issue Type: ${issueType}`,
        contextSummary ? `Diagnostic Context:\n${contextSummary}` : "",
        `User Request:\n${userMessage}`,
      ].filter(Boolean).join("\n\n");

      const payloadBody = JSON.stringify({
        systemInstruction: { parts: [{ text: cachedSkillPrompt }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.25, maxOutputTokens: 2048 },
      });

      let gRes = null;
      let lastErrTxt = "";
      let hitRateLimit = false;

      for (const m of modelsToTry) {
        gRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${env.GEMINI_API_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: payloadBody,
          }
        );

        if (gRes.ok) break;
        lastErrTxt = await gRes.text();

        if (gRes.status === 429) {
          hitRateLimit = true;
          await new Promise((r) => setTimeout(r, 400));
          continue;
        }
        if (![503, 404].includes(gRes.status)) break;
      }

      if (!gRes || !gRes.ok) {
        const statusCode = hitRateLimit && (!gRes || gRes.status === 429) ? 429 : 502;
        return new Response(
          JSON.stringify({
            error: hitRateLimit
              ? "تم الوصول لحد الطلبات المؤقت (Rate limit) على Gemini API. انتظر قليلاً أو راجع الفوترة."
              : "Gemini API error",
            details: lastErrTxt.slice(0, 300),
          }),
          {
            status: statusCode,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      const gJson = await gRes.json();
      const reply =
        gJson?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim() ||
        "تعذر توليد رد مناسب حالياً.";

      if (env.ALBER_CACHE && reply) {
        ctx.waitUntil(env.ALBER_CACHE.put(kvKey, reply, { expirationTtl: 604800 }));
      }

      return new Response(JSON.stringify({ reply, cached: false }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: "Worker error", message: String(e?.message || e) }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  },
};

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
