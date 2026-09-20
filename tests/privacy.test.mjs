import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('website and GitHub notices stay identical to the content bundled offline', () => {
  const result = spawnSync(process.execPath, ['scripts/legal-docs.mjs', '--check'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('generated notices contain no proposed personal-contact fields or compliance claims', () => {
  for (const path of ['src/content/legal.json', 'PRIVACY.md', 'TERMS.md', 'website/privacy.html', 'website/terms.html']) {
    const content = readFileSync(path, 'utf8');
    assert.doesNotMatch(content, /mailto:|identity confirmation pending|privacy contact: pending|GDPR.compliant|PIPL.compliant|Optional Groq cloud processing/i);
  }
});

test('all website entry points suppress background connections before scripts run', () => {
  for (const path of ['index.html', 'privacy.html', 'terms.html']) {
    const html = readFileSync(`website/${path}`, 'utf8');
    assert.match(html, /connect-src 'none'/);
    assert.match(html, /name="referrer" content="no-referrer"/);
    assert.ok(html.indexOf('http-equiv="Content-Security-Policy"') < html.indexOf('<script'));
    assert.ok(html.indexOf('privacy-guard.js') < html.indexOf('theme.js'));
    assert.doesNotMatch(html, /<(?:img|script)[^>]+src="https?:/);
    assert.match(html, /href="privacy.html"/);
    assert.match(html, /href="terms.html"/);
  }
});
