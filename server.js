require('dotenv').config();
const app = require('./app');

const PORT = Number(process.env.PORT || 5000);
const server = app.listen(PORT, () => console.log('API listening on', PORT));

// ⏱️ éviter les timeouts pendant les compute
server.requestTimeout = 5 * 60 * 1000;
server.headersTimeout = 5 * 60 * 1000;
