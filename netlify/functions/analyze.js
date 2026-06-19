exports.handler = async function (event) {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method not allowed" });
    }

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      return json(500, { error: "Missing GROQ_API_KEY in Netlify environment variables." });
    }

    const body = JSON.parse(event.body || "{}");
    const inventoryText = String(body.inventoryText || "").trim();
    const history = Array.isArray(body.history) ? body.history.slice(0, 8) : [];

    if (!inventoryText || inventoryText.length < 10) {
      return json(400, { error: "Моля въведи складови данни." });
    }

    const parsePrompt = `
Ти си StockPulse AI — автономен складов анализатор.

ЗАДАЧА:
Прочети суровите складови данни и извлечи продуктите в чист JSON.

Потребителски текст:
"""
${inventoryText}
"""

История от предишни анализи:
${JSON.stringify(history).slice(0, 5000)}

Върни САМО валиден JSON без markdown.

Формат:
{
  "businessName": "име на бизнес или null",
  "currency": "BGN/EUR/USD/null",
  "products": [
    {
      "name": "име на продукт",
      "sku": "код или null",
      "currentStock": number,
      "salesPerDay": number,
      "leadTimeDays": number,
      "targetCoverDays": number,
      "supplier": "доставчик или null",
      "unitCost": number или null
    }
  ]
}

Правила:
- Ако targetCoverDays липсва, използвай 30.
- Ако leadTimeDays липсва, използвай 7.
- Ако salesPerDay липсва, използвай 0.
- Ако currentStock липсва, използвай 0.
- Разпознавай български и английски.
- Не измисляй продукти.
`;

    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        temperature: 0.1,
        max_tokens: 1600,
        response_format: { type: "json_object" },
        messages: [
          { role: "user", content: parsePrompt }
        ]
      })
    });

    const groqData = await groqRes.json();

    if (!groqRes.ok) {
      return json(500, { error: groqData.error?.message || "Groq API error." });
    }

    const raw = groqData.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(raw);
    const products = Array.isArray(parsed.products) ? parsed.products : [];

    const analyzed = products.map(p => analyzeProduct(p));
    const sorted = analyzed.sort((a, b) => b.priorityScore - a.priorityScore);

    const criticalCount = sorted.filter(p => p.status === "critical").length;
    const warningCount = sorted.filter(p => p.status === "warning").length;
    const safeCount = sorted.filter(p => p.status === "safe").length;

    const totalRecommendedUnits = sorted.reduce((sum, p) => sum + p.recommendedOrderQty, 0);
    const estimatedOrderValue = sorted.reduce((sum, p) => {
      if (!p.unitCost) return sum;
      return sum + p.unitCost * p.recommendedOrderQty;
    }, 0);

    const summaryPrompt = `
Напиши кратко управленско заключение на български за складов анализ.

Данни:
${JSON.stringify({
      criticalCount,
      warningCount,
      safeCount,
      products: sorted
    }).slice(0, 9000)}

Върни САМО JSON:
{
  "executiveSummaryBg": "3-4 изречения",
  "topActionsBg": ["действие 1", "действие 2", "действие 3"],
  "riskVerdictBg": "едно кратко изречение"
}
`;

    let aiSummary = {
      executiveSummaryBg: "Агентът анализира наличностите и изчисли риска от изчерпване.",
      topActionsBg: [],
      riskVerdictBg: "Провери критичните продукти първо."
    };

    try {
      const summaryRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          temperature: 0.25,
          max_tokens: 700,
          response_format: { type: "json_object" },
          messages: [{ role: "user", content: summaryPrompt }]
        })
      });

      const summaryData = await summaryRes.json();
      if (summaryRes.ok) {
        aiSummary = JSON.parse(summaryData.choices?.[0]?.message?.content || "{}");
      }
    } catch (_) {}

    return json(200, {
      businessName: parsed.businessName || null,
      currency: parsed.currency || null,
      generatedAt: new Date().toISOString(),
      totals: {
        products: sorted.length,
        criticalCount,
        warningCount,
        safeCount,
        totalRecommendedUnits,
        estimatedOrderValue: Number(estimatedOrderValue.toFixed(2))
      },
      summary: aiSummary,
      products: sorted
    });

  } catch (err) {
    return json(500, { error: err.message || "Unknown error." });
  }
};

function analyzeProduct(product) {
  const name = clean(product.name) || "Unknown product";
  const sku = clean(product.sku);
  const currentStock = toNum(product.currentStock);
  const salesPerDay = toNum(product.salesPerDay);
  const leadTimeDays = Math.max(0, toNum(product.leadTimeDays) || 7);
  const targetCoverDays = Math.max(1, toNum(product.targetCoverDays) || 30);
  const unitCost = product.unitCost === null || product.unitCost === undefined ? null : toNum(product.unitCost);
  const supplier = clean(product.supplier);

  const daysUntilStockout = salesPerDay > 0
    ? currentStock / salesPerDay
    : 999;

  const reorderDeadlineDays = daysUntilStockout - leadTimeDays;

  let status = "safe";
  let priorityScore = 10;
  let statusLabelBg = "Безопасен";

  if (salesPerDay <= 0) {
    status = "safe";
    priorityScore = 5;
    statusLabelBg = "Няма активни продажби";
  } else if (daysUntilStockout <= leadTimeDays) {
    status = "critical";
    priorityScore = 100 + (leadTimeDays - daysUntilStockout);
    statusLabelBg = "Критичен риск";
  } else if (daysUntilStockout <= leadTimeDays + 7) {
    status = "warning";
    priorityScore = 65 + (leadTimeDays + 7 - daysUntilStockout);
    statusLabelBg = "Рисков продукт";
  } else {
    status = "safe";
    priorityScore = Math.max(10, 40 - daysUntilStockout);
    statusLabelBg = "Стабилен";
  }

  const neededForTarget = Math.ceil(salesPerDay * targetCoverDays);
  const neededDuringLead = Math.ceil(salesPerDay * leadTimeDays);
  const safetyBuffer = Math.ceil(salesPerDay * 5);

  let recommendedOrderQty = Math.max(0, neededForTarget + safetyBuffer - currentStock);
  if (status === "critical") {
    recommendedOrderQty = Math.max(recommendedOrderQty, neededDuringLead + safetyBuffer);
  }

  const stockoutDate = addDays(daysUntilStockout);
  const orderByDate = addDays(Math.max(0, reorderDeadlineDays));

  const explanationBg = buildExplanation({
    name,
    status,
    daysUntilStockout,
    leadTimeDays,
    reorderDeadlineDays,
    recommendedOrderQty,
    targetCoverDays
  });

  return {
    name,
    sku,
    supplier,
    currentStock,
    salesPerDay,
    leadTimeDays,
    targetCoverDays,
    unitCost,
    daysUntilStockout: round(daysUntilStockout),
    stockoutDate,
    reorderDeadlineDays: round(reorderDeadlineDays),
    orderByDate,
    recommendedOrderQty,
    estimatedOrderValue: unitCost ? Number((unitCost * recommendedOrderQty).toFixed(2)) : null,
    status,
    statusLabelBg,
    priorityScore: round(priorityScore),
    explanationBg
  };
}

function buildExplanation(x) {
  if (x.status === "critical") {
    if (x.reorderDeadlineDays < 0) {
      return `${x.name} е критичен: продуктът ще свърши след около ${round(x.daysUntilStockout)} дни, а доставката отнема ${x.leadTimeDays} дни. Реално е трябвало да се поръча преди ${Math.abs(round(x.reorderDeadlineDays))} дни.`;
    }
    return `${x.name} е критичен: времето до изчерпване е почти равно или по-малко от времето за доставка.`;
  }

  if (x.status === "warning") {
    return `${x.name} е рисков: има малък прозорец за реакция преди доставката да стане закъсняла.`;
  }

  return `${x.name} е стабилен при текущата скорост на продажби. Препоръката е изчислена за ${x.targetCoverDays} дни покритие.`;
}

function addDays(days) {
  if (!Number.isFinite(days) || days >= 900) return null;
  const d = new Date();
  d.setDate(d.getDate() + Math.ceil(days));
  return d.toISOString().split("T")[0];
}

function round(n) {
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(1));
}

function toNum(v) {
  if (v === null || v === undefined) return 0;
  const n = Number(String(v).replace(",", ".").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function clean(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function json(statusCode, payload) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    },
    body: JSON.stringify(payload)
  };
}
