// controllers/metrics.controller.js
const { pool } = require("../lib/db");
const { toMonday, DateTime } = require("../utils/time");

/* Résolution de la version à utiliser */
async function resolvePolicyVersion(policyId, explicitVersion) {
  if (!policyId) throw new Error("policyId manquant");

  if (explicitVersion != null && explicitVersion !== "") {
    const v = Number(explicitVersion);
    if (!Number.isFinite(v) || v <= 0) {
      throw new Error("policyVersion invalide");
    }
    return v;
  }

  const [[row]] = await pool.query(
    "SELECT current_version FROM kpi2_policy WHERE id = ?",
    [policyId]
  );
  if (!row) throw new Error(`Policy ${policyId} introuvable`);
  return Number(row.current_version || 1);
}

/**
 * GET /api/metrics/summary/latest?policyId=1[&policyVersion=2]
 */
exports.summaryLatest = async (req, res) => {
  try {
    const policyId = Number(req.query.policyId);
    if (!policyId) return res.status(400).json({ error: "policyId requis" });

    const policyVersion = await resolvePolicyVersion(
      policyId,
      req.query.policyVersion
    );

    // 1) Dernière date dispo (jour) pour cette policy + version
    const [[last]] = await pool.query(
      `SELECT MAX(date) AS last_date 
         FROM kpi2_daily_results 
        WHERE policy_id = ? AND policy_version = ?`,
      [policyId, policyVersion]
    );
    if (!last?.last_date) {
      return res.json({
        data: null,
        message: "Aucune donnée pour cette policy / version",
      });
    }

    const dateISO = DateTime.fromJSDate(last.last_date, {
      zone: "utc",
    }).toISODate();

    // 2) Week start déduit de la date du jour
    const weekStartFromDay = toMonday(dateISO);

    // 3) Dernière semaine réellement agrégée pour cette policy + version
    const [[wlast]] = await pool.query(
      `SELECT MAX(week_start) AS last_week 
         FROM kpi2_weekly_results 
        WHERE policy_id = ? AND policy_version = ?`,
      [policyId, policyVersion]
    );
    const weekStartISO = wlast?.last_week
      ? DateTime.fromJSDate(wlast.last_week, { zone: "utc" }).toISODate()
      : weekStartFromDay;

    // 4) Agrégats jour
    const [[dayAgg]] = await pool.query(
      `SELECT 
         COUNT(*) AS tpe_day_total,
         SUM(CASE WHEN day_ok=1 THEN 1 ELSE 0 END) AS tpe_day_ok,
         SUM(slot_ok_count) AS slots_ok_day,
         SUM(slot_fail_count) AS slots_fail_day
       FROM kpi2_daily_results
       WHERE date = ? AND policy_id = ? AND policy_version = ?`,
      [dateISO, policyId, policyVersion]
    );

    // 5) Agrégats semaine
    const [[weekAgg]] = await pool.query(
      `SELECT 
         COUNT(*) AS tpe_week_total,
         SUM(CASE WHEN decision=1 THEN 1 ELSE 0 END) AS tpe_week_ok
       FROM kpi2_weekly_results
       WHERE week_start = ? AND policy_id = ? AND policy_version = ?`,
      [weekStartISO, policyId, policyVersion]
    );

    // 6) Normalisations / dérivés
    const tpe_day_total = Number(dayAgg?.tpe_day_total || 0);
    const tpe_day_ok = Number(dayAgg?.tpe_day_ok || 0);
    const tpe_day_fail = Math.max(0, tpe_day_total - tpe_day_ok);

    const tpe_week_total = Number(weekAgg?.tpe_week_total || 0);
    const tpe_week_ok = Number(weekAgg?.tpe_week_ok || 0);
    const tpe_week_fail = Math.max(0, tpe_week_total - tpe_week_ok);

    const daily_available_pct =
      tpe_day_total > 0 ? (100 * tpe_day_ok) / tpe_day_total : 0;
    const weekly_available_pct =
      tpe_week_total > 0 ? (100 * tpe_week_ok) / tpe_week_total : 0;

    res.json({
      data: {
        date: dateISO,
        week_start: weekStartISO,
        policy_id: policyId,
        policy_version: policyVersion,

        tpe_day_total,
        tpe_day_ok,
        tpe_day_fail,
        slots_ok_day: Number(dayAgg?.slots_ok_day || 0),
        slots_fail_day: Number(dayAgg?.slots_fail_day || 0),
        daily_available_pct: Number(daily_available_pct),

        tpe_week_total,
        tpe_week_ok,
        tpe_week_fail,
        weekly_available_pct: Number(weekly_available_pct),
      },
    });
  } catch (err) {
    console.error("summaryLatest error:", err);
    res.status(500).json({ error: err.message || "summaryLatest failed" });
  }
};
