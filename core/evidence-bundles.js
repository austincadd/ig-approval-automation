import fs from 'node:fs';
import path from 'node:path';
import { getPolicyVersions } from './policy-versions.js';

function safeSlug(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

function limitText(value, maxLength = 6000) {
  if (value == null) return null;
  const text = String(value);
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function summarizeMap(map, limit = 20) {
  if (!map || typeof map !== 'object') return null;
  return Object.fromEntries(Object.entries(map).slice(0, limit));
}

export async function createEvidenceBundle({
  page,
  jobId,
  candidateId,
  outcomeCode,
  failureClass,
  classifiedFailure,
  diagnostics = {},
  rootDir = 'artifacts/failures'
} = {}) {
  const day = new Date().toISOString().slice(0, 10);
  const bundleDir = path.resolve(rootDir, day, `job-${safeSlug(jobId)}`);
  fs.mkdirSync(bundleDir, { recursive: true });

  const screenshotPath = path.join(bundleDir, 'screenshot.png');
  await page?.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});

  const [finalUrl, visibleText, selectorMap] = await Promise.all([
    Promise.resolve().then(() => page?.url?.() || null).catch(() => null),
    page?.evaluate?.(() => document.body?.innerText || '').catch(() => '') ?? '',
    page?.evaluate?.(() => {
      const nodes = Array.from(document.querySelectorAll('[aria-label]')).slice(0, 80);
      return nodes.map((node, index) => ({
        index,
        tag: node.tagName,
        ariaLabel: node.getAttribute('aria-label'),
        role: node.getAttribute('role'),
        text: (node.textContent || '').trim().slice(0, 120)
      }));
    }).catch(() => []) ?? []
  ]);

  const manifest = {
    capturedAt: new Date().toISOString(),
    policyVersions: getPolicyVersions(),
    jobId: jobId ?? null,
    candidateId: candidateId ?? null,
    outcomeCode: outcomeCode || null,
    failureClass: failureClass || null,
    policy: classifiedFailure?.policy || null,
    finalUrl: finalUrl || null,
    visibleTextExcerpt: limitText(visibleText, 5000),
    selectorDiagnostics: diagnostics.selectorDiagnostics || null,
    primaryControlCandidateMap: diagnostics.primaryControlCandidateMap || null,
    challengeMarkers: summarizeMap(diagnostics.challengeMarkers || null),
    rawDiagnostics: diagnostics.rawDiagnostics || null,
    screenshotPath: fs.existsSync(screenshotPath) ? screenshotPath : null,
    selectorMap
  };

  const manifestPath = path.join(bundleDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  return {
    bundleDir,
    manifestPath,
    screenshotPath: manifest.screenshotPath,
    manifest
  };
}
