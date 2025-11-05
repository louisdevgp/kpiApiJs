// routes/policy.routes.js
const { Router } = require('express');
const policy = require('../controllers/policy.controller');

const router = Router();

router.get('/',        policy.list);            // GET /api/policies
router.get('/:id',     policy.get);             // GET /api/policies/:id
router.post('/',       policy.create);          // POST /api/policies
router.put('/:id',     policy.update);          // PUT /api/policies/:id
router.delete('/:id',  policy.remove);          // DELETE /api/policies/:id

module.exports = router;
