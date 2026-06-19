// StockPulse AI — Autonomous Inventory Agent
// Architecture: ReAct-style loop with conditional second pass
//
// Input:   text OR image (base64) — agent handles both
// Pass 1:  Parse inventory → structured JSON (vision if image, text if text)
// Check:   Validate data quality, flag ambiguities
// Pass 2:  Calculate risk metrics (deterministic JS)
// Decision: If critical products exist → trigger autonomous order draft
// Pass 3 (conditional): Generate order draft with supplier grouping + timeline
// Pass 4:  Executive summary

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return json(500, { error: "Missing GROQ_API_KEY" });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "Invalid JSON" }); }

  const inventoryText = String(body.inventoryText || "").trim();
  const imageBase64   = body.imageBase64 || null;   // base64 string
  const imageType     = body.imageType   || "image/jpeg"; // mime type
  const history       = Array.isArray(body.history) ? body.history.slice(0, 8) : [];

  const hasText  = inventoryText.length >= 10;
  const hasImage = !!imageBase64;

  if (!hasText && !hasImage) {
    return json(400, { error: "Моля въведи складови данни или качи снимка." });
  }

  const agentLog = [];
  function logStep(step, detail = "") {
    agentLog.push({ step, detail, ts: new Date().toISOString() });
  }

  // ─────────────────────────────────────────────
  // PASS 1: Parse → structured inventory
  // Image path: Groq vision (llama-4-scout)
  // Text path:  Groq text (llama-3.3-70b)
  // ─────────────────────────────────────────────
  const inputMode = hasImage ? "image" : "text";
  logStep("PARSE", `Input mode: ${inputMode} — extracting structured product data`);

  const parseSchema = `{
  "businessName": "string or null",
  "currency": "BGN|EUR|USD|null",
  "dataQuality": "complete|partial|poor",
  "ambiguities": ["list any unclear fields or products"],
  "products": [
    {
      "name": "product name",
      "sku": "code or null",
      "currentStock": number,
      "salesPerDay": number,
      "leadTimeDays": number,
      "targetCoverDays": number,
      "supplier": "supplier name or null",
      "unitCost": number or null
    }
  ]
}`;

  const parseRules = `Rules:
- If targetCoverDays missing: use 30
- If leadTimeDays missing: use 7
- If salesPerDay missing: use 0
- If currentStock missing: use 0
- dataQuality = "complete" if >80% of products have salesPerDay > 0 and leadTimeDays specified
- dataQuality = "partial" if some key fields are missing but usable
- dataQuality = "poor" if most products lack sales data
- Recognize Bulgarian and English
- Do NOT invent products
- Return ONLY valid JSON, no markdown, no explanation`;

  let parseResult;

  if (hasImage) {
    // ── Vision path ──
    parseResult = await groqVision(apiKey, imageBase64, imageType, parseSchema, parseRules, history);
  } else {
    // ── Text path ──
    const parsePrompt = `You are StockPulse AI, an inventory analysis agent.

TASK: Extract product inventory data from raw user text into clean JSON.

Input text:
"""
${inventoryText}
"""

Previous analysis history (for context on this business):
${JSON.stringify(history).slice(0, 3000)}

Schema:
${parseSchema}

${parseRules}`;

    parseResult = await groqText(apiKey, parsePrompt, 1800);
  }

  if (parseResult.error) return json(500, { error: parseResult.error });

  let parsed;
  try { parsed = JSON.parse(parseResult.content); }
  catch { return json(500, { error: "Агентът не успя да разпознае структурата на данните." }); }

  const products = Array.isArray(parsed.products) ? parsed.products : [];
  if (!products.length) return json(400, { error: "Не бяха открити продукти. Провери снимката или формата на данните." });

  // ─────────────────────────────────────────────
  // SELF-CHECK: Evaluate data quality
  // ─────────────────────────────────────────────
  logStep("SELF_CHECK", `Data quality: ${parsed.dataQuality}. Ambiguities: ${(parsed.ambiguities || []).length}`);

  const dataWarnings = [];
  if (parsed.dataQuality === "poor") {
    dataWarnings.push("Повечето продукти нямат данни за продажби — прогнозата ще е неточна.");
  }
  if (parsed.ambiguities && parsed.ambiguities.length > 0) {
    dataWarnings.push(...parsed.ambiguities.slice(0, 3));
  }

  // ─────────────────────────────────────────────
  // PASS 2: Risk calculation (deterministic)
  // ─────────────────────────────────────────────
  logStep("CALCULATE_RISK", `Running risk metrics for ${products.length} products`);

  const analyzed = products.map(p => analyzeProduct(p));
  const sorted   = analyzed.sort((a, b) => b.priorityScore - a.priorityScore);

  const criticalProducts = sorted.filter(p => p.status === "critical");
  const warningProducts  = sorted.filter(p => p.status === "warning");
  const safeProducts     = sorted.filter(p => p.status === "safe");

  // ─────────────────────────────────────────────
  // AGENT DECISION: Trigger order draft?
  // ─────────────────────────────────────────────
  const triggerOrderDraft = criticalProducts.length > 0 || warningProducts.length >= 2;
  logStep(
    "DECISION",
    triggerOrderDraft
      ? `Triggering autonomous order draft — ${criticalProducts.length} critical, ${warningProducts.length} at-risk`
      : "No urgent action needed — skipping order draft pass"
  );

  // ─────────────────────────────────────────────
  // PASS 3 (conditional): Autonomous order draft
  // ─────────────────────────────────────────────
  let orderDraft = null;

  if (triggerOrderDraft) {
    logStep("ORDER_DRAFT", "Generating prioritized order plan with supplier grouping");

    const urgentProducts = [...criticalProducts, ...warningProducts].slice(0, 10);

    const orderPrompt = `You are StockPulse AI. You have autonomously detected inventory risk and are now generating an order draft.

Risk summary:
- Critical products (must order immediately): ${criticalProducts.map(p => p.name).join(", ") || "none"}
- At-risk products (order soon): ${warningProducts.map(p => p.name).join(", ") || "none"}

Product details:
${JSON.stringify(urgentProducts.map(p => ({
  name: p.name,
  supplier: p.supplier,
  recommendedOrderQty: p.recommendedOrderQty,
  orderByDate: p.orderByDate,
  estimatedOrderValue: p.estimatedOrderValue,
  status: p.status,
  unitCost: p.unitCost
})), null, 2)}

Currency: ${parsed.currency || "BGN"}

Generate an actionable order draft. Return ONLY valid JSON:
{
  "orderDraftTitle": "short title",
  "urgencyLevel": "IMMEDIATE|HIGH|MEDIUM",
  "totalEstimatedValue": number or null,
  "recommendedActions": [
    {
      "action": "short action description in Bulgarian",
      "deadline": "date string or 'Веднага'",
      "products": ["product names"],
      "estimatedValue": number or null
    }
  ],
  "supplierGroups": [
    {
      "supplier": "supplier name or 'Неизвестен доставчик'",
      "products": ["product names"],
      "totalQty": number,
      "totalValue": number or null,
      "orderBy": "date or 'Веднага'"
    }
  ],
  "agentNote": "one sentence in Bulgarian explaining why agent triggered this draft autonomously"
}`;

    const orderResult = await groqText(apiKey, orderPrompt, 900);
    if (!orderResult.error) {
      try { orderDraft = JSON.parse(orderResult.content); }
      catch { logStep("ORDER_DRAFT_ERROR", "Failed to parse order draft JSON"); }
    }
  }

  // ─────────────────────────────────────────────
  // PASS 4: Executive summary
  // ─────────────────────────────────────────────
  logStep("SUMMARY", "Generating executive summary");

  const summaryPrompt = `Write a brief executive summary in Bulgarian for this inventory analysis.

Context:
${JSON.stringify({
  criticalCount: criticalProducts.length,
  warningCount: warningProducts.length,
  safeCount: safeProducts.length,
  orderDraftTriggered: triggerOrderDraft,
  topProducts: sorted.slice(0, 5).map(p => ({ name: p.name, status: p.status, daysUntilStockout: p.daysUntilStockout }))
}).slice(0, 4000)}

Return ONLY valid JSON:
{
  "executiveSummaryBg": "3-4 sentences",
  "topActionsBg": ["action 1", "action 2", "action 3"],
  "riskVerdictBg": "one short sentence"
}`;

  const summaryResult = await groqText(apiKey, summaryPrompt, 600);
  let aiSummary = {
    executiveSummaryBg: "Агентът завърши анализа на складовите наличности.",
    topActionsBg: [],
    riskVerdictBg: "Провери критичните продукти първо."
  };
  if (!summaryResult.error) {
    try { aiSummary = JSON.parse(summaryResult.content); } catch {}
  }

  logStep("COMPLETE", `Agent finished. Input: ${inputMode}. Passes: ${triggerOrderDraft ? 4 : 3}`);

  const totalRecommendedUnits = sorted.reduce((s, p) => s + p.recommendedOrderQty, 0);
  const estimatedOrderValue   = sorted.reduce((s, p) => p.unitCost ? s + p.unitCost * p.recommendedOrderQty : s, 0);

  return json(200, {
    businessName: parsed.businessName || null,
    currency: parsed.currency || null,
    generatedAt: new Date().toISOString(),
    inputMode,
    dataQuality: parsed.dataQuality || "unknown",
    dataWarnings,
    agentLog,
    orderDraftTriggered: triggerOrderDraft,
    orderDraft,
    totals: {
      products: sorted.length,
      criticalCount: criticalProducts.length,
      warningCount: warningProducts.length,
      safeCount: safeProducts.length,
      totalRecommendedUnits,
      estimatedOrderValue: Number(estimatedOrderValue.toFixed(2))
    },
    summary: aiSummary,
    products: sorted
  });
};

// ─────────────────────────────────────────────
// Groq text helper
// ─────────────────────────────────────────────
async function groqText(apiKey, prompt, maxTokens = 1000) {
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        temperature: 0.15,
        max_tokens: maxTokens,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: prompt }]
      })
    });
    const data = await res.json();
    if (!res.ok) return { error: data.error?.message || "Groq API error" };
    return { content: data.choices?.[0]?.message?.content || "{}" };
  } catch (err) {
    return { error: err.message };
  }
}

// ─────────────────────────────────────────────
// Groq vision helper — llama-4-scout
// ─────────────────────────────────────────────
async function groqVision(apiKey, base64Image, mediaType, schema, rules, history) {
  const prompt = `You are StockPulse AI, an inventory analysis agent.

TASK: You are looking at an image of inventory data — this could be a warehouse printout, a handwritten stock list, a photo of shelves with labels, a spreadsheet screenshot, or any other inventory document.

Extract ALL visible product/item data and return it as structured JSON.

Previous analysis history (for context):
${JSON.stringify(history).slice(0, 2000)}

Schema:
${schema}

${rules}`;

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "meta-llama/llama-4-scout-17b-16e-instruct",
        temperature: 0.1,
        max_tokens: 2000,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: { url: `data:${mediaType};base64,${base64Image}` }
              },
              { type: "text", text: prompt }
            ]
          }
        ]
      })
    });
    const data = await res.json();
    if (!res.ok) return { error: data.error?.message || "Groq vision error" };
    return { content: data.choices?.[0]?.message?.content || "{}" };
  } catch (err) {
    return { error: err.message };
  }
}

// ─────────────────────────────────────────────
// Risk calculation (deterministic, no LLM)
// ─────────────────────────────────────────────
function analyzeProduct(product) {
  const name            = clean(product.name) || "Unknown";
  const sku             = clean(product.sku);
  const currentStock    = toNum(product.currentStock);
  const salesPerDay     = toNum(product.salesPerDay);
  const leadTimeDays    = Math.max(0, toNum(product.leadTimeDays) || 7);
  const targetCoverDays = Math.max(1, toNum(product.targetCoverDays) || 30);
  const unitCost        = (product.unitCost == null) ? null : toNum(product.unitCost);
  const supplier        = clean(product.supplier);

  const daysUntilStockout   = salesPerDay > 0 ? currentStock / salesPerDay : 999;
  const reorderDeadlineDays = daysUntilStockout - leadTimeDays;

  let status, priorityScore, statusLabelBg;

  if (salesPerDay <= 0) {
    status = "safe"; priorityScore = 5; statusLabelBg = "Няма активни продажби";
  } else if (daysUntilStockout <= leadTimeDays) {
    status = "critical"; priorityScore = 100 + (leadTimeDays - daysUntilStockout); statusLabelBg = "Критичен риск";
  } else if (daysUntilStockout <= leadTimeDays + 7) {
    status = "warning"; priorityScore = 65 + (leadTimeDays + 7 - daysUntilStockout); statusLabelBg = "Рисков продукт";
  } else {
    status = "safe"; priorityScore = Math.max(10, 40 - daysUntilStockout); statusLabelBg = "Стабилен";
  }

  const safetyBuffer      = Math.ceil(salesPerDay * 5);
  const neededForTarget   = Math.ceil(salesPerDay * targetCoverDays);
  const neededDuringLead  = Math.ceil(salesPerDay * leadTimeDays);
  let recommendedOrderQty = Math.max(0, neededForTarget + safetyBuffer - currentStock);
  if (status === "critical") recommendedOrderQty = Math.max(recommendedOrderQty, neededDuringLead + safetyBuffer);

  return {
    name, sku, supplier, currentStock, salesPerDay, leadTimeDays, targetCoverDays, unitCost,
    daysUntilStockout:   round(daysUntilStockout),
    stockoutDate:        addDays(daysUntilStockout),
    reorderDeadlineDays: round(reorderDeadlineDays),
    orderByDate:         addDays(Math.max(0, reorderDeadlineDays)),
    recommendedOrderQty,
    estimatedOrderValue: unitCost ? Number((unitCost * recommendedOrderQty).toFixed(2)) : null,
    status, statusLabelBg,
    priorityScore:       round(priorityScore),
    explanationBg:       buildExplanation({ name, status, daysUntilStockout, leadTimeDays, reorderDeadlineDays, recommendedOrderQty, targetCoverDays })
  };
}

function buildExplanation(x) {
  if (x.status === "critical") {
    if (x.reorderDeadlineDays < 0)
      return `${x.name} е критичен: ще свърши след ~${round(x.daysUntilStockout)} дни, доставката отнема ${x.leadTimeDays} дни. Трябваше да се поръча преди ${Math.abs(round(x.reorderDeadlineDays))} дни.`;
    return `${x.name} е критичен: времето до изчерпване е равно или по-малко от времето за доставка.`;
  }
  if (x.status === "warning")
    return `${x.name} е рисков: малък прозорец за реакция преди доставката да закъснее.`;
  return `${x.name} е стабилен при текущите продажби. Препоръката е за ${x.targetCoverDays} дни покритие.`;
}

function addDays(days) {
  if (!Number.isFinite(days) || days >= 900) return null;
  const d = new Date(); d.setDate(d.getDate() + Math.ceil(days));
  return d.toISOString().split("T")[0];
}

function round(n)  { return Number.isFinite(n) ? Number(n.toFixed(1)) : 0; }
function toNum(v)  { if (v == null) return 0; const n = Number(String(v).replace(",", ".").replace(/[^\d.-]/g, "")); return Number.isFinite(n) ? n : 0; }
function clean(v)  { if (v == null) return null; const s = String(v).trim(); return s.length ? s : null; }
function json(statusCode, payload) {
  return { statusCode, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(payload) };
}
