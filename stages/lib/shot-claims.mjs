const targetText = (value) => String(value ?? '').trim();

/**
 * capture-shots 的 targets 可能混入日期、股票代碼或同一主張的重複項；只有同時
 * 含阿拉伯數字、且原文真的出現的 target 才是本 gate 要守的「講稿數字主張」。
 */
export function numericClaimTargets(targets, sourceText) {
  const source = String(sourceText ?? '');
  const claims = [];
  const seen = new Set();
  for (const entry of Array.isArray(targets) ? targets : []) {
    const target = targetText(entry?.target);
    if (!target || !/\d/u.test(target) || !source.includes(target) || seen.has(target)) continue;
    seen.add(target);
    claims.push(target);
  }
  return claims;
}

/**
 * beats 與 skippedClaims 共同承擔主張涵蓋；skip 必須逐項明寫非空 reason。
 * 呼叫端決定要 fail planning，或把 errors/missing 寫成 gate failed。
 */
export function auditShotClaimCoverage({ targets, sourceText, beatAnchors, skippedClaims }) {
  const claims = numericClaimTargets(targets, sourceText);
  const anchors = new Set((Array.isArray(beatAnchors) ? beatAnchors : [])
    .map(targetText).filter(Boolean));
  const skipped = new Set();
  const errors = [];

  if (skippedClaims !== undefined && !Array.isArray(skippedClaims)) {
    errors.push('skippedClaims 必須是 [{target, reason}] 陣列');
  } else {
    for (const [index, entry] of (skippedClaims ?? []).entries()) {
      const target = targetText(entry?.target);
      const reason = typeof entry?.reason === 'string' ? entry.reason.trim() : '';
      if (!target) errors.push(`skippedClaims[${index}] 缺 target`);
      if (!reason) errors.push(`skippedClaims[${index}]「${target || '?'}」缺 reason`);
      if (target && reason) skipped.add(target);
    }
  }

  const coveredByBeat = claims.filter((claim) => anchors.has(claim));
  const coveredBySkip = claims.filter((claim) => !anchors.has(claim) && skipped.has(claim));
  const missing = claims.filter((claim) => !anchors.has(claim) && !skipped.has(claim));
  return { claims, coveredByBeat, coveredBySkip, missing, errors };
}
