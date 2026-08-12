// Example client flow: fetch seat map, create a hold, call payment stub, then confirm booking.

const fetch = require('node-fetch');

const INVENTORY = process.env.INVENTORY_URL || 'http://localhost:3001';
const PAYMENT = process.env.PAYMENT_URL || 'http://localhost:3003';
const BOOKING = process.env.BOOKING_URL || 'http://localhost:3002';

async function run() {
  const screening = 'screening_1';
  console.log('Fetching seat map...');
  let r = await fetch(`${INVENTORY}/screenings/${screening}/seats`);
  const map = await r.json();
  console.log('Seats snapshot: first 10', map.seats.slice(0, 10));

  // attempt to hold 2 seats
  const seat_ids = [map.seats[0].id, map.seats[1].id];
  console.log('Requesting hold for seats', seat_ids);
  r = await fetch(`${INVENTORY}/holds`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ screening_id: screening, seat_ids, ttl_seconds: 120 }) });
  const hold = await r.json();
  console.log('Hold response:', hold);
  if (!hold.hold_id) return console.error('Could not create hold');

  // Simulate payment
  console.log('Calling payment stub...');
  r = await fetch(`${PAYMENT}/pay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ amount: 40.0, currency: 'USD', hold_id: hold.hold_id, screening_id: screening, seat_ids, callback_url: `${BOOKING}/payments/webhook` }) });
  const payResp = await r.json();
  console.log('Payment processor responded', payResp);

  // Wait a moment for payment webhook flow to complete
  await new Promise((r2) => setTimeout(r2, 1500));
  r = await fetch(`${INVENTORY}/screenings/${screening}/seats`);
  const map2 = await r.json();
  console.log('Seats after payment attempt:', map2.seats.slice(0, 10));
}

run().catch((e) => console.error(e));
