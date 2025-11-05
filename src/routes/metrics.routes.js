// routes/metrics.routes.js
const express = require("express");
const router = express.Router();
const metrics = require("../controllers/metrics.controller");

// GET /api/metrics/summary?date=YYYY-MM-DD&week_start=YYYY-MM-DD&policyId=1
router.get("/summary", metrics.getSummary);

module.exports = router;
