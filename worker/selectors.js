// Keep selectors centralized because Instagram DOM changes frequently.
export const SELECTORS = {
  likeButtonCandidates: [
    'svg[aria-label="Like"]',
    'span[aria-label="Like"]',
    'button[aria-label="Like"]'
  ],
  likedStateCandidates: [
    'svg[aria-label="Unlike"]',
    'span[aria-label="Unlike"]',
    'button[aria-label="Unlike"]',
    'svg[aria-label="Liked"]',
    'span[aria-label="Liked"]',
    'button[aria-label="Liked"]'
  ]
};

export const LIKE_CONTROL_LABELS = ['Like'];
export const LIKED_CONTROL_LABELS = ['Unlike', 'Liked'];
export const SUPPORT_ACTION_LABELS = ['Comment', 'Repost', 'Share', 'Save'];
export const INTERACTIVE_CONTROL_SELECTOR = 'div[role="button"], button, a[role="button"]';
export const PRIMARY_ACTION_MIN_BOX = 24;
export const PRIMARY_ACTION_ROW_TOLERANCE = 28;
export const PRIMARY_ACTION_COLUMN_TOLERANCE = 28;
export const REEL_READINESS_RETRY_WAIT_MS = 1200;

function area(candidate) {
  return (candidate?.w || 0) * (candidate?.h || 0);
}

function centerY(candidate) {
  return (candidate?.y || 0) + ((candidate?.h || 0) / 2);
}

function centerX(candidate) {
  return (candidate?.x || 0) + ((candidate?.w || 0) / 2);
}

function summarizeCandidate(candidate) {
  if (!candidate) return null;
  return {
    index: candidate.index,
    tag: candidate.tag,
    aria: candidate.aria,
    x: candidate.x,
    y: candidate.y,
    w: candidate.w,
    h: candidate.h,
    visible: candidate.visible,
    role: candidate.role || null
  };
}

function summarizeCluster(cluster) {
  return {
    orientation: cluster.orientation,
    variant: cluster.variant,
    state: cluster.state,
    supportCount: cluster.supportCount,
    score: cluster.score,
    labels: [...cluster.labels].sort(),
    primaryControl: summarizeCandidate(cluster.primaryControl),
    bounds: {
      minX: cluster.minX,
      maxX: cluster.maxX,
      minY: cluster.minY,
      maxY: cluster.maxY
    }
  };
}

function detectLayoutVariant(cluster) {
  if (cluster.orientation === 'column') return 'reel_rail';
  if ((cluster.maxX - cluster.minX) < 260 && cluster.supportCount >= 2) return 'modal_compact';
  return 'feed_row';
}

export function pickPreferredControl(candidates, labels, minBox = PRIMARY_ACTION_MIN_BOX) {
  const matching = (candidates || []).filter((candidate) => (
    candidate
    && labels.includes(candidate.aria)
    && candidate.visible
  ));

  if (!matching.length) return null;

  const preferred = matching.filter((candidate) => Math.min(candidate.w, candidate.h) >= minBox);
  const pool = preferred.length ? preferred : matching;

  return [...pool].sort((a, b) => {
    if (a.y !== b.y) return a.y - b.y;
    if (a.x !== b.x) return a.x - b.x;
    return area(b) - area(a);
  })[0];
}

export function clusterControlsByRow(candidates, tolerance = PRIMARY_ACTION_ROW_TOLERANCE) {
  const visible = [...(candidates || [])]
    .filter((candidate) => candidate?.visible && candidate.aria)
    .sort((a, b) => centerY(a) - centerY(b) || a.x - b.x);

  const rows = [];
  for (const candidate of visible) {
    const candidateCenterY = centerY(candidate);
    const row = rows.find((entry) => Math.abs(entry.centerY - candidateCenterY) <= tolerance);
    if (row) {
      row.candidates.push(candidate);
      row.centerY = Math.round((row.centerY * (row.candidates.length - 1) + candidateCenterY) / row.candidates.length);
      row.minY = Math.min(row.minY, candidate.y);
      row.maxY = Math.max(row.maxY, candidate.y + candidate.h);
      row.minX = Math.min(row.minX, candidate.x);
      row.maxX = Math.max(row.maxX, candidate.x + candidate.w);
      continue;
    }

    rows.push({
      orientation: 'row',
      centerY: Math.round(candidateCenterY),
      minY: candidate.y,
      maxY: candidate.y + candidate.h,
      minX: candidate.x,
      maxX: candidate.x + candidate.w,
      candidates: [candidate]
    });
  }

  return rows;
}

export function clusterControlsByColumn(candidates, tolerance = PRIMARY_ACTION_COLUMN_TOLERANCE) {
  const visible = [...(candidates || [])]
    .filter((candidate) => candidate?.visible && candidate.aria)
    .sort((a, b) => centerX(a) - centerX(b) || a.y - b.y);

  const columns = [];
  for (const candidate of visible) {
    const candidateCenterX = centerX(candidate);
    const column = columns.find((entry) => Math.abs(entry.centerX - candidateCenterX) <= tolerance);
    if (column) {
      column.candidates.push(candidate);
      column.centerX = Math.round((column.centerX * (column.candidates.length - 1) + candidateCenterX) / column.candidates.length);
      column.minX = Math.min(column.minX, candidate.x);
      column.maxX = Math.max(column.maxX, candidate.x + candidate.w);
      column.minY = Math.min(column.minY, candidate.y);
      column.maxY = Math.max(column.maxY, candidate.y + candidate.h);
      continue;
    }

    columns.push({
      orientation: 'column',
      centerX: Math.round(candidateCenterX),
      minX: candidate.x,
      maxX: candidate.x + candidate.w,
      minY: candidate.y,
      maxY: candidate.y + candidate.h,
      candidates: [candidate]
    });
  }

  return columns;
}

function scoreCluster(cluster) {
  let score = 0;
  if (cluster.unlikedControl || cluster.likedControl) score += 10;
  score += cluster.supportCount * 3;
  if (cluster.orientation === 'row') score += 4;
  if (cluster.orientation === 'column') score += 3;
  if (cluster.variant === 'reel_rail') score += 2;
  if (cluster.variant === 'modal_compact') score += 1;
  if (cluster.primaryControl) score += Math.min(4, Math.round(Math.min(cluster.primaryControl.w, cluster.primaryControl.h) / 12));
  if (cluster.labels.has('Comment')) score += 1;
  if (cluster.labels.has('Share') || cluster.labels.has('Repost')) score += 1;
  if (cluster.labels.has('Save')) score += 1;
  return score;
}

function inspectCluster(cluster, minBox = PRIMARY_ACTION_MIN_BOX) {
  const labels = new Set(cluster.candidates.map((candidate) => candidate.aria));
  const supportCount = SUPPORT_ACTION_LABELS.filter((label) => labels.has(label)).length;
  const unlikedControl = pickPreferredControl(cluster.candidates, LIKE_CONTROL_LABELS, minBox);
  const likedControl = pickPreferredControl(cluster.candidates, LIKED_CONTROL_LABELS, minBox);
  const state = likedControl ? 'liked' : (unlikedControl ? 'unliked' : 'unknown');
  const primaryControl = likedControl || unlikedControl || null;
  const variant = detectLayoutVariant({ ...cluster, supportCount });
  const qualifies = Boolean(primaryControl) && supportCount >= 2;
  const inspected = {
    ...cluster,
    labels,
    supportCount,
    unlikedControl,
    likedControl,
    state,
    primaryControl,
    variant,
    qualifies
  };
  inspected.score = scoreCluster(inspected);
  return inspected;
}

function collectFallbackCandidates(clusters) {
  return clusters
    .filter((cluster) => cluster.primaryControl)
    .sort((a, b) => b.score - a.score || area(b.primaryControl) - area(a.primaryControl))
    .map((cluster) => ({
      orientation: cluster.orientation,
      variant: cluster.variant,
      score: cluster.score,
      state: cluster.state,
      supportCount: cluster.supportCount,
      primaryControl: summarizeCandidate(cluster.primaryControl),
      labels: [...cluster.labels].sort()
    }));
}

export function inspectPrimaryActionRow(candidates, minBox = PRIMARY_ACTION_MIN_BOX) {
  const inspectedRows = clusterControlsByRow(candidates).map((row) => inspectCluster(row, minBox));
  const inspectedColumns = clusterControlsByColumn(candidates).map((column) => inspectCluster(column, minBox));
  const allClusters = [...inspectedRows, ...inspectedColumns];
  const qualified = allClusters.filter((cluster) => cluster.qualifies);
  const row = [...qualified].sort((a, b) => b.score - a.score || area(b.primaryControl) - area(a.primaryControl))[0] || null;

  if (!row) {
    return {
      ok: false,
      row: null,
      state: 'unknown',
      primaryControl: null,
      unlikedControl: null,
      likedControl: null,
      layoutFamily: 'unknown',
      diagnostics: {
        rows: inspectedRows.map(summarizeCluster),
        columns: inspectedColumns.map(summarizeCluster),
        fallbackCandidates: collectFallbackCandidates(allClusters)
      }
    };
  }

  return {
    ok: true,
    row,
    state: row.state,
    primaryControl: row.primaryControl,
    unlikedControl: row.unlikedControl,
    likedControl: row.likedControl,
    layoutFamily: row.variant,
    diagnostics: {
      rows: inspectedRows.map(summarizeCluster),
      columns: inspectedColumns.map(summarizeCluster),
      fallbackCandidates: collectFallbackCandidates(allClusters)
    }
  };
}

export async function scanInteractiveControls(page) {
  const controls = page.locator(INTERACTIVE_CONTROL_SELECTOR);
  const candidates = await controls.evaluateAll((els) => els.map((el, index) => {
    const labelled = el.matches('[aria-label]') ? el : el.querySelector('[aria-label]');
    const aria = labelled?.getAttribute('aria-label');
    if (!aria) return null;

    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    const visible = rect.width > 0
      && rect.height > 0
      && style.display !== 'none'
      && style.visibility !== 'hidden';

    return {
      index,
      tag: el.tagName,
      role: el.getAttribute?.('role') || null,
      aria,
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
      visible
    };
  }).filter(Boolean));

  return { controls, candidates };
}

export async function resolveInteractiveControlHandle(page, descriptor) {
  if (!descriptor) return null;

  const center = {
    x: descriptor.x + (descriptor.w / 2),
    y: descriptor.y + (descriptor.h / 2)
  };

  const handle = await page.evaluateHandle(({ selector, center }) => {
    const raw = document.elementFromPoint(center.x, center.y);
    return raw?.closest(selector) || null;
  }, { selector: INTERACTIVE_CONTROL_SELECTOR, center });

  const element = handle.asElement();
  if (!element) {
    await handle.dispose();
    return null;
  }

  return element;
}

export async function waitForPreferredControl(page, labels, timeoutMs = 5000, minBox = PRIMARY_ACTION_MIN_BOX) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const { candidates } = await scanInteractiveControls(page);
    const chosen = pickPreferredControl(candidates, labels, minBox);
    if (chosen) {
      const handle = await resolveInteractiveControlHandle(page, chosen);
      if (handle) {
        return {
          ok: true,
          handle,
          descriptor: chosen,
          candidates
        };
      }
    }

    await page.waitForTimeout(250);
  }

  return {
    ok: false,
    handle: null,
    descriptor: null,
    candidates: []
  };
}

export async function waitForPrimaryActionControl(page, timeoutMs = 5000, minBox = PRIMARY_ACTION_MIN_BOX) {
  const deadline = Date.now() + timeoutMs;
  let lastInspection = null;
  let lastCandidates = [];

  while (Date.now() < deadline) {
    const { candidates } = await scanInteractiveControls(page);
    lastCandidates = candidates;
    const inspection = inspectPrimaryActionRow(candidates, minBox);
    lastInspection = inspection;
    if (inspection.ok && inspection.primaryControl) {
      const handle = await resolveInteractiveControlHandle(page, inspection.primaryControl);
      if (handle) {
        return {
          ok: true,
          state: inspection.state,
          handle,
          descriptor: inspection.primaryControl,
          row: inspection.row,
          layoutFamily: inspection.layoutFamily,
          candidates,
          diagnostics: inspection.diagnostics,
          attempts: 1
        };
      }
    }

    await page.waitForTimeout(250);
  }

  return {
    ok: false,
    state: 'unknown',
    handle: null,
    descriptor: null,
    row: null,
    layoutFamily: lastInspection?.layoutFamily || 'unknown',
    candidates: lastCandidates,
    diagnostics: lastInspection?.diagnostics || { rows: [], columns: [], fallbackCandidates: [] },
    attempts: 1
  };
}

export async function waitForPrimaryActionControlWithRetry(page, {
  timeoutMs = 5000,
  minBox = PRIMARY_ACTION_MIN_BOX,
  settleWaitMs = REEL_READINESS_RETRY_WAIT_MS,
  retryMode = 'alternate_scan'
} = {}) {
  const first = await waitForPrimaryActionControl(page, timeoutMs, minBox);
  if (first.ok) return first;

  await page.waitForTimeout(settleWaitMs);
  await page.mouse.wheel(0, 64).catch(() => {});
  await page.waitForTimeout(150);
  await page.mouse.wheel(0, -64).catch(() => {});
  await page.waitForTimeout(150);

  const second = await waitForPrimaryActionControl(page, timeoutMs, minBox);
  return {
    ...second,
    retryMode,
    firstAttemptDiagnostics: first.diagnostics,
    firstAttemptCandidates: first.candidates,
    attempts: 2
  };
}
