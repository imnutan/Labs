const BASE = 'http://localhost:3000';

async function chat(sessionId, message) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, message }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(body)}`);
  return body.reply;
}

async function testIsolation() {
  console.log('\n=== Test 1: session isolation ===');
  const a = await chat('shopper-a', 'Remember this secret word: pineapple. Just say OK.');
  console.log('A turn 1:', a);

  const b = await chat('shopper-b', 'What secret word did I just tell you? If none, say so.');
  console.log('B turn 1:', b);

  const a2 = await chat('shopper-a', 'What secret word did I just tell you?');
  console.log('A turn 2:', a2);

  const bLeaked = /pineapple/i.test(b);
  const aRemembered = /pineapple/i.test(a2);
  console.log(
    bLeaked ? 'FAIL: session B saw session A history' : 'PASS: session B did not see session A history'
  );
  console.log(aRemembered ? 'PASS: session A retained its own history' : 'FAIL: session A lost its own history');
}

async function testCatalog() {
  console.log('\n=== Test 2: generic catalog question ===');
  const reply = await chat('shopper-catalog', 'Hi, what do you sell?');
  console.log('Reply:', reply);
}

async function testOrdering() {
  console.log('\n=== Test 3: back-to-back messages on one session ===');
  const p1 = chat('shopper-race', 'Reply with exactly the digit 1 and nothing else.');
  const p2 = chat('shopper-race', 'Reply with exactly the digit 2 and nothing else.');
  const [r1, r2] = await Promise.all([p1, p2]);
  console.log('Reply to first send():', JSON.stringify(r1));
  console.log('Reply to second send():', JSON.stringify(r2));
  const ok = r1.trim().startsWith('1') && r2.trim().startsWith('2');
  console.log(ok ? 'PASS: replies matched their own sends' : 'FAIL: replies were swapped or garbled');
}

async function main() {
  await testIsolation();
  await testCatalog();
  await testOrdering();
}

main().catch((err) => {
  console.error('Test run failed:', err);
  process.exit(1);
});
