// controllers/metrics.controller.js
const { pool } = require("../lib/db");
const { toISODate } = require("../utils/time");

/**
 * GET /api/metrics/summary
 * Query: { date, week_start, policyId }
 *
 * Réponse:
 * {
 *   tpe_day_total, tpe_day_ok, tpe_day_fail,
 *   daily_available_pct,
 *   slots_ok_day, slots_fail_day,
 *   tpe_week_total, tpe_week_ok, tpe_week_fail,
 *   weekly_available_pct,
 *   last_daily_computed_at, last_weekly_computed_at
 * }
 */
exports.getSummary = async (req, res) => {
  try {
    const dateISO = toISODate(req.query.date);
    const weekStartISO = toISODate(req.query.week_start);
    const policyId = Number(req.query.policyId);

    if (!dateISO || !weekStartISO || !policyId) {
      return res.status(400).json({
        error: "Paramètres requis: date, week_start et policyId",
      });
    }

    // ----- Aggregats jour -----
    const [[dayAgg]] = await pool.query(
      `
      SELECT
        COUNT(*) AS tpe_day_total,
        SUM(CASE WHEN day_ok = 1 THEN 1 ELSE 0 END) AS tpe_day_ok,
        SUM(slot_ok_count)   AS slots_ok_day,
        SUM(slot_fail_count) AS slots_fail_day,
        DATE_FORMAT(MAX(computed_at), '%Y-%m-%d %H:%i:%s') AS last_daily_computed_at
      FROM kpi2_daily_results
      WHERE date = ? AND policy_id = ?
      `,
      [dateISO, policyId]
    );

    const tpe_day_total = Number(dayAgg?.tpe_day_total || 0);
    const tpe_day_ok = Number(dayAgg?.tpe_day_ok || 0);
    const tpe_day_fail = Math.max(0, tpe_day_total - tpe_day_ok);
    const slots_ok_day = Number(dayAgg?.slots_ok_day || 0);
    const slots_fail_day = Number(dayAgg?.slots_fail_day || 0);
    const daily_available_pct =
      tpe_day_total > 0 ? (tpe_day_ok * 100) / tpe_day_total : 0;

    // ----- Aggregats semaine -----
    // decision: TINYINT(1) — 1 = DISPONIBLE, 0 = INDISPONIBLE
    const [[weekAgg]] = await pool.query(
      `
      SELECT
        COUNT(*) AS tpe_week_total,
        SUM(CASE WHEN decision = 1 THEN 1 ELSE 0 END) AS tpe_week_ok,
        SUM(slots_ok_total)   AS slots_ok_week,
        SUM(slots_fail_total) AS slots_fail_week,
        DATE_FORMAT(MAX(computed_at), '%Y-%m-%d %H:%i:%s') AS last_weekly_computed_at
      FROM kpi2_weekly_results
      WHERE week_start = ? AND policy_id = ?
      `,
      [weekStartISO, policyId]
    );

    const tpe_week_total = Number(weekAgg?.tpe_week_total || 0);
    const tpe_week_ok = Number(weekAgg?.tpe_week_ok || 0);
    const tpe_week_fail = Math.max(0, tpe_week_total - tpe_week_ok);
    const weekly_available_pct =
      tpe_week_total > 0 ? (tpe_week_ok * 100) / tpe_week_total : 0;

    res.json({
      // JOUR
      tpe_day_total,
      tpe_day_ok,
      tpe_day_fail,
      daily_available_pct,        // ex: 87.5 (le front formate en "87.5%")
      slots_ok_day,
      slots_fail_day,
      last_daily_computed_at: dayAgg?.last_daily_computed_at || null,

      // SEMAINE
      tpe_week_total,
      tpe_week_ok,
      tpe_week_fail,
      weekly_available_pct,       // ex: 91.2
      last_weekly_computed_at: weekAgg?.last_weekly_computed_at || null,
    });
  } catch (err) {
    console.error("getSummary error:", err);
    res.status(500).json({ error: err.message || "metrics summary failed" });
  }
};
