// controllers/availability.controller.js
const { pool } = require("../lib/db");
const {
  toISODate,
  toMonday,
  weekRange,
  fmtDateTime,
  DateTime,
} = require("../utils/time");

// ================= Helpers =================

function isOfflineDurationBad(offline) {
  if (!offline) return false;
  const s = String(offline).toLowerCase();
  return (
    s.includes("> 1 day") ||
    s.includes("> 2 day") ||
    s.includes("> 7 day") ||
    s.includes(">") ||
    s.includes("days")
  );
}

function parsePrinterStatus(printer) {
  const s = String(printer || "").trim().toLowerCase();
  if (!s) return { paper: "unknown", batteryHint: null };

  if (s === "available") return { paper: "ok", batteryHint: null };
  if (s === "out of paper") return { paper: "out", batteryHint: null };
  if (s === "low voltage" || s.includes("low voltage"))
    return { paper: "ok", batteryHint: "low" };

  return { paper: "unknown", batteryHint: null };
}

function isStatusActive(status) {
  if (!status) return false;
  const s = String(status).toLowerCase();
  return s.includes("active") || s.includes("online");
}
function parseSignal(signal) {
  if (signal == null) return 0;
  const n = Number(signal);
  return Number.isFinite(n) ? n : 0;
}
function parseBatteryPct(battery_rate_avg) {
  if (battery_rate_avg == null) return 0;
  const n = Number(battery_rate_avg);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}
function isGeofenceOk(geofence) {
  if (!geofence) return false;
  return String(geofence).toLowerCase().includes("in geofence");
}
function isPrinterOk(printer) {
  if (!printer) return false;
  return String(printer).toLowerCase() === "available";
}

async function getLockedPolicyForWeekOrActive(weekStartISO, explicitPolicyId) {
  if (explicitPolicyId) {
    const [rows] = await pool.query("SELECT * FROM kpi2_policy WHERE id = ?", [
      explicitPolicyId,
    ]);
    if (!rows.length) throw new Error(`Policy ${explicitPolicyId} introuvable`);
    return rows[0];
  }
  try {
    const wk = DateTime.fromISO(weekStartISO, { zone: "utc" });
    const week_number = Number(wk.weekNumber);
    const week_year = Number(wk.weekYear);
    const [lock] = await pool.query(
      `SELECT p.* 
         FROM kpi2_policy_week_lock l 
         JOIN kpi2_policy p ON p.id = l.policy_id
        WHERE l.week_year = ? AND l.week_number = ?
        LIMIT 1`,
      [week_year, week_number]
    );
    if (lock.length) return lock[0];
  } catch {
    /* ignore */
  }
  const [active] = await pool.query(
    `SELECT * FROM kpi2_policy WHERE status = 'active' ORDER BY id DESC LIMIT 1`
  );
  if (!active.length) throw new Error("Aucune policy active trouvée.");
  return active[0];
}

// === Data access
async function listAllTerminalsOnDate(dateISO) {
  const start = DateTime.fromISO(dateISO, { zone: "utc" })
    .startOf("day")
    .toSQL();
  const end = DateTime.fromISO(dateISO, { zone: "utc" })
    .plus({ days: 1 })
    .startOf("day")
    .toSQL();
  const [rows] = await pool.query(
    `SELECT DISTINCT terminal_sn 
       FROM vw_greenpay_timeline 
      WHERE event_time >= ? AND event_time < ?`,
    [start, end]
  );
  return rows.map((r) => r.terminal_sn);
}

/**
 * Best row par (terminal_sn, hour) dans la journée
 */
async function fetchBestRowsByHourInDay(dateISO) {
  const start = DateTime.fromISO(dateISO, { zone: "utc" })
    .startOf("day")
    .toSQL();
  const end = DateTime.fromISO(dateISO, { zone: "utc" })
    .plus({ days: 1 })
    .startOf("day")
    .toSQL();
  const sql = `
    WITH rows_in_day AS (
      SELECT
        terminal_sn,
        event_time,
        status,
        offline_duration,
        \`signal\`,
        geofence,
        battery_rate_avg,
        printer,
        is_charging,
        HOUR(event_time) AS slot_hour,
        ROW_NUMBER() OVER (
          PARTITION BY terminal_sn, HOUR(event_time)
          ORDER BY event_time DESC
        ) AS rn
      FROM vw_greenpay_timeline
      WHERE event_time >= ? AND event_time < ?
    )
    SELECT *
    FROM rows_in_day
    WHERE rn = 1
  `;
  const [rows] = await pool.query(sql, [start, end]);
  return rows;
}

// ================= Core eval =================

/**
 * Retourne { ok: boolean, reasons: string[] }
 * reasons ∈ { OFFLINE_DURATION, STATUS_INACTIVE, SIGNAL_LOW, GEOFENCE_OUT, BATTERY_LOW, PAPER_OUT, PAPER_UNKNOWN, PAPER_UNKNOWN_WARN, NO_DATA }
 */
function evalSlot(rowOrNull, policy) {
  if (!rowOrNull) return { ok: false, reasons: ["NO_DATA"] };
  const r = rowOrNull;
  let ok = true;
  const reasons = [];

  // TPE ON
  if (policy.use_tpe_on) {
    if (isOfflineDurationBad(r.offline_duration)) {
      ok = false;
      reasons.push("OFFLINE_DURATION");
    }
    if (!isStatusActive(r.status)) {
      ok = false;
      reasons.push("STATUS_INACTIVE");
    }
  }

  // Internet
  if (policy.use_internet) {
    if (parseSignal(r.signal) < 2) {
      ok = false;
      reasons.push("SIGNAL_LOW");
    }
  }

  // Geofence
  if (policy.use_geofence) {
    if (!isGeofenceOk(r.geofence)) {
      ok = false;
      reasons.push("GEOFENCE_OUT");
    }
  }

  // Printer + Battery
  const { paper, batteryHint } = parsePrinterStatus(r.printer);

  // Battery
  if (policy.use_battery) {
    if (batteryHint === "low") {
      ok = false;
      reasons.push("BATTERY_LOW");
    } else {
      const pct = parseBatteryPct(r.battery_rate_avg); // ex: 0.18 -> 18%
      if (pct < Number(policy.battery_min_pct || 0)) {
        ok = false;
        reasons.push("BATTERY_LOW");
      }
    }
  }

  // Paper
  if (policy.use_paper) {
    const strict = (policy.paper_mode || "strict") === "strict";
    if (paper === "out") {
      ok = false;
      reasons.push("PAPER_OUT");
    } else if (paper === "unknown") {
      if (strict) {
        ok = false;
        reasons.push("PAPER_UNKNOWN");
      } else {
        reasons.push("PAPER_UNKNOWN_WARN");
      }
    }
  }

  return { ok, reasons };
}

// ================= DAILY =================

exports.computeDaily = async (req, res) => {
  try {
    const dateISO = toISODate(req.body.date);
    if (!dateISO)
      return res.status(400).json({ error: "date invalide (YYYY-MM-DD)" });

    const weekStartISO = req.body.week_start
      ? toISODate(req.body.week_start)
      : toMonday(dateISO);
    const policyId = req.body.policyId ? Number(req.body.policyId) : undefined;

    const policy = await getLockedPolicyForWeekOrActive(weekStartISO, policyId);

    const hours = Array.isArray(policy.slot_hours_json)
      ? policy.slot_hours_json.map(Number).filter(Number.isFinite)
      : [12, 13, 14, 15, 17, 18];

    // best rows par hour
    const bestRows = await fetchBestRowsByHourInDay(dateISO);

    // index (sn -> hour -> row)
    const bySn = new Map();
    for (const r of bestRows) {
      if (!bySn.has(r.terminal_sn)) bySn.set(r.terminal_sn, new Map());
      bySn.get(r.terminal_sn).set(Number(r.slot_hour), r);
    }

    // terminaux du jour
    const terminals = await listAllTerminalsOnDate(dateISO);
    if (!terminals.length)
      return res.json({ ok: true, message: "Aucun TPE ce jour", count: 0 });

    const upserts = [];
    for (const sn of terminals) {
      let okCount = 0,
        failCount = 0;
      const failedSlots = [];
      const reasonsSet = new Set();

      for (const h of hours) {
        const row = bySn.get(sn)?.get(h) || null;
        const slotRes = evalSlot(row, policy);
        if (slotRes.ok) okCount++;
        else {
          failCount++;
          const slotISO = DateTime.fromISO(dateISO, { zone: "utc" })
            .set({ hour: h, minute: 0, second: 0, millisecond: 0 })
            .toISO();
          failedSlots.push(slotISO);
          (slotRes.reasons || []).forEach((r) => reasonsSet.add(r));
        }
      }

      const day_ok = failCount < Number(policy.daily_fail_N || 0);
      upserts.push([
        dateISO,
        sn,
        policy.id,
        day_ok ? 1 : 0,
        okCount,
        failCount,
        JSON.stringify(failedSlots),
        JSON.stringify(Array.from(reasonsSet)),
      ]);
    }

    if (upserts.length) {
      const placeholders = upserts
        .map(() => "(?,?,?,?,?, ?, CAST(? AS JSON), CAST(? AS JSON), NOW())")
        .join(",");
      const flat = [];
      upserts.forEach(([d, sn, pid, dok, okc, fc, slots, reasons]) =>
        flat.push(d, sn, pid, dok, okc, fc, slots, reasons)
      );

      await pool.query(
        `INSERT INTO kpi2_daily_results
           (date, terminal_sn, policy_id, day_ok, slot_ok_count, slot_fail_count, failed_slots_json, failed_reasons_json, computed_at)
         VALUES ${placeholders}
         ON DUPLICATE KEY UPDATE
           day_ok = VALUES(day_ok),
           slot_ok_count = VALUES(slot_ok_count),
           slot_fail_count = VALUES(slot_fail_count),
           failed_slots_json = VALUES(failed_slots_json),
           failed_reasons_json = VALUES(failed_reasons_json),
           computed_at = NOW()`,
        flat
      );
    }
    res.json({ ok: true, count: upserts.length });
  } catch (err) {
    console.error("computeDaily error:", err);
    res.status(500).json({ error: err.message || "computeDaily failed" });
  }
};

// exports.getDaily = async (req, res) => {
//   try {
//     const dateISO = toISODate(req.query.date);
//     const policyId = Number(req.query.policyId);
//     if (!dateISO || !policyId) {
//       return res.status(400).json({ error: "date & policyId requis" });
//     }

//     const page = Math.max(1, Number(req.query.page || 1));
//     const pageSize = Math.min(
//       1000,
//       Math.max(1, Number(req.query.pageSize || 200))
//     );
//     const search = (req.query.search || "").trim();

//     const where = ["date = ?", "policy_id = ?"];
//     const args = [dateISO, policyId];
//     if (search) {
//       where.push("terminal_sn LIKE ?");
//       args.push(`%${search}%`);
//     }
//     const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

//     // totals + counters OK/KO
//     const [[cntRow]] = await pool.query(
//       `SELECT 
//          COUNT(*) AS total,
//          SUM(CASE WHEN day_ok=1 THEN 1 ELSE 0 END) AS ok_count,
//          SUM(CASE WHEN day_ok=0 THEN 1 ELSE 0 END) AS ko_count
//        FROM kpi2_daily_results ${whereSql}`,
//       args
//     );
//     const total = Number(cntRow?.total || 0);
//     const okCount = Number(cntRow?.ok_count || 0);
//     const koCount = Number(cntRow?.ko_count || 0);

//     args.push((page - 1) * pageSize, pageSize);

//     const [rows] = await pool.query(
//       `SELECT 
//           DATE_FORMAT(date, '%Y-%m-%d')                    AS date_fmt,
//           terminal_sn,
//           policy_id,
//           day_ok,
//           slot_ok_count,
//           slot_fail_count,
//           JSON_EXTRACT(failed_slots_json, '$')             AS failed_slots_raw,
//           JSON_EXTRACT(failed_reasons_json, '$')           AS failed_reasons_raw,
//           DATE_FORMAT(computed_at, '%Y-%m-%d %H:%i:%s')    AS computed_at_fmt
//        FROM kpi2_daily_results
//        ${whereSql}
//        ORDER BY terminal_sn
//        LIMIT ?, ?`,
//       args
//     );

//     const data = rows.map((r) => {
//       let failedSlots = [];
//       let failedReasons = [];
//       try {
//         const parsed =
//           Array.isArray(r.failed_slots_raw)
//             ? r.failed_slots_raw
//             : JSON.parse(r.failed_slots_raw || "[]");
//         failedSlots = (parsed || []).map((s) => fmtDateTime(s)).filter(Boolean);
//       } catch {
//         failedSlots = [];
//       }
//       try {
//         failedReasons = Array.isArray(r.failed_reasons_raw)
//           ? r.failed_reasons_raw
//           : JSON.parse(r.failed_reasons_raw || "[]");
//       } catch {
//         failedReasons = [];
//       }

//       return {
//         date: r.date_fmt,
//         terminal_sn: r.terminal_sn,
//         policy_id: r.policy_id,
//         day_ok: !!r.day_ok,
//         slot_ok_count: Number(r.slot_ok_count),
//         slot_fail_count: Number(r.slot_fail_count),
//         failed_slots: failedSlots, // 'YYYY-MM-DD HH:mm:ss'
//         failed_reasons: failedReasons, // ['BATTERY_LOW', 'PAPER_OUT', ...]
//         computed_at: r.computed_at_fmt,
//       };
//     });

//     // === AJOUT résumé (dispo / indispo + pourcentages) ===
//     const available_pct = total ? (okCount * 100) / total : 0;
//     const unavailable_pct = total ? (koCount * 100) / total : 0;

//     res.json({
//       data,
//       meta: {
//         total,
//         page,
//         pageSize,
//         available_count: okCount,
//         unavailable_count: koCount,
//       },
//       summary: {
//         tpe_day_total: total,
//         available_count: okCount,
//         unavailable_count: koCount,
//         available_pct: Number(available_pct.toFixed(2)),
//         unavailable_pct: Number(unavailable_pct.toFixed(2)),
//       },
//     });
//   } catch (err) {
//     console.error("getDaily error:", err);
//     res.status(500).json({ error: err.message || "getDaily failed" });
//   }
// };

// ================= WEEKLY =================


// controllers/availability.controller.js
exports.getDaily = async (req, res) => {
  try {
    const dateISO = toISODate(req.query.date);
    const policyId = Number(req.query.policyId);
    if (!dateISO || !policyId) {
      return res.status(400).json({ error: "date & policyId requis" });
    }

    const page = Math.max(1, Number(req.query.page || 1));
    const pageSize = Math.min(1000, Math.max(1, Number(req.query.pageSize || 200)));
    const search = (req.query.search || "").trim();
    const status = (req.query.status || "all").toLowerCase(); // all|available|unavailable

    const where = ["date = ?", "policy_id = ?"];
    const args = [dateISO, policyId];

    if (search) {
      where.push("terminal_sn LIKE ?");
      args.push(`%${search}%`);
    }
    if (status === "available") where.push("day_ok = 1");
    if (status === "unavailable") where.push("day_ok = 0");

    const whereSql = `WHERE ${where.join(" AND ")}`;

    // totaux & compteurs (dans le périmètre filtré)
    const [[cntRow]] = await pool.query(
      `SELECT 
         COUNT(*) AS total,
         SUM(CASE WHEN day_ok=1 THEN 1 ELSE 0 END) AS ok_count,
         SUM(CASE WHEN day_ok=0 THEN 1 ELSE 0 END) AS ko_count
       FROM kpi2_daily_results ${whereSql}`,
      args
    );
    const total = Number(cntRow?.total || 0);
    const okCount = Number(cntRow?.ok_count || 0);
    const koCount = Number(cntRow?.ko_count || 0);

    // pagination
    const pagingArgs = [...args, (page - 1) * pageSize, pageSize];

    const [rows] = await pool.query(
      `SELECT 
          DATE_FORMAT(date, '%Y-%m-%d')                 AS date_fmt,
          terminal_sn,
          policy_id,
          day_ok,
          slot_ok_count,
          slot_fail_count,
          JSON_EXTRACT(failed_slots_json, '$')          AS failed_slots_raw,
          JSON_EXTRACT(failed_reasons_json, '$')        AS failed_reasons_raw,
          DATE_FORMAT(computed_at, '%Y-%m-%d %H:%i:%s') AS computed_at_fmt
       FROM kpi2_daily_results
       ${whereSql}
       ORDER BY terminal_sn
       LIMIT ?, ?`,
      pagingArgs
    );

    const data = rows.map((r) => {
      let failedSlots = [];
      let failedReasons = [];
      try {
        const parsed = typeof r.failed_slots_raw === "string"
          ? JSON.parse(r.failed_slots_raw || "[]")
          : r.failed_slots_raw;
        failedSlots = (parsed || []).map((s) => fmtDateTime(s)).filter(Boolean);
      } catch {}

      try {
        failedReasons = typeof r.failed_reasons_raw === "string"
          ? JSON.parse(r.failed_reasons_raw || "[]")
          : (r.failed_reasons_raw || []);
      } catch {}

      return {
        date: r.date_fmt,
        terminal_sn: r.terminal_sn,
        policy_id: r.policy_id,
        day_ok: !!r.day_ok,
        slot_ok_count: Number(r.slot_ok_count),
        slot_fail_count: Number(r.slot_fail_count),
        failed_slots: failedSlots,
        failed_reasons: failedReasons,
        computed_at: r.computed_at_fmt,
      };
    });

    const available_pct = total ? (okCount * 100) / total : 0;
    const unavailable_pct = total ? (koCount * 100) / total : 0;

    res.json({
      data,
      meta: {
        total,
        page,
        pageSize,
        available_count: okCount,
        unavailable_count: koCount,
      },
      summary: {
        tpe_day_total: total,
        available_count: okCount,
        unavailable_count: koCount,
        available_pct: Number(available_pct),
        unavailable_pct: Number(unavailable_pct),
      },
    });
  } catch (err) {
    console.error("getDaily error:", err);
    res.status(500).json({ error: err.message || "getDaily failed" });
  }
};



exports.computeWeekly = async (req, res) => {
  try {
    const weekStartISO = toISODate(req.body.week_start);
    if (!weekStartISO) {
      return res
        .status(400)
        .json({ error: "week_start invalide (YYYY-MM-DD)" });
    }

    const policyId = req.body.policyId ? Number(req.body.policyId) : undefined;
    const auto = !!req.body.auto;

    const policy = await getLockedPolicyForWeekOrActive(weekStartISO, policyId);
    const { start, end } = weekRange(weekStartISO);

    if (auto) {
      for (let i = 0; i < 7; i++) {
        const dISO = start.plus({ days: i }).toISODate();
        try {
          await exports.computeDaily(
            {
              body: {
                date: dISO,
                week_start: weekStartISO,
                policyId: policy.id,
              },
            },
            { json: () => {}, status: () => ({ json: () => {} }) }
          );
        } catch (e) {
          console.warn(
            "[computeWeekly] daily compute failed for",
            dISO,
            e.message
          );
        }
      }
    }

    const [agg] = await pool.query(
      `SELECT
          terminal_sn,
          SUM(slot_ok_count)   AS slots_ok_total,
          SUM(slot_fail_count) AS slots_fail_total,
          SUM(CASE WHEN day_ok = 1 THEN 1 ELSE 0 END) AS days_ok,
          SUM(CASE WHEN day_ok = 0 THEN 1 ELSE 0 END) AS days_fail,
          JSON_ARRAYAGG(
            IF(day_ok = 0, DATE_FORMAT(date, '%Y-%m-%d'), NULL)
          ) AS fail_dates_raw
       FROM kpi2_daily_results
      WHERE date >= ? AND date < ? AND policy_id = ?
      GROUP BY terminal_sn`,
      [start.toISODate(), end.toISODate(), policy.id]
    );

    if (!agg.length) {
      return res.json({
        ok: true,
        message: "Aucune donnée daily pour la semaine",
        count: 0,
      });
    }

    const [reasonsAgg] = await pool.query(
      `SELECT terminal_sn, JSON_ARRAYAGG(failed_reasons_json) AS reasons_arrays
         FROM kpi2_daily_results
        WHERE date >= ? AND date < ? AND policy_id = ?
        GROUP BY terminal_sn`,
      [start.toISODate(), end.toISODate(), policy.id]
    );
    const reasonsMap = new Map();
    for (const row of reasonsAgg) {
      let counts = {};
      try {
        const arrays =
          typeof row.reasons_arrays === "string"
            ? JSON.parse(row.reasons_arrays)
            : row.reasons_arrays;
        (arrays || []).forEach((arr) => {
          let R = Array.isArray(arr)
            ? arr
            : typeof arr === "string"
            ? JSON.parse(arr || "[]")
            : [];
          R.forEach((reason) => {
            counts[reason] = (counts[reason] || 0) + 1;
          });
        });
      } catch {}
      reasonsMap.set(row.terminal_sn, counts);
    }

    const rows = [];
    for (const r of agg) {
      const days_ok = Number(r.days_ok || 0);
      const days_fail = Number(r.days_fail || 0);
      const slots_ok_total = Number(r.slots_ok_total || 0);
      const slots_fail_total = Number(r.slots_fail_total || 0);

      let fail_dates = [];
      try {
        const raw = r.fail_dates_raw;
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        fail_dates = Array.isArray(parsed) ? parsed.filter(Boolean) : [];
      } catch {
        fail_dates = [];
      }

      const weekly_fail_days = Number(policy.weekly_fail_days || 0);
      const weekly_fail_slots = Number(policy.weekly_fail_slots || 0);
      const isIndispo =
        (weekly_fail_days > 0 && days_fail >= weekly_fail_days) ||
        (weekly_fail_slots > 0 && slots_fail_total >= weekly_fail_slots);

      rows.push({
        terminal_sn: r.terminal_sn,
        days_ok,
        days_fail,
        slots_ok_total,
        slots_fail_total,
        fail_dates,
        decision: isIndispo ? 0 : 1,
        week_reasons: reasonsMap.get(r.terminal_sn) || {},
      });
    }

    if (rows.length) {
      const placeholders = rows
        .map(
          () => "(?,?,?,?,?,?,?,?, CAST(? AS JSON), CAST(? AS JSON), NOW())"
        )
        .join(",");
      const args = [];
      for (const x of rows) {
        args.push(
          weekStartISO, // week_start
          x.terminal_sn,
          policy.id,
          x.decision, // 1/0
          x.days_ok,
          x.days_fail,
          x.slots_ok_total,
          x.slots_fail_total,
          JSON.stringify(x.fail_dates),
          JSON.stringify(x.week_reasons)
        );
      }

      await pool.query(
        `INSERT INTO kpi2_weekly_results
           (week_start, terminal_sn, policy_id, decision, days_ok, days_fail, slots_ok_total, slots_fail_total, fail_dates_json, week_reasons_json, computed_at)
         VALUES ${placeholders}
         ON DUPLICATE KEY UPDATE
           decision         = VALUES(decision),
           days_ok          = VALUES(days_ok),
           days_fail        = VALUES(days_fail),
           slots_ok_total   = VALUES(slots_ok_total),
           slots_fail_total = VALUES(slots_fail_total),
           fail_dates_json  = VALUES(fail_dates_json),
           week_reasons_json= VALUES(week_reasons_json),
           computed_at      = NOW()`,
        args
      );
    }

    res.json({ ok: true, count: rows.length });
  } catch (err) {
    console.error("computeWeekly error:", err);
    res.status(500).json({ error: err.message || "computeWeekly failed" });
  }
};

exports.getWeekly = async (req, res) => {
  try {
    const weekStartISO = toISODate(req.query.week_start);
    const policyId = Number(req.query.policyId);
    if (!weekStartISO || !policyId) {
      return res.status(400).json({ error: "week_start & policyId requis" });
    }

    const page = Math.max(1, Number(req.query.page || 1));
    const pageSize = Math.min(
      1000,
      Math.max(1, Number(req.query.pageSize || 50))
    );
    const search = (req.query.search || "").trim();
    const status = (req.query.status || "all").toLowerCase(); // all|available|unavailable
    const sortBy = (req.query.sortBy || "").toLowerCase();
    const order =
      (req.query.order || "desc").toLowerCase() === "asc" ? "asc" : "desc";

    const where = ["week_start = ?", "policy_id = ?"];
    const args = [weekStartISO, policyId];
    if (search) {
      where.push("terminal_sn LIKE ?");
      args.push(`%${search}%`);
    }
    if (status === "available") where.push("decision = 1");
    if (status === "unavailable") where.push("decision = 0");

    const whereSql = `WHERE ${where.join(" AND ")}`;

    // total + counters dispo/indispo
    const [[cnt]] = await pool.query(
      `SELECT 
         COUNT(*) AS total,
         SUM(CASE WHEN decision=1 THEN 1 ELSE 0 END) AS available_count,
         SUM(CASE WHEN decision=0 THEN 1 ELSE 0 END) AS unavailable_count
       FROM kpi2_weekly_results ${whereSql}`,
      args
    );
    const total = Number(cnt?.total || 0);
    const available_count = Number(cnt?.available_count || 0);
    const unavailable_count = Number(cnt?.unavailable_count || 0);

    const whitelist = new Set(["days_fail", "slots_fail_total", "slots_ok_total"]);
    const orderBy = whitelist.has(sortBy)
      ? `${sortBy} ${order}`
      : `terminal_sn ASC`;

    args.push((page - 1) * pageSize, pageSize);

    const [rows] = await pool.query(
      `SELECT
          week_start,
          terminal_sn,
          policy_id,
          decision,
          days_ok,
          days_fail,
          slots_ok_total,
          slots_fail_total,
          JSON_EXTRACT(fail_dates_json, '$')   AS fail_dates_json,
          JSON_EXTRACT(week_reasons_json, '$') AS week_reasons_json,
          computed_at
       FROM kpi2_weekly_results
       ${whereSql}
       ORDER BY ${orderBy}
       LIMIT ?, ?`,
      args
    );

    const data = rows.map((r) => {
      const decisionLabel =
        Number(r.decision) === 1 ? "DISPONIBLE" : "INDISPONIBLE";
      let fail_dates = [];
      try {
        const raw = r.fail_dates_json;
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        fail_dates = Array.isArray(parsed) ? parsed.filter(Boolean) : [];
      } catch {}

      let week_reasons = {};
      try {
        const raw = r.week_reasons_json;
        week_reasons =
          typeof raw === "object" ? raw : JSON.parse(raw || "{}");
      } catch {
        week_reasons = {};
      }

      return {
        week_start: r.week_start,
        terminal_sn: r.terminal_sn,
        policy_id: r.policy_id,
        decision: decisionLabel,
        days_ok: Number(r.days_ok),
        days_fail: Number(r.days_fail),
        slots_ok_total: Number(r.slots_ok_total),
        slots_fail_total: Number(r.slots_fail_total),
        fail_dates,
        week_reasons,
        computed_at: r.computed_at,
      };
    });

    res.json({
      data,
      meta: { total, page, pageSize, available_count, unavailable_count },
    });
  } catch (err) {
    console.error("getWeekly error:", err);
    res.status(500).json({ error: err.message || "getWeekly failed" });
  }
};
