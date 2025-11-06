// controllers/bi.controller.js
const { pool } = require("../lib/db");

exports.dailyUnavailable = async (req, res) => {
  try {
    const date = req.query.date;
    const policyId = Number(req.query.policyId);
    if (!date || !policyId)
      return res.status(400).json({ error: "date & policyId requis" });

    const [rows] = await pool.query(
      `SELECT
         terminal_sn,
         JSON_EXTRACT(failed_reasons_json,'$') AS reasons_raw,
         JSON_EXTRACT(failed_slots_json,'$')   AS slots_raw,
         slot_ok_count, slot_fail_count
       FROM kpi2_daily_results
       WHERE date = ? AND policy_id = ? AND day_ok = 0
       ORDER BY terminal_sn`,
      [date, policyId]
    );

    const data = rows.map((r) => {
      let reasons = [];
      let slots = [];
      try {
        reasons = Array.isArray(r.reasons_raw)
          ? r.reasons_raw
          : JSON.parse(r.reasons_raw || "[]");
      } catch {}
      try {
        slots = Array.isArray(r.slots_raw)
          ? r.slots_raw
          : JSON.parse(r.slots_raw || "[]");
      } catch {}
      return {
        terminal_sn: r.terminal_sn,
        reasons,
        failed_slots: slots,
        slot_ok_count: Number(r.slot_ok_count || 0),
        slot_fail_count: Number(r.slot_fail_count || 0),
      };
    });

    res.json({ data });
  } catch (err) {
    console.error("bi.dailyUnavailable error:", err);
    res.status(500).json({ error: err.message || "dailyUnavailable failed" });
  }
};

exports.weeklyUnavailable = async (req, res) => {
  try {
    const week_start = req.query.week_start;
    const policyId = Number(req.query.policyId);
    if (!week_start || !policyId)
      return res.status(400).json({ error: "week_start & policyId requis" });

    const [rows] = await pool.query(
      `SELECT
         terminal_sn,
         JSON_EXTRACT(fail_dates_json,'$')   AS fail_dates_raw,
         JSON_EXTRACT(week_reasons_json,'$') AS reasons_raw,
         days_ok, days_fail, slots_ok_total, slots_fail_total
       FROM kpi2_weekly_results
       WHERE week_start = ? AND policy_id = ? AND decision = 0
       ORDER BY terminal_sn`,
      [week_start, policyId]
    );

    const data = rows.map((r) => {
      let fail_dates = [];
      let reasons = {};
      try {
        fail_dates = Array.isArray(r.fail_dates_raw)
          ? r.fail_dates_raw
          : JSON.parse(r.fail_dates_raw || "[]");
      } catch {}
      try {
        reasons =
          typeof r.reasons_raw === "object"
            ? r.reasons_raw
            : JSON.parse(r.reasons_raw || "{}");
      } catch {
        reasons = {};
      }
      return {
        terminal_sn: r.terminal_sn,
        fail_dates,
        reasons, // { BATTERY_LOW: 2, PAPER_OUT: 1, ... }
        days_ok: Number(r.days_ok || 0),
        days_fail: Number(r.days_fail || 0),
        slots_ok_total: Number(r.slots_ok_total || 0),
        slots_fail_total: Number(r.slots_fail_total || 0),
      };
    });

    res.json({ data });
  } catch (err) {
    console.error("bi.weeklyUnavailable error:", err);
    res.status(500).json({ error: err.message || "weeklyUnavailable failed" });
  }
};
