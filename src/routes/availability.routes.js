const { Router } = require('express');
const ctrl = require('../controllers/availability.controller');

const router = Router();

// Daily
router.post('/daily/compute', ctrl.computeDaily);
router.get('/daily', ctrl.getDaily);

// Weekly
router.post('/weekly/compute', ctrl.computeWeekly);
router.get('/weekly', ctrl.getWeekly);

module.exports = router;
