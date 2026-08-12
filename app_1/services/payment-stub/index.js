// Payment stub: simulate a payment gateway. It accepts /pay and responds with success
// then POSTs to the booking webhook to notify payment success.

const express = require('express');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');

const app = express();
app.use(bodyParser.json());

const BOOKING_WEBHOOK_URL = process.env.BOOKING_WEBHOOK_URL || 'http://booking:3002/payments/webhook';

app.post('/pay', async (req, res) => {
  // body: { amount, currency, idempotency_key, hold_id, screening_id, seat_ids, callback_url }
  const { hold_id, screening_id, seat_ids, callback_url } = req.body;
  const txn_id = `tx_${Date.now()}`;
  // Simulate processing delay
  setTimeout(async () => {
    const payload = { status: 'SUCCESS', payment_txn_id: txn_id, hold_id, screening_id, seat_ids };
    try {
      const to = callback_url || BOOKING_WEBHOOK_URL;
      await fetch(to, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      console.log('Payment stub posted webhook to', to);
    } catch (err) {
      console.error('Failed to call booking webhook', err);
    }
  }, 500);

  res.json({ status: 'PROCESSING', payment_txn_id: txn_id });
});

const PORT = process.env.PORT || 3003;
app.listen(PORT, () => console.log(`Payment stub listening on ${PORT}`));
