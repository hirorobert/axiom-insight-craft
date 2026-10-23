// Test-only containment: all TCP destinations except loopback are refused before connection.
const net = require('node:net');
const original = net.Socket.prototype.connect;
const local = (host) => !host || ['localhost', '127.0.0.1', '::1', '[::1]'].includes(String(host));
net.Socket.prototype.connect = function (...args) {
  let first = args[0];
  if (Array.isArray(first)) first = first[0];
  const host = typeof first === 'object' && first !== null ? first.host : typeof args[1] === 'string' ? args[1] : undefined;
  if (!local(host)) throw new Error('TEST_EGRESS_BLOCKED: external TCP is forbidden');
  return original.apply(this, args);
};
const originalFetch = globalThis.fetch;
globalThis.fetch = function(input, init) {
  const raw = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
  const url = new URL(raw);
  if (!local(url.hostname)) return Promise.reject(new Error('TEST_EGRESS_BLOCKED: external fetch is forbidden'));
  return originalFetch.call(this, input, init);
};
