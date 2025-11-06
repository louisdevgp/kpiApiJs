// controllers/export.controller.js
const { pool } = require("../lib/db");
const { Parser, Transform } = require("json2csv");

// Helpers: libellés FR + mapping raisons
function reasonLabel(key) {
  const map = {
    OFFLINE_DURATION: "Hors-ligne prolongé",
    STATUS_INACTIVE: "Statut inactif",
    SIGNAL_LOW: "Signal faible",
    GEOFENCE_OUT: "Hors geofence",
    BATTERY_LOW: "Batterie faible",
    PAPER_OUT: "Plus de papier",
    PAPER_UNKNOWN: "État papier inconnu",
    PAPER_UNKNOWN_WARN: "Papier incertain",
    NO_DATA: "Pas de données",
  };
  return map[key] || key;
}
function statusLabelDaily(day_ok) {
  return Number(day_ok) === 1 ? "DISPONIBLE" : "INDISPONIBLE";
}
function statusLabelWeekly(decision) {
  return Number(decision) === 1 ? "DISPONIBLE" : "INDISPONIBLE";
}

// Optionnel : recalcul avant export si ?auto=1
async function maybeRecomputeDaily(date, policyId, week_start, auto) {
  if (!auto) return;
  try {
    const availabilityCtrl = require("./availability.controller");
    await availabilityCtrl.computeDaily(
      { body: { date, week_start, policyId } },
      { json: () => {}, status: () => ({ json: () => {} }) }
    );
  } catch (e) {
    console.warn("[export] Recompute daily failed:", e.message);
  }
}
async function maybeRecomputeWeekly(week_start, policyId, auto) {
  if (!auto) return;
  try {
    const availabilityCtrl = require("./availability.controller");
    await availabilityCtrl.computeWeekly(
      { body: { week_start, policyId, auto: true } },
      { json: () => {}, status: () => ({ json: () => {} }) }
    );
  } catch (e) {
    console.warn("[export] Recompute weekly failed:", e.message);
  }
}

exports.dailyExport = async (req, res) => {
  try {
    const date = req.query.date;
    const policyId = Number(req.query.policyId);
    const week_start = req.query.week_start; // utile si auto=1
    const auto = String(req.query.auto || "0") === "1";

    if (!date || !policyId)
      return res.status(400).json({ error: "date & policyId requis" });

    await maybeRecomputeDaily(date, policyId, week_start, auto);

    // On stream pour éviter de charger toute la sortie en RAM
    const [rows] = await pool.query(
      `SELECT terminal_sn, day_ok, slot_ok_count, slot_fail_count,
              JSON_EXTRACT(failed_slots_json,'$')   AS failed_slots_raw,
              JSON_EXTRACT(failed_reasons_json,'$') AS failed_reasons_raw
         FROM kpi2_daily_results
        WHERE date = ? AND policy_id = ?
        ORDER BY terminal_sn`,
      [date, policyId]
    );

    // Projection + libellés
    const data = rows.map((r) => {
      let slots = [];
      let reasons = [];
      try {
        slots = Array.isArray(r.failed_slots_raw)
          ? r.failed_slots_raw
          : JSON.parse(r.failed_slots_raw || "[]");
      } catch {}
      try {
        const arr = Array.isArray(r.failed_reasons_raw)
          ? r.failed_reasons_raw
          : JSON.parse(r.failed_reasons_raw || "[]");
        reasons = (arr || []).map(reasonLabel);
      } catch {}

      return {
        Date: date,
        PolicyID: policyId,
        Terminal: r.terminal_sn,
        Statut: statusLabelDaily(r.day_ok), // DISPONIBLE/INDISPONIBLE
        "Slots OK": Number(r.slot_ok_count),
        "Slots KO": Number(r.slot_fail_count),
        "Créneaux KO": slots.join(" | "),
        "Raisons KO": reasons.join(" | "),
      };
    });

    // CSV avec BOM (Excel friendly)
    const parser = new Parser({
      withBOM: true,
      fields: ["Date", "PolicyID", "Terminal", "Statut", "Slots OK", "Slots KO", "Créneaux KO", "Raisons KO"],
    });
    const csv = parser.parse(data);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="daily_${date}_policy${policyId}.csv"`
    );
    res.setHeader("Cache-Control", "no-store");
    res.send(csv);
  } catch (err) {
    console.error("dailyExport error:", err);
    res.status(500).json({ error: err.message || "dailyExport failed" });
  }
};

exports.weeklyExport = async (req, res) => {
  try {
    const week_start = req.query.week_start;
    const policyId = Number(req.query.policyId);
    const auto = String(req.query.auto || "0") === "1";

    if (!week_start || !policyId)
      return res.status(400).json({ error: "week_start & policyId requis" });

    await maybeRecomputeWeekly(week_start, policyId, auto);

    const [rows] = await pool.query(
      `SELECT terminal_sn, decision, days_ok, days_fail, slots_ok_total, slots_fail_total,
              JSON_EXTRACT(fail_dates_json,'$')   AS fail_dates_raw,
              JSON_EXTRACT(week_reasons_json,'$') AS week_reasons_raw
         FROM kpi2_weekly_results
        WHERE week_start = ? AND policy_id = ?
        ORDER BY terminal_sn`,
      [week_start, policyId]
    );

    const data = rows.map((r) => {
      let dates = [];
      let reasonsObj = {};
      try {
        dates = Array.isArray(r.fail_dates_raw)
          ? r.fail_dates_raw
          : JSON.parse(r.fail_dates_raw || "[]");
      } catch {}
      try {
        reasonsObj =
          typeof r.week_reasons_raw === "object"
            ? r.week_reasons_raw
            : JSON.parse(r.week_reasons_raw || "{}");
      } catch {}

      // "Raisons semaine" sous forme "RAISON:compteur"
      const reasonsStr = Object.entries(reasonsObj)
        .map(([k, v]) => `${reasonLabel(k)}:${v}`)
        .join(" | ");

      return {
        "Semaine (lundi)": week_start,
        PolicyID: policyId,
        Terminal: r.terminal_sn,
        Décision: statusLabelWeekly(r.decision), // DISPONIBLE/INDISPONIBLE
        "Jours OK": Number(r.days_ok),
        "Jours KO": Number(r.days_fail),
        "Slots OK (sem.)": Number(r.slots_ok_total),
        "Slots KO (sem.)": Number(r.slots_fail_total),
        "Dates KO": dates.join(" | "),
        "Raisons (compteurs)": reasonsStr,
      };
    });

    const parser = new Parser({
      withBOM: true,
      fields: [
        "Semaine (lundi)",
        "PolicyID",
        "Terminal",
        "Décision",
        "Jours OK",
        "Jours KO",
        "Slots OK (sem.)",
        "Slots KO (sem.)",
        "Dates KO",
        "Raisons (compteurs)",
      ],
    });
    const csv = parser.parse(data);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="weekly_${week_start}_policy${policyId}.csv"`
    );
    res.setHeader("Cache-Control", "no-store");
    res.send(csv);
  } catch (err) {
    console.error("weeklyExport error:", err);
    res.status(500).json({ error: err.message || "weeklyExport failed" });
  }
};
