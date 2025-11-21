const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const cors = require('cors');

const availabilityRoutes = require('./src/routes/availability.routes');
const policyRoutes = require('./src/routes/policy.routes');
const metricsRoutes = require('./src/routes/metrics.routes');
const biRoutes = require('./src/routes/bi.routes');
const exportRoutes = require('./src/routes/export.routes');

const app = express();
app.use(helmet());
app.use(express.json({ limit: '10mb' }));
app.use(morgan('tiny'));
app.use(cors());

app.get('/health', (_, res) => res.json({ ok: true }));

app.use('/api/availability', availabilityRoutes);
app.use('/api/policies', policyRoutes);
app.use('/api/metrics', metricsRoutes);
app.use('/api/bi', biRoutes);
app.use('/api/export', exportRoutes);

// 404
app.use((req, res) => res.status(404).json({ error: 'Not found' }));


// app.use(express.static('dist'));
// app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'dist/index.html')));



// error handler
app.use((err, _req, res, _next) => {
  console.error('Unhandled:', err);
  res.status(500).json({ error: err.message || 'Internal error' });
});

module.exports = app;
