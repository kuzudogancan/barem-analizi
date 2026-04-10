import { useState, useMemo } from "react";
import { Area, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ResponsiveContainer, ComposedChart } from "recharts";

const defaults = [
  { threshold: 60000, value: 5000, type: "abs" },
  { threshold: 90000, value: 9000, type: "abs" },
  { threshold: 120000, value: 15000, type: "abs" },
  { threshold: 180000, value: 12, type: "pct" },
];

function getDiscount(amount, tiers) {
  for (let i = tiers.length - 1; i >= 0; i--) {
    if (amount >= tiers[i].threshold) return tiers[i].type === "pct" ? amount * (tiers[i].value / 100) : tiers[i].value;
  }
  return 0;
}

function getTierIndex(amount, tiers) {
  for (let i = tiers.length - 1; i >= 0; i--) {
    if (amount >= tiers[i].threshold) return i;
  }
  return -1;
}

function getBestSplit(amount, tiers) {
  let best = getDiscount(amount, tiers);
  let bestParts = null;
  for (const t of tiers) {
    if (amount <= t.threshold) continue;
    const total = getDiscount(t.threshold, tiers) + getDiscount(amount - t.threshold, tiers);
    if (total > best) { best = total; bestParts = [t.threshold, amount - t.threshold]; }
  }
  for (let s = 5000; s < amount; s += 5000) {
    const total = getDiscount(s, tiers) + getDiscount(amount - s, tiers);
    if (total > best) { best = total; bestParts = [s, amount - s]; }
  }
  return { best, parts: bestParts };
}

// Scan all amounts brute-force, find worst arbitrage per affected tier
function generateRecommendations(sorted) {
  if (sorted.length < 2) return [];

  const maxAmt = Math.max(...sorted.map(t => t.threshold)) * 2.5;
  const step = Math.max(1000, Math.round(maxAmt / 300));

  // For each tier, track worst arbitrage case in that tier's range
  const worstByTier = {};

  for (let amt = step; amt <= maxAmt; amt += step) {
    const singleDisc = getDiscount(amt, sorted);
    const { best, parts } = getBestSplit(amt, sorted);
    const diff = best - singleDisc;
    if (diff <= 1 || !parts) continue;

    const tierIdx = getTierIndex(amt, sorted);
    if (tierIdx < 0) continue;

    if (!worstByTier[tierIdx] || diff > worstByTier[tierIdx].diff) {
      worstByTier[tierIdx] = { amt, diff, parts, singleDisc, bestDisc: best, tierIdx };
    }
  }

  return Object.values(worstByTier).map(w => {
    const tier = sorted[w.tierIdx];
    const splitEffRate = w.bestDisc / w.amt;

    // Fix: what discount would this tier need so that single cart always wins?
    // At the worst amount, single cart discount must be >= best split discount
    // For abs tier: need value >= bestDisc (but that's for worst amount; really need value >= splitEffRate * threshold for threshold, and >= bestDisc for worst amount)
    // Simpler: set discount so that eff rate at threshold >= max split eff rate observed
    let fixVal;
    if (tier.type === "abs") {
      // Need: tier.value / amt >= splitEffRate for all amt in range
      // Worst case is at the highest amt in range (lowest eff for abs)
      // But we can't set value per-amount; we need value such that even at worst amount, single >= split
      // value >= best split discount at worst amount
      fixVal = Math.ceil(w.bestDisc);
    } else {
      // For pct: rate >= splitEffRate * 100
      fixVal = Math.ceil(splitEffRate * 1000) / 10;
    }

    return {
      tier, tierIdx: w.tierIdx,
      worstAmt: w.amt, diff: w.diff, parts: w.parts,
      singleDisc: w.singleDisc, bestDisc: w.bestDisc,
      splitEffPct: (splitEffRate * 100).toFixed(1),
      currentEffPct: (w.singleDisc / w.amt * 100).toFixed(1),
      fix: {
        sortedIdx: w.tierIdx,
        newVal: fixVal,
        label: tier.type === "abs" ? `${fmt(fixVal)} ₺` : `%${fixVal}`,
      },
    };
  }).sort((a, b) => b.diff - a.diff);
}

const fmt = (n) => new Intl.NumberFormat("tr-TR").format(Math.round(n));
const fmtK = (n) => n >= 1000 ? `${Math.round(n / 1000)}K` : n;
const fmtPct = (n) => `%${n.toFixed(1)}`;

const FONT = "'Inter', 'SF Pro Display', -apple-system, sans-serif";

export default function App() {
  const [tiers, setTiers] = useState(defaults);

  const updateTier = (i, field, val) => {
    const next = [...tiers];
    if (field === "type") next[i] = { ...next[i], type: val };
    else next[i] = { ...next[i], [field]: Number(val) || 0 };
    setTiers(next);
  };
  const addTier = () => setTiers([...tiers, { threshold: 0, value: 0, type: "abs" }]);
  const removeTier = (i) => setTiers(tiers.filter((_, j) => j !== i));

  const sorted = useMemo(() => [...tiers].filter(t => t.threshold > 0).sort((a, b) => a.threshold - b.threshold), [tiers]);

  const chartData = useMemo(() => {
    if (!sorted.length) return [];
    const maxAmt = Math.max(...sorted.map(t => t.threshold)) * 2.5;
    const step = Math.max(1000, Math.round(maxAmt / 500));
    const data = [];
    for (let amt = step; amt <= maxAmt; amt += step) {
      const sd = getDiscount(amt, sorted);
      const er = amt > 0 ? (sd / amt) * 100 : 0;
      const { best, parts } = getBestSplit(amt, sorted);
      const hasArb = best > sd + 1;
      data.push({ amt, effRate: er, splitRate: hasArb ? (best / amt) * 100 : null, singleDisc: sd, bestSplitDisc: best, hasArb, parts });
    }
    return data;
  }, [sorted]);

  const maxArb = useMemo(() => {
    let w = { amt: 0, diff: 0, parts: null };
    chartData.forEach(d => { const diff = d.bestSplitDisc - d.singleDisc; if (diff > w.diff) w = { amt: d.amt, diff, parts: d.parts }; });
    return w;
  }, [chartData]);

  const recommendations = useMemo(() => generateRecommendations(sorted), [sorted]);

  const applyFix = (fix) => {
    const target = sorted[fix.sortedIdx];
    const oi = tiers.findIndex(t => t.threshold === target.threshold && t.type === target.type);
    if (oi >= 0) updateTier(oi, "value", fix.newVal);
  };

  const autoFixAll = () => {
    const next = [...tiers];
    const s = [...next].filter(t => t.threshold > 0).sort((a, b) => a.threshold - b.threshold);
    // Apply all fixes iteratively, rechecking after each
    for (const rec of recommendations) {
      const target = s[rec.fix.sortedIdx];
      const oi = next.findIndex(t => t.threshold === target.threshold && t.type === target.type);
      if (oi >= 0) { next[oi] = { ...next[oi], value: rec.fix.newVal }; s[rec.fix.sortedIdx] = next[oi]; }
    }
    setTiers(next);
  };

  const CTooltip = ({ active, payload }) => {
    if (!active || !payload?.[0]) return null;
    const d = payload[0].payload;
    return (
      <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: "14px 18px", color: "#334155", fontSize: 13, lineHeight: 1.8, boxShadow: "0 8px 30px rgba(0,0,0,0.08)", fontFamily: FONT }}>
        <div style={{ fontWeight: 600, color: "#0f172a", marginBottom: 2, fontSize: 14 }}>Sepet: {fmt(d.amt)} ₺</div>
        <div>Tek sepet indirimi: <span style={{ color: "#0284c7", fontWeight: 600 }}>{fmt(d.singleDisc)} ₺</span> <span style={{ color: "#94a3b8" }}>({fmtPct(d.effRate)})</span></div>
        {d.hasArb && (<>
          <div>Bölme ile: <span style={{ color: "#dc2626", fontWeight: 600 }}>{fmt(d.bestSplitDisc)} ₺</span> <span style={{ color: "#94a3b8" }}>({fmtPct((d.bestSplitDisc / d.amt) * 100)})</span></div>
          <div style={{ color: "#dc2626", fontWeight: 600, marginTop: 2 }}>→ Arbitraj farkı: +{fmt(d.bestSplitDisc - d.singleDisc)} ₺</div>
          {d.parts && <div style={{ color: "#94a3b8", fontSize: 12 }}>Bölme: {fmt(d.parts[0])} + {fmt(d.parts[1])}</div>}
        </>)}
      </div>
    );
  };

  const isProof = maxArb.diff <= 0;

  return (
    <div style={{ background: "linear-gradient(180deg, #f8fafc 0%, #f1f5f9 100%)", minHeight: "100vh", fontFamily: FONT, padding: "32px 24px" }}>
      <div style={{ maxWidth: 880, margin: "0 auto" }}>
        {/* Header */}
        <div style={{ marginBottom: 28 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
            <div style={{ width: 36, height: 36, borderRadius: 10, background: "linear-gradient(135deg, #0284c7, #7c3aed)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>📊</div>
            <h1 style={{ fontSize: 24, fontWeight: 700, color: "#0f172a", margin: 0, letterSpacing: "-0.5px" }}>Barem Arbitraj Analizi</h1>
          </div>
          <p style={{ color: "#94a3b8", fontSize: 14, margin: 0, paddingLeft: 46 }}>Kampanya baremlerini girin, arbitraj risklerini ve çözüm önerilerini görün</p>
        </div>

        {/* Tier Inputs */}
        <div style={{ background: "#fff", borderRadius: 16, padding: "20px", boxShadow: "0 1px 3px rgba(0,0,0,0.04), 0 1px 2px rgba(0,0,0,0.06)", marginBottom: 16, border: "1px solid #e2e8f0" }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#64748b", marginBottom: 12, textTransform: "uppercase", letterSpacing: "0.05em" }}>Barem Kademeleri</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {tiers.map((t, i) => (
              <div key={i} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", padding: "8px 12px", background: "#f8fafc", borderRadius: 10, border: "1px solid #f1f5f9" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <input type="number" value={t.threshold || ""} onChange={e => updateTier(i, "threshold", e.target.value)}
                    style={{ width: 110, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, color: "#0f172a", padding: "8px 12px", fontSize: 14, fontFamily: FONT, fontWeight: 500, outline: "none" }} placeholder="Limit ₺" />
                  <span style={{ color: "#cbd5e1", fontSize: 13 }}>üzeri</span>
                  <span style={{ color: "#cbd5e1", fontSize: 16 }}>→</span>
                  <input type="number" value={t.value || ""} onChange={e => updateTier(i, "value", e.target.value)}
                    style={{ width: 90, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, color: t.type === "abs" ? "#0284c7" : "#7c3aed", padding: "8px 12px", fontSize: 14, fontFamily: FONT, fontWeight: 600, outline: "none" }}
                    placeholder={t.type === "abs" ? "₺" : "%"} />
                </div>
                <div style={{ display: "flex", gap: 4, background: "#fff", borderRadius: 8, padding: 3, border: "1px solid #e2e8f0" }}>
                  {[["abs", "₺ Sabit"], ["pct", "% Oran"]].map(([val, label]) => (
                    <button key={val} onClick={() => updateTier(i, "type", val)} style={{
                      background: t.type === val ? (val === "abs" ? "#eff6ff" : "#f5f3ff") : "transparent",
                      border: "none", borderRadius: 6,
                      color: t.type === val ? (val === "abs" ? "#0284c7" : "#7c3aed") : "#94a3b8",
                      padding: "5px 12px", cursor: "pointer", fontSize: 12, fontFamily: FONT, fontWeight: t.type === val ? 600 : 400,
                      transition: "all 0.15s",
                    }}>{label}</button>
                  ))}
                </div>
                {tiers.length > 1 && (
                  <button onClick={() => removeTier(i)} style={{ background: "none", border: "none", color: "#cbd5e1", cursor: "pointer", fontSize: 20, padding: "0 4px", marginLeft: "auto", transition: "color 0.15s" }}
                    onMouseEnter={e => e.currentTarget.style.color = "#ef4444"} onMouseLeave={e => e.currentTarget.style.color = "#cbd5e1"}>×</button>
                )}
              </div>
            ))}
          </div>
          <button onClick={addTier} style={{ marginTop: 10, background: "none", border: "1px dashed #cbd5e1", borderRadius: 10, color: "#94a3b8", padding: "8px 16px", cursor: "pointer", fontSize: 13, fontFamily: FONT, transition: "all 0.15s" }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = "#0284c7"; e.currentTarget.style.color = "#0284c7"; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = "#cbd5e1"; e.currentTarget.style.color = "#94a3b8"; }}>+ Kademe Ekle</button>
        </div>

        {/* Verdict */}
        <div style={{
          background: isProof ? "linear-gradient(135deg, #f0fdf4, #ecfdf5)" : "linear-gradient(135deg, #fef2f2, #fff1f2)",
          border: `1px solid ${isProof ? "#bbf7d0" : "#fecaca"}`,
          borderRadius: 14, padding: "16px 20px", marginBottom: 16, display: "flex", alignItems: "center", gap: 14,
        }}>
          <div style={{ fontSize: 28 }}>{isProof ? "✅" : "⚠️"}</div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 16, color: isProof ? "#166534" : "#991b1b" }}>
              {isProof ? "Barem Arbitraj-Proof" : "Arbitraj Riski Tespit Edildi"}
            </div>
            {!isProof && maxArb.amt > 0 && (
              <div style={{ color: "#7f1d1d", fontSize: 13, marginTop: 2 }}>
                En yüksek risk: <strong>{fmt(maxArb.amt)} ₺</strong> sepette bölme ile <strong>+{fmt(maxArb.diff)} ₺</strong> fazla indirim
                {maxArb.parts && <span style={{ color: "#b91c1c" }}> ({fmt(maxArb.parts[0])} + {fmt(maxArb.parts[1])})</span>}
              </div>
            )}
            {isProof && <div style={{ color: "#15803d", fontSize: 13, marginTop: 2 }}>Sepet bölmek hiçbir senaryoda müşteriye avantaj sağlamıyor.</div>}
          </div>
        </div>

        {/* Recommendations */}
        {recommendations.length > 0 && (
          <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 14, padding: "20px", marginBottom: 16, boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 10 }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 16, color: "#0f172a" }}>💡 Düzeltme Önerileri</div>
                <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 2 }}>Her sorunlu kademe için minimum düzeltme — tıklayarak uygulayın</div>
              </div>
              <button onClick={autoFixAll} style={{
                background: "linear-gradient(135deg, #059669, #047857)", border: "none",
                borderRadius: 10, color: "#fff", padding: "10px 20px", cursor: "pointer", fontSize: 13, fontFamily: FONT, fontWeight: 600,
                boxShadow: "0 2px 8px rgba(5,150,105,0.3)", transition: "transform 0.1s, box-shadow 0.1s",
              }}
              onMouseEnter={e => { e.currentTarget.style.transform = "translateY(-1px)"; e.currentTarget.style.boxShadow = "0 4px 12px rgba(5,150,105,0.4)"; }}
              onMouseLeave={e => { e.currentTarget.style.transform = "none"; e.currentTarget.style.boxShadow = "0 2px 8px rgba(5,150,105,0.3)"; }}>
                Tümünü Otomatik Düzelt ✨
              </button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {recommendations.map((rec, ri) => (
                <div key={ri} style={{ background: "#fafbfc", border: "1px solid #f1f5f9", borderRadius: 12, padding: "16px" }}>
                  <div style={{ fontSize: 13, color: "#475569", marginBottom: 12, lineHeight: 1.7 }}>
                    <span style={{ background: "#fef2f2", color: "#dc2626", padding: "2px 8px", borderRadius: 6, fontSize: 11, fontWeight: 600, marginRight: 6 }}>SORUN</span>
                    <strong style={{ color: "#0f172a" }}>{fmt(rec.worstAmt)} ₺</strong> sepette{" "}
                    <strong style={{ color: "#0f172a" }}>{fmt(rec.tier.threshold)} ₺</strong> kademesi{" "}
                    <span style={{ color: "#0284c7", fontWeight: 600 }}>{fmt(rec.singleDisc)} ₺</span> indirim sağlıyor,
                    ama <span style={{ color: "#dc2626", fontWeight: 600 }}>{fmt(rec.parts[0])} + {fmt(rec.parts[1])}</span> bölme ile{" "}
                    <span style={{ color: "#dc2626", fontWeight: 600 }}>{fmt(rec.bestDisc)} ₺</span> alınabiliyor
                    <span style={{ color: "#dc2626", fontWeight: 600 }}> (+{fmt(rec.diff)} ₺ arbitraj)</span>
                  </div>
                  <button onClick={() => applyFix(rec.fix)} style={{
                    background: "#fff", border: "1px solid #d1fae5", borderRadius: 10, color: "#334155", padding: "12px 16px",
                    cursor: "pointer", fontSize: 13, fontFamily: FONT, textAlign: "left", width: "100%", transition: "all 0.15s",
                  }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = "#059669"; e.currentTarget.style.boxShadow = "0 2px 8px rgba(5,150,105,0.1)"; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = "#d1fae5"; e.currentTarget.style.boxShadow = "none"; }}>
                    <div style={{ color: "#059669", fontWeight: 600, fontSize: 12, marginBottom: 4 }}>↑ Düzeltme: {fmt(rec.tier.threshold)} ₺ kademesinin indirimini yükselt</div>
                    <div>
                      Mevcut: <span style={{ color: "#94a3b8" }}>{rec.tier.type === "abs" ? `${fmt(rec.tier.value)} ₺` : `%${rec.tier.value}`}</span>
                      {" → "} Önerilen: <strong style={{ color: "#059669" }}>{rec.fix.label}</strong>
                    </div>
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Chart */}
        <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 14, padding: "24px 16px 12px 0", marginBottom: 16, boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
          <div style={{ paddingLeft: 20, marginBottom: 8, fontSize: 13, fontWeight: 600, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em" }}>Efektif İndirim Oranı Grafiği</div>
          <ResponsiveContainer width="100%" height={340}>
            <ComposedChart data={chartData} margin={{ top: 10, right: 20, left: 10, bottom: 20 }}>
              <defs>
                <linearGradient id="eG" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#0284c7" stopOpacity={0.12} />
                  <stop offset="100%" stopColor="#0284c7" stopOpacity={0.01} />
                </linearGradient>
                <linearGradient id="aG" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#dc2626" stopOpacity={0.12} />
                  <stop offset="100%" stopColor="#dc2626" stopOpacity={0.01} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis dataKey="amt" tickFormatter={fmtK} stroke="#cbd5e1" fontSize={11} tick={{ fill: "#94a3b8" }}
                label={{ value: "Sepet Tutarı (₺)", position: "insideBottom", offset: -10, fill: "#94a3b8", fontSize: 12 }} />
              <YAxis tickFormatter={v => `%${v}`} stroke="#cbd5e1" fontSize={11} tick={{ fill: "#94a3b8" }} domain={[0, "auto"]}
                label={{ value: "Efektif İndirim %", angle: -90, position: "insideLeft", offset: 10, fill: "#94a3b8", fontSize: 12 }} />
              <Tooltip content={<CTooltip />} />
              {sorted.map((t, i) => (
                <ReferenceLine key={i} x={t.threshold} stroke="#e2e8f0" strokeDasharray="4 4"
                  label={{ value: fmtK(t.threshold), fill: "#cbd5e1", fontSize: 10, position: "top" }} />
              ))}
              <Area type="monotone" dataKey="effRate" stroke="#0284c7" fill="url(#eG)" strokeWidth={2.5} dot={false} />
              <Area type="monotone" dataKey="splitRate" stroke="#dc2626" fill="url(#aG)" strokeWidth={2} dot={false} strokeDasharray="6 3" />
            </ComposedChart>
          </ResponsiveContainer>
          <div style={{ display: "flex", gap: 24, justifyContent: "center", padding: "4px 0 4px", fontSize: 12 }}>
            <span style={{ display: "flex", alignItems: "center", gap: 6, color: "#64748b" }}><span style={{ width: 16, height: 3, background: "#0284c7", borderRadius: 2, display: "inline-block" }} /> Tek sepet</span>
            <span style={{ display: "flex", alignItems: "center", gap: 6, color: "#64748b" }}><span style={{ width: 16, height: 3, background: "#dc2626", borderRadius: 2, display: "inline-block" }} /> Bölme ile</span>
          </div>
        </div>

        {/* Table */}
        <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 14, overflow: "hidden", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
          <div style={{ padding: "16px 20px 0", fontSize: 13, fontWeight: 600, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em" }}>Kademe Detayları</div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginTop: 8 }}>
            <thead>
              <tr>
                {["Eşik", "Tip", "İndirim", "Eff%", "Maks Alt Eff%", "Durum"].map(h => (
                  <th key={h} style={{ padding: "10px 14px", textAlign: "right", color: "#94a3b8", fontWeight: 500, fontSize: 12, borderBottom: "1px solid #f1f5f9" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((t, i) => {
                const discAt = t.type === "pct" ? t.threshold * (t.value / 100) : t.value;
                const currEff = t.threshold > 0 ? (discAt / t.threshold) * 100 : 0;
                let peakLower = 0;
                for (let k = 0; k < i; k++) {
                  const pk = sorted[k].type === "pct" ? sorted[k].value : (sorted[k].value / sorted[k].threshold) * 100;
                  if (pk > peakLower) peakLower = pk;
                }
                // Also check if any split in this tier's range beats single
                const hasArbInRange = recommendations.some(r => r.tierIdx === i);
                const issue = hasArbInRange || (i > 0 && peakLower > currEff);
                return (
                  <tr key={i} style={{ borderBottom: "1px solid #f8fafc" }}>
                    <td style={{ padding: "10px 14px", textAlign: "right", color: "#0f172a", fontWeight: 500 }}>{fmt(t.threshold)} ₺</td>
                    <td style={{ padding: "10px 14px", textAlign: "right" }}>
                      <span style={{ background: t.type === "abs" ? "#eff6ff" : "#f5f3ff", color: t.type === "abs" ? "#0284c7" : "#7c3aed", padding: "2px 8px", borderRadius: 6, fontSize: 11, fontWeight: 600 }}>
                        {t.type === "abs" ? "₺ Sabit" : "% Oran"}
                      </span>
                    </td>
                    <td style={{ padding: "10px 14px", textAlign: "right", color: t.type === "abs" ? "#0284c7" : "#7c3aed", fontWeight: 600 }}>
                      {t.type === "abs" ? `${fmt(t.value)} ₺` : `%${t.value}`}
                    </td>
                    <td style={{ padding: "10px 14px", textAlign: "right", color: "#0f172a", fontWeight: 600 }}>{fmtPct(currEff)}</td>
                    <td style={{ padding: "10px 14px", textAlign: "right", color: issue ? "#dc2626" : "#94a3b8", fontWeight: issue ? 600 : 400 }}>
                      {i > 0 ? fmtPct(peakLower) : "—"}
                    </td>
                    <td style={{ padding: "10px 14px", textAlign: "right" }}>
                      {i === 0 ? <span style={{ color: "#94a3b8" }}>—</span> : issue ? (
                        <span style={{ background: "#fef2f2", color: "#dc2626", padding: "3px 10px", borderRadius: 8, fontSize: 11, fontWeight: 600 }}>⚠️ Risk</span>
                      ) : (
                        <span style={{ background: "#f0fdf4", color: "#16a34a", padding: "3px 10px", borderRadius: 8, fontSize: 11, fontWeight: 600 }}>✅ OK</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <p style={{ color: "#94a3b8", fontSize: 12, marginTop: 16, lineHeight: 1.7, textAlign: "center" }}>
          Arbitraj tespiti tüm olası sepet bölme kombinasyonlarını (tek kademe + çapraz kademe) tarar.
          Öneri motoru her sorunlu kademe için minimum indirim artışını hesaplar.
        </p>
      </div>
    </div>
  );
}
