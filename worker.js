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
      const issueType = String(body.issueType || "general").trim().slice(0, 60);
      const contextSummary = String(body.contextSummary || "").trim().slice(0, 600);
      const userMessage = String(body.message || "").trim().slice(0, 600);

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

      // مفتاح كاش مرن يقلل استهلاك الحصة في الأسئلة المتشابهة
      const normalizedMsg = `${issueType}|${userMessage.toLowerCase().replace(/\s+/g, " ").trim()}`;
      const kvKey = `alber_q:${await sha256Hex(normalizedMsg)}`;

      if (env.ALBER_CACHE) {
        const cached = await env.ALBER_CACHE.get(kvKey);
        if (cached) {
          return new Response(JSON.stringify({ reply: cached, cached: true }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }

      const compactSystemPrompt = cachedSkillPrompt.slice(0, 3500);
      const prompt = [
        `Issue: ${issueType}`,
        contextSummary ? `Context:\n${contextSummary}` : "",
        `Message:\n${userMessage}`,
      ].filter(Boolean).join("\n\n");

      const configuredModel = String(env.GEMINI_MODEL || "").trim();
      const geminiModels = [
        ...new Set([
          configuredModel,
          "gemini-3.8-flash",
          "gemini-3.1-pro-preview",
        ].filter(Boolean)),
      ];

      const payloadBody = JSON.stringify({
        systemInstruction: { parts: [{ text: compactSystemPrompt }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.25, maxOutputTokens: 900 },
      });

      let gRes = null;
      let primaryErrTxt = "";
      let hitRateLimit = false;

      for (const m of geminiModels) {
        gRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${env.GEMINI_API_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: payloadBody,
          }
        );

        if (gRes.ok) break;

        const errTxt = await gRes.text();
        if (!primaryErrTxt) {
          primaryErrTxt = `[${m} -> ${gRes.status}] ${errTxt}`;
        }

        if (gRes.status === 429) {
          hitRateLimit = true;
          await new Promise((r) => setTimeout(r, 350));
          continue;
        }

        if (![503, 404].includes(gRes.status)) break;
      }

      let reply = "";

      if (gRes && gRes.ok) {
        const gJson = await gRes.json();
        reply =
          gJson?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim() || "";
      } else if (hitRateLimit && env.FALLBACK_API_URL && env.FALLBACK_API_KEY) {
        // مزود احتياطي مجاني متوافق مع OpenAI Chat Completions عند ضرب 429
        const fbRes = await fetch(env.FALLBACK_API_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${env.FALLBACK_API_KEY}`,
          },
          body: JSON.stringify({
            model: env.FALLBACK_MODEL || "openrouter/free",
            messages: [
              { role: "system", content: compactSystemPrompt },
              { role: "user", content: prompt },
            ],
            temperature: 0.25,
            max_tokens: 900,
          }),
        });

        if (fbRes.ok) {
          const fbJson = await fbRes.json();
          reply = String(fbJson?.choices?.[0]?.message?.content || "").trim();
        }
      }

      if (!reply) {
        const statusCode = hitRateLimit ? 429 : 502;
        return new Response(
          JSON.stringify({
            error: hitRateLimit
              ? "الحد المجاني الحالي على Gemini API ممتلئ مؤقتاً (Rate limit). انتظر قليلاً أو أضف مزوداً احتياطياً مجانياً."
              : "Gemini API error",
            details: primaryErrTxt.slice(0, 400),
          }),
          {
            status: statusCode,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      if (env.ALBER_CACHE) {
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
