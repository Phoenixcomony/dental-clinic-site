// server.js
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch'); // تأكد أنك ثبت node-fetch: npm install node-fetch

const app = express();
app.use(cors());
app.use(express.json());

const airtableToken = "pat6TxSWq73MKhnSB.a7cfd46ca68c37c60d6ce0822deb6201869b82d35b2066f8fb4d7884c61a71f6";
const baseId = "appfn1EBVCaIZPNE5";
const tableName = "الحجوزات";

app.get('/api/slots', async (req, res) => {
  try {
    const response = await fetch(`https://api.airtable.com/v0/${baseId}/${tableName}?sort[0][field]=التاريخ`, {
      headers: {
        Authorization: `Bearer ${airtableToken}`
      }
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: "فشل في جلب البيانات من Airtable" });
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

const port = 3000;
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
