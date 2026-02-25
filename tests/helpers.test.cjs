const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadFunctions } = require('./function-loader.cjs');

const repo = 'C:\\Users\\matt\\projects\\llamacpp-ui-metrics-extension';

test('popup helpers: formatBytes, domain normalization, permission pattern, JSONL parsing', () => {
  const popup = loadFunctions(path.join(repo, 'popup.js'), [
    'formatBytes',
    'normalizeDomainPattern',
    'getOriginPermissionPattern',
    'parseJsonlText'
  ]);

  assert.equal(popup.formatBytes(0), '0 B');
  assert.equal(popup.formatBytes(1536), '1.5 KB');
  assert.equal(popup.formatBytes(1024 * 1024), '1.00 MB');
  assert.equal(popup.formatBytes(-1), '-');

  assert.equal(popup.normalizeDomainPattern('https://Sub.Example.com/a/b'), 'sub.example.com');
  assert.equal(popup.normalizeDomainPattern('*.Example.com'), '*.example.com');
  assert.equal(popup.normalizeDomainPattern('localhost:8080/path'), 'localhost:8080');
  assert.equal(popup.normalizeDomainPattern('*.*.example.com'), null);

  assert.equal(popup.getOriginPermissionPattern('https://example.com/path?q=1'), 'https://example.com/*');
  assert.equal(popup.getOriginPermissionPattern('chrome://extensions'), null);

  const parsed = popup.parseJsonlText('{"req":{},"resp":{}}\n{"req":{"x":1},"resp":{"y":2}}\n');
  assert.equal(parsed.length, 2);
  assert.throws(() => popup.parseJsonlText(''), /empty/i);
  assert.throws(() => popup.parseJsonlText('{"req":{}}'), /schema/i);
  assert.throws(() => popup.parseJsonlText('{not json}'), /Invalid JSON/i);
});

test('content helpers: host matching supports exact, wildcard, and host:port', () => {
  const location = { href: 'https://app.example.com/chat', hostname: 'app.example.com', host: 'app.example.com' };
  const content = loadFunctions(path.join(repo, 'content.js'), ['normalizeDomainPattern', 'hostMatchesPattern'], { location });

  assert.equal(content.hostMatchesPattern('app.example.com'), true);
  assert.equal(content.hostMatchesPattern('*.example.com'), true);
  assert.equal(content.hostMatchesPattern('example.com'), false);

  const portLoc = { href: 'http://localhost:8080/x', hostname: 'localhost', host: 'localhost:8080' };
  const content2 = loadFunctions(path.join(repo, 'content.js'), ['normalizeDomainPattern', 'hostMatchesPattern'], { location: portLoc });
  assert.equal(content2.hostMatchesPattern('localhost:8080'), true);
  assert.equal(content2.hostMatchesPattern('localhost:3000'), false);
});

test('background helpers: numeric normalization and first-turn heuristic', () => {
  const bg = loadFunctions(path.join(repo, 'background.js'), ['toPositiveInt', 'looksLikeFirstTurn']);

  assert.equal(bg.toPositiveInt(3.9), 3);
  assert.equal(bg.toPositiveInt(0), null);
  assert.equal(bg.toPositiveInt(-2), null);
  assert.equal(bg.toPositiveInt(NaN), null);

  assert.equal(bg.looksLikeFirstTurn({ userCount: 1, assistantCount: 0, toolCount: 0, messagesCount: 2 }), true);
  assert.equal(bg.looksLikeFirstTurn({ userCount: 1, assistantCount: 1, toolCount: 0, messagesCount: 3 }), false);
  assert.equal(bg.looksLikeFirstTurn({ userCount: 2, assistantCount: 0, toolCount: 0, messagesCount: 2 }), false);
});

test('injected helpers: parsing, rounding, endpoint detection, finish categorization, payload estimates', () => {
  const injected = loadFunctions(path.join(repo, 'injected.js'), [
    'utf8Bytes',
    'roundMs',
    'safeJsonParse',
    'clipCapturedText',
    'categorizeFinishReason',
    'isChatCompletionsUrl',
    'estimateMessagesBytesAndCounts'
  ], {
    location: { href: 'https://ui.example.com/app', host: 'ui.example.com', hostname: 'ui.example.com' },
    MAX_CAPTURED_TEXT_CHARS: 200000,
  });

  assert.equal(injected.roundMs(1.23456), 1.235);
  assert.equal(injected.roundMs(Number.POSITIVE_INFINITY), null);
  assert.equal(JSON.stringify(injected.safeJsonParse('{"a":1}')), JSON.stringify({ a: 1 }));
  assert.equal(injected.safeJsonParse('{bad'), null);
  assert.equal(injected.clipCapturedText('abcdef', 3), 'abc');
  assert.equal(injected.clipCapturedText(null, 3), null);

  assert.equal(injected.categorizeFinishReason('stop'), 'completed');
  assert.equal(injected.categorizeFinishReason('length'), 'truncated_length');
  assert.equal(injected.categorizeFinishReason(undefined), 'unknown');
  assert.equal(injected.categorizeFinishReason('weird'), 'other');

  assert.equal(injected.isChatCompletionsUrl('https://host/v1/chat/completions'), true);
  assert.equal(injected.isChatCompletionsUrl({ url: '/v1/chat/completions' }), true);
  assert.equal(injected.isChatCompletionsUrl('https://host/v1/models'), false);

  const pngB64 = 'iVBORw0KGgo=';
  const bodyObj = {
    messages: [
      { role: 'system', content: 'You are helpful' },
      { role: 'user', content: [
        { type: 'text', text: 'hello' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${pngB64}` } }
      ] },
      { role: 'assistant', content: 'hi' }
    ]
  };
  const summary = injected.estimateMessagesBytesAndCounts(bodyObj);
  assert.equal(summary.messagesCount, 3);
  assert.equal(summary.byRole.user, 1);
  assert.equal(summary.hasImages, true);
  assert.equal(summary.imagePartsCount, 1);
  assert.ok(summary.imagesBytes > 0);
  assert.ok(summary.messagesBytes >= summary.currentUserTextBytes);
});
