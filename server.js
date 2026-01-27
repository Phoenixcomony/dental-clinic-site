const express = require('express');
const app = express();

const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => res.send('OK'));
app.get('/health', (req, res) => res.send('OK'));

app.listen(PORT, '0.0.0.0', () => {
  console.log('SERVER STARTED ON', PORT);
});

// منع خروج العملية
setInterval(() => {}, 1000);
