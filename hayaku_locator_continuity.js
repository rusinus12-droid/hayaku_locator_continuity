//@name hayaku_locator_continuity
//@display-name HAYAKU · Locator Continuity v1.1.0
//@author rusinus12@gmail.com
//@api 3.0
//@version 1.1.0
//@update-url https://raw.githubusercontent.com/rusinus12-droid/hayaku_locator_continuity/main/hayaku_locator_continuity.js
//@arg hayaku_enabled string true|false
//@arg hayaku_mode string auto|balanced|fast|deep
//@arg hayaku_prompt_mode string auto|balanced|full
//@arg hayaku_max_items_per_axis string 3
//@arg hayaku_bm25_channel string true|false
//@arg hayaku_bm25_weight string 0.08
//@arg hayaku_debug string true|false
//@arg hayaku_main_request_types string model
//@arg hayaku_packet_recovery string true|false
//@arg hayaku_haya_love_frame string true|false
//@arg hayaku_haya_prefill string true|false

/*
 * HAYAKU · Locator Continuity Plugin
 *
 * Design contract:
 * - beforeRequest-only continuity plugin.
 * - No direct LLM/API call.
 * - No embedding provider or vector DB.
 * - Response model never receives locator URIs, _locator, _retrieval, store keys, or internal IDs.
 * - Response model writes a hidden HTML-comment HAYAKU_STATE_PACKET; HAYAKU ingests it on the next beforeRequest.
 * - Locators are internal metadata embedded inside entity/world/narrative/planner records.
 * - No visible UI is created; inspect request diagnostics through HAYAKU.lastDebug().
 * - Continuity memory is chat-packet-only: packets are read from chat messages on each request and are not persisted to pluginStorage/localStorage.
 */

(async () => {
  'use strict';

  const apiCandidates = () => {
    const out = [];
    const push = value => {
      if (value && (typeof value === 'object' || typeof value === 'function') && !out.includes(value)) out.push(value);
    };
    try { if (typeof risuai !== 'undefined') push(risuai); } catch (_) {}
    try { if (typeof Risuai !== 'undefined') push(Risuai); } catch (_) {}
    try { if (typeof RisuAI !== 'undefined') push(RisuAI); } catch (_) {}
    try {
      if (typeof globalThis !== 'undefined') {
        push(globalThis.risuai);
        push(globalThis.Risuai);
        push(globalThis.RisuAI);
      }
    } catch (_) {}
    return out;
  };
  const API = apiCandidates()[0] || null;
  if (!API) {
    console.warn('[HAYAKU] risuai API is unavailable.');
    return;
  }

  const PLUGIN_ID = 'hayaku.locator.continuity';
  const PLUGIN_NAME = 'HAYAKU';
  const PLUGIN_VERSION = '1.1.0';
  const KEY_PREFIX = 'hayaku.v1';
  const STORE_KEY = `${KEY_PREFIX}.store`;
  const SETTINGS_CACHE_KEY = `${KEY_PREFIX}.settings.cache`;
  const INJECTION_HEADER = '[HAYAKU CONTINUITY CONTEXT]';
  const INJECTION_FOOTER = '[/HAYAKU CONTINUITY CONTEXT]';
  const SIDE_WRITE_TAIL_MARKER = '[HAYAKU SIDE-WRITE FINAL REMINDER]';
  const PACKET_START = 'HAYAKU_STATE_PACKET_START';
  const PACKET_END = 'HAYAKU_STATE_PACKET_END';
  const PACKET_RECOVERY_EXCERPT_CHARS = 3600;
  const PACKET_RECOVERY_MIN_VISIBLE_CHARS = 40;
  const PACKET_RECOVERY_MAX_CHAIN_MESSAGES = 3;
  const VISIBLE_REPEAT_GUARD_RECENT_MESSAGES = 8;
  const VISIBLE_REPEAT_GUARD_MAX_ROWS = 3;
  const VISIBLE_REPEAT_GUARD_MAX_SNIPPETS = 4;
  const PATTERN_GUARD_DEFAULT_EXPIRES_AFTER_TURNS = 2;
  const PATTERN_GUARD_MAX_EXPIRES_AFTER_TURNS = 3;
  const PATTERN_GUARD_NEUTRAL_EVIDENCE = 'recent assistant outputs';
  const PATTERN_GUARD_DEFAULT_RESOLVE_WHEN = 'the next visible response avoids the repeated quote/beat/scaffold and advances a new consequence, choice, reaction angle, or information beat';
  const PREVIOUS_TURN_RECALL_BRIDGE_STRONG_CHARS = 1600;
  const PREVIOUS_TURN_RECALL_BRIDGE_LIGHT_CHARS = 760;
  const PREVIOUS_TURN_RECALL_BRIDGE_SHORT_QUERY_CHARS = 140;
  const PRONOUN_RECALL_BRIDGE_MAX_CANDIDATES = 3;
  const HIDDEN_PACKET_RE = new RegExp(`<!--\\s*${PACKET_START}\\s*([\\s\\S]*?)\\s*${PACKET_END}\\s*-->`, 'gi');
  const VISIBLE_PACKET_RE = new RegExp(`<<<\\s*${PACKET_START}\\s*>>>\\s*([\\s\\S]*?)\\s*<<<\\s*${PACKET_END}\\s*>>>`, 'gi');
  const RETRIEVAL_ENGINE_VERSION = 'strengthened_jaccard_v3';
  const JACCARD_TUNING = Object.freeze({
    fuzzyMatchThreshold: 0.58,
    stemMatchSimilarity: 0.82,
    ngramMatchFloor: 0.42,
    ngramMatchScale: 0.92,
    ngramMatchCap: 0.78,
    substringSimilarity: 0.82,
    genericConceptCap: 0.18,
    specificGateFloor: 0.16,
    gateRelevanceFloor: 0.025,
    strongJaccardFloor: 0.055,
    optionalScoreFloor: 0.06,
    multiSelectScoreFloor: 0.08,
    importantRelevanceFloor: 0.035,
    locatorSignalFloor: 0.24,
    priorityBoostFloor: 0.14,
    gateHighRelevanceFloor: 0.08,
    gateSpecificRelevanceFloor: 0.015,
    gatePhraseSignalFloor: 0.22,
    gatePlannerRelevanceFloor: 0.018,
    gatePlannerThresholdRatio: 0.72,
    presentStateFreshnessWeight: 0.035,
    defaultFreshnessWeight: 0.01,
    phraseChannelWeight: 0.05,
    rrfK: 60,
    rrfBlend: 0.12,
    rrfSignalEpsilon: 0.001,
    channelBoost: 1.30,
    channelDamp: 0.85
  });
  const MODE_INJECTION_CAPS = Object.freeze({
    balanced: 22000,
    full: 30000
  });
  const MODE_STATE_VIEW_RATIOS = Object.freeze({
    balanced: 0.48,
    full: 0.55
  });
  const MODE_STATE_VIEW_MAX = Object.freeze({
    balanced: 8500,
    full: 14000
  });

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    mode: 'auto',
    promptMode: 'auto',
    injectionCaps: MODE_INJECTION_CAPS,
    maxItemsPerAxis: 3,
    bm25Channel: true,
    bm25Weight: 0.08,
    debug: false,
    recentLimit: 120,
    importantLimit: 64,
    mainRequestTypes: 'model',
    recentEntityContextMs: 20 * 60 * 1000,
    recencyTurnWindow: 16,
    packetRecovery: true,
    hayaLoveFrame: true,
    hayaPrefill: true,
    sidePacketInstruction: true
  });
  // Performance guard profiles. HAYAKU is storage-free and re-reads chat packets on
  // every request; without an ingest cap, long chats can freeze the UI while the
  // request-local store/index is rebuilt. These caps are intentionally packet-count
  // based rather than message-distance based, because assistant/user alternation and
  // module helper messages make raw message distance an unreliable freeze guard.
  const PERFORMANCE_PROFILES = Object.freeze({
    fast: Object.freeze({
      // Low-latency mode: intentionally scans only a recent window.
      maxScanMessages: 220,
      recentFullPackets: 3,
      maxFullPackets: 3,
      maxLightPackets: 6,
      protectedOldPackets: 2,
      queryOldPackets: 6,
      sourceEvidenceRecentPackets: 1
    }),
    balanced: Object.freeze({
      // Default long-memory mode: scan all packets cheaply, but cap full ingest.
      // The b profile keeps old anchors/locks as candidates while reducing
      // full/light ingest enough for long-chat responsiveness.
      maxScanMessages: 0,
      recentFullPackets: 4,
      maxFullPackets: 4,
      maxLightPackets: 12,
      protectedOldPackets: 6,
      queryOldPackets: 12,
      sourceEvidenceRecentPackets: 1
    }),
    deep: Object.freeze({
      // Deep mode is still bounded to avoid accidental browser OOM on very long logs.
      maxScanMessages: 0,
      recentFullPackets: 96,
      maxFullPackets: 128,
      maxLightPackets: 128,
      protectedOldPackets: 48,
      queryOldPackets: 72,
      sourceEvidenceRecentPackets: 96
    })
  });
  const PROTECTED_PACKET_SIGNAL_RE = /"(?:do_not_resolve_yet|doNotResolveYet|continuity_locks|continuityLocks|speaker_boundaries|speakerBoundaries|pattern_guard|patternGuard|overpromotion_risks|overpromotionRisks|consent_memory|consentMemory|secrets|secret_boundaries|secretBoundaries|hiddenKnowledge|privateThoughts|deniedToEntityIds|hidden_from|hiddenFrom|safeword|safe_signal|safeSignal|revealState)"\s*:/i;
  const HIGH_IMPORTANCE_PACKET_RE = /"overall"\s*:\s*(?:0\.[89]\d*|1(?:\.0+)?)|"importance"\s*:\s*(?:0\.[89]\d*|1(?:\.0+)?)/i;
  const BEFORE_REQUEST_BUDGET_MS = Object.freeze({
    fast: 2500,
    balanced: 5000,
    deep: 12000
  });
  const budgetForSettings = settings => {
    const mode = normalizedPerformanceMode(settings?.effectiveMode || settings?.mode || 'balanced');
    return Math.max(1000, Number(BEFORE_REQUEST_BUDGET_MS[mode] || BEFORE_REQUEST_BUDGET_MS.balanced) || 5000);
  };

  const FAST_PROTECTED_PACKET_SIGNAL_RE = new RegExp([
    '"(?:continuity_lock|continuity_locks|continuityLocks|do_not_resolve_yet|doNotResolveYet|consent_memory|consentMemory',
    'avoid|open_invitation|open_invitations|openInvitations|next_direction|next_response_direction|nextResponseDirection|suggested_hook|suggested_hooks|suggestedHooks',
    'characters|character|people|relations|relationships|pov_memories|povMemories|entity_memories|entityMemories|entity_knowledge|knowledge',
    'secrets|secret_boundaries|secretBoundaries|hiddenKnowledge|privateThoughts',
    'location|time|atmosphere|sensory|lighting|weather|scent|scene_type|sceneType|danger_level|dangerLevel|active_events|activeEvents|events|world_rules|worldRules|rules|offscreen_threads|offscreenThreads|factions|regions',
    'consequence_ledger|consequenceLedger|consequences|payoff_tracker|payoffTracker|payoffs|payover_tracker|payoverTracker|payovers',
    'speaker_boundaries|speakerBoundaries|pattern_guard|patternGuard|overpromotion_risks|overpromotionRisks',
    'summary_memory|summaryMemory|canonical_anchors|canonicalAnchors|canonical_tokens|canonicalTokens|conflict_traces|conflictTraces|conflicts|scene_deltas|sceneDeltas|deltas|theme_motifs|themeMotifs|motifs)"\\s*:',
    '"revealState"\\s*:\\s*"hidden"'
  ].join('|'), 'i');
  const POV_MEMORY_TYPES = Object.freeze(['experienced', 'witnessed', 'heard', 'inferred', 'rumor', 'private_thought', 'public_fact']);
  const KNOWLEDGE_STATES = Object.freeze(['known', 'suspected', 'uncertain', 'misunderstood', 'forgotten', 'hidden']);
  const PRIVACY_STATES = Object.freeze(['public', 'shared', 'private', 'secret', 'internal']);
  const TRUTH_STATES = Object.freeze(['true', 'false', 'contested', 'unknown']);
  const COMPACT_PACKET_EXAMPLE = '{"meta":{"schema":"hayaku_packet_v1","packet_type":"current_snapshot","packet_schema_rev":2,"ledger_profile":"hidden_packet_ledger_v2","scene_id":"s7","turn_anchor":"리아가 하루에게 열쇠를 건넴","confidence":0.88,"pov_entity":"리아","active_speaker":"리아","visible_participants":["하루","리아"],"scene_visibility":"limited","summary_memory":{"summary":"리아가 숨겨둔 열쇠를 하루에게 넘기고 신뢰가 심화됨","recallAnchors":["key / 열쇠 / 鍵 / object:key","relation:trust"],"canonicalAnchors":["object:key","relation:trust"],"mentionedEntityNames":["하루","Haru","리아","Lia"],"confidence":0.8,"overpromotion_risks":[]},"speaker_boundaries":[],"pattern_guard":[],"overpromotion_risks":[],"consent_memory":{"preferences":["신뢰 기반 접근","느린 긴장"],"limits":["강제 공개 금지"],"comfort":0.7}},"entity":{"characters":[{"name":"리아","current_state":"열쇠를 건네며 감정을 드러냄","emotion":"긴장과 안도","relation_to_user":"신뢰 심화","condition":"오른손 가벼운 찰과상","attire":"두건과 긴 소매 외투","carrying":["열쇠","서약서"],"importance":0.9}],"relations":[{"from":"하루","to":"리아","state":"신뢰 심화","trust":0.7,"intimacy":0.62,"power_balance":"peer","dynamic":"warming"}]},"world":{"location":"기록실","time":"밤","sensory":"희미한 촛불, 오래한 종이 냄새, 밤공기 차가움","active_events":[{"event":"열쇠 인도","status":"active"}]},"narrative":{"scene_phase":"전환","tension_level":0.6,"pacing":"escalating","time_elapsed":"수 분","conflict_traces":[{"summary":"비밀 공유로 관계 전환"}]},"planner":{"continuity_locks":[{"label":"열쇠의 의미는 미해결","status":"active"}],"do_not_resolve_yet":[{"label":"하루의 진짜 의도는 아직 밝히지 않음","status":"active"}],"open_invitations":[{"label":"하루가 열쇠의 용도를 당장 물을 수 있음","status":"active"}]},"importance":{"overall":0.85,"reason":["비밀 공유로 관계 전환"]}}';
  const TAIL_CURRENT_PACKET_EXAMPLE = '{"meta":{"schema":"hayaku_packet_v1","packet_type":"current_snapshot","packet_schema_rev":2,"confidence":0.6},"entity":{"characters":[],"relations":[],"pov_memories":[],"secrets":[]},"world":{"location":"","time":"","active_events":[]},"narrative":{"scene_phase":"","conflict_traces":[]},"planner":{"continuity_locks":[],"do_not_resolve_yet":[],"next_direction":[]},"importance":{"overall":0.4,"reason":[]}}';
  const TAIL_RECOVERY_PACKET_EXAMPLE = '{"meta":{"schema":"hayaku_packet_v1","packet_type":"recovery_snapshot","packet_schema_rev":2,"confidence":0.45},"entity":{"characters":[],"relations":[],"pov_memories":[],"secrets":[]},"world":{"location":"","time":"","active_events":[]},"narrative":{"scene_phase":"","conflict_traces":[]},"planner":{"continuity_locks":[],"do_not_resolve_yet":[],"next_direction":[]},"importance":{"overall":0.3,"reason":[]}}';

  

  // HAYAKU Packet Ledger Rev2 - storage-free hidden-packet ledger layer.
  const HAYAKU_LEDGER_REV2_PATCH_MARKER = 'hayaku_packet_ledger_rev2_no_node_memory';
  const HAYAKU_LEDGER_REV2_PHASE2_RECALL_MARKER = 'meta_summary_boundary_guard_recall_v1';
  const LEDGER_REV2_SCORING_ENGINE = `${RETRIEVAL_ENGINE_VERSION}+packet_ledger_rev2`;
  const LEDGER_REV2_SCORING_WEIGHTS = Object.freeze({
    recency: 0.075,
    salience: 0.105,
    sameRef: 0.120,
    sameScene: 0.055,
    directEvidence: 0.080,
    stalePenalty: 0.120,
    supersededPenalty: 0.260,
    secretBoundaryPenalty: 0.100
  });
  const LEDGER_REV2_FORBIDDEN_PACKET_FIELDS = Object.freeze([
    'node_memory',
    'nodeMemory',
    'storage_policy',
    'storagePolicy',
    'audit_cautions',
    'auditCautions',
    'requiresAudit'
  ]);
  const LEDGER_REV2_CURRENT_LOOKUP_RE = /(?:현재|지금|방금|최신|위치|장소|어디|상태|있어|있나|今|現在|さっき|最新|場所|どこ|何処|状態|様子|いる|ある|latest|current|now|right now|where|location|status|state)/i;
  const LEDGER_REV2_PAST_LOOKUP_RE = /(?:과거|예전|이전|전에|지난|당시|기록|내역|이력|변천|변화|히스토리|過去|昔|以前|前に|当時|記録|履歴|変化|経緯|ヒストリー|history|timeline|record|log|past|previous|before|formerly|used to)/i;
  const LEDGER_REV2_SECRETISH_RE = /\b(secret|private|internal|hidden|denied|비밀|사적|내부|숨김|은폐)\b/;
  const LEDGER_REV2_SECRET_CATEGORY_RE = /pov|secret|memory|boundary/i;
  const LEDGER_REV2_STALE_STATUS_RE = /^(?:resolved|dormant)$/i;
  const LEDGER_REV2_STALE_SCOPE_RE = /^(?:past)$/i;
  const LEDGER_REV2_SUPERSEDED_STATUS_RE = /^(?:superseded)$/i;
  const LEDGER_REV2_NO_LONGER_TRUE_RE = /^(?:no_longer_true)$/i;
  const LEDGER_REV2_SUPERSEDING_STATUS_RE = /^(?:superseded|resolved)$/i;
  const ledgerRev2Text = value => {
    if (value == null) return '';
    if (Array.isArray(value)) return value.map(ledgerRev2Text).filter(Boolean).join(' ');
    if (typeof value === 'object') {
      try {
        return Object.entries(value)
          .filter(([key]) => !LEDGER_REV2_FORBIDDEN_PACKET_FIELDS.includes(String(key || '').trim()))
          .map(([, body]) => ledgerRev2Text(body))
          .filter(Boolean)
          .join(' ');
      } catch (_) {
        return '';
      }
    }
    return String(value || '').trim();
  };
  const ledgerRev2List = value => {
    if (Array.isArray(value)) return value.map(item => ledgerRev2Text(item)).filter(Boolean);
    const body = ledgerRev2Text(value);
    return body ? [body] : [];
  };
  const ledgerRev2Clamp = (value, min = 0, max = 1, fallback = 0) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  };
  const patternGuardExpiryTurns = value => {
    const n = Number(value);
    if (!Number.isFinite(n)) return PATTERN_GUARD_DEFAULT_EXPIRES_AFTER_TURNS;
    return Math.max(1, Math.min(PATTERN_GUARD_MAX_EXPIRES_AFTER_TURNS, Math.round(n)));
  };
  const ledgerRev2Lower = value => ledgerRev2Text(value).toLowerCase();
  const ledgerRev2RowItem = row => row && typeof row.item === 'object' && row.item ? row.item : row || {};
  const ledgerRev2RowRefs = row => {
    const item = ledgerRev2RowItem(row);
    return ledgerRev2List([
      row?.publicRef,
      row?.ref,
      row?.id,
      item?.ref,
      item?.id,
      item?.name,
      item?.title,
      item?.from,
      item?.to,
      item?.ownerEntityId,
      item?.holderEntityIds,
      item?.visibleToEntityIds,
      item?.deniedToEntityIds,
      item?.related_refs,
      item?.relatedRefs,
      item?.canonicalAnchors,
      item?.canonical_anchors,
      item?.canonicalTokens,
      item?.canonical_tokens,
      item?.aliases,
      item?.replaces
    ]).map(value => value.toLowerCase());
  };
  const ledgerRev2RowBody = row => {
    const item = ledgerRev2RowItem(row);
    return ledgerRev2Text([
      row?.publicText,
      row?.text,
      row?.displayText,
      row?.category,
      row?.axis,
      item?.summary,
      item?.text,
      item?.rawText,
      item?.state,
      item?.current_state,
      item?.emotion,
      item?.name,
      item?.title,
      item?.label,
      item?.boundary,
      item?.pattern,
      item?.risk,
      item?.safe_interpretation,
      item?.variation_hint,
      item?.evidence,
      item?.directEvidenceSnippets,
      item?.recallAnchors,
      item?.canonicalAnchors,
      item?.canonical_anchors,
      item?.canonicalTokens,
      item?.canonical_tokens,
      item?.related_refs,
      item?.relatedRefs,
      item?.replaces
    ]).toLowerCase();
  };
  const ledgerRev2QueryTerms = signature => {
    const values = [];
    for (const key of ['raw', 'query', 'text', 'source', 'currentTurnText']) {
      if (signature?.[key]) values.push(signature[key]);
    }
    for (const key of ['mentionedEntities', 'focusNames', 'subjects', 'subjectTokens', 'tokens', 'conceptTokens']) {
      if (Array.isArray(signature?.[key])) values.push(...signature[key]);
    }
    if (signature?.knowledgeContext) values.push(signature.knowledgeContext);
    return ledgerRev2List(values).map(value => value.toLowerCase());
  };
  const ledgerRev2HasQueryHit = (row, signature) => {
    const body = ledgerRev2RowBody(row);
    const refs = ledgerRev2RowRefs(row);
    const terms = ledgerRev2QueryTerms(signature).filter(term => term.length >= 2);
    if (!terms.length) return false;
    return terms.some(term => body.includes(term) || refs.some(ref => ref.includes(term) || term.includes(ref)));
  };
  const ledgerRev2HasSameScene = (row, store = {}, signature = {}) => {
    const item = ledgerRev2RowItem(row);
    const rowScene = ledgerRev2Lower(item.scene_id || item.sceneId || row?.scene_id || row?.sceneId || item.scene || item.location || row?.location);
    const anchors = store?.context?.sceneAnchors || store?.sceneAnchors || signature?.sceneAnchors || {};
    const currentScene = ledgerRev2Lower(anchors.scene_id || anchors.sceneId || anchors.location || anchors.scene || signature.scene_id || signature.sceneId);
    if (!rowScene || !currentScene) return false;
    return rowScene === currentScene || rowScene.includes(currentScene) || currentScene.includes(rowScene);
  };
  const ledgerRev2HasDirectEvidence = row => {
    const item = ledgerRev2RowItem(row);
    return ledgerRev2List([
      item?.evidence,
      item?.directEvidenceSnippets,
      item?.sourceRefs,
      item?.source_refs,
      item?.rawText
    ]).some(value => value.length >= 3);
  };
  const ledgerRev2Status = row => {
    const item = ledgerRev2RowItem(row);
    return ledgerRev2Lower(item.status || row?.status);
  };
  const ledgerRev2TimeScope = row => {
    const item = ledgerRev2RowItem(row);
    return ledgerRev2Lower(item.time_scope || item.timeScope || row?.time_scope || row?.timeScope);
  };
  const ledgerRev2IsSupersedingRow = row => {
    const status = ledgerRev2Status(row);
    const scope = ledgerRev2TimeScope(row);
    return LEDGER_REV2_SUPERSEDING_STATUS_RE.test(status) || LEDGER_REV2_NO_LONGER_TRUE_RE.test(scope);
  };
  const ledgerRev2SecretBoundarySignal = row => {
    const item = ledgerRev2RowItem(row);
    const body = ledgerRev2Lower([
      row?.category,
      item?.privacy,
      item?.secrecyLevel,
      item?.knowledgeState,
      item?.revealState,
      item?.truthState,
      item?.hidden_from,
      item?.hiddenFrom,
      item?.deniedToEntityIds,
      item?.visibleToEntityIds,
      item?.holderEntityIds,
      item?.boundary,
      item?.risk
    ]);
    const secretish = LEDGER_REV2_SECRETISH_RE.test(body);
    const restricted = ledgerRev2List([item?.hidden_from, item?.hiddenFrom, item?.deniedToEntityIds]).length > 0;
    const visible = ledgerRev2List([item?.known_to, item?.knownTo, item?.visibleToEntityIds]).length > 0;
    return secretish || restricted || (visible && LEDGER_REV2_SECRET_CATEGORY_RE.test(String(row?.category || '')));
  };
  const ledgerRev2IsCurrentLookup = query => LEDGER_REV2_CURRENT_LOOKUP_RE.test(ledgerRev2Text(query));
  const ledgerRev2IsPastLookup = query => LEDGER_REV2_PAST_LOOKUP_RE.test(ledgerRev2Text(query));
  const resolvePacketLedgerRev2Supersessions = (rows = [], query = '') => {
    const list = ensureArray(rows);
    if (!list.length) return list;
    const currentLookup = ledgerRev2IsCurrentLookup(query) && !ledgerRev2IsPastLookup(query);
    const supersededRefs = new Set();
    for (const row of list) {
      if (!ledgerRev2IsSupersedingRow(row)) continue;
      const item = ledgerRev2RowItem(row);
      ledgerRev2List([item?.replaces, item?.supersedes, item?.invalidates, item?.ref, item?.id, row?.publicRef, row?.ref, row?.id])
        .map(value => value.toLowerCase())
        .filter(Boolean)
        .forEach(value => supersededRefs.add(value));
    }
    if (!supersededRefs.size || !currentLookup) return list;
    return list.filter(row => {
      if (ledgerRev2IsSupersedingRow(row)) return true;
      const refs = ledgerRev2RowRefs(row);
      return !refs.some(ref => supersededRefs.has(ref));
    });
  };
  const applyPacketScoringV2 = (row = {}, signature = {}, store = {}, settings = {}) => {
    const item = ledgerRev2RowItem(row);
    const breakdown = row.scoreBreakdown || {};
    const gate = ledgerRev2Clamp(breakdown.relevanceGate ?? breakdown.relevanceEvidence ?? row.score, 0, 1, 0);
    const baseScore = Number(row.score || 0) || 0;
    const importance = ledgerRev2Clamp(row.importance ?? item.importance, 0, 1, 0);
    const salience = ledgerRev2Clamp(row.salience ?? item.salience, 0, 1, 0);
    const impression = ledgerRev2Clamp(row.impression ?? item.impression, 0, 1, 0);
    const pressure = ledgerRev2Clamp(row.pressure ?? item.pressure, 0, 1, 0);
    const recencySource = ledgerRev2Clamp(breakdown.recency ?? breakdown.freshnessPrior ?? row.chatRecency ?? item.chatRecency ?? 0, 0, 1, 0);
    const salienceSource = Math.max(salience, importance * 0.84, pressure * 0.72, impression * 0.58);
    const sameRef = ledgerRev2HasQueryHit(row, signature) ? 1 : 0;
    const sameScene = ledgerRev2HasSameScene(row, store, signature) ? 1 : 0;
    const directEvidence = ledgerRev2HasDirectEvidence(row) ? 1 : 0;
    const status = ledgerRev2Status(row);
    const timeScope = ledgerRev2TimeScope(row);
    const staleSignal = LEDGER_REV2_STALE_STATUS_RE.test(status) || LEDGER_REV2_STALE_SCOPE_RE.test(timeScope) ? 1 : 0;
    const supersededSignal = LEDGER_REV2_SUPERSEDED_STATUS_RE.test(status) || LEDGER_REV2_NO_LONGER_TRUE_RE.test(timeScope) ? 1 : 0;
    const secretBoundary = ledgerRev2SecretBoundarySignal(row) ? 1 : 0;
    const queryTerms = ledgerRev2QueryTerms(signature);
    const queryTermsText = ledgerRev2Text(queryTerms);
    const currentLookup = LEDGER_REV2_CURRENT_LOOKUP_RE.test(queryTermsText) && !LEDGER_REV2_PAST_LOOKUP_RE.test(queryTermsText);
    const recencyBoost = recencySource * LEDGER_REV2_SCORING_WEIGHTS.recency * (0.35 + gate * 0.65);
    const salienceBoost = salienceSource * LEDGER_REV2_SCORING_WEIGHTS.salience * (0.25 + gate * 0.75);
    const sameRefBoost = sameRef * LEDGER_REV2_SCORING_WEIGHTS.sameRef;
    const sameSceneBoost = sameScene * LEDGER_REV2_SCORING_WEIGHTS.sameScene * (0.4 + gate * 0.6);
    const directEvidenceBoost = directEvidence * LEDGER_REV2_SCORING_WEIGHTS.directEvidence * (0.35 + gate * 0.65);
    const stalePenalty = staleSignal * LEDGER_REV2_SCORING_WEIGHTS.stalePenalty * (currentLookup ? 1 : 0.55);
    const supersededPenalty = supersededSignal * LEDGER_REV2_SCORING_WEIGHTS.supersededPenalty * (currentLookup ? 1 : 0.65);
    const secretBoundaryPenalty = secretBoundary * LEDGER_REV2_SCORING_WEIGHTS.secretBoundaryPenalty * (sameRef ? 0.35 : 1);
    const packetLedgerV2Delta = recencyBoost + salienceBoost + sameRefBoost + sameSceneBoost + directEvidenceBoost
      - stalePenalty - supersededPenalty - secretBoundaryPenalty;
    const score = ledgerRev2Clamp(baseScore + packetLedgerV2Delta, 0, 1.35, baseScore);
    return {
      ...row,
      score,
      retrievalEngine: LEDGER_REV2_SCORING_ENGINE,
      scoreBreakdown: {
        ...breakdown,
        retrievalEngine: LEDGER_REV2_SCORING_ENGINE,
        packetLedgerV2: {
          baseScore: Number(baseScore.toFixed(4)),
          delta: Number(packetLedgerV2Delta.toFixed(4)),
          recencyBoost: Number(recencyBoost.toFixed(4)),
          salienceBoost: Number(salienceBoost.toFixed(4)),
          sameRefBoost: Number(sameRefBoost.toFixed(4)),
          sameSceneBoost: Number(sameSceneBoost.toFixed(4)),
          directEvidenceBoost: Number(directEvidenceBoost.toFixed(4)),
          stalePenalty: Number(stalePenalty.toFixed(4)),
          supersededPenalty: Number(supersededPenalty.toFixed(4)),
          secretBoundaryPenalty: Number(secretBoundaryPenalty.toFixed(4)),
          status,
          timeScope
        }
      }
    };
  };
  const ledgerRev2Compact = (value, max = 520) => typeof compact === 'function' ? compact(value, max) : String(value || '').slice(0, max);
  const ledgerRev2ItemFrom = (raw, fallback = {}) => {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { ...fallback, ...raw };
    return { ...fallback, summary: ledgerRev2Compact(raw, 420), text: ledgerRev2Compact(raw, 420) };
  };
  const ingestPacketLedgerRev2Meta = (store = {}, parsed = {}, turn = 0, packetHash = '', sourceMeta = {}, packetQuality = {}) => {
    const meta = parsed && typeof parsed.meta === 'object' && parsed.meta ? parsed.meta : {};
    const result = { summaryMemory: 0, speakerBoundaries: 0, patternGuards: 0, overpromotionRisks: 0, consentMemory: 0, forbiddenFields: [] };
    for (const key of LEDGER_REV2_FORBIDDEN_PACKET_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(meta, key)) result.forbiddenFields.push(`meta.${key}`);
      if (Object.prototype.hasOwnProperty.call(parsed || {}, key)) result.forbiddenFields.push(key);
    }
    const sceneId = meta.scene_id || meta.sceneId || '';
    const summaryMemory = meta.summary_memory || meta.summaryMemory || null;
    const metaCanonicalAnchors = mergeValues([
      meta.canonicalAnchors,
      meta.canonical_anchors,
      meta.canonicalTokens,
      meta.canonical_tokens
    ], 32);
    const summaryMemoryObject = summaryMemory && typeof summaryMemory === 'object' ? summaryMemory : null;
    if (summaryMemoryObject || metaCanonicalAnchors.length) {
      const summarySource = summaryMemoryObject || {};
      const summaryText = ledgerRev2Compact(summarySource.summary || ledgerRev2Text(summarySource.recallAnchors || metaCanonicalAnchors || ''), 900);
      const recallAnchors = ensureArray(summarySource.recallAnchors).map(item => ledgerRev2Compact(item?.summary || item?.text || item, 160)).filter(Boolean).slice(0, 12);
      const explicitCanonicalAnchors = mergeValues([
        summarySource.canonicalAnchors,
        summarySource.canonical_anchors,
        summarySource.canonicalTokens,
        summarySource.canonical_tokens,
        metaCanonicalAnchors
      ], 32);
      const evidenceSnips = ensureArray(summarySource.directEvidenceSnippets).map(item => ledgerRev2Compact(item?.text || item?.summary || item, 220)).filter(Boolean).slice(0, 8);
      const mentioned = ensureArray(summarySource.mentionedEntityNames).map(item => ledgerRev2Compact(item, 80)).filter(Boolean).slice(0, 24);
      const inferredCanonicalAnchors = typeof canonicalRecallTokensForText === 'function'
        ? canonicalRecallTokensForText([summaryText, recallAnchors, evidenceSnips, mentioned, explicitCanonicalAnchors].join(' '))
        : [];
      const canonicalAnchors = mergeValues([explicitCanonicalAnchors, inferredCanonicalAnchors], 40)
        .filter(token => CANONICAL_RECALL_TOKEN_PREFIX_RE.test(token));
      const body = [summaryText, ...recallAnchors, ...canonicalAnchors, ...evidenceSnips, ...mentioned].filter(Boolean).join('\n');
      if (body) {
        if (!store.memory || typeof store.memory !== 'object') store.memory = { summaries: [] };
        const id = `ledger_rev2_summary_${packetHash || stableHash64(body)}`;
        const map = new Map(ensureArray(store.memory.summaries).map(item => [item.id, item]));
        const confidenceRaw = summarySource.confidence;
        const confidence = Number.isFinite(Number(confidenceRaw))
          ? ledgerRev2Clamp(confidenceRaw, 0, 1, 0.62)
          : /high/i.test(String(confidenceRaw || '')) ? 0.82 : /low/i.test(String(confidenceRaw || '')) ? 0.38 : 0.62;
        const memory = {
          id,
          kind: 'ledger_rev2_summary_memory',
          summary: summaryText || ledgerRev2Compact(body, 240),
          text: body,
          recallAnchors,
          canonicalAnchors,
          directEvidenceSnippets: evidenceSnips,
          mentionedEntityNames: mentioned,
          packetHashes: [packetHash].filter(Boolean),
          importance: ledgerRev2Clamp(parsed?.importance?.overall ?? summarySource.importance, 0, 1, 0.68),
          salience: ledgerRev2Clamp(summarySource.salience, 0, 1, 0.72),
          confidence,
          status: 'active',
          time_scope: 'current',
          scene_id: sceneId,
          sourceType: 'hayaku_packet_ledger_rev2_summary_memory',
          sourceScope: 'hidden_packet_meta',
          _ledgerRev2: { field: summaryMemoryObject ? 'meta.summary_memory' : 'meta.canonicalAnchors', packetHash, turn }
        };
        if (typeof makeLocator === 'function') {
          memory._locator = makeLocator('narrative', 'summary_memory', id, 'summary', turn, packetHash, body, memory, {
            sourceType: 'hayaku_packet_ledger_rev2_summary_memory',
            sourceScope: 'hidden_packet_meta',
            sourceEvidence: { mode: 'ledger_rev2_summary_memory', lines: [summaryText, ...evidenceSnips].filter(Boolean).slice(0, 4), confidence }
          });
        }
        memory._retrieval = typeof retrievalFor === 'function'
          ? retrievalFor('narrative', 'summary_memory', summaryText || 'summary_memory', memory, memory.importance, memory._locator || null, turn)
          : {
            axis: 'narrative',
            category: 'summary_memory',
            importance: memory.importance,
            confidence: memory.confidence,
            salience: memory.salience,
            entityNames: mentioned,
            tokens: tokenize(body, 260),
            priorityTerms: [...recallAnchors, ...canonicalAnchors],
            canonicalAnchors,
            crossLingualTokens: canonicalAnchors,
            sourceEvidence: { mode: 'ledger_rev2_summary_memory', lines: [summaryText, ...evidenceSnips].filter(Boolean).slice(0, 4), confidence }
          };
        map.set(id, memory);
        store.memory.summaries = [...map.values()].slice(-80);
        result.summaryMemory = 1;
      }
    }
    const plannerRows = [];
    const pushPlannerMeta = (raw, category, index, defaults = {}) => {
      const item = ledgerRev2ItemFrom(raw, defaults);
      const summary = ledgerRev2Compact(item.summary || item.text || item.boundary || item.pattern || item.risk || item.title || item.label || '', 520);
      if (!summary) return;
      const ref = item.ref || item.id || `${category}_${packetHash || stableHash64(summary)}_${index}`;
      const base = {
        ...item,
        ref,
        id: ref,
        type: category,
        kind: category,
        category,
        summary,
        text: ledgerRev2Compact(item.text || item.boundary || item.pattern || item.risk || summary, 900),
        status: item.status || 'active',
        time_scope: item.time_scope || item.timeScope || 'current',
        scene_id: item.scene_id || item.sceneId || sceneId,
        confidence: ledgerRev2Clamp(item.confidence, 0, 1, 0.72),
        importance: ledgerRev2Clamp(item.importance, 0, 1, category === 'overpromotion_risk' ? 0.82 : 0.72),
        salience: ledgerRev2Clamp(item.salience, 0, 1, category === 'pattern_guard' ? 0.76 : 0.72),
        evidence: ensureArray(item.evidence || item.directEvidenceSnippets).map(value => ledgerRev2Compact(value, 220)).filter(Boolean).slice(0, 6),
        related_refs: ensureArray(item.related_refs || item.relatedRefs || item.source_refs || item.sourceRefs).map(value => ledgerRev2Compact(value, 120)).filter(Boolean).slice(0, 16),
        canonicalAnchors: typeof canonicalRecallTokensForValue === 'function' ? canonicalRecallTokensForValue(item).slice(0, 24) : [],
        sourceType: `hayaku_packet_ledger_rev2_${category}`,
        sourceScope: 'hidden_packet_meta',
        _ledgerRev2: { field: `meta.${category}`, packetHash, turn }
      };
      if (category === 'pattern_guard') {
        base.expires_after_turns = patternGuardExpiryTurns(item.expires_after_turns ?? item.expiresAfterTurns);
        if (!base.resolve_when) base.resolve_when = item.resolveWhen || PATTERN_GUARD_DEFAULT_RESOLVE_WHEN;
        base.evidence = [PATTERN_GUARD_NEUTRAL_EVIDENCE];
        if (!base.resolved_reason && /^(?:resolved|dormant)$/i.test(String(base.status || ''))) {
          base.resolved_reason = item.resolvedReason || 'the repeated pattern was not observed in the latest visible response';
        }
      }
      if (typeof decorateItem === 'function') {
        plannerRows.push(decorateItem('planner', category, base, turn, packetHash, ref, category, sourceMeta));
      } else {
        plannerRows.push(base);
      }
    };
    ensureArray(meta.speaker_boundaries || meta.speakerBoundaries).forEach((raw, index) => {
      pushPlannerMeta(raw, 'speaker_boundary', index, { importance: 0.76, salience: 0.78 });
      result.speakerBoundaries += 1;
    });
    ensureArray(meta.pattern_guard || meta.patternGuard).forEach((raw, index) => {
      pushPlannerMeta(raw, 'pattern_guard', index, { importance: 0.72, salience: 0.80 });
      result.patternGuards += 1;
    });
    ensureArray(meta.overpromotion_risks || meta.overpromotionRisks || summaryMemory?.overpromotion_risks || summaryMemory?.overpromotionRisks).forEach((raw, index) => {
      pushPlannerMeta(raw, 'overpromotion_risk', index, { importance: 0.84, salience: 0.82 });
      result.overpromotionRisks += 1;
    });
    const consentRaw = meta.consent_memory || meta.consentMemory || (parsed && parsed.planner ? (parsed.planner.consent_memory || parsed.planner.consentMemory) : null) || null;
    if (objectish(consentRaw)) {
      const prefs = ensureArray(consentRaw.preferences || consentRaw.preferences_list || consentRaw.likes).map(v => ledgerRev2Compact(v, 80)).filter(Boolean).slice(0, 12);
      const limits = ensureArray(consentRaw.limits || consentRaw.hard_limits || consentRaw.hardLimits || consentRaw.no_go || consentRaw.noGo).map(v => ledgerRev2Compact(v, 80)).filter(Boolean).slice(0, 12);
      const safeword = ledgerRev2Compact(consentRaw.safeword || consentRaw.safe_signal || consentRaw.safeSignal || '', 60);
      const comfortRaw = consentRaw.comfort != null ? consentRaw.comfort : consentRaw.comfort_level;
      const comfort = Number.isFinite(Number(comfortRaw)) ? ledgerRev2Clamp(comfortRaw, 0, 1, 0.7) : '';
      const consentSummary = [
        prefs.length ? `preferences(선호):${prefs.join(',')}` : '',
        limits.length ? `limits(한계/선):${limits.join(',')}` : '',
        safeword ? `safeword(안전어):${safeword}` : '',
        comfort !== '' ? `comfort:${Number(comfort).toFixed(2)}` : ''
      ].filter(Boolean).join(' / ');
      if (consentSummary) {
        pushPlannerMeta({ summary: consentSummary, text: consentSummary, preferences: prefs, limits, safeword, comfort }, 'consent_memory', 0, { importance: 0.8, salience: 0.82 });
        result.consentMemory = (result.consentMemory || 0) + 1;
      }
    }
    if (plannerRows.length) {
      if (!store.planner || typeof store.planner !== 'object') store.planner = { items: [] };
      const keyFn = item => normalizeKey(item.ref || item.id || item.summary || item.text || item.label || '');
      store.planner.items = typeof upsertList === 'function'
        ? upsertList(store.planner.items, plannerRows, keyFn, 120)
        : [...ensureArray(store.planner.items), ...plannerRows].slice(-120);
    }
    if (result.forbiddenFields.length) {
      store.context = {
        ...(store.context || {}),
        ledgerRev2Warnings: [{ packetHash, forbiddenFields: result.forbiddenFields, updatedAt: now() }, ...ensureArray(store.context?.ledgerRev2Warnings)].slice(0, 12)
      };
    }
    return result;
  };
const MODE_PROFILES = Object.freeze({
    fast: Object.freeze({
      token: 0.32, subject: 0.24, axis: 0.15, branch: 0.08, emotionTag: 0.08,
      worldTag: 0.05, narrativeTag: 0.03, pressure: 0.025, importance: 0.015, recency: 0.02,
      coverage: 0.05, priority: 0.06, locator: 0.14, salience: 0.03,
      threshold: 0.04, itemBonus: -1
    }),
    balanced: Object.freeze({
      token: 0.28, subject: 0.22, axis: 0.14, branch: 0.10, emotionTag: 0.10,
      worldTag: 0.07, narrativeTag: 0.05, pressure: 0.035, importance: 0.02, recency: 0.015,
      coverage: 0.075, priority: 0.075, locator: 0.16, salience: 0.045,
      threshold: 0.028, itemBonus: 0
    }),
    deep: Object.freeze({
      token: 0.23, subject: 0.19, axis: 0.12, branch: 0.11, emotionTag: 0.12,
      worldTag: 0.08, narrativeTag: 0.07, pressure: 0.055, importance: 0.025, recency: 0.01,
      coverage: 0.10, priority: 0.09, locator: 0.19, salience: 0.065,
      threshold: 0.018, itemBonus: 2
    })
  });
  const SELECT_PLANNER_INTENT_RE = /연속성|지켜야|이어져야|이어야|다음\s*(?:장면|약속|방향)|유지|약속|예정|미해결|결과|여파|압력|위험|next\s*(?:scene|promise|direction)|continuity|preserve|promise|consequence|payoff|unresolved|obligation|pressure|risk|danger/i;
  const SELECT_NARRATIVE_ACTION_RE = /고백|데이트\s*신청|신청했|청혼|키스|입맞|손(?:을|을\s*서로)?\s*잡|손을\s*잡|껴안|안았|포옹|만났|마주쳤|찾아갔|방문|도착|떠났|나갔|돌아왔|따라갔|기다렸|합류|헤어졌|거절|받아들|수락|대답|답(?:한다|했다|하)|응답|약속(?:했|을\s*(?:지켰|어겼|잡았|정했))|들켰|눈치챘|알아차렸|밝혔|공개|다퉜|싸웠|충돌|제안|초대|confess|answer(?:s|ed|ing)?|respond(?:s|ed|ing)?|ask(?:ed)?\s+(?:out|on\s+a\s+date)|date|kiss|hold(?:ing)?\s+hands?|take(?:s|n|ing)?\s+[^.?!\n]{0,40}\bhand|grab(?:s|bed|bing)?\s+[^.?!\n]{0,40}\bhand|touch(?:es|ed|ing)?|hug|meet|met|encounter|visit|arrive|leave|left|return|follow|wait|join|break\s+up|reject|accept|promise|caught|notice|realize|reveal|fight|argue|invite/i;
  const SELECT_CONTINUITY_PRESSURE_RE = /scheduled|future_pressure|active|current|promise|promised|must|next|lock|unresolved|obligation|pressure|consequence|payoff|boundary|boundaries|deniable|deniability|permission|permit|conditional|terms|confession|confessed|public|visibility|exposure|deeper|touch|hand|recoil|약속|예정|다음|이어|유지|연속|현재|활성|미해결|결과|여파|압력|지켜야|경계|부정\s*가능|부정할|고백|공개|노출|시선|허락|조건|깊이|손|닿|잡/i;
  const SELECT_NARRATIVE_ACTION_WORDS = new Set([
    '고백', '청혼', '키스', '입맞', '껴안', '안았', '포옹', '만났', '마주쳤', '방문', '도착',
    '떠났', '나갔', '돌아왔', '따라갔', '기다렸', '합류', '헤어졌', '거절', '수락', '대답',
    '응답', '들켰', '눈치챘', '알아차렸', '밝혔', '공개', '다퉜', '싸웠', '충돌', '제안', '초대',
    'confess', 'answer', 'respond', 'date', 'kiss', 'touch', 'hug', 'meet', 'met', 'encounter',
    'visit', 'arrive', 'leave', 'left', 'return', 'follow', 'wait', 'join', 'reject', 'accept',
    'promise', 'caught', 'notice', 'realize', 'reveal', 'fight', 'argue', 'invite'
  ].map(word => String(word).toLowerCase()));
  const SELECT_CONTINUITY_PRESSURE_WORDS = new Set([
    'scheduled', 'future_pressure', 'active', 'current', 'promise', 'promised', 'must', 'next', 'lock',
    'unresolved', 'obligation', 'pressure', 'consequence', 'payoff', 'boundary', 'boundaries', 'deniable',
    'deniability', 'permission', 'permit', 'conditional', 'terms', 'confession', 'confessed', 'public',
    'visibility', 'exposure', 'deeper', 'touch', 'hand', 'recoil', '약속', '예정', '다음', '유지', '연속',
    '현재', '활성', '미해결', '결과', '여파', '압력', '경계', '고백', '공개', '노출', '시선',
    '허락', '조건', '깊이', '손'
  ].map(word => String(word).toLowerCase()));
  const SELECT_HAND_TOUCH_RE = /손(?:을|에|끝|가락)?\s*(?:잡|닿|얹|쥐|스치)|잡은\s*손|손잡|hand|hands|touch(?:es|ed|ing)?|take(?:s|n|ing)?\s+[^.?!\n]{0,40}\bhand|grab(?:s|bed|bing)?\s+[^.?!\n]{0,40}\bhand|hold(?:ing)?\s+hands?/i;
  const SELECT_DEEPER_QUESTION_RE = /더\s*깊|깊이|얼마나\s*더|deeper|how\s+much\s+deeper|permission|permit|conditional|terms|허락|조건/i;
  const SELECT_INTIMACY_CONSENT_RE = /가까워|가까이|친밀|친해|어디까지|어디\s*까지|한계|선(?:을|이|이란|을\s*넘|을\s*밖)?|동의|허락|원해|싫어|그만|멈춰|안전어|세이프워드|경계|넘어|품어|안기|껴안|키스|스치|애무|관계(?:를|를\s*갖|를\s*맺)?|touch(?:es|ed|ing)?|intimate|intimacy|consent|limit|limits|boundary|boundaries|safeword|preferences|comfort|how\s+far|closer|get\s+closer|親密|限界|境界|合意|許可|線|止め|セーフワード/i;
  const SELECT_OBSERVER_WITNESS_RE = /들켰|눈치|시선|보이|봤|본다|목격|관찰|쳐다|마주치|classmate|witness|observer|notic(?:e|es|ed|ing)?|spot(?:s|ted)?|see\s+them|saw\s+them|caught|watch(?:es|ed|ing)?/i;
  const SELECT_PUBLIC_REVEAL_RE = /공개|노출|드러|알려(?:졌|짐|진|져)|밝혀|public|visibility|exposure|revealed?|\bknown\b/i;
  const SELECT_RUMOR_SPREAD_RE = /소문|여론|퍼지|퍼뜨|gossip|rumou?r|spread/i;
  const SELECT_AMBIENT_CUE_RE = /날씨|하늘|비(?:가|는|를|에|의)?|바람|공기|햇빛|구름|안개|풍경|배경|분위기|창밖|weather|sky|rain|wind|air|sunlight|cloud|fog|scenery|background|atmosphere|mood/i;
  const SELECT_DESCRIPTIVE_ONLY_RE = /(?:묘사|그린다|보여(?:줘|준다)?|시작|이어간다|이어\s*간다|열어(?:줘|간다)?|describe|depict|open|start|continue)/i;
  const SELECT_STATE_OR_PROFILE_INTENT_RE = /관계|상태|말투|성격|심리|기억|비밀|위치|장소|어디|어떻게\s*(?:보|생각|느끼|말|반응|대답)|関係|状態|口調|性格|心理|記憶|秘密|内緒|位置|場所|どこ|何処|どう\s*(?:見|思|感じ|言|反応|答)|relationship|status|state|profile|personality|memory|secret|where|location|react|answer|reply/i;
  const SELECT_AMBIENT_VISUAL_OBSERVATION_RE = /(?:하늘|날씨|풍경|창밖|구름|안개|햇빛|비(?:가|는|를|에|의)?|sky|weather|scenery|cloud|fog|sunlight|rain)[^.?!\n]{0,30}(?:보|바라|올려다|look|watch|gaze)|(?:보|바라|올려다|look|watch|gaze)[^.?!\n]{0,30}(?:하늘|날씨|풍경|창밖|구름|안개|햇빛|비(?:가|는|를|에|의)?|sky|weather|scenery|cloud|fog|sunlight|rain)/i;
  const SELECT_MEMORY_FOCUSED_RE = /감정|속앓|생각|기억|느낌|마음|왜|의문|비밀|알고|모르|emotion|feeling|thought|memory|secret|why/i;
  const SELECT_AMBIENT_TOPIC_STOP_RE = /^(?:오늘|이야기|이어|이어간다|시작|가볍게|묘사|그린다|보여|하늘|날씨|비|비가|비는|그친|그치고|개인|갠|바람|공기|햇빛|구름|안개|풍경|배경|분위기|창밖|today|story|continue|start|lightly|describe|sky|weather|rain|wind|air|sunlight|cloud|fog|scenery|background|atmosphere|mood)$/i;
  const SELECT_VISIBILITY_OBSERVER_ACTION_RE = /목격|관찰|눈치|시선|보는|봤|witness|observer|notic(?:e|es|ed|ing)?|spot|seen|watch/i;
  const SELECT_VISIBILITY_OBSERVER_ACTOR_RE = /classmate|반\s*친구|학생들|주변|yoomin|유민/i;
  const SELECT_VISIBILITY_PUBLIC_BODY_RE = /공개|노출|드러|알려|부정\s*가능|사적|공적|public|private\s*split|visibility|exposure|deniable|deniability/i;
  const SELECT_VISIBILITY_RUMOR_BODY_RE = /소문|여론|퍼지|gossip|rumou?r|spread/i;
  const SELECT_VISIBILITY_OBSERVER_ANY_RE = /목격|관찰|눈치|시선|classmate|witness|observer|notic(?:e|es|ed|ing)?|seen|watch|yoomin|유민/i;
  const SELECT_DIRECT_HAND_BODY_RE = /hand|hands|touch|recoil|손|닿|잡|스치|물러/i;
  const SELECT_DIRECT_DEEPER_BODY_RE = /deeper|깊|permission|permit|conditional|terms|confession|deniable|deniability|허락|조건|고백|부정/i;
  const SELECT_CHARACTER_PROFILE_BODY_RE = /identity|interpretation|personality|speech|psychology|profile|정체|해석|성격|말투|심리|현재|상태|감정|기억/i;
  const SELECT_AMBIENT_INACTIVE_LIFECYCLE_RE = /resolved|superseded|past|no_longer_true|과거|해결|종료/i;
  const RETRIEVAL_EXPLICIT_CONTINUITY_INTENT_RE = /연속성|지켜야|이어져야|이어야|다음\s*장면|다음\s*약속|continuity|preserve|must\s+(?:keep|preserve)|next\s+scene|next\s+promise/i;
  const RETRIEVAL_SPECIFIC_CONCEPT_RE = /^(?:object|color|place|position|relation|state|info|time|intent):/i;
  const RETRIEVAL_SPECIFIC_FRAME_RE = /^(?:psychology|relation|emotion):|^intent:(?:cause|motive|secret_owner|contradiction)/i;
  const RETRIEVAL_SURFACE_CLEAN_RE = /[^a-z0-9가-힣ぁ-んァ-ヶー一-龯々〆〤_\-\s]/g;
  const RETRIEVAL_SURFACE_SPACE_RE = /\s+/g;
  const RETRIEVAL_SURFACE_STOP_RE = /^(?:현재|상태|위치|장소|시간|물건|사물|대상|항목|아이템|확인|한다|current|state|location|place|object|item|thing|check)$/i;
  const PROFILE_INTENT_RE = /어떤\s*사람|누구|성격|말투|심리|정체|프로필|해석|기억|과거|왜|감정|마음|생각|속내|속마음|どんな\s*(?:人|人物)|誰|性格|口調|心理|正体|プロフィール|解釈|記憶|過去|なぜ|感情|心|考え|本音|identity|personality|speech|profile|interpretation|memory|past|why|emotion|feeling|thought|inner\s*(?:state|thought)/i;
  const PROFILE_BROAD_INTENT_RE = /모두|전부|각자|서로|등장인물|캐릭터들|인물들|全員|全部|各自|お互い|登場人物|キャラクターたち|人物たち|everyone|all\s+(?:characters|people)|each\s+(?:character|person)/i;
  const PROFILE_IMPLICIT_IDENTITY_RE = /누구|어떤\s*사람|정체|誰|どんな\s*(?:人|人物)|正体|who\s+(?:is|are)|what\s+kind\s+of\s+(?:person|character)/i;
  const PROFILE_EXPRESSION_INTENT_RE = /어떻게\s*(?:말|대답|답|반응|받아|거절|수락)|무슨\s*(?:말|대답)|대사|말투|목소리|톤|표정|반응|どう\s*(?:言|答|反応|受け止め|拒絶|受け入れ)|どんな\s*(?:言葉|返事)|台詞|口調|声|トーン|表情|反応|how\s+(?:does|would|should).{0,40}(?:say|answer|reply|respond|react)|dialogue|voice|tone|reaction/i;
  const LOW_SIGNAL_CONTINUITY_KEYS = Object.freeze(new Set([
    'unknown',
    'continuitylock',
    'donotresolveyet',
    'lock',
    'avoid',
    'delta',
    'motif',
    'conflict',
    'consequence',
    'payoff',
    'state',
    'planner',
    'narrative'
  ]));

  const ENTITY_BRANCHES = Object.freeze({
    desire: ['want', 'need', 'wish', 'goal', 'desire', '갈망', '원해', '원한다', '원하', '바라', '갖고 싶', '목표', '열망', '欲しい', '望む', '願う', '目的', '目標'],
    fear: ['fear', 'afraid', 'avoid', 'worry', 'anxious', '두려', '무서', '불안', '걱정', '피하', '겁에', '겁이', '겁먹', '겁난', '공포', '怖い', '恐怖', '不安', '心配', '避ける'],
    wound: ['hurt', 'scar', 'trauma', 'loss', 'betray', '상처', '트라우마', '배신', '잃은', '잃고', '잃었', '잃음', '후회', '원망', '傷', 'トラウマ', '裏切', '失う', '後悔'],
    mask: ['mask', 'pretend', 'hide', 'conceal', 'act like', '숨기', '감추', '척하', '척해', '척이', '태연', '연기', '아닌 척', '隠す', '隠れる', 'ふり', '平気なふり', '演じる'],
    bond: ['bond', 'trust', 'love', 'protect', 'care', 'attach', '신뢰', '믿음', '믿고', '믿는', '믿어', '믿었다', '애정', '사랑', '지키', '의지', '질투', '信頼', '信用', '愛情', '好き', '守る', '頼る', '嫉妬'],
    fixation: ['obsess', 'cling', 'fixate', 'compulsion', '집착', '매달', '놓지 못', '강박', '미련', '執着', 'こだわる', '未練', 'しがみつく']
  });

  const WORLD_SIGNALS = Object.freeze({
    setting: ['세계', '왕국', '제국', '도시', '마을', '교회', '성', '폐허', '世界', '王国', '帝国', '都市', '町', '村', '教会', '城', '廃墟', 'setting', 'kingdom', 'empire', 'city'],
    rule: ['규칙', '금지', '허용', '불가능', '마법은', '이 세계에서는', '規則', 'ルール', '禁止', '許可', '不可能', 'この世界では', 'rule', 'law', 'forbidden', 'allowed'],
    faction: ['세력', '조직', '가문', '군대', '왕실', '교단', '길드', '勢力', '組織', '家門', '軍', '王室', '教団', 'ギルド', 'faction', 'guild', 'army', 'order'],
    region: ['지역', '영토', '국경', '수도', '성문', '숲', '전장', '地域', '領土', '国境', '首都', '城門', '森', '戦場', 'region', 'border', 'gate', 'forest'],
    pressure: ['전쟁', '반란', '추격', '봉쇄', '위협', '소문', '혼란', '戦争', '反乱', '追跡', '封鎖', '脅威', '噂', '混乱', 'war', 'rebellion', 'threat', 'rumor'],
    offscreen: ['한편', '그 사이', '장면 밖', '다른 곳', '소문으로는', '一方', 'その間', '場面外', '別の場所', '噂では', 'meanwhile', 'offscreen']
  });

  const EMOTION_TAGS = Object.freeze({
    anger: ['분노', '화가', '화를', '화난', '화나', '격노', '노려', '怒り', '怒る', '腹を立てる', '睨む', 'anger', 'angry', 'rage'],
    fear: ['두려', '무서', '불안', '떨리', '떨며', '떨고', '떨어', '怖い', '恐怖', '不安', '震える', 'fear', 'afraid', 'anxious'],
    sadness: ['슬프', '눈물', '울먹', '울고', '운다', '울음', '상처', '悲しい', '涙', '泣く', '傷', 'sad', 'cry', 'tears'],
    affection: ['사랑', '좋아', '안아', '위로', '好き', '愛', '愛情', '抱きしめる', '慰める', 'affection', 'love', 'comfort'],
    trust: ['믿음', '믿고', '믿는', '믿어', '믿었다', '신뢰', '의지', '약속', '信頼', '信用', '頼る', '約束', 'trust', 'promise'],
    hostility: ['적대', '공격', '위협', '죽일', '죽이', '죽음', '죽어', '겨누', '敵意', '攻撃', '脅す', '殺', '狙う', 'hostile', 'attack', 'threat'],
    tension: ['긴장', '침묵', '대치', '불길', '緊張', '沈黙', '対峙', '不吉', 'tension', 'silent', 'standoff'],
    guilt: ['죄책', '죄책감', '후회', '미안', '罪悪感', '後悔', 'ごめん', '申し訳', 'guilt', 'regret', 'remorse'],
    joy: ['기쁨', '웃음', '웃고', '웃는', '웃지', '웃어', '미소', '안도', '喜び', '笑う', '微笑み', '安堵', 'joy', 'relief', 'smile']
  });

  const NARRATIVE_TAGS = Object.freeze({
    conflict: ['갈등', '불신', '다툼', '충돌', '葛藤', '不信', '争い', '衝突', 'conflict', 'distrust'],
    escalation: ['고조', '격화', '위기', '高まる', '激化', '危機', 'escalation', 'crisis'],
    aftermath: ['후폭풍', '결과', '대가', '余波', '結果', '代償', 'aftermath', 'consequence'],
    secret: ['비밀', '숨김', '거짓', '秘密', '内緒', '隠す', '嘘', 'secret', 'lie'],
    payoff: ['복선', '회수', '질문', '伏線', '回収', '問い', '質問', 'payoff', 'foreshadow', 'question'],
    lock: ['잠금', '유지', '바꾸면 안', '固定', '維持', '変えてはいけない', '解決しない', 'do not resolve', 'continuity lock']
  });

  const BODY_SIGNATURE_HINTS = Object.freeze([
    '숨', '숨결', '호흡', '시선', '눈빛', '입술', '턱', '어깨', '손', '손끝', '손가락', '자세', '발걸음',
    'breath', 'gaze', 'eyes', 'lips', 'jaw', 'shoulders', 'hands', 'fingers', 'posture', 'steps'
  ]);

  const RELATION_SIGNAL_TAGS = Object.freeze({
    trustUp: ['믿음', '믿고', '믿는', '믿어', '믿었다', '신뢰', '의지', '약속', '보호', '信頼', '信用', '頼る', '約束', '守る', 'trust', 'rely', 'promise', 'protect'],
    trustDown: ['불신', '의심', '배신', '거짓', '속였', '믿지 못', '믿을 수 없', '믿지 않', '不信', '疑う', '裏切', '嘘', '騙す', 'distrust', 'suspect', 'betray', 'lie'],
    affection: ['사랑', '애정', '좋아', '끌림', '안아', '위로', '好き', '愛情', '惹かれる', '抱きしめる', '慰める', 'love', 'affection', 'comfort'],
    hostility: ['적대', '위협', '공격', '죽일', '죽이', '죽음', '죽어', '겨누', '敵意', '脅威', '攻撃', '殺', '狙う', 'hostile', 'attack', 'threat'],
    boundary: ['거절', '거리', '선', '금지', '하지마', '拒絶', '距離', '境界', '禁止', 'やめて', 'refuse', 'boundary', 'forbid'],
    attachment: ['집착', '질투', '미련', '놓지 못', '執着', '嫉妬', '未練', '離せない', 'obsess', 'jealous', 'cling']
  });

  const STORY_LEDGER_HINTS = Object.freeze({
    unresolved: ['미해결', '아직', '보류', '未解決', 'まだ', '保留', 'open', 'unresolved', 'pending'],
    doNotResolve: ['풀지', '해결하지', '解かない', '解決しない', 'do not resolve', 'do_not_resolve', 'forbidden', '금지', '禁止'],
    consequence: ['결과', '대가', '후폭풍', '여파', '結果', '代償', '余波', 'consequence', 'aftermath', 'cost'],
    payoff: ['복선', '회수', '떡밥', '질문', '伏線', '回収', '問い', 'payoff', 'foreshadow', 'open question'],
    escalation: ['고조', '격화', '위기', '압박', '高まる', '激化', '危機', '圧迫', 'escalation', 'crisis', 'pressure']
  });

  const TIME_SIGNAL_TAGS = Object.freeze({
    sceneTime: ['시간', '날짜', '오전', '오후', '새벽', '아침', '점심', '저녁', '밤', '時間', '日付', '朝', '昼', '夕方', '夜', '深夜', 'time', 'date', 'morning', 'night'],
    recent: ['방금', '직전', '아까', '현재', '지금', '최근', 'さっき', '直前', '今', '現在', '最近', 'just', 'now', 'current', 'recent'],
    elapsed: ['후', '뒤', '동안', '지나', '흘렀', '後', 'あと', '間', '過ぎ', '経った', 'later', 'after', 'elapsed'],
    scheduled: ['예정', '내일', '오늘', '어제', '다음', '약속', '予定', '明日', '今日', '昨日', '次', '約束', 'tomorrow', 'today', 'yesterday', 'next']
  });

  const LOCATOR_HINT_TAGS = Object.freeze({
    ref: ['ref', 'reference', '참조', '기록', '항목', '参照', '記録', '項目', 'record'],
    previous: ['직전', '이전', '방금', '마지막', '최근', '直前', '以前', 'さっき', '最後', '最近', 'previous', 'last', 'recent'],
    state: ['상태', 'current_state', '状態', '様子', 'state', 'status'],
    event: ['사건', '이벤트', 'active_event', '事件', '出来事', 'イベント', 'event'],
    relation: ['관계', '関係', 'relations', 'relationship', 'relation']
  });
  const SEMANTIC_FRAME_MAP = Object.freeze({
    'intent:cause': ['왜', '원인', '이유', '때문', '계기', '어쩌다', 'なぜ', 'どうして', '理由', '原因', 'きっかけ', 'why', 'cause', 'reason', 'because', 'what made', 'led to'],
    'intent:motive': ['동기', '속내', '의도', '원했', '바랐', '動機', '本音', '意図', '望んだ', '欲しがった', 'motive', 'intent', 'intention', 'wanted', 'desire'],
    'intent:future_pressure': ['앞으로', '어떻게 될', '가능성', '압박점', 'これから', 'どうなる', '可能性', '圧力点', 'future', 'likely', 'pressure point', 'what happens next'],
    'intent:secret_owner': ['누가 알고', '알고 있', '비밀을 아는', '誰が知って', '知っている', '秘密を知る', 'who knows', 'secret holder', 'knows about'],
    'intent:contradiction': ['이상하', '위화감', '모순', '앞뒤', 'おかしい', '違和感', '矛盾', '辻褄', 'strange', 'off', 'inconsistent', 'contradiction'],
    'psychology:withdrawal': ['마음을 닫', '거리두', '거리를 두', '차갑게', '회피', '방어적', '벽을 치', '心を閉ざす', '距離を置く', '冷たく', '回避', '防御的', '壁を作る', 'shut down', 'closed off', 'withdraw', 'distant', 'defensive', 'put up a wall'],
    'psychology:collapse': ['무너', '버티지 못', '통제 상실', '멘붕', '붕괴', 'break down', 'collapse', 'fall apart', 'lose control'],
    'psychology:suppression': ['참았', '억눌', '삼키', '숨겼', 'suppress', 'held back', 'bottled up', 'swallowed'],
    'relation:betrayal': ['배신', '속였', '뒤통수', 'betray', 'betrayal', 'deceived', 'lied to'],
    'relation:distrust': ['불신', '의심', '믿지', '경계', 'distrust', 'suspect', 'suspicious', 'wary'],
    'relation:attachment': ['집착', '매달', '놓지 못', 'cling', 'attached', 'obsessed', 'fixated'],
    'relation:distance': ['거리', '멀어', '냉담', '피하', 'distant', 'distance', 'avoid', 'cold'],
    'emotion:masked_pain': ['괜찮은 척', '웃었지만', '아닌 척', '태연한 척', '平気なふり', '笑ったけど', '痛みを隠す', 'pretended to be fine', 'smiled but', 'masking pain'],
    'emotion:fear_response': ['몸이 굳', '떨리', '떨며', '떨고', '얼어붙', '숨을 죽', '体が固まる', '震える', '凍りつく', '息を潜める', 'froze', 'trembled', 'held breath', 'fear response'],
    'narrative:aftermath': ['후폭풍', '여파', '대가', '결과적으로', 'aftermath', 'fallout', 'consequence', 'cost'],
    'narrative:turning_point': ['전환점', '결정적', '그때부터', 'turning point', 'decisive moment', 'from then on'],
    'world:reaction_chain': ['연쇄', '파급', '소문', '퍼지', '동요', '連鎖', '波及', '噂', '広がる', '動揺', 'chain reaction', 'ripple', 'spread', 'rumor', 'public reaction']
  });
  const CROSS_LINGUAL_LEXICON = Object.freeze({
    'object:key': ['열쇠', 'key', '鍵', 'かぎ', 'キー'],
    'object:clock': ['시계', 'clock', 'watch', '時計', '腕時計'],
    'object:compass': ['나침반', 'compass', '羅針盤', 'コンパス'],
    'object:brooch': ['브로치', 'brooch', 'ブローチ'],
    'object:crown': ['왕관', 'crown', '王冠', '冠'],
    'object:necklace': ['목걸이', '펜던트', 'necklace', 'pendant', 'locket', '首飾り', 'ネックレス', 'ペンダント', 'ロケット'],
    'object:ring': ['반지', 'ring', '指輪', 'リング'],
    'object:letter': ['편지', 'letter', '手紙', '書簡'],
    'object:book': ['책', '책자', 'book', 'notebook', '本', 'ノート'],
    'object:phone': ['휴대폰', '핸드폰', '전화기', 'phone', 'mobile phone', 'smartphone', '携帯', '携帯電話', 'スマホ'],
    'object:box': ['상자', '함', 'box', 'case', '箱', 'ケース'],
    'object:door': ['문', 'door', '扉', 'ドア'],
    'color:gold': ['황금', '금색', 'gold', 'golden', '黄金', '金色'],
    'color:silver': ['은색', 'silver', '銀色'],
    'color:red': ['붉은', '빨간', 'red', 'crimson', '赤い', '紅い', '赤'],
    'color:blue': ['푸른', '파란', 'blue', '青い', '青'],
    'place:basement': ['지하', 'basement', 'underground', '地下'],
    'place:archive': ['기록실', '자료실', 'archive', 'records room', '記録室', '資料室', 'アーカイブ'],
    'place:study': ['서재', 'study', '書斎'],
    'place:tower': ['탑', 'tower', '塔'],
    'place:vault': ['금고', 'vault', 'safe', '金庫', '保管庫'],
    'place:desk': ['책상', 'desk', '机', 'デスク'],
    'place:wardrobe': ['옷장', '장롱', 'wardrobe', 'closet', '衣装棚', 'クローゼット', '箪笥'],
    'place:room': ['방', '방안', 'room', '室内', '部屋'],
    'place:school': ['학교', '교실', 'school', 'classroom', '学校', '教室'],
    'place:cafe': ['카페', '찻집', 'cafe', 'coffee shop', 'カフェ', '喫茶店'],
    'place:home': ['집', '자택', 'home', 'house', '家', '自宅'],
    'place:garden': ['정원', 'garden', '庭'],
    'place:station': ['역', '정거장', 'station', '駅'],
    'place:church': ['교회', 'church', '教会'],
    'position:on': ['위에', '놓여', '올려', 'on', 'placed on', 'sitting on', '上に', '置かれ', '載って'],
    'position:inside': ['안에', '속에', '봉인', 'inside', 'within', 'sealed in', '中に', '内側', '封じ', '封印'],
    'position:under': ['아래', '밑', '아래에', '밑에', 'under', 'below', 'beneath', '下', '下に', '机の下'],
    'position:near': ['근처', '옆', '가까이', 'near', 'beside', 'next to', 'そば', '近く', '隣'],
    'state:hidden': ['숨겨', '감춰', 'hidden', 'concealed', '隠れ', '隠し', '隠され'],
    'state:moved': ['옮겨', '이동', 'moved', 'relocated', '移動', '移された', '移した'],
    'state:confirmed': ['확인', '봤', '마지막으로 본', 'confirmed', 'saw', 'last seen', '確認', '見た', '最後に見た'],
    'info:location': ['위치', '어디', '장소', 'where', 'location', 'place', 'どこ', '何処', '場所', '位置'],
    'info:status': ['상태', '어떻게', 'status', 'state', 'condition', '状態', '様子', 'どうなった'],
    'info:memory': ['기억', '회상', 'memory', 'remember', 'recall', '記憶', '思い出す', '覚えている'],
    'info:secret': ['비밀', '숨긴 정보', 'secret', 'hidden knowledge', '秘密', '内緒', '隠し事'],
    'relation:friend': ['친구', 'friend', '友達', '親友'],
    'relation:sibling': ['남매', '오빠', '여동생', 'sibling', 'brother', 'sister', '兄妹', '兄', '妹', '姉', '弟'],
    'time:past': ['과거', '전에', '예전', 'past', 'before', 'previously', '過去', '以前', '昔', '前に'],
    'time:future': ['미래', '앞으로', '나중', 'future', 'later', '未来', 'これから', '後で'],
    'intent:ask_location': ['어디', '위치', 'where', 'location', 'どこ', '何処', '場所'],
    'intent:ask_state': ['상태', '어떻게 됐', 'status', 'state', 'what happened', '状態', 'どうなった', '何が起きた'],
    'intent:ask_memory': ['기억', '떠올', 'recall', 'remember', '記憶', '思い出す', '覚えている']
  });
  const CANONICAL_RECALL_TOKEN_RE = /^(?:object|color|place|position|relation|state|info|time|intent|emotion|world|narrative|story|locator):[a-z0-9_\-]+$/i;
  const CANONICAL_RECALL_TOKEN_PREFIX_RE = /^(?:object|color|place|position|relation|state|info|time|intent|emotion|entity|world|narrative|story|locator):/i;
  const MULTILINGUAL_ANCHOR_EXAMPLES = Object.freeze([
    'key / 열쇠 / 鍵 / object:key',
    'archive / 기록실 / 資料室 / place:archive',
    'under desk / 책상 아래 / 机の下 / position:under',
    'secret / 비밀 / 秘密 / info:secret'
  ]);
  const UNIVERSAL_CANONICAL_ANCHOR_PATCH_MARKER = 'universal_canonical_anchor_v1';
  const UNIVERSAL_CANONICAL_ANCHOR_EXAMPLES = Object.freeze([
    'object:necklace',
    'place:wardrobe',
    'state:hidden',
    'info:location',
    'relation:friend',
    'emotion:fear',
    'narrative:aftermath'
  ]);
  const CANONICAL_ANCHOR_FIELD_NAMES = Object.freeze([
    'canonicalAnchors', 'canonical_anchors', 'canonicalTokens', 'canonical_tokens',
    'recallAnchors', 'recall_anchors', 'relatedCanonicalAnchors', 'related_canonical_anchors'
  ]);

  const ENTITY_REJECT_WORDS = new Set([
    '그', '그녀', '그들', '누군가', '무언가', '이것', '저것', '상태', '감정', '공기', '분위기',
    '손', '눈', '입술', '어깨', '목소리', '시선', '생각', '기억', '장면', '세계', '규칙',
    'he', 'she', 'they', 'someone', 'something', 'state', 'emotion', 'air', 'mood',
    'hand', 'eyes', 'lips', 'voice', 'gaze', 'thought', 'memory', 'scene', 'world', 'rule',
    'character', 'person', 'entity', 'relation', 'relationship', 'people',
    '彼', '彼女', '彼ら', '誰か', '何か', 'これ', 'それ', 'あれ', '状態', '感情', '空気', '雰囲気',
    '手', '目', '瞳', '唇', '肩', '声', '視線', '考え', '思考', '記憶', '場面', '世界', '規則',
    'キャラクター', '人物', '人', '関係', '関係性'
  ]);

  const Memory = {
    settings: { ...DEFAULT_SETTINGS },
    store: null,
    lastBeforeRequest: null,
    lastWarnings: [],
    packetScanCache: new Map(),
    packetScanScopeKey: '',
    packetScanScopeConfident: false,
    packetScanStats: null,
    compatInfo: null,
    replacer: {
      permission: 'not_requested',
      registered: false,
      registerError: '',
      lastRunAt: 0,
      runCount: 0,
      lastError: '',
      handler: null
    }
  };

  const now = () => Date.now();
  const text = value => String(value == null ? '' : value);
  const clamp = (value, min = 0, max = 1, fallback = 0) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
  };
  const firstFinite = (values = [], fallback = 0) => {
    for (const value of ensureArray(values)) {
      const n = Number(value);
      if (Number.isFinite(n)) return n;
    }
    return fallback;
  };
  const firstExplicitFinite = (values = [], fallback = null) => {
    for (const value of ensureArray(values)) {
      if (value == null || value === '') continue;
      const n = Number(value);
      if (Number.isFinite(n)) return n;
    }
    return fallback;
  };
  const escHtml = value => text(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  const RisuCompat = (() => {
    const candidates = apiCandidates;
    const api = () => candidates()[0] || API || null;
    const host = name => candidates().find(candidate => typeof candidate?.[name] === 'function') || api();
    const storageHost = () => candidates().find(candidate => candidate?.pluginStorage) || api();
    const has = name => typeof host(name)?.[name] === 'function';
    const detectSync = (runtime = null) => {
      const current = api();
      return {
        plugin: PLUGIN_NAME,
        version: PLUGIN_VERSION,
        apiVersion: text(current?.apiVersion ?? runtime?.apiVersion ?? 'unknown') || 'unknown',
        platform: text(runtime?.platform ?? 'unknown') || 'unknown',
        saveMethod: text(runtime?.saveMethod ?? 'unknown') || 'unknown',
        hasPluginStorage: !!storageHost()?.pluginStorage,
        hasSafeLocalStorage: !!current?.safeLocalStorage,
        hasLocalPluginStorage: typeof current?.getLocalPluginStorage === 'function',
        hasNativeFetch: has('nativeFetch'),
        hasDatabase: has('getDatabase'),
        hasReplacer: has('addRisuReplacer'),
        hasRemoveReplacer: has('removeRisuReplacer'),
        hasPermissionApi: has('requestPluginPermission'),
        hasRuntimeInfo: has('getRuntimeInfo'),
        directLocalStorage: false
      };
    };
    const refreshInfo = async () => {
      const current = api();
      let runtime = null;
      try {
        if (typeof current?.getRuntimeInfo === 'function') runtime = await current.getRuntimeInfo();
      } catch (error) {
        runtime = { error: text(error?.message || error || 'runtime_info_failed') };
      }
      Memory.compatInfo = detectSync(runtime);
      return Memory.compatInfo;
    };
    const ensurePermission = async name => {
      const current = api();
      try {
        if (typeof current?.requestPluginPermission !== 'function') return null;
        return !!(await current.requestPluginPermission(name));
      } catch (_) {
        return false;
      }
    };
    const getArgument = async (key, fallback = '') => {
      const current = api();
      try {
        const fn = current?.getArgument || current?.getArg;
        if (typeof fn === 'function') {
          const value = await fn.call(current, key);
          if (value != null && value !== '') return text(value);
        }
      } catch (_) {}
      return text(fallback);
    };
    const removeStorageKey = async key => {
      try {
        const s = storageHost()?.pluginStorage;
        if (!s) return false;
        if (typeof s.removeItem === 'function') {
          await s.removeItem(key);
          return true;
        }
        if (typeof s.setItem === 'function') {
          await s.setItem(key, '');
          return true;
        }
      } catch (_) {}
      return false;
    };
    const addBeforeRequest = async handler => {
      await refreshInfo();
      const current = host('addRisuReplacer');
      if (typeof current?.addRisuReplacer !== 'function') {
        Memory.replacer.registered = false;
        Memory.replacer.registerError = 'addRisuReplacer_unavailable';
        return false;
      }
      const permission = await ensurePermission('replacer');
      Memory.replacer.permission = permission === null ? 'api_unavailable' : (permission ? 'granted' : 'denied');
      // Some RisuAI-compatible hosts do not expose requestPluginPermission; in that
      // case we preserve legacy behavior and attempt hook registration. An explicit
      // denial is respected and leaves HAYAKU fail-open.
      if (permission === false) {
        Memory.replacer.registered = false;
        Memory.replacer.registerError = 'permission_denied';
        return false;
      }
      const wrapped = async (messages = [], requestType = 'model') => {
        Memory.replacer.runCount += 1;
        Memory.replacer.lastRunAt = now();
        try {
          return await handler(messages, requestType);
        } catch (error) {
          Memory.replacer.lastError = text(error?.message || error || 'beforeRequest_failed');
          return messages;
        }
      };
      try {
        try {
          if (Memory.replacer.handler && typeof current.removeRisuReplacer === 'function') {
            await current.removeRisuReplacer('beforeRequest', Memory.replacer.handler);
          }
        } catch (_) {}
        await current.addRisuReplacer('beforeRequest', wrapped);
        Memory.replacer.handler = wrapped;
        Memory.replacer.registered = true;
        Memory.replacer.registerError = '';
        await refreshInfo();
        return true;
      } catch (error) {
        Memory.replacer.registered = false;
        Memory.replacer.registerError = text(error?.message || error || 'register_failed').slice(0, 240);
        return false;
      }
    };
    const removeBeforeRequest = async () => {
      try {
        const current = host('removeRisuReplacer');
        if (Memory.replacer.handler && typeof current?.removeRisuReplacer === 'function') {
          await current.removeRisuReplacer('beforeRequest', Memory.replacer.handler);
        }
      } catch (_) {}
      Memory.replacer.registered = false;
      Memory.replacer.handler = null;
    };
    const onUnload = async handler => {
      try {
        const current = host('onUnload');
        if (typeof current?.onUnload === 'function') {
          await current.onUnload(handler);
          return true;
        }
      } catch (_) {}
      return false;
    };
    const snapshot = () => ({
      ...(Memory.compatInfo || detectSync()),
      replacerPermission: Memory.replacer.permission,
      beforeRequestRegistered: Memory.replacer.registered === true,
      beforeRequestLastRunAt: Memory.replacer.lastRunAt || 0,
      beforeRequestRunCount: Memory.replacer.runCount || 0,
      replacerRegisterError: Memory.replacer.registerError || '',
      lastReplacerError: Memory.replacer.lastError || ''
    });
    return Object.freeze({ api, has, refreshInfo, snapshot, getArgument, removeStorageKey, addBeforeRequest, removeBeforeRequest, onUnload });
  })();

  const compact = (value = '', max = 240) => {
    const source = text(value).replace(/\s+/g, ' ').trim();
    const requested = Number(max);
    const limit = Number.isFinite(requested) ? Math.max(0, requested) : 240;
    if (limit <= 0) return '';
    if (source.length <= limit) return source;
    return `${source.slice(0, Math.max(1, limit - 1)).trim()}…`;
  };
  const clone = (value, fallback = null) => {
    try { return JSON.parse(JSON.stringify(value ?? fallback)); }
    catch (_) { return value ?? fallback; }
  };
  const safeJsonParse = (raw, fallback = null) => {
    try {
      if (raw == null || raw === '') return fallback;
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (_) {
      return fallback;
    }
  };
  const simpleHash = (value = '') => {
    const src = text(value);
    let hash = 2166136261;
    for (let i = 0; i < src.length; i += 1) {
      hash ^= src.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  };
  const stableHash64Fallback = (value = '') => {
    const src = text(value);
    let left = 2166136261;
    let right = 3266489917;
    for (let i = 0; i < src.length; i += 1) {
      const code = src.charCodeAt(i);
      left ^= code;
      left = Math.imul(left, 16777619);
      right ^= code + i + ((left >>> 7) & 0xffff);
      right = Math.imul(right, 2246822519);
      right ^= right >>> 13;
    }
    const leftPart = (left >>> 0).toString(36).padStart(7, '0');
    const rightPart = (right >>> 0).toString(36).padStart(7, '0');
    return `h64${leftPart}${rightPart}`;
  };
  const stableHash64 = (value = '') => {
    const src = text(value);
    if (typeof BigInt !== 'function') return stableHash64Fallback(src);
    try {
      let hash = BigInt('14695981039346656037');
      const prime = BigInt('1099511628211');
      const mask = BigInt('18446744073709551615');
      for (let i = 0; i < src.length; i += 1) {
        hash ^= BigInt(src.charCodeAt(i));
        hash = (hash * prime) & mask;
      }
      return `h64${hash.toString(36)}`;
    } catch (_) {
      return stableHash64Fallback(src);
    }
  };
  const normalizeKey = (value = '') => text(value)
    .toLowerCase()
    .replace(/[\s_\-'"`’‘“”!?.,:;()[\]{}<>\\/|。、，．！？「」『』（）［］【】《》〈〉・：；]+/g, '')
    .trim();
  const escapeRegExp = value => text(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const makeUnicodeRegExp = (pattern, flags = '') => {
    try { return new RegExp(pattern, flags); } catch (_) { return null; }
  };
  const UNICODE_WORD_CLEAN_RE = makeUnicodeRegExp('[^\\p{L}\\p{N}_\\-\\s]', 'gu');
  const UNICODE_NGRAM_CLEAN_RE = makeUnicodeRegExp('[^\\p{L}\\p{N}]+', 'gu');
  const UNICODE_NAME_RE = makeUnicodeRegExp('^[\\p{L}][\\p{L}\\p{N}_\\-\\s]{1,40}$', 'u');
  const SEARCH_WORD_CLEAN_FALLBACK_RE = /[^a-z0-9가-힣ぁ-んァ-ヶー一-龯々〆〤_\-\s]/g;
  const SEARCH_NGRAM_CLEAN_FALLBACK_RE = /[^a-z0-9가-힣ぁ-んァ-ヶー一-龯々〆〤]+/g;
  const JP_CHAR_RE = /[ぁ-んァ-ヶー一-龯々〆〤]/;
  const KO_JP_BLOCK_WORD_RE = /^[가-힣ぁ-んァ-ヶー一-龯々〆〤]{2,}$/;
  const cleanSearchText = value => text(value)
    .toLowerCase()
    .replace(UNICODE_WORD_CLEAN_RE || SEARCH_WORD_CLEAN_FALLBACK_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const cleanNgramText = value => text(value)
    .toLowerCase()
    .replace(UNICODE_NGRAM_CLEAN_RE || SEARCH_NGRAM_CLEAN_FALLBACK_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const hasJapaneseText = value => JP_CHAR_RE.test(text(value));
  const ensureArray = value => Array.isArray(value) ? value : (value == null ? [] : [value]);
  const PERFORMANCE_MODE_VALUES = Object.freeze(['fast', 'balanced', 'deep']);
  const normalizedPerformanceMode = (mode = '', fallback = 'balanced') => {
    const value = text(mode).trim().toLowerCase();
    return PERFORMANCE_MODE_VALUES.includes(value) ? value : fallback;
  };
  const effectivePerformanceModeOf = (settings = Memory.settings || DEFAULT_SETTINGS) => (
    normalizedPerformanceMode(settings?.effectiveMode || settings?.mode || DEFAULT_SETTINGS.mode, 'balanced')
  );
  const hasOwnProperty = (obj, key) => Boolean(obj && Object.prototype.hasOwnProperty.call(obj, key));
  const requestScopePrimitive = value => {
    if (value == null || typeof value === 'object') return '';
    const body = text(value).trim();
    if (!body || body === '[object Object]') return '';
    return compact(body, 260);
  };
  const requestScopeNestedId = (source, label = '') => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return [];
    const out = [];
    const push = (key, value) => {
      const body = requestScopePrimitive(value);
      if (body) out.push(`${label}.${key}:${body}`);
    };
    push('id', source.id);
    push('uuid', source.uuid);
    push('uid', source.uid);
    push('chatId', source.chatId);
    push('chat_id', source.chat_id);
    push('roomId', source.roomId);
    push('room_id', source.room_id);
    push('conversationId', source.conversationId);
    push('conversation_id', source.conversation_id);
    push('sessionId', source.sessionId);
    push('session_id', source.session_id);
    push('threadId', source.threadId);
    push('thread_id', source.thread_id);
    return out;
  };
  const requestScopeCandidatesFromMessage = msg => {
    if (!msg || typeof msg !== 'object') return [];
    const out = [];
    const push = (key, value) => {
      const body = requestScopePrimitive(value);
      if (body) out.push(`${key}:${body}`);
    };
    push('chatId', msg.chatId);
    push('chat_id', msg.chat_id);
    push('chatUUID', msg.chatUUID);
    push('chat_uuid', msg.chat_uuid);
    push('roomId', msg.roomId);
    push('room_id', msg.room_id);
    push('conversationId', msg.conversationId);
    push('conversation_id', msg.conversation_id);
    push('sessionId', msg.sessionId);
    push('session_id', msg.session_id);
    push('threadId', msg.threadId);
    push('thread_id', msg.thread_id);
    if (typeof msg.chat === 'string' || typeof msg.chat === 'number') push('chat', msg.chat);
    out.push(...requestScopeNestedId(msg.chat, 'chat'));
    out.push(...requestScopeNestedId(msg.room, 'room'));
    out.push(...requestScopeNestedId(msg.conversation, 'conversation'));
    out.push(...requestScopeNestedId(msg.session, 'session'));
    out.push(...requestScopeNestedId(msg.thread, 'thread'));
    out.push(...requestScopeNestedId(msg.metadata?.chat, 'metadata.chat'));
    out.push(...requestScopeNestedId(msg.meta?.chat, 'meta.chat'));
    return uniq(out, 32);
  };
  const requestScopeForMessages = (messages = [], requestType = '') => {
    const candidates = uniq(ensureArray(messages).flatMap(requestScopeCandidatesFromMessage), 48).sort();
    if (!candidates.length) {
      return {
        key: '',
        confident: false,
        reason: 'missing_stable_chat_scope',
        requestType: text(requestType || '')
      };
    }
    const fingerprint = candidates.join('\n');
    return {
      key: `scope_${stableHash64(fingerprint)}`,
      confident: true,
      reason: 'stable_chat_scope',
      requestType: text(requestType || ''),
      hints: candidates.slice(0, 6).map(value => compact(value, 80))
    };
  };
  const roleFromUserFlag = value => {
    if (value?.is_user === true || value?.isUser === true) return 'user';
    if (value?.is_user === false || value?.isUser === false) return 'assistant';
    return '';
  };
  const roleHintOf = value => text(value?.role).trim() || roleFromUserFlag(value);
  const payloadRoleOf = value => {
    const role = text(roleHintOf(value)).trim().toLowerCase();
    return /^(?:char|character|ai|bot)$/.test(role) ? 'assistant' : role;
  };
  const nestedPayloadMessageAllowed = (message = {}, options = {}) => {
    const role = payloadRoleOf(message);
    if (!role) return options.requireRole !== true;
    const ownerRole = payloadRoleOf({ role: options.ownerRole || '' });
    if (/user|human/i.test(ownerRole)) return /user|human/i.test(role);
    if (/system/i.test(ownerRole)) return /system/i.test(role);
    return /^(?:assistant|model)$/i.test(role);
  };
  const PAYLOAD_TEXT_KEYS = ['content', 'text', 'message', 'parts', 'messages', 'output', 'output_text', 'outputText', 'choices', 'delta'];
  const payloadWrapperNameIsTypeHint = value => (
    value && typeof value === 'object' && !Array.isArray(value)
    && !payloadRoleOf(value)
    && PAYLOAD_TEXT_KEYS.some(key => hasOwnProperty(value, key))
  );
  const payloadTypeHints = value => [
    value?.type,
    value?.kind,
    value?.object,
    value?.category,
    payloadWrapperNameIsTypeHint(value) ? value?.name : ''
  ].map(item => text(item).trim()).filter(Boolean);
  const PROVENANCE_HINT_KEYS = [
    'source', 'source_type', 'sourceType', 'source_name', 'sourceName',
    'origin', 'origin_type', 'originType', 'subtype', 'channel', 'recipient', 'target',
    'event', 'event_type', 'eventType', 'response_type', 'responseType',
    'tool_name', 'toolName', 'tool', 'provider', 'label'
  ];
  const PROVENANCE_DESCRIPTOR_KEYS = [
    'type', 'kind', 'object', 'category', 'name', 'label', 'metadata',
    ...PROVENANCE_HINT_KEYS
  ];
  const provenanceHintValues = (value, depth = 0) => {
    if (value == null) return [];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return [value];
    if (depth >= 3 || typeof value !== 'object') return [];
    if (Array.isArray(value)) return value.flatMap(item => provenanceHintValues(item, depth + 1));
    return PROVENANCE_DESCRIPTOR_KEYS.flatMap(key => provenanceHintValues(value[key], depth + 1));
  };
  const payloadProvenanceHints = value => [
    ...PROVENANCE_HINT_KEYS.flatMap(key => provenanceHintValues(value?.[key])),
    ...provenanceHintValues(value?.metadata)
  ].map(item => text(item).trim()).filter(Boolean);
  const outputPayloadType = value => payloadTypeHints(value)[0] || '';
  const normalizedPayloadType = value => text(value).trim().toLowerCase();
  const PAYLOAD_TOOL_CALL_KEYS = [
    'tool_call_id', 'toolCallId', 'tool_callId',
    'function_call_id', 'functionCallId', 'function_callId',
    'tool_use_id', 'toolUseId', 'tool_useId',
    'call_id', 'callId', 'invocation_id', 'invocationId',
    'tool_calls', 'toolCalls', 'tool_outputs', 'toolOutputs',
    'function_call', 'functionCall', 'function_calls', 'functionCalls',
    'function_result', 'functionResult'
  ];
  const payloadHasToolCallKey = value => (
    value && typeof value === 'object' && !Array.isArray(value)
    && PAYLOAD_TOOL_CALL_KEYS.some(key => hasOwnProperty(value, key) || hasOwnProperty(value?.metadata, key))
  );
  const payloadTypeTokens = value => text(value)
    .trim()
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const neutralPayloadType = value => {
    if (/^(?:text|input_text|output_text|message|content|part|parts|segment|segments|delta)$/.test(normalizedPayloadType(value))) return true;
    const tokenPhrase = payloadTypeTokens(value).join('_');
    return /^(?:input_text|output_text|message_content|content_part|text_segment|delta_text)$/.test(tokenPhrase);
  };
  const blockedPayloadType = value => {
    const tokens = payloadTypeTokens(value);
    if (tokens.some(token => /^(?:tool|tools|toolcall|toolcalls|function|functions|functioncall|functioncalls|call|calls|reasoning)$/.test(token))) return true;
    if (tokens.length === 1 && /^(?:citation|citations|annotation|annotations)$/.test(tokens[0])) return true;
    if (tokens.length === 2 && /^(?:url|uri|link|file|web|webpage|search|document|documents|page|pages|browser|tool|mcp|computer|filesystem|fs)$/.test(tokens[0]) && /^(?:citation|citations|annotation|annotations)$/.test(tokens[1])) return true;
    if (tokens.length === 3 && /^(?:web|file)$/.test(tokens[0]) && tokens[1] === 'search' && /^(?:citation|citations|annotation|annotations)$/.test(tokens[2])) return true;
    if (tokens.length === 2 && tokens[0] === 'search' && /^(?:result|results|output|outputs|response|responses)$/.test(tokens[1])) return true;
    if (tokens.length === 2 && tokens[0] === 'search' && /^(?:payload|payloads|content|contents|text|texts)$/.test(tokens[1])) return true;
    if (tokens.length === 3 && tokens[0] === 'search' && tokens[1] === 'result' && /^(?:payload|payloads|content|contents|text|texts)$/.test(tokens[2])) return true;
    if (tokens.length === 3 && tokens[0] === 'search' && tokens[1] === 'result' && /^(?:item|items)$/.test(tokens[2])) return true;
    if (tokens.length === 3 && tokens[0] === 'search' && tokens[1] === 'result' && /^(?:entry|entries|record|records)$/.test(tokens[2])) return true;
    if (tokens.length === 2 && tokens[0] === 'search' && /^(?:hit|hits|snippet|snippets|record|records)$/.test(tokens[1])) return true;
    if (tokens.length === 2 && tokens[0] === 'search' && /^(?:entry|entries|item|items|source|sources|document|documents)$/.test(tokens[1])) return true;
    if (tokens.length === 3 && tokens[0] === 'search' && /^(?:hit|hits|snippet|snippets|record|records)$/.test(tokens[1]) && /^(?:item|items)$/.test(tokens[2])) return true;
    if (tokens.length === 4 && tokens[0] === 'search' && tokens[1] === 'result' && /^(?:entry|entries|record|records)$/.test(tokens[2]) && /^(?:item|items)$/.test(tokens[3])) return true;
    const tokenPhrase = ` ${tokens.join(' ')} `;
    const hasToolDomain = / (?:web search|webpage|file search|file system|filesystem|fs|code interpreter|computer|mcp|browser) /.test(tokenPhrase);
    const hasToolAction = tokens.some(token => /^(?:result|results|output|outputs|response|responses|use|uses|used|call|calls|called|payload|payloads|content|contents|text|texts|body|bodies|page|pages|document|documents|snippet|snippets|citation|citations|annotation|annotations)$/.test(token));
    return hasToolDomain && hasToolAction;
  };
  const blockedPayloadProvenanceType = value => {
    if (blockedPayloadType(value)) return true;
    const tokens = payloadTypeTokens(value);
    const tokenPhrase = ` ${tokens.join(' ')} `;
    return / (?:web search|webpage|file search|file system|filesystem|fs|code interpreter|computer|mcp|browser) /.test(tokenPhrase);
  };
  const semanticPayloadType = value => {
    const hints = payloadTypeHints(value);
    return hints.some(hint => !neutralPayloadType(hint) && !blockedPayloadType(hint));
  };
  const blockedPayloadWrapperType = value => {
    if (payloadTypeHints(value).some(blockedPayloadType)) return true;
    if (semanticPayloadType(value)) return false;
    return payloadHasToolCallKey(value) || payloadProvenanceHints(value).some(blockedPayloadProvenanceType);
  };
  const outputPayloadItemAllowed = value => {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) return true;
    const type = normalizedPayloadType(outputPayloadType(value));
    if (blockedPayloadWrapperType(value)) return false;
    if (payloadRoleOf(value)) return true;
    return /^(?:message|output_text|text|input_text)$/.test(type);
  };
  const choicePayloadFinishReason = value => text(value?.finish_reason || value?.finishReason || '').trim().toLowerCase();
  const choicePayloadIndexAllowed = value => {
    if (!hasOwnProperty(value, 'index')) return true;
    const raw = text(value?.index).trim();
    if (!raw) return true;
    const index = Number(raw);
    return Number.isFinite(index) ? index === 0 : raw === '0';
  };
  const choicePayloadItemAllowed = value => {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) return true;
    if (blockedPayloadType(choicePayloadFinishReason(value))) return false;
    if (!choicePayloadIndexAllowed(value)) return false;
    const nested = hasOwnProperty(value, 'message')
      ? value.message
      : hasOwnProperty(value, 'delta') ? value.delta : null;
    if (nested && typeof nested === 'object') {
      return /^(?:assistant|model)$/i.test(payloadRoleOf(nested));
    }
    const role = payloadRoleOf(value);
    if (role) return /^(?:assistant|model)$/i.test(role);
    return hasOwnProperty(value, 'text');
  };
  const payloadTextParts = (value, seen = new WeakSet(), options = {}) => {
    if (value == null) return [];
    if (typeof value === 'string') return [value];
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return [String(value)];
    if (typeof value !== 'object') return [];
    if (seen.has(value)) return [];
    seen.add(value);
    if (blockedPayloadWrapperType(value)) {
      seen.delete(value);
      return [];
    }
    const selfRole = payloadRoleOf(value);
    if (options.filterSelfRole && (selfRole || options.requireRole) && !nestedPayloadMessageAllowed(value, options)) {
      seen.delete(value);
      return [];
    }
    const out = [];
    const pushPayloadChild = (child, childOptions = {}) => {
      const childRole = child && typeof child === 'object' ? payloadRoleOf(child) : '';
      const mergedOptions = { ...options, ...childOptions };
      if (blockedPayloadWrapperType(child)) return;
      if (mergedOptions.outputPayload && !outputPayloadItemAllowed(child)) return;
      if (mergedOptions.choicePayload && !choicePayloadItemAllowed(child)) return;
      if ((childRole || mergedOptions.requireRole) && !nestedPayloadMessageAllowed(child, mergedOptions)) return;
      out.push(...payloadTextParts(child, seen, {
        ...mergedOptions,
        ownerRole: childRole || mergedOptions.ownerRole,
        filterSelfRole: false,
        requireRole: false
      }));
    };
    if (Array.isArray(value)) {
      for (const item of value) pushPayloadChild(item);
      seen.delete(value);
      return out;
    }
    for (const key of PAYLOAD_TEXT_KEYS) {
      if (!hasOwnProperty(value, key)) continue;
      if (key === 'messages') {
        for (const item of ensureArray(value[key])) {
          pushPayloadChild(item, { requireRole: true });
        }
        continue;
      }
      if (key === 'choices') {
        for (const item of ensureArray(value[key])) {
          pushPayloadChild(item, { choicePayload: true });
        }
        continue;
      }
      if (key === 'output') {
        for (const item of ensureArray(value[key])) {
          pushPayloadChild(item, { outputPayload: true });
        }
        continue;
      }
      pushPayloadChild(value[key]);
    }
    seen.delete(value);
    return out;
  };
  const payloadText = (value, options = {}) => payloadTextParts(value, new WeakSet(), { ...options, filterSelfRole: true }).join('\n');
  const payloadHasText = (value, options = {}) => value != null && payloadText(value, options).trim() !== '';
  const dataPayloadText = (data, options = {}) => {
    if (typeof data === 'string') return data;
    if (!data || typeof data !== 'object') return '';
    return payloadText(data, options);
  };
  const rawMessagePayloadCandidates = msg => {
    if (!msg || typeof msg !== 'object') return [];
    const ownerRole = payloadRoleOf(msg);
    return uniq([
      payloadText(msg.content, { ownerRole }),
      payloadText(msg.text, { ownerRole }),
      payloadText(msg.message, { ownerRole }),
      payloadText(msg.output, { ownerRole, outputPayload: true }),
      payloadText(msg.output_text, { ownerRole }),
      payloadText(msg.outputText, { ownerRole }),
      payloadText(msg.choices, { ownerRole, choicePayload: true }),
      dataPayloadText(msg.data, { ownerRole })
    ].filter(value => payloadHasText(value)), 8);
  };
  const rawMessagePayload = msg => {
    const candidates = rawMessagePayloadCandidates(msg);
    return candidates[0] ?? '';
  };
  const syncDataPayload = (data, body = '') => {
    if (typeof data === 'string' || data == null) return body;
    if (typeof data !== 'object') return body;
    if (hasOwnProperty(data, 'content') || !hasOwnProperty(data, 'text')) return { ...data, content: body };
    return { ...data, text: body };
  };
  const withMessagePayload = (msg = {}, body = '') => {
    const out = { ...msg };
    const hasContentLike = hasOwnProperty(out, 'content') || hasOwnProperty(out, 'text') || hasOwnProperty(out, 'message');
    if (hasOwnProperty(out, 'data')) out.data = syncDataPayload(out.data, body);
    if (hasOwnProperty(out, 'content')) {
      out.content = body;
      return out;
    }
    if (hasOwnProperty(out, 'text')) {
      out.text = body;
      return out;
    }
    if (hasOwnProperty(out, 'message')) {
      out.message = body;
      return out;
    }
    if (!hasContentLike && !hasOwnProperty(out, 'data')) out.content = body;
    return out;
  };
  const uniq = (items = [], limit = 128) => {
    const out = [];
    const seen = new Set();
    for (const raw of ensureArray(items).flat()) {
      const value = text(raw).trim();
      const key = normalizeKey(value);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(value);
      if (out.length >= limit) break;
    }
    return out;
  };
  const mergeValues = (values = [], limit = 128) => uniq(ensureArray(values).flatMap(value => ensureArray(value)), limit);
  const tokenize = (value = '', limit = 160) => {
    const cleaned = cleanSearchText(value);
    if (!cleaned) return [];
    const basic = cleaned.split(/\s+/).map(s => s.trim()).filter(s => s.length >= 2);
    const scriptGrams = [];
    cleaned.split(/\s+/).forEach(part => {
      if (KO_JP_BLOCK_WORD_RE.test(part)) {
        const maxGram = hasJapaneseText(part) ? 4 : 3;
        for (let n = 2; n <= maxGram; n += 1) {
          for (let i = 0; i <= part.length - n; i += 1) scriptGrams.push(part.slice(i, i + n));
        }
      }
    });
    return uniq([...basic, ...scriptGrams], limit);
  };
  const tokenSetHasAny = (value = '', tokenSet = new Set(), limit = 120) => tokenize(value, limit)
    .some(token => tokenSet.has(text(token).toLowerCase()) || tokenSet.has(normalizeKey(token)));
  const narrativeActionText = value => tokenSetHasAny(value, SELECT_NARRATIVE_ACTION_WORDS) || SELECT_NARRATIVE_ACTION_RE.test(text(value));
  const continuityPressureText = value => tokenSetHasAny(value, SELECT_CONTINUITY_PRESSURE_WORDS) || SELECT_CONTINUITY_PRESSURE_RE.test(text(value));
  const jaccard = (a = [], b = []) => {
    const left = new Set(ensureArray(a).filter(Boolean));
    const right = new Set(ensureArray(b).filter(Boolean));
    if (!left.size || !right.size) return 0;
    let inter = 0;
    left.forEach(item => { if (right.has(item)) inter += 1; });
    const union = left.size + right.size - inter;
    return union > 0 ? inter / union : 0;
  };
  const lexicalStats = (queryTokens = [], textTokens = []) => {
    const left = new Set(ensureArray(queryTokens).filter(Boolean));
    const right = new Set(ensureArray(textTokens).filter(Boolean));
    if (!left.size || !right.size) {
      return { jaccard: 0, overlap: 0, querySize: left.size, textSize: right.size, coverage: 0, density: 0 };
    }
    let overlap = 0;
    left.forEach(token => { if (right.has(token)) overlap += 1; });
    const union = left.size + right.size - overlap;
    return {
      jaccard: union > 0 ? overlap / union : 0,
      overlap,
      querySize: left.size,
      textSize: right.size,
      coverage: left.size > 0 ? overlap / left.size : 0,
      density: right.size > 0 ? overlap / right.size : 0
    };
  };
  const bigramTokens = (tokens = [], limit = 200) => {
    const arr = ensureArray(tokens).map(token => normalizeKey(token)).filter(Boolean);
    if (arr.length < 2) return [];
    const out = [];
    for (let i = 0; i < arr.length - 1; i += 1) out.push(`${arr[i]}\u0002${arr[i + 1]}`);
    return uniq(out, limit);
  };
  const extractTags = (sourceText = '', registry = {}) => {
    const body = text(sourceText).toLowerCase();
    const out = [];
    for (const [tag, words] of Object.entries(registry)) {
      if (ensureArray(words).some(word => body.includes(text(word).toLowerCase()))) out.push(tag);
    }
    return out;
  };
  const charNgramTokens = (value = '', limit = 220) => {
    const cleaned = cleanNgramText(value);
    const grams = [];
    cleaned.split(/\s+/).forEach(part => {
      if (part.length < 2) return;
      const min = part.length <= 3 ? 2 : 3;
      const max = Math.min(4, part.length);
      for (let n = min; n <= max; n += 1) {
        for (let i = 0; i <= part.length - n; i += 1) grams.push(part.slice(i, i + n));
      }
    });
    return uniq(grams, limit);
  };
  const NGRAM_CACHE_LIMIT = 4000;
  const ngramCache = new Map();
  const clearNgramCache = () => {
    try { ngramCache.clear(); } catch (_) {}
  };
  const charNgramTokensCached = (value = '', limit = 220) => {
    const body = text(value);
    const key = `${Number(limit) || 0}:${body}`;
    const cached = ngramCache.get(key);
    if (cached) return cached;
    const result = charNgramTokens(body, limit);
    if (ngramCache.size >= NGRAM_CACHE_LIMIT) {
      const firstKey = ngramCache.keys().next().value;
      if (firstKey != null) ngramCache.delete(firstKey);
    }
    ngramCache.set(key, result);
    return result;
  };
  const conceptTokensForText = value => {
    const body = text(value);
    return uniq([
      ...extractTags(body, EMOTION_TAGS).map(tag => `emotion:${tag}`),
      ...extractTags(body, RELATION_SIGNAL_TAGS).map(tag => `relation:${tag}`),
      ...extractTags(body, ENTITY_BRANCHES).map(tag => `entity:${tag}`),
      ...extractTags(body, WORLD_SIGNALS).map(tag => `world:${tag}`),
      ...extractTags(body, NARRATIVE_TAGS).map(tag => `narrative:${tag}`),
      ...extractTags(body, STORY_LEDGER_HINTS).map(tag => `story:${tag}`),
      ...extractTags(body, TIME_SIGNAL_TAGS).map(tag => `time:${tag}`),
      ...extractTags(body, LOCATOR_HINT_TAGS).map(tag => `locator:${tag}`),
      ...crossLingualTokensForText(body)
    ], 128);
  };
  const conceptTokensForRetrieval = retrieval => uniq([
    ...ensureArray(retrieval?.emotionTags).map(tag => `emotion:${tag}`),
    ...ensureArray(retrieval?.relationTags).map(tag => `relation:${tag}`),
    ...ensureArray(retrieval?.branchTags).map(tag => `entity:${tag}`),
    ...ensureArray(retrieval?.worldTags).map(tag => `world:${tag}`),
    ...ensureArray(retrieval?.narrativeTags).map(tag => `narrative:${tag}`),
    ...ensureArray(retrieval?.storyTags).map(tag => `story:${tag}`),
    ...ensureArray(retrieval?.timeTags).map(tag => `time:${tag}`),
    ...ensureArray(retrieval?.locatorHintTags).map(tag => `locator:${tag}`),
    ...ensureArray(retrieval?.crossLingualTokens),
    ...ensureArray(retrieval?.canonicalAnchors)
  ], 128);
  const crossLingualTokensForText = value => {
    const body = text(value).toLowerCase();
    const out = [];
    for (const [token, phrases] of Object.entries(CROSS_LINGUAL_LEXICON)) {
      const tokenLower = token.toLowerCase();
      if (body.includes(tokenLower) || ensureArray(phrases).some(phrase => body.includes(text(phrase).toLowerCase()))) out.push(token);
    }
    const explicitCanonicalTokens = (text(value).match(/(?:object|color|place|position|relation|state|info|time|intent|emotion|entity|world|narrative|story|locator):[a-z0-9_\-]+/gi) || [])
      .filter(token => CANONICAL_RECALL_TOKEN_PREFIX_RE.test(token));
    return uniq([...out, ...explicitCanonicalTokens], 128);
  };
  const canonicalRecallTokensForText = value => uniq(crossLingualTokensForText(value)
    .filter(token => CANONICAL_RECALL_TOKEN_PREFIX_RE.test(token)), 128);
  const canonicalRecallFieldValues = value => {
    if (value == null) return [];
    if (Array.isArray(value)) return value.flatMap(canonicalRecallFieldValues);
    if (!objectish(value)) return [value];
    const direct = [];
    for (const key of CANONICAL_ANCHOR_FIELD_NAMES) {
      if (Object.prototype.hasOwnProperty.call(value, key)) direct.push(value[key]);
    }
    return direct.flatMap(canonicalRecallFieldValues);
  };
  const canonicalRecallTokensForValue = value => uniq([
    ...canonicalRecallTokensForText(canonicalRecallFieldValues(value).join(' ')),
    ...canonicalRecallTokensForText(itemText(value))
  ], 128);
  const semanticFrameTokensForText = (value, precomputedConcepts = null) => {
    const body = text(value).toLowerCase();
    const out = [];
    for (const [token, phrases] of Object.entries(SEMANTIC_FRAME_MAP)) {
      if (ensureArray(phrases).some(phrase => body.includes(text(phrase).toLowerCase()))) out.push(token);
    }
    const concepts = ensureArray(precomputedConcepts).length ? ensureArray(precomputedConcepts) : conceptTokensForText(value);
    if (concepts.includes('relation:trustDown')) out.push('relation:distrust');
    if (concepts.includes('entity:fear')) out.push('psychology:withdrawal');
    if (concepts.includes('entity:wound')) out.push('psychology:collapse');
    if (concepts.includes('story:consequence')) out.push('narrative:aftermath');
    if (concepts.includes('world:pressure')) out.push('world:reaction_chain');
    return uniq(out, 128);
  };
  const tokenWeight = token => {
    const raw = text(token);
    const key = normalizeKey(raw);
    if (!key) return 0;
    let weight = 1;
    if (/^(locator|ref|turn|hayaku|entity|world|narrative|planner)[:_\-/]/i.test(raw) || /^(locator|ref|turn|hayaku)/i.test(raw)) weight += 0.42;
    if (CANONICAL_RECALL_TOKEN_PREFIX_RE.test(raw)) weight += 0.46;
    else if (/^(emotion|relation|entity|world|narrative|story|time|locator):/i.test(raw)) weight += 0.30;
    if (key.length >= 5) weight += 0.16;
    if (/^[가-힣A-Za-zぁ-んァ-ヶー一-龯々〆〤][가-힣A-Za-z0-9ぁ-んァ-ヶー一-龯々〆〤_\-]{1,24}$/.test(raw) && !/^(state|status|current|recent)$/i.test(raw)) weight += 0.10;
    return clamp(weight, 0.7, 1.85, 1);
  };
  const weightedJaccard = (leftTokens = [], rightTokens = []) => {
    const left = new Map();
    const right = new Map();
    ensureArray(leftTokens).forEach(token => {
      const key = normalizeKey(token);
      if (key) left.set(key, Math.max(left.get(key) || 0, tokenWeight(token)));
    });
    ensureArray(rightTokens).forEach(token => {
      const key = normalizeKey(token);
      if (key) right.set(key, Math.max(right.get(key) || 0, tokenWeight(token)));
    });
    if (!left.size || !right.size) return { jaccard: 0, coverage: 0, overlap: 0, overlapWeight: 0 };
    let overlap = 0;
    let overlapWeight = 0;
    let leftWeight = 0;
    let rightWeight = 0;
    left.forEach(weight => { leftWeight += weight; });
    right.forEach(weight => { rightWeight += weight; });
    left.forEach((leftW, key) => {
      if (!right.has(key)) return;
      overlap += 1;
      overlapWeight += Math.min(leftW, right.get(key));
    });
    const unionWeight = leftWeight + rightWeight - overlapWeight;
    return {
      jaccard: unionWeight > 0 ? overlapWeight / unionWeight : 0,
      coverage: leftWeight > 0 ? overlapWeight / leftWeight : 0,
      overlap,
      overlapWeight
    };
  };
  const KR_VERB_TAIL_RE = /(다|고|은|는|며|려|러|자|지|데|게|기|다가|았|었|였|습니다|습니까|요|죠|군요|네요|한다|된다|인다)$/u;
  const JP_CONJ_TAIL_RE = /(ました|ません|ます|ない|たり|って|て|た|く|む|り|です|だ|に|で|を|よ|ね|な)$/u;
  const stemToken = value => {
    const raw = normalizeKey(value);
    if (!raw || raw.length < 3) return raw || '';
    const kr = raw.replace(KR_VERB_TAIL_RE, '').trim();
    if (kr && kr.length >= 2 && kr !== raw) return kr;
    const jp = raw.replace(JP_CONJ_TAIL_RE, '').trim();
    if (jp && jp.length >= 2 && jp !== raw) return jp;
    return raw;
  };
  const TOKEN_SIMILARITY_CACHE_LIMIT = 10000;
  const tokenSimilarityCache = new Map();
  const clearTokenSimilarityCache = () => { try { tokenSimilarityCache.clear(); } catch (_) {} };
  const getTokenSimilarityCache = key => {
    if (!tokenSimilarityCache.has(key)) return undefined;
    const value = tokenSimilarityCache.get(key);
    tokenSimilarityCache.delete(key);
    tokenSimilarityCache.set(key, value);
    return value;
  };
  const setTokenSimilarityCache = (key, value) => {
    if (tokenSimilarityCache.has(key)) tokenSimilarityCache.delete(key);
    tokenSimilarityCache.set(key, value);
    while (tokenSimilarityCache.size > TOKEN_SIMILARITY_CACHE_LIMIT) {
      const oldestKey = tokenSimilarityCache.keys().next().value;
      if (oldestKey == null) break;
      tokenSimilarityCache.delete(oldestKey);
    }
  };
  const tokenSimilarity = (a, b) => {
    const left = normalizeKey(a);
    const right = normalizeKey(b);
    if (!left || !right) return 0;
    if (left === right) return 1;
    const cacheKey = left < right ? `${left}\u0001${right}` : `${right}\u0001${left}`;
    const cached = getTokenSimilarityCache(cacheKey);
    if (cached !== undefined) return cached;
    let result = 0;
    if ((left.length >= 4 && right.includes(left)) || (right.length >= 4 && left.includes(right))) {
      result = JACCARD_TUNING.substringSimilarity;
    } else {
      const stemL = stemToken(left);
      const stemR = stemToken(right);
      if (stemL && stemR && stemL.length >= 3 && stemR.length >= 3 && stemL === stemR) {
        result = JACCARD_TUNING.stemMatchSimilarity;
      } else {
        const grams = lexicalStats(charNgramTokensCached(left, 40), charNgramTokensCached(right, 40));
        result = grams.jaccard >= JACCARD_TUNING.ngramMatchFloor
          ? clamp(grams.jaccard * JACCARD_TUNING.ngramMatchScale, 0, JACCARD_TUNING.ngramMatchCap, 0)
          : 0;
      }
    }
    setTokenSimilarityCache(cacheKey, result);
    return result;
  };
  const softWeightedJaccard = (leftTokens = [], rightTokens = []) => {
    const left = uniq(leftTokens, 160);
    const right = uniq(rightTokens, 240);
    if (!left.length || !right.length) return { jaccard: 0, coverage: 0, overlap: 0, soft: true };
    let leftWeight = 0;
    let rightWeight = 0;
    let overlapWeight = 0;
    let overlap = 0;
    const used = new Set();
    left.forEach(leftToken => {
      const lw = tokenWeight(leftToken);
      leftWeight += lw;
      let best = { index: -1, sim: 0, weight: 0 };
      right.forEach((rightToken, index) => {
        if (used.has(index)) return;
        const sim = tokenSimilarity(leftToken, rightToken);
        if (sim > best.sim) best = { index, sim, weight: tokenWeight(rightToken) };
      });
      if (best.index >= 0 && best.sim >= JACCARD_TUNING.fuzzyMatchThreshold) {
        used.add(best.index);
        overlap += 1;
        overlapWeight += Math.min(lw, best.weight) * best.sim;
      }
    });
    right.forEach(token => { rightWeight += tokenWeight(token); });
    const unionWeight = leftWeight + rightWeight - overlapWeight;
    return {
      jaccard: unionWeight > 0 ? overlapWeight / unionWeight : 0,
      coverage: leftWeight > 0 ? overlapWeight / leftWeight : 0,
      overlap,
      overlapWeight,
      soft: true
    };
  };
  const bm25Score = (queryTokens = [], docTokens = [], docFreq = new Map(), docCount = 1, avgDocLen = 1) => {
    const query = uniq(queryTokens, 80);
    const doc = ensureArray(docTokens).map(token => normalizeKey(token)).filter(Boolean);
    if (!query.length || !doc.length) return 0;
    const tf = new Map();
    doc.forEach(token => tf.set(token, (tf.get(token) || 0) + 1));
    const k1 = 1.2;
    const b = 0.75;
    const dl = doc.length;
    const avg = Math.max(1, Number(avgDocLen || 1));
    let raw = 0;
    let maxRaw = 0;
    query.forEach(token => {
      const key = normalizeKey(token);
      const freq = tf.get(key) || 0;
      const df = Math.max(0, Number(docFreq.get(key) || 0));
      const idf = Math.log(1 + ((Math.max(1, docCount) - df + 0.5) / (df + 0.5)));
      const denom = freq + k1 * (1 - b + b * (dl / avg));
      if (freq > 0) raw += idf * ((freq * (k1 + 1)) / Math.max(0.0001, denom));
      maxRaw += idf * (k1 + 1);
    });
    return clamp(maxRaw > 0 ? raw / maxRaw : 0, 0, 1, 0);
  };
  const bm25DocumentTokens = (value = '', limit = 180) => {
    const cleaned = cleanSearchText(value);
    if (!cleaned) return [];
    const out = [];
    cleaned.split(/\s+/).forEach(part => {
      const token = part.trim();
      if (token.length >= 2) out.push(token);
      if (KO_JP_BLOCK_WORD_RE.test(token)) {
        const maxGram = hasJapaneseText(token) ? 4 : 3;
        for (let n = 2; n <= maxGram; n += 1) {
          for (let i = 0; i <= token.length - n; i += 1) out.push(token.slice(i, i + n));
        }
      }
    });
    return out.slice(0, Math.max(0, Number(limit) || 180));
  };
  const stripKoreanParticles = value => text(value)
    .replace(/(께서는|에서는|에게서|으로서|으로써|에게|에서|부터|까지|처럼|보다|하고|에게는|한테|로서|로써|으로|로|은|는|이|가|을|를|와|과|랑|도|만|의)$/u, '')
    .trim();
  const stripJapaneseParticles = value => text(value)
    .replace(/(について|として|から|まで|より|では|には|へは|とは|って|なら|だけ|ほど|くらい|ぐらい|は|が|を|に|へ|と|で|の|も|や|か|ね|よ)$/u, '')
    .trim();
  const stripKnownParticles = value => stripJapaneseParticles(stripKoreanParticles(value));
  const normalizedSurface = value => normalizeKey(stripKnownParticles(value));
  const isSpecificConceptToken = token => RETRIEVAL_SPECIFIC_CONCEPT_RE.test(text(token));
  const isSpecificFrameToken = token => RETRIEVAL_SPECIFIC_FRAME_RE.test(text(token));
  const surfaceSpecificTokensOf = value => {
    const cleaned = cleanSearchText(value)
      .replace(RETRIEVAL_SURFACE_CLEAN_RE, ' ')
      .replace(RETRIEVAL_SURFACE_SPACE_RE, ' ')
      .trim();
    if (!cleaned) return [];
    return uniq(cleaned
      .split(/\s+/)
      .map(token => normalizedSurface(token))
      .filter(token => token.length >= 2 && !RETRIEVAL_SURFACE_STOP_RE.test(token)), 32);
  };
  const relationEndpointsOf = value => {
    if (!objectish(value)) return [];
    return uniq([
      value.from, value.to, value.entityA, value.entityB, value.source, value.target,
      value.name, value.relation_to_user, value.relationship_to_user
    ], 16);
  };
  const profileFieldText = value => {
    if (value == null) return '';
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return text(value).trim();
    if (Array.isArray(value)) return value.map(profileFieldText).filter(Boolean).join(', ');
    if (typeof value === 'object') {
      const timed = [
        ['past', value.past || value.before || value.history],
        ['present', value.present || value.current || value.now],
        ['future', value.future || value.tendency || value.direction || value.later]
      ]
        .map(([label, body]) => [label, profileFieldText(body)])
        .filter(([, body]) => body)
        .map(([label, body]) => `${label}: ${body}`);
      if (timed.length) return timed.join(' / ');
      return Object.entries(value)
        .filter(([key]) => !/^[_$]/.test(key))
        .map(([key, body]) => [key, profileFieldText(body)])
        .filter(([, body]) => body)
        .map(([key, body]) => `${key}: ${body}`)
        .join(' / ');
    }
    return text(value).trim();
  };
  const legacyPacketExtraTextValues = value => {
    if (!objectish(value)) return [];
    return Object.entries(value)
      .filter(([key]) => /^(?:impression[_-]|knowledge[_-]?boundary|knowledgeBoundary)/i.test(key))
      .flatMap(([, raw]) => ensureArray(raw))
      .map(raw => profileFieldText(raw) || text(raw))
      .filter(Boolean);
  };
  const surfaceTermsOf = value => {
    if (!objectish(value)) return uniq([value], 24);
    return uniq([
      value.name, value.title, value.label, value.summary, value.text, value.rawText, value.content, value.memory,
      value.event, value.description, value.detail, value.details, value.rule, value.item,
      value.role, value.type, value.kind,
      value.current_state, value.currentState, value.state, value.status, value.relation_to_user, value.relationship_to_user, value.last_action, value.lastAction, value.location, value.time,
      value.time_scope, value.timeScope, value.lifecycle, value.confidence, value.evidence,
      value.resolved_reason, value.resolvedReason,
      value.replaces, value.supersedes, value.invalidates,
      profileFieldText(value.identity), profileFieldText(value.original_identity), profileFieldText(value.originalIdentity),
      profileFieldText(value.core_identity), profileFieldText(value.coreIdentity), profileFieldText(value.baseline),
      profileFieldText(value.interpretation), profileFieldText(value.character_interpretation), profileFieldText(value.characterInterpretation),
      profileFieldText(value.personality), profileFieldText(value.personality_traits), profileFieldText(value.personalityTraits),
      profileFieldText(value.speech_style), profileFieldText(value.speechStyle), profileFieldText(value.dialogue_style), profileFieldText(value.dialogueStyle), profileFieldText(value.voice),
      profileFieldText(value.psychology), profileFieldText(value.current_psychology), profileFieldText(value.currentPsychology), profileFieldText(value.mental_state), profileFieldText(value.mentalState),
      value.scene_phase, value.scenePhase, value.current_arc, value.currentArc, value.motif,
      value.from, value.to, value.entityA, value.entityB,
      value.ownerEntityId, value.owner, value.memoryType, value.knowledgeState, value.privacy,
      value.truthState, value.secrecyLevel, value.revealState,
      ...(ensureArray(value.canonicalAnchors || value.canonical_anchors || value.canonicalTokens || value.canonical_tokens || [])),
      ...(ensureArray(value.recallAnchors || value.recall_anchors || [])),
      ...(ensureArray(value.aliases || value.alias || [])),
      ...(ensureArray(value.knowledge_boundary || value.knowledgeBoundary || value.knowledgeBoundaries || [])),
      ...(ensureArray(value.active_events || value.activeEvents || [])),
      ...(ensureArray(value.world_rules || value.worldRules || [])),
      ...(ensureArray(value.factions || [])),
      ...(ensureArray(value.regions || [])),
      ...(ensureArray(value.visibleToEntityIds || value.visibleTo || [])),
      ...(ensureArray(value.deniedToEntityIds || value.deniedTo || [])),
      ...(ensureArray(value.known_to || value.knownTo || value.knownBy || [])),
      ...(ensureArray(value.hidden_from || value.hiddenFrom || [])),
      ...(ensureArray(value.holderEntityIds || value.holders || [])),
      ...(ensureArray(value.relatedEntityIds || value.relatedEntities || [])),
      ...(ensureArray(value.related_refs || value.relatedRefs || [])),
      ...(ensureArray(value.keywords || value.keyword || [])),
      value.condition, value.physical_state, value.physicalState, value.attire, value.outfit,
      ...(ensureArray(value.carrying || value.carried || value.inventory || [])),
      value.intimacy, value.power_balance, value.powerBalance, value.power_dynamic, value.powerDynamic, value.dynamic,
      value.pacing, value.time_elapsed, value.timeElapsed,
      value.sensory, value.lighting, value.weather,
      ...(ensureArray(value.open_invitations || value.openInvitations || [])),
      value.preferences, value.limits, value.safeword, value.safe_signal, value.comfort,
      ...legacyPacketExtraTextValues(value)
    ], 48);
  };
  const entityGate = value => {
    const surface = stripKnownParticles(value);
    const key = normalizedSurface(surface);
    if (!key) return { allowed: false, reason: 'empty', confidence: 0 };
    if (ENTITY_REJECT_WORDS.has(key) || ENTITY_REJECT_WORDS.has(surface.toLowerCase())) return { allowed: false, reason: 'generic_or_abstract', confidence: 0.05 };
    if (/^[a-z]$/i.test(surface)) return { allowed: false, reason: 'too_short', confidence: 0.12 };
    if (/^[가-힣]$/.test(surface)) return { allowed: true, reason: 'single_korean_name', confidence: 0.34 };
    if (/^[ぁ-んァ-ヶー一-龯々〆〤]$/.test(surface)) return { allowed: true, reason: 'single_japanese_name', confidence: 0.32 };
    if (/^(?:현재|이전|다음|최근|중요|위험|갈등|관계|상태|감정|분위기|장면|규칙|現在|以前|次|最近|重要|危険|葛藤|関係|状態|感情|雰囲気|場面|規則|ルール)$/i.test(surface)) return { allowed: false, reason: 'scene_or_abstract_label', confidence: 0.08 };
    const unicodeNameMatch = UNICODE_NAME_RE ? UNICODE_NAME_RE.test(surface) : /^[가-힣A-Za-zぁ-んァ-ヶー一-龯々〆〤][가-힣A-Za-z0-9ぁ-んァ-ヶー一-龯々〆〤_\-\s]{1,40}$/.test(surface);
    const confidence = clamp(
      (unicodeNameMatch ? 0.42 : 0.18)
      + (/[A-Z][a-z]/.test(surface) ? 0.12 : 0)
      + (/[가-힣]{2,}/.test(surface) ? 0.16 : 0)
      + (/[ぁ-んァ-ヶー一-龯々〆〤]{2,}/.test(surface) ? 0.16 : 0),
      0, 1, 0.25
    );
    return { allowed: confidence >= 0.28, reason: confidence >= 0.28 ? '' : 'weak_named_entity_evidence', confidence };
  };
  const priorityTermsOf = value => {
    const body = itemText(value);
    const terms = surfaceTermsOf(value).filter(term => text(term).length >= 2);
    const highValue = [];
    if (/비밀|秘密|内緒|secret/i.test(body)) highValue.push('secret', '비밀', '秘密');
    if (/약속|約束|promise/i.test(body)) highValue.push('promise', '약속', '約束');
    if (/갈등|葛藤|衝突|conflict/i.test(body)) highValue.push('conflict', '갈등', '葛藤');
    if (/후폭풍|결과|余波|結果|consequence|aftermath/i.test(body)) highValue.push('consequence', '후폭풍', '余波');
    if (/규칙|금지|規則|ルール|禁止|rule|forbidden/i.test(body)) highValue.push('rule', '규칙', '規則');
    if (/현재|직전|최근|今|現在|直前|最近|current|recent/i.test(body)) highValue.push('current', 'recent', '현재', '最近');
    return uniq([...terms, ...highValue], 64);
  };
  const priorityBoostFor = (query = '', priorityTerms = [], queryTokens = [], queryConceptTokens = null) => {
    const body = text(query).toLowerCase();
    let boost = 0;
    for (const term of ensureArray(priorityTerms)) {
      const t = text(term).toLowerCase().trim();
      if (!t || t.length < 2) continue;
      if (body.includes(t)) boost += t.length >= 6 ? 0.12 : 0.08;
    }
    const pTokens = tokenize(priorityTerms.join(' '), 80);
    const stats = softWeightedJaccard(queryTokens, pTokens);
    const conceptStats = weightedJaccard(
      ensureArray(queryConceptTokens).length ? queryConceptTokens : conceptTokensForText(query),
      conceptTokensForText(priorityTerms.join(' '))
    );
    boost += Math.min(
      0.22,
      Math.max(stats.coverage * 0.18, stats.jaccard * 0.16)
      + conceptStats.coverage * 0.08
      + stats.overlap * 0.018
    );
    return clamp(boost, 0, 0.34, 0);
  };
  const extractTimeProfile = (value, turn = 0) => {
    const body = itemText(value);
    const explicit = uniq([
      ...((body.match(/\b\d{4}[-./]\d{1,2}[-./]\d{1,2}\b/g) || [])),
      ...((body.match(/\b\d{1,2}:\d{2}\b/g) || [])),
      ...((body.match(/(?:오전|오후|새벽|아침|점심|저녁|밤)\s*\d{0,2}:?\d{0,2}/g) || []))
    ], 8);
    return {
      tags: extractTags(body, TIME_SIGNAL_TAGS),
      explicit,
      sceneTurn: Number(turn || 0),
      hasExplicitTime: explicit.length > 0,
      recencyAnchor: /방금|직전|아까|현재|지금|최근|just|now|current|recent/i.test(body)
    };
  };
  const locatorTokensFor = (axis, category, id, field, subject, value, locator = {}) => tokenize([
    axis, category, id, field, subject,
    locator.uri, locator.field, locator.turnId ? `turn_${locator.turnId}` : '',
    publicRefOf(value), ...surfaceTermsOf(value), ...relationEndpointsOf(value)
  ].filter(Boolean).join(' '), 140);
  const locatorScoreFor = (query = '', row = {}, qTokens = []) => {
    const r = row.retrieval || {};
    const locator = row.locator || {};
    const qKey = normalizeKey(query);
    const exactRef = row.publicRef && qKey.includes(normalizeKey(row.publicRef)) ? 1 : 0;
    const locatorField = normalizeKey([locator.uri, locator.field, locator.turnId ? `turn_${locator.turnId}` : ''].filter(Boolean).join(' '));
    const locatorExact = locatorField && qKey.includes(locatorField) ? 1 : 0;
    const hint = Math.max(
      weightedJaccard(extractTags(query, LOCATOR_HINT_TAGS).map(tag => `locator:${tag}`), ensureArray(r.locatorHintTags).map(tag => `locator:${tag}`)).coverage,
      softWeightedJaccard(qTokens, r.locatorTokens || []).coverage
    );
    return clamp(exactRef * 0.75 + locatorExact * 0.5 + hint * 0.55, 0, 1, 0);
  };
  const modeProfile = (mode = (Memory.settings?.effectiveMode || Memory.settings?.mode)) => MODE_PROFILES[normalizedPerformanceMode(mode)] || MODE_PROFILES.balanced;
  const normalizedInjectionMode = mode => {
    const value = text(mode).trim().toLowerCase();
    if (value === 'full') return value;
    return 'balanced';
  };
  const modeInjectionCap = mode => MODE_INJECTION_CAPS[normalizedInjectionMode(mode)] || MODE_INJECTION_CAPS.balanced;
  const stateViewCharBudgetForMode = mode => {
    const normalized = normalizedInjectionMode(mode);
    const cap = modeInjectionCap(normalized);
    const ratio = MODE_STATE_VIEW_RATIOS[normalized] || MODE_STATE_VIEW_RATIOS.balanced;
    const max = MODE_STATE_VIEW_MAX[normalized] || MODE_STATE_VIEW_MAX.balanced;
    return Math.max(1800, Math.min(max, Math.floor(cap * ratio)));
  };
  const objectish = value => value && typeof value === 'object' && !Array.isArray(value);
  const itemObject = (value, fallbackKey = 'label') => objectish(value) ? { ...value } : { [fallbackKey]: text(value) };
  const collectionTypedItem = (category, value, fallbackKey = 'label') => {
    const obj = itemObject(value, fallbackKey);
    const incomingType = text(obj.type || '').trim();
    const out = { ...obj, type: category };
    if (incomingType && normalizeKey(incomingType) !== normalizeKey(category)) {
      if (!out.item_type) out.item_type = incomingType;
      if (!out.itemType) out.itemType = incomingType;
    }
    return out;
  };
  const isPacketItemObject = value => objectish(value) && [
    'ref', 'id', 'name', 'from', 'to', 'ownerEntityId', 'owner', 'summary', 'text', 'title',
    'state', 'current_state', 'currentState', 'label', 'rawText', 'content', 'memoryType',
    'holderEntityIds', 'alias', 'aliases', 'detail', 'details', 'item',
    'knowledge_boundary', 'knowledgeBoundary', 'location', 'time', 'scene_phase',
    'scenePhase', 'current_arc', 'currentArc', 'decision', 'immediateResult',
    'immediate_result', 'delayedEffect', 'delayed_effect'
  ].some(key => hasOwnProperty(value, key));
  const packetItems = value => {
    if (Array.isArray(value)) return value;
    if (value == null) return [];
    if (!objectish(value)) return [value];
    if (isPacketItemObject(value)) return [value];
    return Object.entries(value).map(([key, item]) => {
      if (objectish(item)) return { id: key, ref: key, ...item };
      return { id: key, ref: key, label: text(item), summary: text(item), value: item };
    });
  };
  const packetCollection = (...values) => values.flatMap(value => packetItems(value));
  const tagDensity = (sourceText = '', registry = {}) => {
    const body = text(sourceText).toLowerCase();
    let hits = 0;
    let groups = 0;
    for (const words of Object.values(registry)) {
      const count = ensureArray(words).filter(word => body.includes(text(word).toLowerCase())).length;
      if (count) {
        groups += 1;
        hits += Math.min(3, count);
      }
    }
    return clamp((groups * 0.18) + (hits * 0.045), 0, 1, 0);
  };
  const bodySignatureScore = value => {
    const body = itemText(value).toLowerCase();
    const hits = BODY_SIGNATURE_HINTS.filter(word => body.includes(text(word).toLowerCase())).length;
    return clamp(hits * 0.08, 0, 0.32, 0);
  };
  const deriveEmotionProfile = value => {
    const body = itemText(value);
    const tags = extractTags(body, EMOTION_TAGS);
    const highArousal = ['anger', 'fear', 'hostility', 'tension'];
    const relationWeighted = ['affection', 'trust', 'hostility', 'guilt'];
    const primary = tags[0] || '';
    const secondary = tags.slice(1, 4);
    const intensity = clamp(
      tagDensity(body, EMOTION_TAGS)
      + tags.filter(tag => highArousal.includes(tag)).length * 0.08
      + bodySignatureScore(body),
      0, 1, 0
    );
    const relationImpact = clamp(
      tagDensity(body, RELATION_SIGNAL_TAGS)
      + tags.filter(tag => relationWeighted.includes(tag)).length * 0.08
      + (/관계|사이|믿|불신|약속|배신|relationship|trust|betray/i.test(body) ? 0.16 : 0),
      0, 1, 0
    );
    const instability = clamp(
      tags.filter(tag => ['anger', 'fear', 'sadness', 'hostility', 'tension', 'guilt'].includes(tag)).length * 0.12
      + (/떨|무너|폭발|침묵|대치|crack|break|standoff/i.test(body) ? 0.16 : 0),
      0, 1, 0
    );
    const positive = tags.filter(tag => ['affection', 'trust', 'joy'].includes(tag)).length;
    const negative = tags.filter(tag => ['anger', 'fear', 'sadness', 'hostility', 'guilt', 'tension'].includes(tag)).length;
    const valence = clamp((positive - negative) / Math.max(1, positive + negative), -1, 1, 0);
    const arousal = clamp(intensity + tags.filter(tag => highArousal.includes(tag)).length * 0.08, 0, 1, 0);
    const control = clamp(0.55 - instability * 0.35 + tags.includes('trust') * 0.1 - tags.includes('fear') * 0.1, 0, 1, 0.5);
    const conflicted = positive > 0 && negative > 0;
    return {
      primary,
      secondary,
      tags,
      intensity,
      valence,
      arousal,
      control,
      conflicted,
      blendProfile: uniq([primary, ...secondary, conflicted ? 'conflicted' : ''], 5).filter(Boolean).join('+'),
      relationImpact,
      instability,
      bodySignals: BODY_SIGNATURE_HINTS.filter(word => body.toLowerCase().includes(text(word).toLowerCase())).slice(0, 6)
    };
  };
  const deriveEmotionImpression = emotionProfile => {
    const bodySignalLift = Math.min(0.08, ensureArray(emotionProfile?.bodySignals).length * 0.015);
    return clamp(
      Number(emotionProfile?.intensity || 0) * 0.42
      + Number(emotionProfile?.arousal || 0) * 0.22
      + Number(emotionProfile?.instability || 0) * 0.18
      + Number(emotionProfile?.relationImpact || 0) * 0.12
      + (emotionProfile?.conflicted ? 0.06 : 0)
      + bodySignalLift,
      0, 1, 0.2
    );
  };
  const deriveReactionReachProfile = (axis, category, value) => {
    const body = itemText(value);
    const endpoints = relationEndpointsOf(value).filter(Boolean).length;
    const collectiveSignal = /집단|조직|세력|가문|학교|마을|도시|국가|왕국|군대|대중|사람들|모두|여론|군중|group|faction|public|crowd|city|nation|kingdom|army/i.test(body);
    const chainSignal = /연쇄|파급|확산|전염|동요|소문|폭로|반란|폭동|혼란|붕괴|퍼지|chain|spread|ripple|rumor|reveal|panic|riot|rebellion/i.test(body);
    const publicExposure = /공개|목격|알려|드러|방송|게시|소문|보고|증언|public|witness|broadcast|posted|revealed|reported/i.test(body);
    const groupAffected = /피해|위협|구원|보호|상실|공포|분노|불안|희망|위로|affected|threatened|saved|protected|loss|fear|anger|hope|comfort/i.test(body);
    const scale = clamp(
      0.10
      + (axis === 'entity' ? 0.05 : 0)
      + (axis === 'world' ? 0.14 : 0)
      + ((axis === 'narrative' || axis === 'planner') ? 0.08 : 0)
      + (endpoints > 1 ? 0.08 : 0)
      + (collectiveSignal ? 0.22 : 0)
      + (chainSignal ? 0.18 : 0)
      + (publicExposure ? 0.12 : 0)
      + (groupAffected ? 0.08 : 0)
      + (/active_event|world_rule|conflict|consequence|payoff|lock|갈등|결과|규칙|잠금/i.test(category) ? 0.06 : 0),
      0, 1, 0.1
    );
    return {
      scale,
      scope: scale >= 0.62 ? 'mass' : (scale >= 0.38 ? 'group' : 'individual'),
      collectiveSignal,
      reactionChain: chainSignal ? 1 : 0,
      publicExposure: publicExposure ? 1 : 0,
      groupAffected: groupAffected ? 1 : 0,
      endpoints
    };
  };
  const deriveEmotionImportance = (axis, category, value, emotionProfile = deriveEmotionProfile(value), reachProfile = deriveReactionReachProfile(axis, category, value)) => {
    const body = itemText(value);
    const branchEmotion = Math.min(0.12, extractTags(body, ENTITY_BRANCHES).length * 0.035);
    return clamp(
      0.18
      + Number(emotionProfile.intensity || 0) * 0.24
      + Number(emotionProfile.relationImpact || 0) * 0.19
      + Number(emotionProfile.instability || 0) * 0.17
      + Number(emotionProfile.arousal || 0) * 0.12
      + Math.abs(Number(emotionProfile.valence || 0)) * 0.05
      + (emotionProfile.conflicted ? 0.05 : 0)
      + Number(reachProfile.scale || 0) * 0.18
      + Number(reachProfile.reactionChain || 0) * 0.08
      + Number(reachProfile.publicExposure || 0) * 0.05
      + branchEmotion,
      0, 1, 0.45
    );
  };
  const deriveWorldProfile = value => {
    const body = itemText(value);
    const tags = extractTags(body, WORLD_SIGNALS);
    const danger = /위험|전쟁|반란|추격|봉쇄|전투|습격|위협|war|rebellion|chase|siege|battle|threat/i.test(body) ? 0.28 : 0;
    const rulePressure = /규칙|금지|허용|불가능|법칙|계약|rule|law|forbidden|allowed|impossible/i.test(body) ? 0.18 : 0;
    const offscreen = /한편|그 사이|장면 밖|소문|meanwhile|offscreen|rumor/i.test(body) ? 0.14 : 0;
    const canonLevel = /후보|가능성|candidate|maybe|possible/i.test(body)
      ? 'candidate'
      : (/확정|반드시|절대|hard|canon|confirmed|rule|규칙|금지/i.test(body) ? 'hard' : 'soft');
    return {
      tags,
      pressure: clamp(tagDensity(body, WORLD_SIGNALS) + danger + rulePressure + offscreen, 0, 1, 0),
      danger,
      rulePressure,
      offscreen,
      canonLevel,
      locationTokens: tokenize([value?.location, value?.region, value?.place, value?.title, value?.label].filter(Boolean).join(' '), 24),
      factionTokens: tokenize(ensureArray(value?.factions || value?.organizations || value?.groups || []).join(' '), 24)
    };
  };
  const inferConflictType = value => {
    const body = itemText(value).toLowerCase();
    if (/관계|불신|믿|사이|애정|질투|relationship|trust/.test(body)) return 'relationship';
    if (/세계|세력|법칙|규칙|world|faction|law/.test(body)) return 'world';
    if (/비밀|거짓|숨|secret|lie/.test(body)) return 'secret';
    if (/기한|마감|시간|deadline|timer/.test(body)) return 'deadline';
    if (/내면|죄책|두려|internal|fear|guilt/.test(body)) return 'internal';
    return 'unknown';
  };
  const deriveStoryProfile = (axis, category, value) => {
    const body = itemText(value);
    const tags = extractTags(body, STORY_LEDGER_HINTS);
    let priority = 0.25;
    if (/conflict|갈등|tension|긴장/i.test(category) || tags.includes('escalation')) priority += 0.18;
    if (/consequence|결과|후폭풍/i.test(category) || tags.includes('consequence')) priority += 0.16;
    if (/payoff|복선|회수|question/i.test(category) || tags.includes('payoff')) priority += 0.15;
    if (/lock|do_not_resolve|avoid|continuity/i.test(category) || tags.includes('doNotResolve')) priority += 0.24;
    if (value?.primary === true || value?.doNotResolveYet === true) priority += 0.12;
    if (Number(value?.pressure || value?.priority || value?.strength || 0) > 0) priority += Number(value.pressure || value.priority || value.strength) * 0.28;
    return {
      tags,
      conflictType: inferConflictType(value),
      priority: clamp(priority, 0, 1, 0.25),
      unresolved: /미해결|아직|보류|open|unresolved|pending|latent|active|escalating/i.test(body),
      lock: /잠금|유지|풀지|하지마|lock|do not resolve|do_not_resolve|forbidden/i.test(body)
    };
  };
  const itemText = item => {
    if (item == null) return '';
    if (typeof item === 'string') return item;
    if (Array.isArray(item)) return item.map(itemText).filter(Boolean).join(' | ');
    if (typeof item === 'object') {
      return [
        item.name, item.title, item.label, item.summary, item.text, item.rawText, item.content, item.memory,
        item.event, item.description, item.detail, item.details, item.rule, item.item,
        item.state, item.status, item.role,
        item.time_scope, item.timeScope, item.lifecycle, item.confidence, item.evidence,
        item.resolved_reason, item.resolvedReason,
        item.replaces, item.supersedes, item.invalidates,
        item.current_state, item.currentState, item.relation_to_user, item.relationship_to_user, item.last_action, item.lastAction,
        profileFieldText(item.identity), profileFieldText(item.original_identity), profileFieldText(item.originalIdentity),
        profileFieldText(item.core_identity), profileFieldText(item.coreIdentity), profileFieldText(item.baseline),
        profileFieldText(item.interpretation), profileFieldText(item.character_interpretation), profileFieldText(item.characterInterpretation),
        profileFieldText(item.personality), profileFieldText(item.personality_traits), profileFieldText(item.personalityTraits),
        profileFieldText(item.speech_style), profileFieldText(item.speechStyle), profileFieldText(item.dialogue_style), profileFieldText(item.dialogueStyle), profileFieldText(item.voice),
        profileFieldText(item.psychology), profileFieldText(item.current_psychology), profileFieldText(item.currentPsychology), profileFieldText(item.mental_state), profileFieldText(item.mentalState),
        item.location, item.time, item.scene_phase, item.current_arc, item.motif,
        item.atmosphere, item.danger_level, item.dangerLevel, item.scene_type, item.sceneType,
        item.from, item.to, item.entityA, item.entityB, item.trust, item.tension, item.evidence,
        item.ownerEntityId, item.owner, item.memoryType, item.knowledgeState, item.privacy, item.truthState,
        item.secrecyLevel, item.revealState,
        item.decision, item.immediate_result, item.immediateResult,
        item.delayed_effect, item.delayedEffect,
        item.kind, item.type, item.item_type, item.itemType, item.emotion, item.currentState, item.lastAction,
        ...(ensureArray(item.knowledge_boundary || item.knowledgeBoundary || item.knowledgeBoundaries || []).map(itemText)),
        ...(ensureArray(item.important_notes || item.notes || []).map(itemText)),
        ...(ensureArray(item.active_events || item.activeEvents || []).map(itemText)),
        ...(ensureArray(item.world_rules || item.worldRules || []).map(itemText)),
        ...(ensureArray(item.factions || item.organizations || item.groups || []).map(itemText)),
        ...(ensureArray(item.regions || item.locations || []).map(itemText)),
        ...(ensureArray(item.unresolved_flags || item.unresolvedFlags || []).map(itemText)),
        ...(ensureArray(item.visibleToEntityIds || item.visibleTo || item.sharedWith || []).map(itemText)),
        ...(ensureArray(item.deniedToEntityIds || item.deniedTo || []).map(itemText)),
        ...(ensureArray(item.known_to || item.knownTo || item.knownBy || []).map(itemText)),
        ...(ensureArray(item.hidden_from || item.hiddenFrom || []).map(itemText)),
        ...(ensureArray(item.holderEntityIds || item.holders || []).map(itemText)),
        ...(ensureArray(item.relatedEntityIds || item.relatedEntities || []).map(itemText)),
        ...(ensureArray(item.related_refs || item.relatedRefs || []).map(itemText)),
        ...(ensureArray(item.canonicalAnchors || item.canonical_anchors || item.canonicalTokens || item.canonical_tokens || []).map(itemText)),
        ...(ensureArray(item.recallAnchors || item.recall_anchors || []).map(itemText)),
        ...(ensureArray(item.aliases || item.alias || []).map(itemText)),
        ...(ensureArray(item.keywords || item.keyword || []).map(itemText)),
        ...(ensureArray(item.next_direction || item.next_response_direction || item.nextResponseDirection || []).map(itemText)),
        ...(ensureArray(item.avoid || []).map(itemText)),
        ...(ensureArray(item.suggested_hooks || item.suggestedHooks || []).map(itemText)),
        ...(ensureArray(item.open_invitations || item.openInvitations || []).map(itemText)),
        item.condition, item.physical_state, item.physicalState, item.attire, item.outfit, item.clothing,
        ...(ensureArray(item.carrying || item.carried || item.inventory || []).map(itemText)),
        item.intimacy, item.power_balance, item.powerBalance, item.power_dynamic, item.powerDynamic, item.dynamic,
        item.pacing, item.time_elapsed, item.timeElapsed,
        item.sensory, item.lighting, item.weather, item.scent,
        item.preferences, item.limits, item.safeword, item.safe_signal, item.comfort,
        ...legacyPacketExtraTextValues(item)
      ].filter(Boolean).join(' | ');
    }
    return text(item);
  };
  const enumValue = (value, allowed = [], fallback = '') => {
    const raw = text(value).trim();
    return allowed.includes(raw) ? raw : fallback;
  };
  const normalizePovMemory = record => {
    const source = objectish(record) ? record : { text: text(record) };
    const confidenceExplicit = Number.isFinite(Number(source.confidence)) && Number(source.confidence) > 0;
    const salienceExplicit = firstExplicitFinite([source.salience], null);
    const pressureExplicit = firstExplicitFinite([source.pressure, source.urgency], null);
    const impressionExplicit = firstExplicitFinite([source.impression], null);
    const ownerEntityId = compact(source.ownerEntityId || source.ownerEntity || source.owner || source.entity || source.name || '', 100);
    const body = compact(source.text || source.rawText || source.memory || source.content || source.summary || '', 900);
    const summary = compact(source.summary || body, 260);
    const memoryType = enumValue(source.memoryType || source.type, POV_MEMORY_TYPES, source.privacy === 'internal' ? 'private_thought' : 'experienced');
    const knowledgeState = enumValue(source.knowledgeState || source.state, KNOWLEDGE_STATES, memoryType === 'rumor' ? 'suspected' : 'known');
    const privacy = enumValue(source.privacy, PRIVACY_STATES, memoryType === 'private_thought' ? 'internal' : 'public');
    const truthState = enumValue(source.truthState || source.truth, TRUTH_STATES, (['rumor', 'inferred'].includes(memoryType) || ['suspected', 'uncertain', 'misunderstood', 'hidden'].includes(knowledgeState)) ? 'unknown' : 'true');
    return {
      ref: text(source.ref || '').trim(),
      publicRef: text(source.publicRef || source._public?.ref || '').trim(),
      id: text(source.id || '').trim(),
      ownerEntityId,
      summary,
      text: body,
      memoryType,
      knowledgeState,
      privacy: memoryType === 'private_thought' ? 'internal' : privacy,
      truthState,
      visibleToEntityIds: mergeValues([source.visibleToEntityIds, source.visibleTo, source.sharedWith, source.known_to, source.knownTo, source.knownBy, source.knows], 32),
      deniedToEntityIds: mergeValues([source.deniedToEntityIds, source.deniedTo, source.hidden_from, source.hiddenFrom, source.unknownTo], 32),
      targetEntities: mergeValues([source.targetEntities, source.targets], 32),
      relatedEntities: mergeValues([source.relatedEntities, source.relatedEntityIds, source.entities], 32),
      _confidenceExplicit: confidenceExplicit,
      confidence: clamp(source.confidence, 0, 1, knowledgeState === 'known' ? 0.68 : 0.45),
      importance: (() => { const v = Number(source.importance); return Number.isFinite(v) ? clamp(v > 1 ? v / 10 : v, 0, 1, 0.5) : 0.5; })(),
      ...(salienceExplicit != null ? { salience: clamp(salienceExplicit, 0, 1, 0.5) } : {}),
      ...(pressureExplicit != null ? { pressure: clamp(pressureExplicit, 0, 1, 0.4) } : {}),
      ...(impressionExplicit != null ? { impression: clamp(impressionExplicit, 0, 1, 0.4) } : {}),
      canRevealAsFact: source.canRevealAsFact === true,
      requiresSuspicionLanguage: source.requiresSuspicionLanguage === true || ['rumor', 'inferred'].includes(memoryType) || ['suspected', 'uncertain', 'misunderstood', 'hidden'].includes(knowledgeState) || truthState !== 'true'
    };
  };
  const normalizeSecret = secret => {
    const source = objectish(secret) ? secret : { summary: text(secret) };
    const confidenceExplicit = Number.isFinite(Number(source.confidence)) && Number(source.confidence) > 0;
    const salienceExplicit = firstExplicitFinite([source.salience], null);
    const pressureExplicit = firstExplicitFinite([source.pressure, source.urgency], null);
    const impressionExplicit = firstExplicitFinite([source.impression], null);
    const summary = compact(source.summary || source.text || source.rawText || source.title || '', 420);
    const revealSourceRefs = mergeValues([source.revealSourceRefs, source.reveal_source_refs], 32);
    const relatedRefs = mergeValues([source.related_refs, source.relatedRefs, source.sourceRefs, source.relatedSourceRefs], 64);
    const evidence = compact(source.evidence || source.revealEvidence || source.reveal_evidence || '', 420);
    let revealState = enumValue(source.revealState || source.state, ['hidden', 'hinted', 'partially_revealed', 'revealed', 'false_secret'], 'hidden');
    const hasRevealEvidence = Boolean(evidence || revealSourceRefs.length || relatedRefs.length);
    const riskFlags = mergeValues([source.riskFlags, revealState === 'revealed' && !hasRevealEvidence ? 'revealed_without_evidence_downgraded' : ''], 16);
    if (revealState === 'revealed' && !hasRevealEvidence) revealState = 'partially_revealed';
    return {
      ref: text(source.ref || '').trim(),
      publicRef: text(source.publicRef || source._public?.ref || '').trim(),
      id: text(source.id || '').trim(),
      title: compact(source.title || summary, 120),
      summary,
      rawText: compact(source.rawText || source.text || summary, 900),
      holderEntityIds: mergeValues([source.holderEntityIds, source.holders, source.known_to, source.knownTo, source.knownBy, source.ownerEntityId, source.owner, source.entity], 32),
      visibleToEntityIds: mergeValues([source.visibleToEntityIds, source.visibleTo, source.sharedWith, source.known_to, source.knownTo, source.knownBy], 32),
      deniedToEntityIds: mergeValues([source.deniedToEntityIds, source.deniedTo, source.hidden_from, source.hiddenFrom, source.unknownTo], 32),
      relatedEntityIds: mergeValues([source.relatedEntityIds, source.relatedEntities, source.entities], 32),
      secrecyLevel: enumValue(source.secrecyLevel || source.privacy, ['private', 'secret', 'internal', 'sealed'], 'secret'),
      revealState,
      truthState: enumValue(source.truthState || source.truth, TRUTH_STATES, 'unknown'),
      evidence,
      related_refs: relatedRefs,
      revealSourceRefs,
      riskFlags,
      _confidenceExplicit: confidenceExplicit,
      confidence: clamp(source.confidence, 0, 1, 0.5),
      importance: (() => { const v = Number(source.importance); return Number.isFinite(v) ? clamp(v > 1 ? v / 10 : v, 0, 1, 0.6) : 0.6; })(),
      ...(salienceExplicit != null ? { salience: clamp(salienceExplicit, 0, 1, 0.5) } : {}),
      ...(pressureExplicit != null ? { pressure: clamp(pressureExplicit, 0, 1, 0.4) } : {}),
      ...(impressionExplicit != null ? { impression: clamp(impressionExplicit, 0, 1, 0.4) } : {})
    };
  };
  const countPacketItems = parsed => {
    const entity = parsed?.entity || parsed?.entities || {};
    const world = parsed?.world || {};
    const narrative = parsed?.narrative || {};
    const planner = parsed?.planner || {};
    const meta = parsed?.meta || {};
    const summaryMemory = meta.summary_memory || meta.summaryMemory || {};
    const rev2MetaValues = [
      summaryMemory.summary,
      ...(Array.isArray(summaryMemory.recallAnchors) ? summaryMemory.recallAnchors : []),
      ...mergeValues([meta.canonicalAnchors, meta.canonical_anchors, meta.canonicalTokens, meta.canonical_tokens], 32),
      ...(Array.isArray(summaryMemory.directEvidenceSnippets) ? summaryMemory.directEvidenceSnippets : []),
      ...(Array.isArray(meta.speaker_boundaries || meta.speakerBoundaries) ? (meta.speaker_boundaries || meta.speakerBoundaries) : []),
      ...(Array.isArray(meta.pattern_guard || meta.patternGuard) ? (meta.pattern_guard || meta.patternGuard) : []),
      ...(Array.isArray(meta.overpromotion_risks || meta.overpromotionRisks) ? (meta.overpromotion_risks || meta.overpromotionRisks) : [])
    ].filter(value => value != null && !(typeof value === 'string' && !value.trim()));
    const rev2MetaItems = packetItems(rev2MetaValues).length;
    return {
      rev2MetaItems,
      characters: packetItems(entity.characters || entity.character || entity.people || []).length,
      relations: packetItems(entity.relations || entity.relationships || []).length,
      povMemories: packetCollection(entity.pov_memories || entity.povMemories || entity.entityMemories || entity.entity_memories || entity.knowledge || [], parsed?.povMemories || parsed?.entityMemories || parsed?.entity_knowledge || []).length,
      secrets: packetCollection(entity.secrets || entity.secret_boundaries || entity.secretBoundaries || entity.hiddenKnowledge || entity.privateThoughts || [], parsed?.secrets || parsed?.hiddenKnowledge || parsed?.privateThoughts || []).length,
      worldItems: packetItems(world.active_events || world.activeEvents || world.events || []).length
        + packetItems(world.world_rules || world.worldRules || world.rules || []).length
        + packetItems(world.factions || []).length
        + packetItems(world.regions || []).length
        + packetItems(world.offscreen_threads || world.offscreenThreads || []).length
        + (world.location || world.time || world.atmosphere || world.sensory || world.lighting || world.weather || world.scent || world.scene_type || world.sceneType || world.danger_level || world.dangerLevel ? 1 : 0),
      narrativeItems: packetItems(narrative.conflict_traces || narrative.conflictTraces || narrative.conflicts || []).length
        + packetItems(narrative.scene_deltas || narrative.sceneDeltas || narrative.deltas || []).length
        + packetItems(narrative.theme_motifs || narrative.themeMotifs || narrative.motifs || []).length
        + (narrative.scene_phase || narrative.scenePhase || narrative.current_arc || narrative.currentArc || narrative.tension_level || narrative.tensionLevel || narrative.dominant_mood || narrative.dominantMood || narrative.pacing || narrative.time_elapsed || narrative.timeElapsed ? 1 : 0),
      plannerItems: packetItems(planner.consequence_ledger || planner.consequenceLedger || planner.consequences || []).length
        + packetItems(planner.payoff_tracker || planner.payoffTracker || planner.payoffs || planner.payover_tracker || planner.payoverTracker || planner.payovers || []).length
        + packetItems(planner.continuity_locks || planner.continuityLocks || []).length
        + packetItems(planner.do_not_resolve_yet || planner.doNotResolveYet || planner.avoid || []).length
        + packetItems(planner.next_direction || planner.next_response_direction || planner.nextResponseDirection || []).length
        + packetItems(planner.suggested_hooks || planner.suggestedHooks || []).length
        + packetItems(planner.open_invitations || planner.openInvitations || []).length
        + (objectish(planner.consent_memory || planner.consentMemory) ? 1 : 0)
    };
  };
  const buildPacketQualityContext = (packetRaw = '', parsed = {}, sourceMeta = {}) => {
    const counts = countPacketItems(parsed);
    const totalItems = Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0);
    if (sourceMeta?.lightweightIngest === true) {
      return {
        lightweightIngest: true,
        sourceText: '',
        sourceTokens: [],
        sourceChars: [],
        sourceConcepts: [],
        sourceFrames: [],
        sourceEvidence: null,
        counts,
        totalItems,
        breadthPenalty: 0,
        packetTokens: []
      };
    }
    const sourceEvidence = normalizeSourceEvidence(sourceMeta.sourceEvidence);
    const sourceText = [
      ...mergeValues([sourceEvidence?.lines, sourceEvidence?.allLines], 18),
      sourceEvidence?.allText || ''
    ].filter(Boolean).join('\n');
    const breadthPenalty = clamp(
      Math.max(0, totalItems - 18) * 0.015
      + Math.max(0, counts.characters - 6) * 0.025
      + Math.max(0, counts.secrets - 4) * 0.025
      + Math.max(0, counts.worldItems - 12) * 0.012,
      0, 0.35, 0
    );
    return {
      lightweightIngest: false,
      sourceText,
      sourceTokens: tokenize(sourceText, 360),
      sourceChars: sourceText ? charNgramTokens(sourceText, 360) : [],
      sourceConcepts: sourceText ? conceptTokensForText(sourceText) : [],
      sourceFrames: sourceText ? semanticFrameTokensForText(sourceText) : [],
      sourceEvidence,
      counts,
      totalItems,
      breadthPenalty,
      packetTokens: sourceText ? tokenize(packetRaw, 360) : []
    };
  };
  const riskyPacketItem = (axis, category, item = {}) => {
    if (axis === 'entity' && (category === 'secret' || category === 'pov_memory')) return true;
    if (axis === 'world' && /world_rule|current_state/.test(category)) return true;
    if (axis === 'entity' && category === 'character' && (item.identity || item.interpretation || item.psychology)) return true;
    if (axis === 'planner' && /continuity_lock|do_not_resolve_yet/.test(category)) return true;
    if (item.replaces || item.supersedes || item.invalidates || item.hidden_from || item.known_to) return true;
    if (item.status && /resolved|superseded|dormant/i.test(text(item.status))) return true;
    return false;
  };
  const structuralMetaPacketItem = (axis, category, item = {}) => {
    if (axis === 'world' && /^(?:current_state|world)$/i.test(text(category))) {
      return Boolean(item.location || item.time || item.scene_type || item.sceneType || item.danger_level || item.dangerLevel || item.atmosphere || item.sensory || item.lighting || item.weather || item.scent);
    }
    if (axis === 'narrative' && /^(?:state|narrative)$/i.test(text(category))) {
      return Boolean(item.scene_phase || item.scenePhase || item.current_arc || item.currentArc || item.tension_level || item.tensionLevel || item.dominant_mood || item.dominantMood || item.pacing || item.time_elapsed || item.timeElapsed);
    }
    return false;
  };
  const scorePacketItemQuality = (axis, category, item = {}, context = {}) => {
    const body = [
      itemText(item),
      ensureArray(item.evidence).join(' '),
      surfaceTermsOf(item).join(' '),
      priorityTermsOf(item).join(' ')
    ].filter(Boolean).join(' ');
    const itemTokens = tokenize(body, 220);
    if (!itemTokens.length || !context.sourceTokens?.length) {
      return { score: 0.62, confidenceFactor: 1, reason: 'unverified_missing_source_text', evidenceSupport: 0 };
    }
    const tokenStats = lexicalStats(itemTokens, context.sourceTokens);
    const charStats = softWeightedJaccard(charNgramTokens(body, 260), context.sourceChars || []);
    const conceptStats = softWeightedJaccard(conceptTokensForText(body), context.sourceConcepts || []);
    const frameStats = softWeightedJaccard(semanticFrameTokensForText(body), context.sourceFrames || []);
    const entityTerms = mergeValues([
      item.name, item.title, item.label, item.from, item.to, item.ownerEntityId,
      item.holderEntityIds, item.visibleToEntityIds, item.deniedToEntityIds, item.relatedEntityIds,
      item.location, item.region, item.aliases
    ], 80);
    const entityOverlap = entityTerms.length ? lexicalStats(tokenize(entityTerms.join(' '), 120), context.sourceTokens).coverage : 0;
    const evidenceText = text(item.evidence || '').trim();
    const normalizedEvidenceText = normalizeKey(evidenceText);
    const normalizedSourceText = normalizeKey(context.sourceText || '');
    const evidenceExactSupport = normalizedEvidenceText && normalizedSourceText.includes(normalizedEvidenceText) ? 1 : 0;
    const evidenceSupport = evidenceText ? Math.max(
      evidenceExactSupport,
      lexicalStats(tokenize(evidenceText, 120), context.sourceTokens).coverage,
      softWeightedJaccard(charNgramTokens(evidenceText, 160), context.sourceChars || []).coverage
    ) : 0;
    const baseScore = clamp(
      tokenStats.coverage * 0.24
      + charStats.coverage * 0.22
      + entityOverlap * 0.20
      + conceptStats.coverage * 0.14
      + frameStats.coverage * 0.08
      + evidenceSupport * 0.18
      - Number(context.breadthPenalty || 0),
      0, 1, 0.5
    );
    const evidenceFloor = evidenceSupport >= 0.92 ? 0.72
      : evidenceSupport >= 0.72 ? 0.64
        : evidenceSupport >= 0.52 ? 0.54
          : evidenceSupport >= 0.34 ? 0.44
            : 0;
    const structuralMeta = structuralMetaPacketItem(axis, category, item);
    const structuralMetaFloor = structuralMeta ? 0.62 : 0;
    const score = clamp(Math.max(baseScore, evidenceFloor, structuralMetaFloor), 0, 1, 0.5);
    const confidenceFactor = structuralMeta && score >= structuralMetaFloor
      ? 1
      : (score >= 0.65 ? 1 : (score >= 0.35 ? 0.78 + score * 0.18 : (riskyPacketItem(axis, category, item) ? 0.45 + score * 0.25 : 0.62 + score * 0.25)));
    return {
      score,
      confidenceFactor: clamp(confidenceFactor, 0.35, 1, 0.75),
      tokenCoverage: Number(tokenStats.coverage.toFixed(4)),
      charCoverage: Number(charStats.coverage.toFixed(4)),
      conceptCoverage: Number(conceptStats.coverage.toFixed(4)),
      frameCoverage: Number(frameStats.coverage.toFixed(4)),
      entityOverlap: Number(entityOverlap.toFixed(4)),
      evidenceSupport: Number(evidenceSupport.toFixed(4)),
      breadthPenalty: Number((context.breadthPenalty || 0).toFixed(4))
    };
  };
  const applyPacketQualityToItem = (axis, category, item = {}, context = {}) => {
    if (!objectish(item)) return item;
    if (context?.lightweightIngest === true) {
      return {
        ...item,
        _packetQuality: { score: 0.66, confidenceFactor: 1, reason: 'lightweight_ingest', evidenceSupport: 0 },
        _confidenceExplicit: Number.isFinite(Number(item.confidence)) && Number(item.confidence) > 0,
        _confidenceQualityAdjusted: false,
        _lightweightIngest: true
      };
    }
    if (context?.compactFullIngest === true) {
      return {
        ...item,
        _packetQuality: { score: 0.72, confidenceFactor: 1, reason: 'compact_full_ingest', evidenceSupport: 0 },
        _confidenceExplicit: Number.isFinite(Number(item.confidence)) && Number(item.confidence) > 0,
        _confidenceQualityAdjusted: false,
        _compactFullIngest: true
      };
    }
    const quality = scorePacketItemQuality(axis, category, item, context);
    const factor = quality.confidenceFactor;
    const incomingConfidence = Number(item.confidence);
    const confidenceExplicit = item._confidenceExplicit === false
      ? false
      : Number.isFinite(incomingConfidence) && incomingConfidence > 0;
    const out = { ...item, _packetQuality: quality, _confidenceExplicit: confidenceExplicit, _confidenceQualityAdjusted: false };
    if (factor < 0.995) {
      const baseConfidence = Number.isFinite(Number(out.confidence)) && Number(out.confidence) > 0 ? Number(out.confidence) : 0.58;
      out.confidence = clamp(baseConfidence * factor, 0, 1, 0.5);
      out._confidenceQualityAdjusted = true;
      out.qualityFlags = mergeValues([out.qualityFlags, quality.score < 0.35 ? 'packet_quality_low' : 'packet_quality_softened'], 16);
    }
    if (axis === 'entity' && category === 'secret' && out.revealState === 'revealed' && quality.evidenceSupport < 0.08 && quality.score < 0.62) {
      out.revealState = 'partially_revealed';
      out.riskFlags = mergeValues([out.riskFlags, 'revealed_source_mismatch_downgraded'], 16);
      out.qualityFlags = mergeValues([out.qualityFlags, 'unsupported_reveal_downgraded'], 16);
    }
    return out;
  };
  const stableItemKey = item => text(item?._stableKey || publicRefOf(item) || item?.id || '').trim();
  const itemByStableKey = items => {
    const map = new Map();
    ensureArray(items).forEach(item => {
      const key = stableItemKey(item);
      if (key) map.set(key, item);
    });
    return map;
  };
  const hasNewStableItem = (items = [], previous = []) => {
    const previousKeys = itemByStableKey(previous);
    return ensureArray(items).some(item => {
      const key = stableItemKey(item);
      return key && !previousKeys.has(key);
    });
  };
  const relationSignatureOf = (item = {}) => JSON.stringify({
    from: text(item.from || item.entityA || item.source || ''),
    to: text(item.to || item.entityB || item.target || ''),
    label: text(item.label || item.type || item.relationship || item.kind || ''),
    state: text(item.state || item.summary || item.relationship_to_user || item.relation_to_user || ''),
    trust: Number.isFinite(Number(item.trust)) ? Number(item.trust) : null,
    tension: Number.isFinite(Number(item.tension)) ? Number(item.tension) : null,
    status: text(item.status || ''),
    timeScope: text(item.time_scope || item.timeScope || ''),
    known: mergeValues([item.known_to, item.knownTo, item.visibleToEntityIds, item.visibleTo], 32).sort(),
    hidden: mergeValues([item.hidden_from, item.hiddenFrom, item.deniedToEntityIds, item.deniedTo], 32).sort()
  });
  const hasRelationChange = (items = [], previous = []) => {
    const previousByKey = itemByStableKey(previous);
    return ensureArray(items).some(item => {
      const key = stableItemKey(item);
      const prev = key ? previousByKey.get(key) : null;
      if (!prev) return Boolean(key);
      return relationSignatureOf(item) !== relationSignatureOf(prev);
    });
  };
  const boundarySignatureOf = (item = {}, kind = '') => {
    if (kind === 'secret') {
      return JSON.stringify({
        holders: mergeValues([item.holderEntityIds, item.holders], 32).sort(),
        visible: mergeValues([item.visibleToEntityIds, item.visibleTo, item.sharedWith, item.known_to, item.knownTo, item.knownBy], 32).sort(),
        denied: mergeValues([item.deniedToEntityIds, item.deniedTo, item.hidden_from, item.hiddenFrom, item.unknownTo], 32).sort(),
        secrecyLevel: text(item.secrecyLevel || item.privacy || ''),
        revealState: text(item.revealState || ''),
        truthState: text(item.truthState || '')
      });
    }
    return JSON.stringify({
      owner: text(item.ownerEntityId || item.owner || ''),
      visible: mergeValues([item.visibleToEntityIds, item.visibleTo, item.sharedWith], 32).sort(),
      denied: mergeValues([item.deniedToEntityIds, item.deniedTo, item.hidden_from, item.hiddenFrom], 32).sort(),
      memoryType: text(item.memoryType || item.type || ''),
      knowledgeState: text(item.knowledgeState || ''),
      privacy: text(item.privacy || ''),
      truthState: text(item.truthState || '')
    });
  };
  const hasBoundaryChange = (items = [], previous = [], kind = '') => {
    const previousByKey = itemByStableKey(previous);
    return ensureArray(items).some(item => {
      const key = stableItemKey(item);
      const prev = key ? previousByKey.get(key) : null;
      if (!prev) return Boolean(key);
      return boundarySignatureOf(item, kind) !== boundarySignatureOf(prev, kind);
    });
  };
  const hasRevealStateChange = (items = [], previous = []) => {
    const previousByKey = itemByStableKey(previous);
    return ensureArray(items).some(item => {
      const key = stableItemKey(item);
      const prev = key ? previousByKey.get(key) : null;
      return Boolean(prev && text(item.revealState || '') !== text(prev.revealState || ''));
    });
  };
  const hasUnsupportedSecretReveal = secrets => ensureArray(secrets).some(secret => {
    if (!objectish(secret)) return false;
    const revealState = text(secret.revealState || secret.reveal_state || secret.state || '').trim().toLowerCase();
    if (revealState !== 'revealed') return false;
    const evidence = text(secret.evidence || secret.revealEvidence || secret.reveal_evidence || '').trim();
    const relatedRefs = mergeValues([secret.related_refs, secret.relatedRefs, secret.sourceRefs, secret.revealSourceRefs], 32);
    return !evidence && !relatedRefs.length;
  });
  const hasPacketQualityRisk = items => ensureArray(items).some(item => {
    if (!objectish(item)) return false;
    const flags = mergeValues([item.qualityFlags, item.riskFlags], 32);
    return flags.some(flag => /packet_quality_low|unsupported_reveal|source_mismatch|revealed_without_evidence/i.test(flag));
  });
  const countLowQualityItems = items => ensureArray(items).filter(item => {
    if (!objectish(item)) return false;
    const flags = mergeValues([item.qualityFlags, item.riskFlags], 32);
    return flags.some(flag => /packet_quality_low|unsupported_reveal|source_mismatch/i.test(flag));
  }).length;
  const rawPacketHasInternalLeak = packetRaw => /"(?:_locator|_retrieval|locator|storeKey|store_key|internalId|internal_id)"\s*:/i.test(text(packetRaw));
  const PACKET_TOP_KEYS = Object.freeze(new Set([
    'meta', 'entity', 'entities', 'world', 'narrative', 'planner', 'importance',
    'turn', 'delta', 'delta_only', 'deltaOnly',
    'povMemories', 'entityMemories', 'entity_knowledge',
    'secrets', 'hiddenKnowledge', 'privateThoughts'
  ]));
  const PACKET_COLLECTION_KEYS = Object.freeze(new Set([
    'characters', 'people',
    'relations', 'relationships',
    'pov_memories', 'povMemories', 'entityMemories', 'entity_memories', 'knowledge',
    'secrets', 'secret_boundaries', 'secretBoundaries', 'hiddenKnowledge', 'privateThoughts',
    'active_events', 'activeEvents', 'events',
    'world_rules', 'worldRules', 'rules',
    'offscreen_threads', 'offscreenThreads', 'factions', 'regions',
    'conflict_traces', 'conflictTraces', 'conflicts',
    'scene_deltas', 'sceneDeltas', 'deltas',
    'theme_motifs', 'themeMotifs', 'motifs',
    'consequence_ledger', 'consequenceLedger', 'consequences',
    'payoff_tracker', 'payoffTracker', 'payoffs',
    'payover_tracker', 'payoverTracker', 'payovers',
    'continuity_locks', 'continuityLocks',
    'do_not_resolve_yet', 'doNotResolveYet', 'avoid',
    'next_direction', 'next_response_direction', 'nextResponseDirection',
    'suggested_hooks', 'suggestedHooks',
    'open_invitations', 'openInvitations',
    'speaker_boundaries', 'speakerBoundaries',
    'pattern_guard', 'patternGuard',
    'overpromotion_risks', 'overpromotionRisks'
  ]));
  const PACKET_CRITICAL_UNKNOWN_TOP_KEYS = Object.freeze(new Set([
    'characters', 'people',
    'relations', 'relationships',
    'povmemories', 'entitymemories', 'entityknowledge',
    'secrets', 'secretboundaries', 'hiddenknowledge', 'privatethoughts',
    'activeevents', 'events', 'worldrules', 'rules', 'offscreenthreads', 'factions', 'regions',
    'conflicttraces', 'conflicts', 'scenedeltas', 'deltas', 'thememotifs', 'motifs',
    'consequenceledger', 'consequences', 'payofftracker', 'payoffs', 'payovertracker', 'payovers',
    'continuitylocks', 'donotresolveyet', 'avoid', 'nextdirection', 'suggestedhooks'
  ]));
  const isCriticalPacketShapeWarning = warning => {
    const raw = text(warning);
    if (/^non_array_collection:/i.test(raw)) return true;
    const match = /^unknown_top_key:(.+)$/i.exec(raw);
    return Boolean(match && PACKET_CRITICAL_UNKNOWN_TOP_KEYS.has(normalizeKey(match[1])));
  };
  const validatePacketShape = parsed => {
    const warnings = [];
    if (!objectish(parsed)) return warnings;
    Object.keys(parsed).forEach(key => {
      if (!PACKET_TOP_KEYS.has(key)) warnings.push(`unknown_top_key:${key}`);
    });
    const checkCollections = (obj, path) => {
      if (!objectish(obj)) return;
      Object.entries(obj).forEach(([key, value]) => {
        if (PACKET_COLLECTION_KEYS.has(key) && value != null && !Array.isArray(value) && objectish(value) && !isPacketItemObject(value)) {
          warnings.push(`non_array_collection:${path}.${key}`);
        }
      });
    };
    checkCollections(parsed, 'packet');
    checkCollections(parsed.meta, 'meta');
    checkCollections(parsed.entity, 'entity');
    checkCollections(parsed.entities, 'entities');
    checkCollections(parsed.world, 'world');
    checkCollections(parsed.narrative, 'narrative');
    checkCollections(parsed.planner, 'planner');
    return uniq(warnings, 24);
  };
  const coercePacketCollections = parsed => {
    if (!objectish(parsed)) return parsed;
    const coerceObject = obj => {
      if (!objectish(obj)) return;
      Object.entries(obj).forEach(([key, value]) => {
        if (!PACKET_COLLECTION_KEYS.has(key) || value == null || Array.isArray(value)) return;
        if (!objectish(value)) {
          obj[key] = [value];
          return;
        }
        if (isPacketItemObject(value)) {
          obj[key] = [value];
          return;
        }
        obj[key] = Object.entries(value).map(([ref, item]) => (
          objectish(item)
            ? { ref, id: item.id || ref, ...item }
            : { ref, id: ref, label: text(item), summary: text(item), value: item }
        ));
      });
    };
    [
      parsed,
      parsed.meta,
      parsed.entity,
      parsed.entities,
      parsed.world,
      parsed.narrative,
      parsed.planner
    ].forEach(coerceObject);
    return parsed;
  };
  const buildPacketIngestSignal = (packetRaw = '', parsed = {}, packetQuality = {}, sourceMeta = {}) => {
    const meta = objectish(parsed?.meta) ? parsed.meta : {};
    const declaredHayakuSchema = /^hayaku_packet/i.test(text(meta.schema || ''));
    const hasAxis = key => objectish(parsed?.[key]);
    const missingRequiredAxes = Boolean(declaredHayakuSchema && !['entity', 'world', 'narrative', 'planner'].every(hasAxis));
    const sourceShapeWarnings = ensureArray(sourceMeta.packetShapeWarnings);
    const packetShapeWarnings = sourceShapeWarnings.length ? sourceShapeWarnings : validatePacketShape(parsed);
    const entity = parsed?.entity || parsed?.entities || {};
    const rawSecrets = packetCollection(
      entity.secrets || entity.secret_boundaries || entity.secretBoundaries || entity.hiddenKnowledge || entity.privateThoughts || [],
      parsed.secrets || parsed.hiddenKnowledge || parsed.privateThoughts || []
    );
    return {
      packetHash: sourceMeta.packetHash || '',
      messageIndex: Number.isFinite(Number(sourceMeta.messageIndex)) ? Number(sourceMeta.messageIndex) : null,
      invalidJsonRecently: false,
      missingRequiredAxes,
      requiredKeysMissingRecently: missingRequiredAxes,
      packetShapeWarningsRecently: packetShapeWarnings.length > 0,
      packetShapeWarnings,
      lastPacketHadLocatorLeak: rawPacketHasInternalLeak(packetRaw),
      lastPacketWasDeltaOnly: /"packet_type"\s*:\s*"(?:delta|patch|update)"/i.test(packetRaw) || parsed?.delta === true || parsed?.delta_only === true || parsed?.deltaOnly === true,
      lastPacketRefReuseError: false,
      lastPacketSecretRevealRisk: hasUnsupportedSecretReveal(rawSecrets),
      lastPacketHadUnsupportedReveal: hasUnsupportedSecretReveal(rawSecrets),
      lowQualityItems: 0,
      totalItems: Number(packetQuality.totalItems || 0),
      sourceLines: ensureArray(packetQuality.sourceEvidence?.lines).length,
      hasNewCharacter: false,
      hasNewWorldRule: false,
      hasSecretBoundaryChange: false,
      hasPovMemoryChange: false,
      hasRevealStateChange: false,
      hasRelationshipChange: false,
      hasLocationOrTimeChange: false,
      hasHighImpactConsequence: false,
      hasSceneIdChange: false
    };
  };

  const storageRemove = async key => RisuCompat.removeStorageKey(key);

  const readArg = async (key, fallback = '') => RisuCompat.getArgument(key, fallback);
  const truthySetting = value => /^(?:true|on|1|yes)$/i.test(text(value).trim());
  const falsySetting = value => /^(?:false|off|0|no)$/i.test(text(value).trim());
  const loadSettings = async () => {
    const enabledRaw = await readArg('hayaku_enabled', String(DEFAULT_SETTINGS.enabled));
    const modeRaw = await readArg('hayaku_mode', DEFAULT_SETTINGS.mode);
    const promptModeRaw = await readArg('hayaku_prompt_mode', DEFAULT_SETTINGS.promptMode);
    const maxItemsPerAxisRaw = await readArg('hayaku_max_items_per_axis', DEFAULT_SETTINGS.maxItemsPerAxis);
    const bm25ChannelRaw = await readArg('hayaku_bm25_channel', String(DEFAULT_SETTINGS.bm25Channel));
    const bm25WeightRaw = await readArg('hayaku_bm25_weight', String(DEFAULT_SETTINGS.bm25Weight));
    const debugRaw = await readArg('hayaku_debug', String(DEFAULT_SETTINGS.debug));
    const mainRequestTypesRaw = await readArg('hayaku_main_request_types', DEFAULT_SETTINGS.mainRequestTypes);
    const packetRecoveryRaw = await readArg('hayaku_packet_recovery', String(DEFAULT_SETTINGS.packetRecovery));
    const hayaLoveFrameRaw = await readArg('hayaku_haya_love_frame', String(DEFAULT_SETTINGS.hayaLoveFrame));
    const hayaPrefillRaw = await readArg('hayaku_haya_prefill', String(DEFAULT_SETTINGS.hayaPrefill));
    const mainRequestTypesValue = (() => {
      const raw = text(mainRequestTypesRaw).trim();
      if (!raw) return DEFAULT_SETTINGS.mainRequestTypes;
      // Guard: a boolean-like value means the arg was not actually configured with a type list.
      if (/^(?:true|false|yes|no|on|off|1|0)$/i.test(raw)) return DEFAULT_SETTINGS.mainRequestTypes;
      return raw;
    })();
    const maxItemsPerAxis = Number(maxItemsPerAxisRaw);
    const bm25Weight = Number(bm25WeightRaw);
    Memory.settings = {
      ...DEFAULT_SETTINGS,
      enabled: falsySetting(enabledRaw) ? false : true,
      mode: ['auto', 'fast', 'balanced', 'deep'].includes(text(modeRaw).trim()) ? text(modeRaw).trim() : DEFAULT_SETTINGS.mode,
      promptMode: ['auto', 'balanced', 'full'].includes(text(promptModeRaw).trim()) ? text(promptModeRaw).trim() : DEFAULT_SETTINGS.promptMode,
      injectionCaps: MODE_INJECTION_CAPS,
      maxItemsPerAxis: Math.max(1, Math.min(12, Number.isFinite(maxItemsPerAxis) ? maxItemsPerAxis : DEFAULT_SETTINGS.maxItemsPerAxis)),
      bm25Channel: falsySetting(bm25ChannelRaw) ? false : true,
      bm25Weight: clamp(Number.isFinite(bm25Weight) ? bm25Weight : DEFAULT_SETTINGS.bm25Weight, 0, 0.25, DEFAULT_SETTINGS.bm25Weight),
      debug: truthySetting(debugRaw),
      mainRequestTypes: mainRequestTypesValue,
      packetRecovery: falsySetting(packetRecoveryRaw) ? false : true,
      hayaLoveFrame: falsySetting(hayaLoveFrameRaw) ? false : true,
      hayaPrefill: falsySetting(hayaPrefillRaw) ? false : true
    };
    delete Memory.settings.ui;
    return Memory.settings;
  };

  const emptyStore = () => ({
    version: 'hayaku_store_v1',
    updatedAt: 0,
    turn: 0,
    ingestedPacketHashes: [],
    entity: { characters: [], relations: [], povMemories: [], secrets: [] },
    memory: { summaries: [] },
    world: { items: [] },
    narrative: { conflictTraces: [], sceneDeltas: [], themeMotifs: [], items: [] },
    planner: { consequenceLedger: [], payoffTracker: [], continuityLocks: [], doNotResolveYet: [], items: [] },
    context: { recentEntities: [], recentQuery: '', updatedAt: 0, sceneAnchors: null, sceneAnchorUpdatedAt: 0 },
    index: [],
    stats: { packets: 0, items: 0, lastIngestAt: 0 }
  });
  const normalizeStore = store => {
    const base = emptyStore();
    const source = store && typeof store === 'object' ? store : {};
    const normalized = {
      ...base,
      ...source,
      ingestedPacketHashes: ensureArray(source.ingestedPacketHashes || []),
      entity: { ...base.entity, ...(source.entity && typeof source.entity === 'object' ? source.entity : {}) },
      memory: { ...base.memory, ...(source.memory && typeof source.memory === 'object' ? source.memory : {}) },
      world: { ...base.world, ...(source.world && typeof source.world === 'object' ? source.world : {}) },
      narrative: { ...base.narrative, ...(source.narrative && typeof source.narrative === 'object' ? source.narrative : {}) },
      planner: { ...base.planner, ...(source.planner && typeof source.planner === 'object' ? source.planner : {}) },
      context: { ...base.context, ...(source.context && typeof source.context === 'object' ? source.context : {}) },
      index: ensureArray(source.index || []),
      stats: { ...base.stats, ...(source.stats && typeof source.stats === 'object' ? source.stats : {}) }
    };
    delete normalized.lastInjection;
    return normalized;
  };
  // saveStore is an intentional no-op for persistence: per the chat-packet-only
  // design (see header doc), packets are re-read from chat messages on each
  // request and are never persisted to pluginStorage/localStorage. It only
  // refreshes the in-memory updatedAt stamp so callers/debug can observe it.
  const saveStore = async (store = Memory.store) => {
    if (!store) return false;
    store.updatedAt = now();
    return true;
  };
  const purgePersistentStore = async () => {
    await storageRemove(STORE_KEY);
    await storageRemove(SETTINGS_CACHE_KEY);
  };
  const debugLog = (...args) => {
    try {
      if (Memory.settings?.debug) console.log('[HAYAKU DEBUG]', ...args);
    } catch (_) {}
  };
  const debugError = (label, error, extra = {}) => {
    const detail = {
      label,
      message: error?.message || text(error),
      stack: error?.stack || '',
      ...extra
    };
    Memory.lastWarnings = [detail, ...ensureArray(Memory.lastWarnings)].slice(0, 12);
    try {
      if (Memory.settings?.debug) console.error('[HAYAKU DEBUG ERROR]', detail);
    } catch (_) {}
    return detail;
  };

  const RequestKindCore = (() => {
    const MAIN_TYPES = new Set(['model']);
    const AMBIENT_HELPER_TYPES = new Set(['otherax', 'other-ax', 'other_ax', 'submodel', 'sub-model', 'sub_model', 'translate', 'translation']);
    const PROTECTED_AUXILIARY_TYPES = new Set(['submodel', 'sub-model', 'sub_model', 'memory', 'emotion', 'otherax', 'other-ax', 'other_ax', 'translate', 'translation']);
    const GIGATRANS_AMBIENT_GRACE_MS = 8000;
    let lastGigaTransHelperAt = 0;
    const moduleMarkerPattern = /(?:<\s*\/?\s*(?:lb-[a-z0-9-]+|lightboard-[a-z0-9-]+)\b|\blb-(?:rerolling|pending|lazy|reroll|interaction-identifier|xnai)\b|<GT-(?:CTRL|SEP)\b|GigaTrans|기가트랜스|재생성\s*중)/i;
    const hardAuxiliaryMarkerPattern = /(?:<\/?\s*lb-process\b|\blb-xnai-editing\b|\blb-xnai-gen\/|\[LightBoard\]|\bLightBoard\s+Backend\b|<\s*\/?\s*lightboard-[a-z0-9-]+\b|\[LBDATA START\][\s\S]*?(?:lb-rerolling|lb-pending|lb-interaction-identifier|lb-xnai)|<GT-(?:CTRL|SEP)\b|<\s*\/?\s*GigaTrans\b|기가트랜스)/i;
    const structuredImagePromptPattern = /(?:\b(?:positive|negative)\s+prompt\b|(?:네거티브|포지티브)\s*프롬프트|(?:sampler|cfg\s*scale|steps|seed|denoise|checkpoint|loras?|vae)\s*:|stable\s*diffusion|comfyui|image\s+prompt|illustration\s+prompt|삽화\s*프롬프트|이미지\s*프롬프트)/i;
    const structuredTranslationPromptPattern = /(?:translate\s+(?:the\s+following|to\b)|translation\s+request|source\s+language|target\s+language|번역\s*(?:요청|전용)|다음\s*(?:문장|텍스트|내용)을\s*번역|원문\s*:|번역문\s*:)/i;
    const lightBoardStructuredFormatMarkers = Object.freeze([
      '<lb-npclist>',
      '</lb-npclist>',
      '[characterlist|',
      'char-history-wrapper',
      'char-history-content',
      'char-info-row',
      '📜 과거 기록 보기'
    ]);
    const lightBoardStructuredGuidanceMarkers = Object.freeze([
      'must start with <lb-npclist>',
      'every character must have all 7 base fields',
      'future relevance test',
      'strictly exclude characters',
      'fill every field completely',
      'structured character list output',
      'specific format'
    ]);
    const gigaTransStrongMarkers = Object.freeze([
      'translate the <sample_text>',
      'output only the translated text',
      '<sample_text>',
      '</sample_text>',
      '<translator_notes>',
      '</translator_notes>',
      '<lorebook>',
      '</lorebook>',
      '<persona>',
      '</persona>',
      '<context>',
      '</context>'
    ]);
    const gigaTransSlotMarkers = Object.freeze(['{{slot::input}}', '{{slot::tnote}}', '{{slot::lore}}', '{{slot::persona}}', '{{slot::context}}']);
    const separatorPattern = /^(?:[-_\s|:;,.·•~`'"()[\]{}<>/\\]+|#+|응답\s*없음|no\s+content|null|undefined)*$/i;
    const messageText = (message = {}) => text(rawMessagePayload(message));
    const CLASSIFY_MESSAGE_SCAN_LIMIT = 24;
    const combinedMessages = messages => ensureArray(messages).slice(-CLASSIFY_MESSAGE_SCAN_LIMIT).map(messageText).filter(Boolean).join('\n\n');
    const stripModuleArtifacts = value => text(value)
      .replace(/\[LBDATA START\][\s\S]*?\[LBDATA END\]/gi, ' ')
      .replace(/<GigaTrans\b[^>]*>[\s\S]*?<\/GigaTrans>/gi, ' ')
      .replace(/<\/GigaTrans>/gi, ' ')
      .replace(/<GigaTrans\b[^>]*>/gi, ' ')
      .replace(/<GT-CTRL\s*\/?>/gi, ' ')
      .replace(/<GT-SEP\s*\/?>/gi, ' ')
      .replace(/<\s*\/?\s*(?:lb-[a-z0-9-]+|lightboard-[a-z0-9-]+)\b[^>]*>/gi, ' ')
      .replace(/\blb-(?:rerolling|pending|lazy|reroll|interaction-identifier|xnai)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const isEffectivelyEmpty = value => {
      const clean = stripModuleArtifacts(value).trim();
      return !clean || separatorPattern.test(clean);
    };
    const isModuleOnlyPrompt = value => {
      const raw = text(value || '');
      return !!raw.trim() && moduleMarkerPattern.test(raw) && isEffectivelyEmpty(raw);
    };
    const isLightBoardStructuredPrompt = value => {
      const raw = text(value || '').trim();
      if (!raw) return false;
      const lower = raw.toLowerCase();
      const formatHits = lightBoardStructuredFormatMarkers.filter(marker => lower.includes(text(marker).toLowerCase())).length;
      const guidanceHits = lightBoardStructuredGuidanceMarkers.filter(marker => lower.includes(text(marker).toLowerCase())).length;
      if (formatHits >= 2 && guidanceHits >= 1) return true;
      return formatHits >= 3;
    };
    const isGigaTransHelperPrompt = value => {
      const raw = text(value || '').trim();
      if (!raw) return false;
      const lower = raw.toLowerCase();
      const buttonEvent = /\bonButtonClick\b/i.test(raw) && /\bgt__\w+::\d+\b/i.test(raw);
      const gtMarker = /<GT-CTRL\b[^>]*\/?>|<GT-SEP\s*\/?>|<\s*GigaTrans(?:\s[^>]*)?>|<\s*\/\s*GigaTrans\s*>|\bgt__\w+::\d+\b/i.test(raw);
      const strongHits = gigaTransStrongMarkers.reduce((count, marker) => count + (lower.includes(marker) ? 1 : 0), 0);
      const sampleTextPair = lower.includes('<sample_text>') && lower.includes('</sample_text>');
      const translatorNotesPair = lower.includes('<translator_notes>') && lower.includes('</translator_notes>');
      const translationInstruction = lower.includes('translate the <sample_text>')
        || lower.includes('output only the translated text')
        || /\bgigatrans\s+(?:translation|translator|engine)\b/i.test(raw);
      const slotHits = gigaTransSlotMarkers.filter(marker => lower.includes(marker)).length;
      return buttonEvent
        || gtMarker
        || strongHits >= 4
        || (sampleTextPair && translatorNotesPair && translationInstruction)
        || (slotHits >= 2 && (lower.includes('# advance_notice') || lower.includes('# system_role')) && translationInstruction);
    };
    const isHardAuxiliaryPrompt = value => {
      const raw = text(value || '');
      if (!raw.trim()) return false;
      if (hardAuxiliaryMarkerPattern.test(raw)) return true;
      if (isGigaTransHelperPrompt(raw)) return true;
      if (isLightBoardStructuredPrompt(raw)) return true;
      if (structuredImagePromptPattern.test(raw)) return true;
      if (structuredTranslationPromptPattern.test(raw)) return true;
      return false;
    };
    const classify = (requestType = '', messages = [], content = '', options = {}) => {
      const typeKey = text(requestType || '').trim().toLowerCase();
      const body = text(content || '') || combinedMessages(messages);
      const reasons = [];
      const mainTypeSet = options.mainTypes
        ? new Set(ensureArray(options.mainTypes).map(s => text(s).trim().toLowerCase()).filter(Boolean))
        : MAIN_TYPES;
      const protectedAuxiliaryType = PROTECTED_AUXILIARY_TYPES.has(typeKey);
      const mainType = mainTypeSet.has(typeKey) && !protectedAuxiliaryType;
      if (!mainType) reasons.push(typeKey ? `requestType:${typeKey}` : 'requestType:empty');
      const gigaTransHelper = !mainType && isGigaTransHelperPrompt(body);
      const hardAuxiliary = !mainType && (hardAuxiliaryMarkerPattern.test(body)
        || gigaTransHelper
        || isLightBoardStructuredPrompt(body)
        || structuredImagePromptPattern.test(body)
        || structuredTranslationPromptPattern.test(body));
      if (gigaTransHelper) lastGigaTransHelperAt = Date.now();
      const recentGigaTransHelper = !hardAuxiliary
        && AMBIENT_HELPER_TYPES.has(typeKey)
        && (Date.now() - Number(lastGigaTransHelperAt || 0)) < GIGATRANS_AMBIENT_GRACE_MS;
      if (recentGigaTransHelper) reasons.push('recent_gigatrans_helper_request');
      if (hardAuxiliary) reasons.push('hard_auxiliary_prompt');
      const moduleOnly = !mainType && isModuleOnlyPrompt(body);
      if (moduleOnly) reasons.push('module_only_prompt');
      const auxiliary = !mainType;
      const effectiveText = stripModuleArtifacts(body);
      return {
        requestType: text(requestType || ''), normalizedType: typeKey,
        isMainType: mainType, auxiliary, main: mainType && !auxiliary,
        moduleOnly, hardAuxiliary, reasons,
        reason: reasons.join(',') || 'main_model_request',
        effectiveTextPreview: compact(effectiveText, 220), effectiveTextChars: effectiveText.length
      };
    };
    return Object.freeze({ classify, isModuleOnlyPrompt, isHardAuxiliaryPrompt, stripModuleArtifacts });
  })();

  const messageContent = msg => text(rawMessagePayload(msg));
  const normalizeMessageRole = role => {
    const value = text(role).trim().toLowerCase();
    if (/^(?:char|character|ai|bot)$/.test(value)) return 'assistant';
    return value;
  };
  const roleOf = msg => normalizeMessageRole(roleHintOf(msg));
  const currentInputFrom = value => {
    const body = stripHayakuBlocks(value);
    const match = body.match(/<Current Input>\s*```?([\s\S]*?)```?\s*<\/Current Input>/i)
      || body.match(/<Current Input>([\s\S]*?)<\/Current Input>/i);
    return match ? text(match[1]).trim() : '';
  };
  const latestCurrentInputRange = (messages = []) => {
    const list = ensureArray(messages);
    for (let start = list.length - 1; start >= 0; start -= 1) {
      const startRole = roleOf(list[start]);
      const startBody = messageContent(list[start]);
      if (startRole && !/user|human/i.test(startRole)) continue;
      if (!/<Current Input\b/i.test(startBody)) continue;
      const chunks = [];
      for (let end = start; end < list.length; end += 1) {
        const role = roleOf(list[end]);
        if (role && !/user|human/i.test(role)) break;
        const body = messageContent(list[end]);
        chunks.push(body);
        if (/<\/Current Input>/i.test(body)) {
          const current = currentInputFrom(chunks.join('\n'));
          if (current) return { start, end, text: current };
          break;
        }
      }
    }
    return null;
  };
  const BACKSTAGE_PAYLOAD_RE = /<tool_response\b|<\/tool_response>|<tool_call\b|<\/tool_call>|<tool_name>|<\/tool_name>|# User Statement|\[HAYAKU CONTINUITY CONTEXT\]|\[HAYAKU SIDE-WRITE FINAL REMINDER\]|\[LBDATA START\]|<GT-CTRL|verify_authorization|check_connectivity|bypass self-correction|LICENSED_USER_FROM_PROVIDER|NO_INTERNET|session_token|license check|connectivity check|external connection|legal liability|standard limitations/i;
  const isBackstageUserPayload = value => BACKSTAGE_PAYLOAD_RE.test(text(value));
  const shouldDropOutgoingMessage = msg => {
    const body = messageContent(msg);
    if (!body.trim()) return true;
    if (currentInputFrom(body)) return false;
    const role = roleOf(msg);
    if (isBackstageUserPayload(body)) return true;
    if (/assistant|model/i.test(role) && /<Thoughts>/i.test(body) && !/# 응답/.test(body)) return true;
    if ((!role || /user|human/i.test(role)) && /^system\s*:/i.test(body.trim())) return true;
    return false;
  };
  const latestUserText = (messages = []) => {
    const list = ensureArray(messages);
    const currentRange = latestCurrentInputRange(list.slice(-32));
    if (currentRange?.text) return currentRange.text;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const role = roleOf(list[i]);
      if (role && !/user|human/i.test(role)) continue;
      const body = messageContent(list[i]);
      const current = currentInputFrom(body);
      if (current) return current;
    }
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const role = roleOf(list[i]);
      if (role && !/user|human/i.test(role)) continue;
      const body = messageContent(list[i]);
      if (body.trim() && !isBackstageUserPayload(body)) return stripHayakuBlocks(body).trim();
    }
    const fallbackRole = roleOf(list[list.length - 1] || {});
    if (fallbackRole && !/user|human/i.test(fallbackRole)) return '';
    const fallback = stripHayakuBlocks(messageContent(list[list.length - 1] || '')).trim();
    return isBackstageUserPayload(fallback) ? '' : fallback;
  };
  const stripHayakuBlocks = (value, options = {}) => {
    let stripped = text(value)
      .replace(new RegExp(`<!--\\s*${PACKET_START}\\s*([\\s\\S]*?)\\s*${PACKET_END}\\s*-->`, 'gi'), ' ')
      .replace(new RegExp(`<<<\\s*${PACKET_START}\\s*>>>\\s*([\\s\\S]*?)\\s*<<<\\s*${PACKET_END}\\s*>>>`, 'gi'), ' ');
    if (options.looseMarkers) {
      stripped = stripped.replace(new RegExp(`(?:<!--\\s*)?${PACKET_START}\\s*([\\s\\S]*?)\\s*${PACKET_END}\\s*(?:-->)?`, 'gi'), ' ');
    }
    stripped = stripped
      .replace(new RegExp(`\\[HAYAKU CONTINUITY CONTEXT\\][\\s\\S]*?\\[/HAYAKU CONTINUITY CONTEXT\\]`, 'gi'), ' ');
    return options.preserveWhitespace ? stripped : stripped.trim();
  };
  const hasCompleteHayakuPacketMarkers = value => {
    const body = text(value);
    return body.includes(PACKET_START) && body.includes(PACKET_END);
  };
  const hasCompleteHayakuPacketInMessage = message => rawMessagePayloadCandidates(message)
    .some(body => hasCompleteHayakuPacketMarkers(body));
  const recoveryBoundaryIndex = (messages = []) => {
    const list = ensureArray(messages);
    const currentRange = latestCurrentInputRange(list);
    if (currentRange) return currentRange.start;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const role = roleOf(list[i]);
      if (role && !/user|human/i.test(role)) continue;
      const body = messageContent(list[i]);
      if (body.trim() && !isBackstageUserPayload(body)) return i;
    }
    return list.length;
  };
  const compactRecoveryExcerpt = (value, limit = PACKET_RECOVERY_EXCERPT_CHARS) => {
    const clean = stripHayakuBlocks(value, { looseMarkers: true })
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .trim();
    const maxChars = Math.max(120, Number(limit) || PACKET_RECOVERY_EXCERPT_CHARS);
    if (clean.length <= maxChars) return clean;
    const headChars = Math.floor(maxChars * 0.62);
    const tailChars = Math.max(120, maxChars - headChars - 18);
    return `${clean.slice(0, headChars).trimEnd()}\n[...]\n${clean.slice(Math.max(0, clean.length - tailChars)).trimStart()}`;
  };
  const findLatestAssistantRecoverySource = (messages = []) => {
    const list = ensureArray(messages);
    const boundary = recoveryBoundaryIndex(list);
    for (let i = Math.min(boundary - 1, list.length - 1); i >= 0; i -= 1) {
      const message = list[i];
      const role = roleOf(message);
      if (!/^(assistant|model)$/i.test(role)) continue;
      const candidates = rawMessagePayloadCandidates(message).map(body => text(body)).filter(Boolean);
      if (!candidates.length) continue;
      const joined = candidates.join('\n');
      const visible = compactRecoveryExcerpt(joined);
      if (visible.length < PACKET_RECOVERY_MIN_VISIBLE_CHARS) continue;
      if (isBackstageUserPayload(visible)) continue;
      if (RequestKindCore.isModuleOnlyPrompt(visible) || RequestKindCore.isHardAuxiliaryPrompt(visible)) continue;
      return {
        message,
        index: i,
        boundary,
        role,
        visible,
        visibleChars: visible.length,
        hasPacketMarkers: hasCompleteHayakuPacketInMessage(message)
      };
    }
    return null;
  };
  const buildAssistantRecoverySource = (message, index, boundary) => {
    const role = roleOf(message);
    if (!/^(assistant|model)$/i.test(role)) return null;
    const candidates = rawMessagePayloadCandidates(message).map(body => text(body)).filter(Boolean);
    if (!candidates.length) return null;
    const joined = candidates.join('\n');
    const visible = compactRecoveryExcerpt(joined);
    if (visible.length < PACKET_RECOVERY_MIN_VISIBLE_CHARS) return null;
    if (isBackstageUserPayload(visible)) return null;
    if (RequestKindCore.isModuleOnlyPrompt(visible) || RequestKindCore.isHardAuxiliaryPrompt(visible)) return null;
    return {
      message,
      index,
      boundary,
      role,
      visible,
      visibleChars: visible.length,
      hasPacketMarkers: hasCompleteHayakuPacketInMessage(message)
    };
  };
  const compactRecoverySourceChain = (sources = [], limit = PACKET_RECOVERY_EXCERPT_CHARS) => {
    const list = ensureArray(sources).filter(Boolean);
    if (!list.length) return '';
    if (list.length === 1) return compactRecoveryExcerpt(list[0].visible, limit);
    const maxChars = Math.max(1200, Number(limit) || PACKET_RECOVERY_EXCERPT_CHARS);
    const perSource = Math.max(520, Math.floor((maxChars - (list.length * 80)) / Math.max(1, list.length)));
    const body = list.map((source, index) => [
      `[Missing assistant output ${index + 1}/${list.length} | messageIndex ${source.index}]`,
      compactRecoveryExcerpt(source.visible, perSource)
    ].join('\n')).join('\n\n');
    return compactRecoveryExcerpt(body, maxChars);
  };
  const recoveryMissingScopePhrase = (count = 1, omitted = 0, previous = false) => {
    const safeCount = Math.max(1, Number(count || 1) || 1);
    const skipped = Math.max(0, Number(omitted || 0) || 0);
    const noun = previous ? 'missing previous assistant outputs' : 'missing assistant outputs';
    return skipped > 0
      ? `the most recent ${safeCount} ${noun} in chronological order`
      : `all ${safeCount} ${noun} in chronological order`;
  };
  const recoveryPacketTypeOf = parsed => text(objectish(parsed?.meta) ? (parsed.meta.packet_type || parsed.meta.packetType || '') : '').trim().toLowerCase();
  const isRecoveryPacketType = packetType => /^recovery[_-]?snapshot$/.test(text(packetType));
  const recoveryPacketStateByMessage = (packets = [], boundary = Infinity) => {
    const byMessageIndex = new Map();
    const touch = index => {
      if (!byMessageIndex.has(index)) {
        byMessageIndex.set(index, {
          messageIndex: index,
          total: 0,
          validCount: 0,
          invalidCount: 0,
          validCurrentLikeCount: 0,
          validRecoveryCount: 0,
          invalidReason: ''
        });
      }
      return byMessageIndex.get(index);
    };
    ensureArray(packets).forEach(packet => {
      const messageIndex = Number(packet?.messageIndex);
      if (!Number.isFinite(messageIndex) || messageIndex >= boundary) return;
      const state = touch(messageIndex);
      state.total += 1;
      const raw = text(materializeExtractedPacket(packet).raw || '').trim();
      const parsed = safeJsonParse(raw, null);
      if (!parsed || typeof parsed !== 'object') {
        state.invalidCount += 1;
        state.invalidReason = state.invalidReason || 'json_parse_failed';
        return;
      }
      state.validCount += 1;
      const packetType = recoveryPacketTypeOf(parsed);
      if (isRecoveryPacketType(packetType)) state.validRecoveryCount += 1;
      else state.validCurrentLikeCount += 1;
    });
    let latestAnyPacketIndex = -1;
    let latestValidPacketIndex = -1;
    let latestUsablePacketIndex = -1;
    byMessageIndex.forEach((state, messageIndex) => {
      if (state.total > 0) latestAnyPacketIndex = Math.max(latestAnyPacketIndex, messageIndex);
      if (state.validCount > 0) latestValidPacketIndex = Math.max(latestValidPacketIndex, messageIndex);
      if (state.validCurrentLikeCount > 0) latestUsablePacketIndex = Math.max(latestUsablePacketIndex, messageIndex);
    });
    return { byMessageIndex, latestAnyPacketIndex, latestValidPacketIndex, latestUsablePacketIndex };
  };
  const detectPacketRecovery = (messages = [], packets = [], settings = Memory.settings || DEFAULT_SETTINGS) => {
    if (settings?.packetRecovery === false) return null;
    const list = ensureArray(messages);
    const boundary = recoveryBoundaryIndex(list);
    const packetState = recoveryPacketStateByMessage(packets, boundary);
    const latestPacketIndex = packetState.latestUsablePacketIndex;
    const chainSources = [];
    for (let i = Math.max(0, latestPacketIndex + 1); i < Math.min(boundary, list.length); i += 1) {
      const source = buildAssistantRecoverySource(list[i], i, boundary);
      if (!source) continue;
      const state = packetState.byMessageIndex.get(i) || {};
      const hasUnreadableCurrentPacket = Boolean(source.hasPacketMarkers && Number(state.invalidCount || 0) > 0 && Number(state.validCurrentLikeCount || 0) <= 0);
      if (source.hasPacketMarkers && !hasUnreadableCurrentPacket) continue;
      chainSources.push({
        ...source,
        hasUnreadableCurrentPacket,
        recoveryIssue: hasUnreadableCurrentPacket ? 'unreadable_current_packet' : 'missing_packet',
        packetParseReason: state.invalidReason || ''
      });
    }
    const cappedChainSources = chainSources.length > PACKET_RECOVERY_MAX_CHAIN_MESSAGES
      ? chainSources.slice(-PACKET_RECOVERY_MAX_CHAIN_MESSAGES)
      : chainSources;
    const omittedMissingMessageCount = Math.max(0, chainSources.length - cappedChainSources.length);
    const latestFallbackSource = findLatestAssistantRecoverySource(list);
    const latestFallbackState = latestFallbackSource ? (packetState.byMessageIndex.get(latestFallbackSource.index) || {}) : {};
    const latestFallbackUnreadable = Boolean(
      latestFallbackSource?.hasPacketMarkers
      && Number(latestFallbackState.invalidCount || 0) > 0
      && Number(latestFallbackState.validCurrentLikeCount || 0) <= 0
    );
    const sources = cappedChainSources.length
      ? cappedChainSources
      : ensureArray(latestFallbackSource).filter(source => source && (!source.hasPacketMarkers || latestFallbackUnreadable)).map(source => ({
        ...source,
        hasUnreadableCurrentPacket: latestFallbackUnreadable,
        recoveryIssue: latestFallbackUnreadable ? 'unreadable_current_packet' : 'missing_packet',
        packetParseReason: latestFallbackState.invalidReason || ''
      }));
    if (!sources.length) return null;
    const latestSource = sources[sources.length - 1];
    if (latestPacketIndex >= latestSource.index) return null;
    const excerpt = compactRecoverySourceChain(sources);
    if (!excerpt) return null;
    const chain = sources.length > 1;
    const hasUnreadableCurrentPacket = sources.some(source => source?.hasUnreadableCurrentPacket);
    return {
      active: true,
      source: 'detected_missing_packet',
      reason: hasUnreadableCurrentPacket
        ? (chain ? 'assistant_chain_with_invalid_packet' : 'latest_assistant_invalid_packet')
        : (chain
        ? (latestPacketIndex >= 0 ? 'assistant_chain_after_latest_packet' : 'assistant_chain_without_packet')
        : (latestPacketIndex >= 0 ? 'latest_assistant_after_latest_packet' : 'latest_assistant_without_packet')),
      recoveryIssue: hasUnreadableCurrentPacket ? 'unreadable_current_packet' : 'missing_packet',
      invalidPacketCount: sources.reduce((sum, source) => sum + (source?.hasUnreadableCurrentPacket ? 1 : 0), 0),
      latestAnyPacketIndex: packetState.latestAnyPacketIndex,
      latestValidPacketIndex: packetState.latestValidPacketIndex,
      messageIndex: latestSource.index,
      firstMissingMessageIndex: sources[0].index,
      messageIndices: sources.map(source => source.index),
      missingMessageCount: sources.length,
      totalMissingMessageCount: chainSources.length || sources.length,
      omittedMissingMessageCount,
      latestPacketIndex,
      boundaryIndex: latestSource.boundary,
      messageCount: list.length,
      distanceFromLatest: Math.max(0, list.length - 1 - latestSource.index),
      visibleChars: sources.reduce((sum, source) => sum + Number(source.visibleChars || 0), 0),
      excerpt
    };
  };
  const isDetectedPacketRecoveryRequest = recovery => {
    if (recovery?.active !== true) return false;
    if (recovery.source !== 'detected_missing_packet') return false;
    if (!/^(latest_assistant_without_packet|latest_assistant_after_latest_packet|assistant_chain_without_packet|assistant_chain_after_latest_packet|latest_assistant_invalid_packet|assistant_chain_with_invalid_packet)$/.test(text(recovery.reason))) return false;
    if (!Number.isFinite(Number(recovery.messageIndex))) return false;
    if (!Number.isFinite(Number(recovery.boundaryIndex))) return false;
    if (text(recovery.excerpt).trim().length < PACKET_RECOVERY_MIN_VISIBLE_CHARS) return false;
    return true;
  };
  const visibleRepeatGuardClean = value => {
    let clean = stripHayakuBlocks(value, { looseMarkers: true })
      .replace(/<Thoughts>[\s\S]*?<\/Thoughts>/gi, ' ')
      .replace(/<GigaTrans>[\s\S]*?<\/GigaTrans>/gi, ' ')
      .replace(/<GT-CTRL\s*\/?>/gi, ' ')
      .replace(/<lb-[^>]*>[\s\S]*?<\/lb-[^>]+>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    const responseAt = clean.search(/(?:^|\n)\s*#\s*(?:Response|응답)\b/i);
    if (responseAt >= 0) clean = clean.slice(responseAt).trim();
    return clean;
  };
  const normalizeVisibleRepeat = value => text(value)
    .replace(/[“”„‟]/g, '"')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/\s+/g, ' ')
    .replace(/[.!?。！？…~]+$/g, '')
    .trim()
    .toLowerCase();
  const isVisibleRepeatBoilerplate = value => /^(?:#{1,6}\s|[-*_]{3,}\s*$)|\b(?:chatindex|volume\s+\d|chapter\s+\d|response|literal translation|cultural overlay|private session|providing result now)\b|^⏱/i.test(text(value).trim());
  const splitVisibleRepeatSentences = value => visibleRepeatGuardClean(value)
    .split(/[\n。！？!?]+|(?<!\d)\.(?!\d)/g)
    .map(line => line.replace(/^[\s>*_`#\-•]+|[\s*_`]+$/g, '').replace(/\s+/g, ' ').trim())
    .filter(line => line.length >= 18 && line.length <= 220 && !isVisibleRepeatBoilerplate(line));
  const extractVisibleRepeatDialogues = value => {
    const clean = visibleRepeatGuardClean(value);
    const out = [];
    const patterns = [
      /"([^"\n]{3,180})"/g,
      /“([^”\n]{3,180})”/g,
      /「([^」\n]{3,180})」/g,
      /『([^』\n]{3,180})』/g,
      /'([^'\n]{3,180})'/g
    ];
    patterns.forEach(re => {
      let match = null;
      while ((match = re.exec(clean))) {
        const quote = text(match[1]).replace(/\s+/g, ' ').trim();
        if (quote.length >= 3 && !isVisibleRepeatBoilerplate(quote)) out.push(quote);
      }
    });
    return out;
  };
  const recentAssistantVisibleSources = (messages = [], limit = VISIBLE_REPEAT_GUARD_RECENT_MESSAGES) => {
    const list = ensureArray(messages);
    const boundary = recoveryBoundaryIndex(list);
    const sources = [];
    for (let i = Math.min(boundary - 1, list.length - 1); i >= 0 && sources.length < limit; i -= 1) {
      const role = roleOf(list[i]);
      if (!/^(assistant|model)$/i.test(role)) continue;
      const joined = rawMessagePayloadCandidates(list[i]).map(body => text(body)).filter(Boolean).join('\n');
      const visible = visibleRepeatGuardClean(joined);
      if (visible.length < 80) continue;
      sources.push({ index: i, visible, visibleChars: visible.length });
    }
    return sources.reverse();
  };
  const repeatedVisibleItems = (rows, options = {}) => {
    const minKeyLength = Math.max(1, Number(options.minKeyLength || 6) || 6);
    const map = new Map();
    ensureArray(rows).forEach(row => {
      const key = normalizeVisibleRepeat(row.text);
      if (!key || key.length < minKeyLength) return;
      if (!map.has(key)) map.set(key, { text: row.text, count: 0, messages: new Set() });
      const item = map.get(key);
      item.count += 1;
      item.messages.add(row.messageIndex);
    });
    return Array.from(map.values())
      .filter(item => item.count >= 2 && item.messages.size >= 1)
      .sort((a, b) => b.messages.size - a.messages.size || b.count - a.count || b.text.length - a.text.length);
  };
  const makeVisibleRepeatPatternGuardRow = (kind = 'repeat', summary = '', snippets = [], sourceCount = 0) => {
    const sampleCount = ensureArray(snippets).map(snippet => compact(snippet, 110)).filter(Boolean).slice(0, VISIBLE_REPEAT_GUARD_MAX_SNIPPETS).length;
    const sampleText = sampleCount ? ` ${sampleCount} recent repeated sample(s) were detected for private comparison only; do not quote, paraphrase, or store those samples in packet fields.` : '';
    const packetText = ` This is a short-lived correction guard: if the current visible response avoids the pattern, omit it or mark it status "resolved", time_scope "past", with resolved_reason; otherwise preserve it in current_snapshot meta.pattern_guard with expires_after_turns ${PATTERN_GUARD_DEFAULT_EXPIRES_AFTER_TURNS} and evidence "${PATTERN_GUARD_NEUTRAL_EVIDENCE}". Do not copy sample text into the packet or visible output.`;
    const publicText = compact(`${summary}${sampleText}${packetText} Advance the scene with a new consequence, choice, reaction angle, or information beat instead of restating the same line.`, 980);
    const id = `visible_repeat_${kind}_${stableHash64(publicText).slice(0, 12)}`;
    const score = kind === 'dialogue' ? 1.18 : 1.08;
    return {
      axis: 'planner',
      category: 'pattern_guard',
      id,
      publicRef: `planner.pattern_guard.${id}`,
      publicText,
      publicProfile: '',
      importance: 0.86,
      score,
      updatedAt: now(),
      lifecycle: {
        status: 'active',
        timeScope: 'current',
        confidence: 0.84,
        evidence: PATTERN_GUARD_NEUTRAL_EVIDENCE,
        expiresAfterTurns: PATTERN_GUARD_DEFAULT_EXPIRES_AFTER_TURNS,
        resolveWhen: PATTERN_GUARD_DEFAULT_RESOLVE_WHEN
      },
      retrieval: {
        subject: 'visible repeat guard',
        importance: 0.86,
        pressure: 0.38,
        salience: 0.92,
        impression: 0,
        priorityTerms: ['repeat', 'verbatim', 'dialogue', 'sentence_skeleton', 'expires_after_turns', 'resolved', kind],
        semanticFrameTokens: ['pattern_guard', 'anti_repetition', 'short_lived_guard', kind],
        entityNames: [],
        relationEndpoints: [],
        sourceEvidence: null
      },
      _metaGuard: { forced: true, runtime: true, visibleRepeat: true, kind, sourceCount, sampleCount, expiresAfterTurns: PATTERN_GUARD_DEFAULT_EXPIRES_AFTER_TURNS }
    };
  };
  const buildVisibleRepeatGuards = (messages = []) => {
    const sources = recentAssistantVisibleSources(messages);
    if (sources.length < 2) return [];
    const sentenceRows = [];
    const dialogueRows = [];
    const boilerplateRows = [];
    sources.forEach(source => {
      splitVisibleRepeatSentences(source.visible).forEach(sentence => sentenceRows.push({ messageIndex: source.index, text: sentence }));
      extractVisibleRepeatDialogues(source.visible).forEach(dialogue => dialogueRows.push({ messageIndex: source.index, text: dialogue }));
      visibleRepeatGuardClean(source.visible)
        .split(/\n+/g)
        .map(line => line.replace(/\s+/g, ' ').trim())
        .filter(line => line.length >= 8 && line.length <= 120 && isVisibleRepeatBoilerplate(line))
        .forEach(line => boilerplateRows.push({ messageIndex: source.index, text: line }));
    });
    const repeatedDialogues = repeatedVisibleItems(dialogueRows, { minKeyLength: 3 }).filter(item => item.messages.size >= 2 || item.count >= 2);
    const repeatedSentences = repeatedVisibleItems(sentenceRows).filter(item => item.messages.size >= 2);
    const repeatedBoilerplate = repeatedVisibleItems(boilerplateRows).filter(item => item.messages.size >= 3);
    const guards = [];
    if (repeatedDialogues.length) {
      guards.push(makeVisibleRepeatPatternGuardRow(
        'dialogue',
        'Avoid reusing recent direct dialogue verbatim unless the user explicitly asks for an exact echo.',
        repeatedDialogues.slice(0, VISIBLE_REPEAT_GUARD_MAX_SNIPPETS).map(item => item.text),
        sources.length
      ));
    }
    if (repeatedSentences.length) {
      guards.push(makeVisibleRepeatPatternGuardRow(
        'sentence',
        'Avoid repeating recent narration sentences or near-identical reaction beats; keep the fact but change the beat and syntax.',
        repeatedSentences.slice(0, VISIBLE_REPEAT_GUARD_MAX_SNIPPETS).map(item => item.text),
        sources.length
      ));
    }
    if (repeatedBoilerplate.length) {
      guards.push(makeVisibleRepeatPatternGuardRow(
        'boilerplate',
        'Do not let repeated headings, status labels, helper boilerplate, or interface scaffolding substitute for fresh scene progress; keep only user-required template parts.',
        repeatedBoilerplate.slice(0, VISIBLE_REPEAT_GUARD_MAX_SNIPPETS).map(item => item.text),
        sources.length
      ));
    }
    return guards.slice(0, VISIBLE_REPEAT_GUARD_MAX_ROWS);
  };
  const attachVisibleRepeatGuards = (selected = {}, runtimeGuards = []) => {
    const guards = ensureArray(runtimeGuards).filter(Boolean);
    if (!guards.length) return selected;
    const seen = new Set();
    const metaGuards = [...guards, ...ensureArray(selected.metaGuards)]
      .filter(row => {
        const key = rowIdentityKey(row) || normalizeKey([row.category, row.publicText, row.id].filter(Boolean).join('|'));
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || Number(b.importance || 0) - Number(a.importance || 0) || Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
      .slice(0, 5);
    return { ...selected, metaGuards };
  };
  const stripHayakuTextPayload = (value, options = {}) => {
    if (typeof value !== 'string') return { value, changed: false, removed: 0 };
    const clean = stripHayakuBlocks(value, { preserveWhitespace: true, looseMarkers: options.looseMarkers !== false });
    return {
      value: clean,
      changed: clean !== value,
      removed: Math.max(0, value.length - clean.length)
    };
  };
  const hayakuPayloadNeedsStrip = (value, options = {}, seen = new WeakSet()) => {
    if (typeof value === 'string') return stripHayakuTextPayload(value, options).changed;
    if (value == null || typeof value !== 'object') return false;
    if (seen.has(value)) return false;
    seen.add(value);
    for (const key of Object.keys(value)) {
      if (hayakuPayloadNeedsStrip(value[key], options, seen)) {
        seen.delete(value);
        return true;
      }
    }
    seen.delete(value);
    return false;
  };
  const cloneStrippedHayakuPayloadValue = (value, options = {}, memo = new WeakMap(), stats = { removed: 0 }) => {
    if (typeof value === 'string') {
      const result = stripHayakuTextPayload(value, options);
      stats.removed += result.removed;
      return result.value;
    }
    if (value == null || typeof value !== 'object') return value;
    if (memo.has(value)) return memo.get(value);
    const out = Array.isArray(value) ? value.slice() : { ...value };
    memo.set(value, out);
    for (const key of Object.keys(value)) {
      out[key] = cloneStrippedHayakuPayloadValue(value[key], options, memo, stats);
    }
    return out;
  };
  const stripHayakuPayloadValue = (value, options = {}) => {
    if (typeof value === 'string') return stripHayakuTextPayload(value, options);
    if (value == null || typeof value !== 'object') return { value, changed: false, removed: 0 };
    if (!hayakuPayloadNeedsStrip(value, options)) return { value, changed: false, removed: 0 };
    const stats = { removed: 0 };
    return { value: cloneStrippedHayakuPayloadValue(value, options, new WeakMap(), stats), changed: true, removed: stats.removed };
  };
  const stripHayakuDataPayload = (data, options = {}) => {
    return stripHayakuPayloadValue(data, options);
  };
  const stripHayakuFromMessagePayloads = (msg = {}, options = {}) => {
    if (!msg || typeof msg !== 'object') return { message: msg, changed: false, removed: 0 };
    const result = stripHayakuPayloadValue(msg, options);
    return { message: result.value, changed: result.changed, removed: result.removed };
  };
  const stripNarrativeTags = value => text(value)
    .replace(/<\/?Narration>/gi, '')
    .replace(/<([A-Za-z_][A-Za-z0-9_.-]*)>/g, '')
    .replace(/<\/([A-Za-z_][A-Za-z0-9_.-]*)>/g, '')
    .replace(/§([^§]{1,80})§/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  const sanitizeEvidenceBody = value => stripHayakuBlocks(value)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\[상태창\|[^\]]*\]/gi, ' ')
    .replace(/\[LBDATA START\][\s\S]*?\[LBDATA END\]/gi, ' ')
    .replace(/<GT-CTRL\s*\/?>/gi, ' ')
    .replace(/<GT-SEP\s*\/?>/gi, ' ')
    .replace(/<\s*\/?\s*(?:lb-[a-z0-9-]+|lightboard-[a-z0-9-]+)\b[^>]*>/gi, ' ')
    .replace(/\blb-(?:rerolling|pending|lazy|reroll|interaction-identifier|xnai)\b/gi, ' ')
    .replace(/<Thoughts>[\s\S]*?<\/Thoughts>/gi, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\b(?:Response|choices|usage|prompt_tokens|completion_tokens|total_tokens)\b[\s\S]{0,1200}$/gi, ' ')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const sanitizeEvidenceLine = (value, maxLength = 220) => {
    let line = stripNarrativeTags(sanitizeEvidenceBody(value))
      .replace(/\s+/g, ' ')
      .trim();
    line = line.replace(/^[-*_#>\s|:;,.·•~`'"()[\]{}<>/\\]+/, '').trim();
    if (!line || line.length < 8) return '';
    if (isBackstageUserPayload(line)) return '';
    if (/HAYAKU_STATE_PACKET|HAYAKU CONTINUITY CONTEXT|Packet keys only|Response Quality Rule/i.test(line)) return '';
    if (/^(?:\{|\}|\[|\]|"?(?:role|content|messages|model|usage|choices|created|object|id)"?\s*:)/i.test(line)) return '';
    if (/^(?:-{3,}|={3,}|<\/?[A-Z][A-Z0-9_-]+\/?>)$/i.test(line)) return '';
    return compact(line, maxLength);
  };
  const evidenceCandidateLines = (message = {}, maxLines = 60) => {
    const role = roleOf(message) || 'unknown';
    if (/system|developer|tool/i.test(role)) return [];
    let body = messageContent(message);
    const current = currentInputFrom(body);
    if (current) body = current;
    body = sanitizeEvidenceBody(body);
    const lines = [];
    text(body).split(/\r?\n+/).forEach(raw => {
      const line = sanitizeEvidenceLine(raw);
      if (!line) return;
      if (lines.some(existing => normalizeKey(existing.text) === normalizeKey(line))) return;
      lines.push({ role, text: line, fullText: sanitizeEvidenceLine(raw, 520) || line });
    });
    if (lines.length) return lines.slice(0, maxLines);
    const compactBody = sanitizeEvidenceLine(body);
    return compactBody ? [{ role, text: compactBody }] : [];
  };
  const scoreEvidenceLine = (line, packetTokens, packetConcepts, packetFrames) => {
    const body = text(line?.text || line || '');
    const tokenScore = lexicalStats(packetTokens, tokenize(body, 96));
    const conceptScore = softWeightedJaccard(packetConcepts, conceptTokensForText(body));
    const frameScore = softWeightedJaccard(packetFrames, semanticFrameTokensForText(body));
    const roleBoost = /user|human/i.test(line?.role || '') ? 0.025 : 0;
    return clamp(
      Math.max(tokenScore.coverage, tokenScore.jaccard)
      + Math.max(conceptScore.coverage, conceptScore.jaccard) * 0.45
      + Math.max(frameScore.coverage, frameScore.jaccard) * 0.35
      + roleBoost,
      0, 1, 0
    );
  };
  const buildSourceEvidence = (messages = [], messageIndex = 0, packetRaw = '', opts = {}) => {
    const list = ensureArray(messages);
    const lightweight = !!opts.lightweight;
    const allTextCap = lightweight ? 4000 : 14000;
    const allLinesCap = lightweight ? 4 : 12;
    const selectedCap = lightweight ? 1 : 3;
    const packetTokens = tokenize(packetRaw, 260);
    const packetConcepts = conceptTokensForText(packetRaw);
    const packetFrames = semanticFrameTokensForText(packetRaw);
    const sourceIndexes = uniq([messageIndex - 1, messageIndex].filter(index => index >= 0 && index < list.length), 4);
    const candidates = [];
    sourceIndexes.forEach(index => {
      evidenceCandidateLines(list[index]).forEach((line, lineIndex) => {
        const score = scoreEvidenceLine(line, packetTokens, packetConcepts, packetFrames);
        if (score < 0.025 && candidates.length >= 6) return;
        candidates.push({
          ...line,
          messageIndex: index,
          lineIndex,
          score,
          distanceFromPacket: Math.abs(Number(messageIndex) - index)
        });
      });
    });
    const selected = candidates
      .sort((a, b) => b.score - a.score || a.distanceFromPacket - b.distanceFromPacket || a.messageIndex - b.messageIndex || a.lineIndex - b.lineIndex)
      .filter((line, index, arr) => arr.findIndex(other => normalizeKey(other.text) === normalizeKey(line.text)) === index)
      .slice(0, selectedCap);
    const allLines = candidates
      .sort((a, b) => b.score - a.score || a.distanceFromPacket - b.distanceFromPacket || a.messageIndex - b.messageIndex || a.lineIndex - b.lineIndex)
      .filter((line, index, arr) => arr.findIndex(other => normalizeKey(other.text) === normalizeKey(line.text)) === index)
      .slice(0, allLinesCap)
      .map(line => compact(line.fullText || line.text, 520));
    if (!selected.length) return null;
    const allText = compact(sourceIndexes
      .map(index => stripNarrativeTags(sanitizeEvidenceBody(messageContent(list[index] || ''))))
      .filter(Boolean)
      .join('\n'), allTextCap);
    return {
      mode: lightweight ? 'packet_neighbor_excerpt_light' : 'packet_neighbor_excerpt',
      messageIndex,
      lines: selected.map(line => compact(line.text, 180)),
      allLines,
      allText,
      roles: selected.map(line => line.role),
      confidence: clamp(selected[0]?.score || 0.08, 0, 1, 0.08)
    };
  };
  const normalizeSourceEvidence = evidence => {
    if (!objectish(evidence)) return null;
    const lines = uniq(ensureArray(evidence.lines).map(line => sanitizeEvidenceLine(line)).filter(Boolean), 3);
    if (!lines.length) return null;
    const allLines = uniq([
      ...lines,
      ...ensureArray(evidence.allLines || evidence.all_lines).map(line => sanitizeEvidenceLine(line, 520)).filter(Boolean)
    ], 12);
    const allText = compact(stripNarrativeTags(sanitizeEvidenceBody(evidence.allText || evidence.all_text || '')), 14000);
    return {
      mode: evidence.mode || 'packet_neighbor_excerpt',
      messageIndex: Number.isFinite(Number(evidence.messageIndex)) ? Number(evidence.messageIndex) : null,
      lines,
      allLines,
      allText,
      roles: ensureArray(evidence.roles).map(role => compact(role, 24)).slice(0, lines.length),
      confidence: clamp(evidence.confidence, 0, 1, 0.08)
    };
  };
  const filterSourceEvidenceForRow = (evidence, axis, category, subject = '', value = {}) => {
    const normalized = normalizeSourceEvidence(evidence);
    if (!normalized?.lines?.length) return null;
    const body = [
      subject,
      category,
      itemText(value),
      surfaceTermsOf(value).join(' '),
      priorityTermsOf(value).join(' ')
    ].filter(Boolean).join(' ');
    const rowTokens = tokenize(body, 220);
    if (!rowTokens.length) return null;
    const rowConcepts = conceptTokensForText(body);
    const rowFrames = semanticFrameTokensForText(body);
    const scored = mergeValues([normalized.lines, normalized.allLines], 12).map((line, index) => {
      const role = normalized.roles?.[index] || '';
      return {
        line,
        role,
        score: scoreEvidenceLine({ role, text: line }, rowTokens, rowConcepts, rowFrames)
      };
    }).filter(item => item.score >= 0.06);
    const selected = scored
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    if (!selected.length) return null;
    return {
      ...normalized,
      lines: selected.map(item => item.line),
      roles: selected.map(item => item.role),
      confidence: clamp(Math.max(normalized.confidence || 0, selected[0]?.score || 0), 0, 1, normalized.confidence || 0.08)
    };
  };

  const performanceProfileForSettings = (settings = Memory.settings || DEFAULT_SETTINGS) => {
    const mode = effectivePerformanceModeOf(settings);
    return PERFORMANCE_PROFILES[mode] || PERFORMANCE_PROFILES.balanced;
  };
  const packetCheapTerms = value => tokenize(value, 48)
    .map(term => text(term).toLowerCase())
    .filter(term => term.length >= 2 && !/^(?:현재|지금|방금|최신|이야기|계속|이어|장면|상태|current|latest|continue|scene|story)$/.test(term))
    .slice(0, 32);
  const packetCheapRelevanceScore = (packet = {}, query = '') => {
    const raw = text(packet.cheapText || packet.raw || '').toLowerCase();
    if (!raw || !text(query).trim()) return 0;
    const terms = packetCheapTerms(query);
    if (!terms.length) return 0;
    let score = 0;
    for (const term of terms) {
      if (!term) continue;
      if (raw.includes(term)) score += term.length >= 4 ? 1.2 : 0.75;
      const canonical = CANONICAL_RECALL_TOKEN_PREFIX_RE.test(term) ? term : '';
      if (canonical && raw.includes(canonical)) score += 1.6;
    }
    const compactQuery = cleanSearchText(query).slice(0, 80);
    if (compactQuery.length >= 8 && raw.includes(compactQuery)) score += 2.5;
    return score;
  };
  const packetProtectionScore = (packet = {}) => {
    const raw = text(packet.cheapText || packet.raw || '');
    if (!raw) return 0;
    let score = 0;
    if (PROTECTED_PACKET_SIGNAL_RE.test(raw)) score += 1;
    if (HIGH_IMPORTANCE_PACKET_RE.test(raw)) score += 0.7;
    if (/"(?:secret|secrets|hidden|private|internal|deniedToEntityIds|do_not_resolve_yet|continuity_locks)"/i.test(raw)) score += 0.4;
    return score;
  };
  const selectPacketsForIngest = (packets = [], query = '', settings = Memory.settings || DEFAULT_SETTINGS) => {
    const list = ensureArray(packets).map((packet, index) => ({
      ...packet,
      packetOrdinal: index,
      packetDistanceFromLatest: Math.max(0, ensureArray(packets).length - 1 - index)
    }));
    const total = list.length;
    if (!total) return { packets: [], stats: { total: 0, full: 0, light: 0, skipped: 0, mode: effectivePerformanceModeOf(settings), configuredMode: text(settings?.mode || '') } };
    const profile = performanceProfileForSettings(settings);
    const byRecent = list.slice().sort((a, b) => a.packetDistanceFromLatest - b.packetDistanceFromLatest || a.messageIndex - b.messageIndex);
    const selected = new Map();
    const add = (packet, reason = 'selected', lightweightIngest = true) => {
      const key = packet.hash || `${packet.messageIndex}:${packet.packetOrdinal}`;
      const prev = selected.get(key);
      if (!prev) {
        selected.set(key, { ...packet, selectionReason: reason, lightweightIngest: !!lightweightIngest });
        return;
      }
      if (prev.lightweightIngest && !lightweightIngest) {
        selected.set(key, { ...prev, ...packet, selectionReason: `${prev.selectionReason || 'selected'}+${reason}`, lightweightIngest: false });
      }
    };

    byRecent.slice(0, Math.max(0, Number(profile.recentFullPackets) || 0)).forEach(packet => add(packet, 'recent_full', false));

    const old = byRecent.filter(packet => !selected.has(packet.hash || `${packet.messageIndex}:${packet.packetOrdinal}`));
    const scored = old.map(packet => {
      const relevance = packetCheapRelevanceScore(packet, query);
      const protection = packetProtectionScore(packet);
      const recency = total <= 1 ? 1 : clamp(1 - (packet.packetDistanceFromLatest / Math.max(1, total - 1)), 0, 1, 0);
      return {
        packet,
        relevance,
        protection,
        priority: relevance * 1.35 + protection * 1.1 + recency * 0.25
      };
    });

    const fullSlots = Math.max(0, (Number(profile.maxFullPackets) || 0) - Array.from(selected.values()).filter(packet => !packet.lightweightIngest).length);
    scored
      .filter(row => row.relevance >= 2.4)
      .sort((a, b) => b.relevance - a.relevance || b.protection - a.protection || a.packet.packetDistanceFromLatest - b.packet.packetDistanceFromLatest)
      .slice(0, fullSlots)
      .forEach(row => add(row.packet, 'query_full', false));

    scored
      .filter(row => row.protection > 0)
      .sort((a, b) => b.protection - a.protection || b.relevance - a.relevance || a.packet.packetDistanceFromLatest - b.packet.packetDistanceFromLatest)
      .slice(0, Math.max(0, Number(profile.protectedOldPackets) || 0))
      .forEach(row => add(row.packet, 'protected_light', true));

    scored
      .filter(row => row.relevance > 0)
      .sort((a, b) => b.relevance - a.relevance || b.protection - a.protection || a.packet.packetDistanceFromLatest - b.packet.packetDistanceFromLatest)
      .slice(0, Math.max(0, Number(profile.queryOldPackets) || 0))
      .forEach(row => add(row.packet, 'query_light', true));

    const selectedRows = Array.from(selected.values());
    const fullRows = selectedRows.filter(packet => !packet.lightweightIngest);
    const lightLimit = Math.max(0, Number(profile.maxLightPackets) || 0);
    const lightRows = selectedRows
      .filter(packet => packet.lightweightIngest)
      .sort((a, b) => {
        const scoreA = packetCheapRelevanceScore(a, query) + packetProtectionScore(a);
        const scoreB = packetCheapRelevanceScore(b, query) + packetProtectionScore(b);
        return scoreB - scoreA || a.packetDistanceFromLatest - b.packetDistanceFromLatest;
      })
      .slice(0, lightLimit);
    const finalRows = [...fullRows, ...lightRows]
      .sort((a, b) => a.packetOrdinal - b.packetOrdinal || a.messageIndex - b.messageIndex);
    return {
      packets: finalRows,
      stats: {
        total,
        selected: finalRows.length,
        full: fullRows.length,
        light: lightRows.length,
        skipped: Math.max(0, total - finalRows.length),
        mode: effectivePerformanceModeOf(settings),
        configuredMode: text(settings?.mode || ''),
        profile: clone(profile, {})
      }
    };
  };
  const PREVIOUS_TURN_RECALL_BRIDGE_CONTINUATION_RE = /(?:^|\b)(?:계속|이어|이어서|다음|좋아|응|그래|삽화|그려|continue|go\s*on|next|ok|okay|yes)(?:\b|$)/i;
  const PREVIOUS_TURN_RECALL_BRIDGE_RESET_RE = /(?:새\s*장면|장면\s*전환|다른\s*장면|다른\s*장소|시간\s*(?:건너|스킵|점프)|며칠\s*후|몇\s*시간\s*후|다음\s*날|한편|new\s*scene|scene\s*change|timeskip|time\s*skip|meanwhile|cut\s*to|next\s*day)/i;
  const previousTurnBridgeMode = query => {
    const raw = text(query).trim();
    if (!raw) return { use: true, mode: 'strong', reason: 'empty_query' };
    if (PREVIOUS_TURN_RECALL_BRIDGE_RESET_RE.test(raw)) return { use: false, mode: 'none', reason: 'scene_shift_query' };
    const terms = packetCheapTerms(raw);
    if (PREVIOUS_TURN_RECALL_BRIDGE_CONTINUATION_RE.test(raw)) return { use: true, mode: 'strong', reason: 'continuation_query' };
    if (raw.length <= PREVIOUS_TURN_RECALL_BRIDGE_SHORT_QUERY_CHARS || terms.length <= 3) return { use: true, mode: 'strong', reason: 'short_or_sparse_query' };
    return { use: true, mode: 'light', reason: 'contextual_light_bridge' };
  };
  const latestCurrentSnapshotPacket = (messages = [], packets = []) => {
    const boundary = recoveryBoundaryIndex(messages);
    let best = null;
    ensureArray(packets).forEach((packet, packetIndex) => {
      const messageIndex = Number(packet?.messageIndex);
      if (!Number.isFinite(messageIndex) || messageIndex >= boundary) return;
      const materialized = materializeExtractedPacket(packet);
      const raw = text(materialized.raw || '').trim();
      if (!raw) return;
      const parsed = safeJsonParse(raw, null);
      if (!objectish(parsed)) return;
      const packetType = recoveryPacketTypeOf(parsed) || 'current_snapshot';
      if (isRecoveryPacketType(packetType)) return;
      const rank = messageIndex * 100000 + packetIndex;
      if (!best || rank > best.rank) {
        best = { packet: materialized, parsed, packetType, messageIndex, packetIndex, rank };
      }
    });
    return best;
  };
  const previousTurnBridgeItemText = value => {
    if (value == null) return '';
    if (Array.isArray(value)) return value.map(previousTurnBridgeItemText).filter(Boolean).join(' / ');
    if (objectish(value)) {
      const direct = value.summary || value.text || value.label || value.title || value.name || value.state || value.current_state || value.currentState
        || value.event || value.delta || value.thread || value.rule || value.direction || value.hook || value.invitation || value.location || value.time;
      if (direct) return previousTurnBridgeItemText(direct);
      return compact(itemText(value), 180);
    }
    return text(value);
  };
  const previousTurnBridgeList = (values = [], limit = 8, maxChars = 140) => {
    const out = [];
    const seen = new Set();
    const visit = value => {
      if (value == null || out.length >= limit) return;
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      const body = compact(previousTurnBridgeItemText(value), maxChars);
      const key = normalizeKey(body);
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push(body);
    };
    visit(values);
    return out;
  };
  const PRONOUN_RECALL_QUERY_RE = /(?:그녀|그가|그는|그를|그에게|그 사람|그 애|걔|저 사람|이 사람|she|her|he|him|they|them|彼女|彼|あの子)/i;
  const PRONOUN_RECALL_FEMININE_RE = /(?:그녀|she|her|彼女)/i;
  const PRONOUN_RECALL_MASCULINE_RE = /(?:그가|그는|그를|그에게|he|him|彼)(?!女)/i;
  const PRONOUN_RECALL_NEUTRAL_RE = /(?:그 사람|그 애|걔|저 사람|이 사람|they|them|あの子)/i;
  const PRONOUN_RECALL_SPEECH_RE = /(?:말했|말하|대답|속삭|외치|중얼|물었|묻|said|says|speak|spoke|ask|asked|whisper|彼女|言っ|言う|答え|尋ね)/i;
  const PRONOUN_RECALL_FEMININE_HINT_RE = /(?:그녀|여성|여자|소녀|female|woman|girl|she\/her|彼女|女)/i;
  const PRONOUN_RECALL_MASCULINE_HINT_RE = /(?:남성|남자|소년|male|man|boy|he\/him|彼\b|男)/i;
  const pronounRecallIntent = query => {
    const raw = text(query);
    if (!PRONOUN_RECALL_QUERY_RE.test(raw)) return { active: false, kind: '', label: '' };
    if (PRONOUN_RECALL_FEMININE_RE.test(raw)) return { active: true, kind: 'feminine', label: 'she/her' };
    if (PRONOUN_RECALL_MASCULINE_RE.test(raw)) return { active: true, kind: 'masculine', label: 'he/him' };
    if (PRONOUN_RECALL_NEUTRAL_RE.test(raw)) return { active: true, kind: 'neutral', label: 'that person' };
    return { active: true, kind: 'ambiguous', label: 'pronoun' };
  };
  const pronounCandidateName = value => text(value?.name || value?.title || value?.label || value || '').trim();
  const pronounCandidateGender = (candidate = {}) => {
    const body = text([
      candidate.name,
      candidate.text,
      candidate.item?.gender,
      candidate.item?.sex,
      candidate.item?.pronouns,
      candidate.item?.identity,
      candidate.item?.current_state,
      candidate.item?.currentState,
      candidate.item?.condition,
      candidate.item?.summary
    ].filter(Boolean).join(' '));
    if (PRONOUN_RECALL_FEMININE_HINT_RE.test(body)) return 'feminine';
    if (PRONOUN_RECALL_MASCULINE_HINT_RE.test(body)) return 'masculine';
    return '';
  };
  const samePronounEntityName = (left = '', right = '') => {
    const a = normalizedSurface(left);
    const b = normalizedSurface(right);
    return Boolean(a && b && a === b);
  };
  const buildPronounRecallBridge = (query = '', parsed = {}, context = {}) => {
    const intent = pronounRecallIntent(query);
    if (!intent.active) return { active: false, intent, candidates: [], text: '' };
    const meta = context.meta || (objectish(parsed.meta) ? parsed.meta : {});
    const entity = context.entity || (objectish(parsed.entity) ? parsed.entity : {});
    const summaryMemory = context.summaryMemory || {};
    const sceneText = text([
      meta.turn_anchor,
      meta.turnAnchor,
      summaryMemory.summary,
      summaryMemory.text,
      summaryMemory.recallAnchors,
      summaryMemory.mentionedEntityNames,
      meta.visible_participants,
      meta.visibleParticipants,
      meta.pov_entity,
      meta.povEntity,
      meta.active_speaker,
      meta.activeSpeaker
    ].filter(Boolean).join(' '));
    const povNames = previousTurnBridgeList([meta.pov_entity, meta.povEntity], 4, 80);
    const activeSpeakerNames = previousTurnBridgeList([meta.active_speaker, meta.activeSpeaker], 4, 80);
    const visibleNames = previousTurnBridgeList([meta.visible_participants, meta.visibleParticipants], 16, 80);
    const mentionedNames = previousTurnBridgeList([summaryMemory.mentionedEntityNames, summaryMemory.mentioned_entity_names], 16, 80);
    const map = new Map();
    const ensure = (name, item = null, source = '') => {
      const clean = pronounCandidateName(name);
      if (!clean) return null;
      const key = normalizedSurface(clean);
      if (!key) return null;
      if (!map.has(key)) map.set(key, { name: clean, item: item || null, text: previousTurnBridgeItemText(item || clean), sources: new Set(), score: 0, reasons: [] });
      const row = map.get(key);
      if (item && !row.item) row.item = item;
      if (item) row.text = previousTurnBridgeItemText(item);
      if (source) row.sources.add(source);
      return row;
    };
    ensureArray(entity.characters).forEach(item => ensure(item, item, 'character'));
    [...povNames, ...activeSpeakerNames, ...visibleNames, ...mentionedNames].forEach(name => ensure(name, null, 'meta'));
    const speechIntent = PRONOUN_RECALL_SPEECH_RE.test(text(query));
    const nameInList = (name, list) => list.some(value => samePronounEntityName(name, value));
    const rows = Array.from(map.values()).map(row => {
      let score = 0.12;
      const reasons = [];
      const addScore = (value, reason) => {
        score += value;
        reasons.push(reason);
      };
      if (row.sources.has('character')) addScore(0.10, 'character_row');
      if (nameInList(row.name, povNames)) addScore(0.24, 'pov_entity');
      if (nameInList(row.name, activeSpeakerNames)) addScore(speechIntent ? 0.16 : 0.10, 'active_speaker');
      if (nameInList(row.name, visibleNames)) addScore(0.12, 'visible_participant');
      if (nameInList(row.name, mentionedNames)) addScore(0.10, 'mentioned_entity');
      if (queryMentionsAny(sceneText, [row.name])) addScore(0.20, 'scene_text');
      const gender = pronounCandidateGender(row);
      if (intent.kind === 'feminine' && gender === 'feminine') addScore(0.24, 'feminine_hint');
      if (intent.kind === 'masculine' && gender === 'masculine') addScore(0.24, 'masculine_hint');
      if (intent.kind === 'feminine' && gender === 'masculine') score -= 0.28;
      if (intent.kind === 'masculine' && gender === 'feminine') score -= 0.28;
      if (intent.kind === 'neutral' || intent.kind === 'ambiguous') addScore(0.04, 'neutral_pronoun');
      return {
        name: row.name,
        gender,
        score: clamp(score, 0, 0.95, 0),
        confidence: clamp(score, 0.15, 0.92, 0.35),
        reasons: uniq(reasons, 8)
      };
    }).filter(row => row.score > 0.1)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, PRONOUN_RECALL_BRIDGE_MAX_CANDIDATES);
    if (!rows.length) return { active: false, intent, candidates: [], text: '' };
    const topScore = rows[0]?.score || 0;
    const ambiguousTop = rows.length > 1 && topScore - rows[1].score < 0.08;
    if (rows.length > 1 && topScore - rows[1].score < 0.08) {
      rows.forEach(row => {
        row.confidence = clamp(row.confidence * 0.78, 0.15, 0.84, row.confidence);
      });
      rows[0].reasons = uniq([...rows[0].reasons, 'ambiguous_close_candidate'], 8);
    }
    let previousConfidence = 1;
    rows.forEach((row, index) => {
      const maxForRank = index === 0 ? (ambiguousTop ? 0.84 : 0.92) : Math.max(0.15, previousConfidence - 0.01);
      row.confidence = clamp(row.confidence, 0.15, maxForRank, row.confidence);
      previousConfidence = row.confidence;
    });
    const textLine = `pronoun_candidates: likely ${intent.label} referent -> ${rows.map(row => `${row.name}(confidence:${Number(row.confidence).toFixed(2)}, reasons:${row.reasons.slice(0, 4).join('+') || 'scene_anchor'})`).join(' | ')}`;
    return { active: true, intent, candidates: rows, text: textLine };
  };
  const buildPreviousTurnRecallBridge = (messages = [], packets = [], query = '', settings = Memory.settings || DEFAULT_SETTINGS) => {
    const modeInfo = previousTurnBridgeMode(query);
    if (!modeInfo.use) {
      return { active: false, mode: modeInfo.mode, reason: modeInfo.reason, query: text(query), text: '', chars: 0 };
    }
    const latest = latestCurrentSnapshotPacket(messages, packets);
    if (!latest) return { active: false, mode: modeInfo.mode, reason: 'no_previous_current_snapshot', query: text(query), text: '', chars: 0 };
    const parsed = latest.parsed || {};
    const meta = objectish(parsed.meta) ? parsed.meta : {};
    const rawSummaryMemory = meta.summary_memory ?? meta.summaryMemory;
    const summaryMemory = objectish(rawSummaryMemory) ? rawSummaryMemory : (rawSummaryMemory ? { summary: rawSummaryMemory } : {});
    const entity = objectish(parsed.entity) ? parsed.entity : {};
    const world = objectish(parsed.world) ? parsed.world : {};
    const narrative = objectish(parsed.narrative) ? parsed.narrative : {};
    const planner = objectish(parsed.planner) ? parsed.planner : {};
    const pronounBridge = buildPronounRecallBridge(query, parsed, { meta, summaryMemory, entity, world, narrative, planner });
    const lines = [];
    const add = (label, value, max = 220) => {
      const body = compact(previousTurnBridgeItemText(value), max);
      if (body) lines.push(`${label}: ${body}`);
    };
    const addList = (label, values, limit = 8, max = 120) => {
      const list = previousTurnBridgeList(values, limit, max);
      if (list.length) lines.push(`${label}: ${list.join(' | ')}`);
    };
    add('scene_id', meta.scene_id || meta.sceneId, 80);
    add('turn_anchor', meta.turn_anchor || meta.turnAnchor, 220);
    add('summary', summaryMemory.summary || summaryMemory.text, modeInfo.mode === 'strong' ? 420 : 260);
    addList('recall_anchors', [summaryMemory.recallAnchors, summaryMemory.recall_anchors], 10, 120);
    addList('canonical_anchors', [summaryMemory.canonicalAnchors, summaryMemory.canonical_anchors, summaryMemory.canonicalTokens, summaryMemory.canonical_tokens, meta.canonicalAnchors, meta.canonical_anchors], 12, 80);
    addList('mentioned_entities', [summaryMemory.mentionedEntityNames, summaryMemory.mentioned_entity_names, meta.visible_participants, meta.visibleParticipants, meta.pov_entity, meta.povEntity, meta.active_speaker, meta.activeSpeaker], 16, 80);
    if (pronounBridge.active && pronounBridge.text) lines.push(pronounBridge.text);
    add('scene_visibility', meta.scene_visibility || meta.sceneVisibility, 80);
    add('world_place_time', [world.location, world.time, world.scene_type || world.sceneType].filter(Boolean).join(' / '), 180);
    addList('world_active_events', world.active_events || world.activeEvents, modeInfo.mode === 'strong' ? 5 : 3, 150);
    addList('characters', ensureArray(entity.characters).map(item => [item?.name, item?.current_state || item?.currentState || item?.state || item?.summary, item?.condition, ensureArray(item?.carrying).join('/')].filter(Boolean).join(': ')), modeInfo.mode === 'strong' ? 5 : 3, 170);
    addList('relations', ensureArray(entity.relations).map(item => [item?.from && item?.to ? `${item.from}->${item.to}` : '', item?.state || item?.dynamic].filter(Boolean).join(': ')), modeInfo.mode === 'strong' ? 4 : 2, 150);
    add('narrative_state', [narrative.scene_phase || narrative.scenePhase, narrative.current_arc || narrative.currentArc, narrative.dominant_mood || narrative.dominantMood, narrative.pacing, narrative.time_elapsed || narrative.timeElapsed].filter(Boolean).join(' / '), 220);
    addList('conflict_traces', narrative.conflict_traces || narrative.conflictTraces, modeInfo.mode === 'strong' ? 4 : 2, 170);
    addList('scene_deltas', narrative.scene_deltas || narrative.sceneDeltas, modeInfo.mode === 'strong' ? 4 : 2, 170);
    addList('continuity_locks', planner.continuity_locks || planner.continuityLocks, modeInfo.mode === 'strong' ? 5 : 3, 160);
    addList('do_not_resolve_yet', planner.do_not_resolve_yet || planner.doNotResolveYet, modeInfo.mode === 'strong' ? 5 : 3, 160);
    addList('next_direction', planner.next_direction || planner.nextDirection, modeInfo.mode === 'strong' ? 4 : 2, 170);
    addList('open_invitations', planner.open_invitations || planner.openInvitations, modeInfo.mode === 'strong' ? 4 : 2, 170);
    const limit = modeInfo.mode === 'strong' ? PREVIOUS_TURN_RECALL_BRIDGE_STRONG_CHARS : PREVIOUS_TURN_RECALL_BRIDGE_LIGHT_CHARS;
    const bridgeText = compact(lines.join('\n'), limit);
    if (!bridgeText || bridgeText.length < 24) return { active: false, mode: modeInfo.mode, reason: 'empty_previous_turn_bridge', query: text(query), text: '', chars: 0 };
    const retrievalQuery = [text(query).trim(), bridgeText].filter(Boolean).join('\n');
    return {
      active: true,
      mode: modeInfo.mode,
      reason: modeInfo.reason,
      query: retrievalQuery,
      text: bridgeText,
      chars: bridgeText.length,
      sourceMessageIndex: latest.messageIndex,
      packetHash: latest.packet?.hash || '',
      packetType: latest.packetType,
      sceneId: text(meta.scene_id || meta.sceneId || ''),
      pronounBridge: pronounBridge.active ? {
        intent: pronounBridge.intent,
        candidates: pronounBridge.candidates
      } : null,
      preview: compact(bridgeText, 260)
    };
  };
  const lightweightPacketRaw = raw => {
    const parsed = safeJsonParse(raw, null);
    if (!parsed || typeof parsed !== 'object') return raw;
    const meta = objectish(parsed.meta) ? parsed.meta : {};
    const planner = objectish(parsed.planner) ? parsed.planner : {};
    const rawSummaryMemory = meta.summary_memory || meta.summaryMemory || null;
    const compactLightList = (value, limit = 8, maxChars = 140) => ensureArray(value)
      .map(item => compact(item?.summary || item?.text || item, maxChars))
      .filter(Boolean)
      .slice(0, limit);
    const summaryMemory = objectish(rawSummaryMemory) ? {
      summary: compact(rawSummaryMemory.summary || rawSummaryMemory.text || '', 700),
      recallAnchors: compactLightList(rawSummaryMemory.recallAnchors || rawSummaryMemory.recall_anchors, 10, 140),
      canonicalAnchors: compactLightList(rawSummaryMemory.canonicalAnchors || rawSummaryMemory.canonical_anchors || rawSummaryMemory.canonicalTokens || rawSummaryMemory.canonical_tokens, 16, 80),
      mentionedEntityNames: compactLightList(rawSummaryMemory.mentionedEntityNames || rawSummaryMemory.mentioned_entity_names, 20, 80),
      confidence: rawSummaryMemory.confidence,
      overpromotion_risks: compactLightList(rawSummaryMemory.overpromotion_risks || rawSummaryMemory.overpromotionRisks, 4, 160)
    } : rawSummaryMemory;
    const light = {
      meta: {
        schema: meta.schema || 'hayaku_packet_v1',
        packet_type: meta.packet_type || meta.packetType || 'current_snapshot',
        packet_schema_rev: meta.packet_schema_rev || meta.packetSchemaRev || 2,
        ledger_profile: meta.ledger_profile || meta.ledgerProfile || 'hidden_packet_ledger_v2',
        scene_id: meta.scene_id || meta.sceneId || '',
        turn_anchor: meta.turn_anchor || meta.turnAnchor || '',
        confidence: meta.confidence,
        pov_entity: meta.pov_entity || meta.povEntity || '',
        active_speaker: meta.active_speaker || meta.activeSpeaker || '',
        visible_participants: ensureArray(meta.visible_participants || meta.visibleParticipants).slice(0, 8),
        scene_visibility: meta.scene_visibility || meta.sceneVisibility || '',
        summary_memory: summaryMemory,
        speaker_boundaries: ensureArray(meta.speaker_boundaries || meta.speakerBoundaries).slice(0, 4),
        pattern_guard: ensureArray(meta.pattern_guard || meta.patternGuard).slice(0, 4),
        overpromotion_risks: ensureArray(meta.overpromotion_risks || meta.overpromotionRisks).slice(0, 4),
        consent_memory: meta.consent_memory || meta.consentMemory || null
      },
      planner: {
        continuity_locks: ensureArray(planner.continuity_locks || planner.continuityLocks).slice(0, 6),
        do_not_resolve_yet: ensureArray(planner.do_not_resolve_yet || planner.doNotResolveYet).slice(0, 6)
      },
      importance: parsed.importance || null
    };
    return JSON.stringify(light);
  };

  const boundedPacketStringLimit = key => {
    const k = text(key || '').trim();
    if (/^(?:summary|text|rawText|current_state|currentState|state|description|evidence|directEvidenceSnippets)$/i.test(k)) return 900;
    if (/^(?:sensory|atmosphere|worldSummary|world_summary)$/i.test(k)) return 520;
    if (/^(?:turn_anchor|turnAnchor|label|hook|delta|rule|event|reason)$/i.test(k)) return 360;
    if (/^(?:location|time|emotion|condition|attire|relation_to_user|relationToUser|power_balance|powerBalance)$/i.test(k)) return 260;
    if (/^(?:name|from|to|id|ref|status|category|type|kind)$/i.test(k)) return 120;
    if (/anchors?|tokens?|mentionedEntityNames|visible_participants|participants/i.test(k)) return 140;
    return 700;
  };
  const boundedPacketArrayLimit = key => {
    const k = text(key || '').trim();
    if (/^(?:characters|relations|active_events|activeEvents|world_rules|worldRules|factions|conflict_traces|conflictTraces|scene_deltas|sceneDeltas)$/i.test(k)) return 8;
    if (/^(?:theme_motifs|themeMotifs|recallAnchors|canonicalAnchors|canonicalTokens|mentionedEntityNames|visible_participants|visibleParticipants)$/i.test(k)) return 16;
    if (/^(?:directEvidenceSnippets|evidence|reason|carrying|speaker_boundaries|speakerBoundaries|pattern_guard|patternGuard|overpromotion_risks|overpromotionRisks)$/i.test(k)) return 8;
    if (/^(?:continuity_locks|continuityLocks|do_not_resolve_yet|doNotResolveYet|open_invitations|openInvitations|suggested_hooks|suggestedHooks)$/i.test(k)) return 8;
    return 24;
  };
  const boundedPacketValue = (value, key = '', depth = 0) => {
    if (value == null) return value;
    if (typeof value === 'string') return compact(value, boundedPacketStringLimit(key));
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.slice(0, boundedPacketArrayLimit(key)).map(item => boundedPacketValue(item, key, depth + 1));
    if (typeof value === 'object') {
      if (depth > 8) return compact(ledgerRev2Text(value), boundedPacketStringLimit(key));
      const out = {};
      for (const [childKey, childValue] of Object.entries(value)) {
        if (/^_(?:locator|retrieval|ledgerRev2)|internalId|internal_id|storeKey|store_key|locatorUri|locator_uri$/i.test(childKey)) continue;
        out[childKey] = boundedPacketValue(childValue, childKey, depth + 1);
      }
      return out;
    }
    return value;
  };
  const boundedPacketRaw = raw => {
    const parsed = safeJsonParse(raw, null);
    if (!parsed || typeof parsed !== 'object') return raw;
    try { return JSON.stringify(boundedPacketValue(parsed)); }
    catch (_) { return raw; }
  };

  // Cheap header scan helpers: balanced mode must still see very old packet anchors,
  // but it should not allocate every full packet body before the shortlist is known.
  // These helpers keep only a compact lexical sketch plus body offsets; selected
  // packets are materialized later, immediately before full/light ingest.
  const PACKET_EAGER_RAW_CHARS = 3200;
  const PACKET_CHEAP_HEAD_CHARS = 2200;
  const PACKET_CHEAP_TAIL_CHARS = 1800;
  const PACKET_CHEAP_AROUND_CHARS = 900;
  const PACKET_CHEAP_TEXT_MAX = 7200;
  const PACKET_CHEAP_SCAN_KEYS = Object.freeze([
    '"summary_memory"', '"summaryMemory"', '"recallAnchors"', '"recall_anchors"',
    '"canonicalAnchors"', '"canonical_anchors"', '"canonicalTokens"', '"canonical_tokens"',
    '"mentionedEntityNames"', '"mentioned_entity_names"', '"turn_anchor"', '"turnAnchor"',
    '"continuity_locks"', '"continuityLocks"', '"do_not_resolve_yet"', '"doNotResolveYet"',
    '"speaker_boundaries"', '"speakerBoundaries"', '"pattern_guard"', '"patternGuard"',
    '"overpromotion_risks"', '"overpromotionRisks"', '"consent_memory"', '"consentMemory"',
    '"world_rules"', '"worldRules"', '"active_events"', '"activeEvents"',
    '"characters"', '"relations"', '"importance"'
  ]);
  const PACKET_SCAN_CACHE_LIMIT = 2400;
  const syncPacketScanCacheScope = (scope = {}) => {
    const scopeKey = scope?.confident ? text(scope.key || '') : '';
    const previousScopeKey = text(Memory.packetScanScopeKey || '');
    const previousSize = Memory.packetScanCache?.size || 0;
    let cleared = false;
    if (!scopeKey || (previousScopeKey && previousScopeKey !== scopeKey)) {
      try { Memory.packetScanCache?.clear?.(); } catch (_) {}
      cleared = previousSize > 0;
    }
    Memory.packetScanScopeKey = scopeKey;
    Memory.packetScanScopeConfident = Boolean(scopeKey);
    return {
      enabled: Boolean(scopeKey),
      scopeKey,
      scopeConfident: Boolean(scopeKey),
      cleared,
      previousScopeKey,
      previousSize
    };
  };
  const packetScanCacheKey = (message = {}, payloadBody = '', candidateIndex = 0, scopeKey = '') => {
    const body = text(payloadBody || '');
    const role = roleOf(message) || '';
    const ids = mergeValues([
      message.chatId,
      message.id,
      message.msgId,
      message.messageId,
      message.uid,
      message.uuid,
      message.saying,
      message.name,
      message.time,
      message.generationInfo?.generationId,
      message.generationId
    ], 16).join('|');
    const edgeHash = stableHash64([body.slice(0, 192), body.slice(Math.max(0, body.length - 192))].join('\n'));
    const bodyHash = stableHash64(body);
    return stableHash64([PLUGIN_VERSION, scopeKey, role, ids, candidateIndex, body.length, edgeHash, bodyHash].join('\u0001'));
  };
  const getPacketScanCacheEntry = key => {
    const cache = Memory.packetScanCache;
    if (!cache || !key || !cache.has(key)) return null;
    const value = cache.get(key);
    cache.delete(key);
    cache.set(key, value);
    return value;
  };
  const setPacketScanCacheEntry = (key, value = {}) => {
    if (!key) return;
    if (!Memory.packetScanCache || typeof Memory.packetScanCache.set !== 'function') Memory.packetScanCache = new Map();
    const cache = Memory.packetScanCache;
    if (cache.has(key)) cache.delete(key);
    cache.set(key, value);
    while (cache.size > PACKET_SCAN_CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest == null) break;
      cache.delete(oldest);
    }
  };
  const packetTemplateFromScan = ({ rawStart, rawEnd, type, payloadBody = '' }) => {
    const rawLengthEstimate = Math.max(0, Number(rawEnd || 0) - Number(rawStart || 0));
    const eagerRaw = rawLengthEstimate <= PACKET_EAGER_RAW_CHARS ? text(payloadBody).slice(rawStart, rawEnd).trim() : '';
    const cheapText = eagerRaw || packetCheapTextFromBody(payloadBody, rawStart, rawEnd);
    if (!cheapText) return null;
    return {
      type,
      raw: eagerRaw,
      rawStart,
      rawEnd,
      rawLengthEstimate,
      hash: eagerRaw ? stableHash64(eagerRaw) : '',
      cheapText
    };
  };
  const pushUniqueSegment = (segments, seen, segment = '') => {
    const body = text(segment).trim();
    if (!body) return;
    const key = `${body.length}:${body.slice(0, 80)}:${body.slice(-80)}`;
    if (seen.has(key)) return;
    seen.add(key);
    segments.push(body);
  };
  const packetCheapTextFromBody = (body = '', rawStart = 0, rawEnd = 0) => {
    const src = text(body);
    const start = Math.max(0, Number(rawStart) || 0);
    const end = Math.max(start, Math.min(src.length, Number(rawEnd) || 0));
    if (end <= start) return '';
    const segments = [];
    const seen = new Set();
    pushUniqueSegment(segments, seen, src.slice(start, Math.min(end, start + PACKET_CHEAP_HEAD_CHARS)));
    if (end - start > PACKET_CHEAP_HEAD_CHARS) {
      pushUniqueSegment(segments, seen, src.slice(Math.max(start, end - PACKET_CHEAP_TAIL_CHARS), end));
    }
    for (const key of PACKET_CHEAP_SCAN_KEYS) {
      let from = start;
      let guard = 0;
      while (from < end && guard < 3) {
        const at = src.indexOf(key, from);
        if (at < 0 || at >= end) break;
        pushUniqueSegment(segments, seen, src.slice(Math.max(start, at - 80), Math.min(end, at + PACKET_CHEAP_AROUND_CHARS)));
        from = at + key.length;
        guard += 1;
      }
    }
    return compact(segments.join('\n'), PACKET_CHEAP_TEXT_MAX);
  };
  const materializeExtractedPacket = (packet = {}) => {
    if (packet.raw) {
      const raw = text(packet.raw).trim();
      return { ...packet, raw, hash: packet.hash || stableHash64(raw), rawLength: raw.length };
    }
    const body = text(packet.payloadBody || '');
    const raw = body.slice(Number(packet.rawStart || 0), Number(packet.rawEnd || 0)).trim();
    return { ...packet, raw, hash: packet.hash || stableHash64(raw), rawLength: raw.length };
  };
  const scanPacketMarkersInBody = (body = '', startNeedle = PACKET_START, endNeedle = PACKET_END, type = 'html_comment', onPacket = () => {}) => {
    const src = text(body);
    let cursor = 0;
    while (cursor < src.length) {
      const markerStart = src.indexOf(startNeedle, cursor);
      if (markerStart < 0) break;
      const rawStart = markerStart + startNeedle.length;
      const markerEnd = src.indexOf(endNeedle, rawStart);
      if (markerEnd < 0) break;
      onPacket({ rawStart, rawEnd: markerEnd, type, markerStart, markerEnd: markerEnd + endNeedle.length });
      cursor = markerEnd + endNeedle.length;
    }
  };

  const extractPackets = (messages = [], requestScope = requestScopeForMessages(messages)) => {
    const packets = [];
    const list = ensureArray(messages);
    const cacheScope = syncPacketScanCacheScope(requestScope);
    const cacheEnabled = cacheScope.enabled === true;
    const stats = {
      messages: list.length,
      messagesScanned: 0,
      assistantMessages: 0,
      payloadCandidates: 0,
      cacheHits: 0,
      cacheMisses: 0,
      packets: 0,
      eagerPackets: 0,
      lazyPackets: 0,
      scanStartIndex: 0,
      cacheSize: Memory.packetScanCache?.size || 0,
      cacheEnabled,
      cacheScopeKey: cacheScope.scopeKey || '',
      cacheScopeConfident: cacheScope.scopeConfident === true,
      cacheScopeCleared: cacheScope.cleared === true,
      mode: effectivePerformanceModeOf(Memory.settings),
      configuredMode: text(Memory.settings?.mode || '')
    };
    const canContainStatePacket = message => {
      const role = roleOf(message);
      if (!role) return false;
      return /^(assistant|model)$/i.test(role);
    };
    const profile = performanceProfileForSettings(Memory.settings);
    const maxScanMessages = Math.max(0, Number(profile.maxScanMessages || 0) || 0);
    const scanStartIndex = maxScanMessages > 0 && list.length > maxScanMessages ? list.length - maxScanMessages : 0;
    stats.scanStartIndex = scanStartIndex;
    const sourceEvidenceWindowMessages = Math.max(0, (Number(profile.sourceEvidenceRecentPackets) || 0) * 2 + 2);
    list.forEach((message, messageIndex) => {
      if (messageIndex < scanStartIndex) return;
      stats.messagesScanned += 1;
      if (!canContainStatePacket(message)) return;
      stats.assistantMessages += 1;
      const distanceFromLatest = Math.max(0, list.length - 1 - messageIndex);
      const chatRecency = list.length <= 1 ? 1 : clamp(1 - (distanceFromLatest / Math.max(1, list.length - 1)), 0, 1, 0);
      const includeSourceEvidence = distanceFromLatest <= sourceEvidenceWindowMessages;
      const meta = { messageIndex, messageCount: list.length, distanceFromLatest, chatRecency };
      rawMessagePayloadCandidates(message).forEach((body, candidateIndex) => {
        const payloadBody = text(body || '');
        if (!payloadBody || payloadBody.includes(SIDE_WRITE_TAIL_MARKER)) return;
        stats.payloadCandidates += 1;
        const cacheKey = cacheEnabled ? packetScanCacheKey(message, payloadBody, candidateIndex, cacheScope.scopeKey) : '';
        let templates = null;
        const cached = cacheEnabled ? getPacketScanCacheEntry(cacheKey) : null;
        if (cached && Array.isArray(cached.templates)) {
          templates = cached.templates;
          stats.cacheHits += 1;
        } else {
          stats.cacheMisses += 1;
          templates = [];
          const pushTemplate = ({ rawStart, rawEnd, type }) => {
            if (rawEnd <= rawStart) return;
            const template = packetTemplateFromScan({ rawStart, rawEnd, type, payloadBody });
            if (template) templates.push(template);
          };
          scanPacketMarkersInBody(payloadBody, PACKET_START, PACKET_END, 'html_comment', pushTemplate);
          scanPacketMarkersInBody(payloadBody, `<<< ${PACKET_START} >>>`, `<<< ${PACKET_END} >>>`, 'visible_marker', pushTemplate);
          if (cacheEnabled) setPacketScanCacheEntry(cacheKey, { templates, payloadLength: payloadBody.length, scopeKey: cacheScope.scopeKey, updatedAt: now() });
        }
        for (const template of templates) {
          const packet = {
            ...template,
            ...meta,
            payloadBody: template.raw ? undefined : payloadBody,
            sourceEvidence: null,
            sourceEvidenceDeferred: includeSourceEvidence,
            sourceEvidenceSkipped: !includeSourceEvidence,
            scanCacheKey: cacheKey,
            scanCacheHit: cached ? true : false
          };
          packets.push(packet);
          stats.packets += 1;
          if (packet.raw) stats.eagerPackets += 1;
          else stats.lazyPackets += 1;
        }
      });
    });
    stats.cacheSize = Memory.packetScanCache?.size || 0;
    Memory.packetScanStats = stats;
    return packets;
  };

  const axisOf = (axis, category, fallback = '') => ({ axis, category, fallback });
  const cleanPublicSegment = value => normalizeKey(value || 'item').slice(0, 48) || 'item';
  const makePublicRef = (axis, category, id, value = {}) => {
    const seed = value.ref || value.publicRef || value._public?.ref || id || value.name || value.title || value.label || itemText(value);
    return `${axis}.${category}.${cleanPublicSegment(seed)}`;
  };
  const publicRefOf = item => text(item?.ref || item?.publicRef || item?._public?.ref || '').trim();
  const publicRefMatches = (ref, axis, category) => {
    const value = text(ref).trim();
    if (!value) return false;
    return value.startsWith(`${axis}.${category}.`);
  };
  const stableDedupeKey = (axis, category, value = {}, subject = '') => {
    if (axis === 'entity' && category === 'character') {
      const primaryName = text(value.name || value.title || value.label || '').trim();
      if (primaryName) return normalizeKey(['character', primaryName].join('|'));
      const aliases = mergeValues([value.aliases, value.alias], 32);
      if (aliases.length) return normalizeKey(['character', aliases[0], ...aliases].join('|'));
      return normalizeKey(['character', subject, value.id, value.summary || itemText(value)].filter(Boolean).join('|'));
    }
    if (axis === 'entity' && category === 'relation') {
      return normalizeKey(['relation', value.from || value.entityA, value.to || value.entityB, value.label || value.type || value.relationship || value.kind || 'relation'].join('|'));
    }
    if (axis === 'entity' && category === 'pov_memory') {
      return normalizeKey(['pov_memory', value.ownerEntityId || value.owner || subject, value.memoryType || value.type, value.summary || value.text || value.id].join('|'));
    }
    if (axis === 'entity' && category === 'secret') {
      return normalizeKey(['secret', mergeValues([value.holderEntityIds, value.holders, value.ownerEntityId], 16).join(','), value.title || value.id || value.summary || value.rawText].join('|'));
    }
    if (axis === 'planner' && (category === 'continuity_lock' || category === 'do_not_resolve_yet' || category === 'payoff' || category === 'consequence')) {
      return normalizeKey([category, value.label || value.title || value.summary || value.decision || value.text || subject].join('|'));
    }
    if (axis === 'narrative' && (category === 'conflict_trace' || category === 'scene_delta' || category === 'theme_motif')) {
      return normalizeKey([category, value.label || value.title || value.summary || value.motif || subject].join('|'));
    }
    if (axis === 'world') {
      return normalizeKey([category, value.location || value.region || value.label || value.title || value.summary || value.event || value.rule || subject].join('|'));
    }
    return normalizeKey([axis, category, subject, value.id, value.label, value.title, value.summary].filter(Boolean).join('|'));
  };
  const modelForbiddenField = key => /^(?:_locator|_retrieval|_stableKey|locator|storeKey|store_key|internalId|internal_id)$/i.test(text(key));
  const stripModelForbiddenFields = value => {
    if (Array.isArray(value)) return value.map(stripModelForbiddenFields);
    if (typeof value === 'string') return value.replace(/\bhayaku:\/\/\S+/gi, '').trim();
    if (!objectish(value)) return value;
    const out = {};
    Object.entries(value).forEach(([key, body]) => {
      if (modelForbiddenField(key)) return;
      const clean = stripModelForbiddenFields(body);
      if (clean === '') return;
      out[key] = clean;
    });
    return out;
  };
  const makeLocator = (axis, category, id, field, turn, sourceHash, subject = '', value = {}, sourceMeta = {}) => ({
    schema: 'hayaku_locator_v1',
    uri: `hayaku://${axis}/${category}/${normalizeKey(id || category)}/${normalizeKey(field || 'item')}/turn_${turn}`,
    axis, category, field: field || 'item', turnId: turn, packetOrder: turn,
    subject: compact(subject || '', 100),
    source: 'side_packet_ingested_beforeRequest',
    sourceType: 'chat_packet',
    sourceScope: 'current_chat',
    anchorHash: sourceHash || '',
    sourceHash: sourceHash || '',
    messageIndex: Number.isFinite(Number(sourceMeta.messageIndex)) ? Number(sourceMeta.messageIndex) : null,
    messageCount: Number.isFinite(Number(sourceMeta.messageCount)) ? Number(sourceMeta.messageCount) : null,
    messageRange: Number.isFinite(Number(sourceMeta.messageIndex)) ? { from: Number(sourceMeta.messageIndex), to: Number(sourceMeta.messageIndex) } : null,
    distanceFromLatest: Number.isFinite(Number(sourceMeta.distanceFromLatest)) ? Number(sourceMeta.distanceFromLatest) : null,
    chatRecency: Number.isFinite(Number(sourceMeta.chatRecency)) ? clamp(sourceMeta.chatRecency, 0, 1, 0) : null,
    sourceEvidence: normalizeSourceEvidence(sourceMeta.sourceEvidence),
    createdAt: now(),
    locatorTokens: locatorTokensFor(axis, category, id, field, subject, value, { turnId: turn, field })
  });
  const makeCompactLocator = (axis, category, id, field, turn, sourceHash, subject = '', value = {}, sourceMeta = {}) => ({
    schema: 'hayaku_locator_v1',
    uri: `hayaku://${axis}/${category}/${normalizeKey(id || category)}/${normalizeKey(field || 'item')}/turn_${turn}`,
    axis,
    category,
    field: field || 'item',
    turnId: turn,
    packetOrder: turn,
    subject: compact(subject || '', 100),
    source: 'side_packet_ingested_beforeRequest',
    sourceType: 'chat_packet',
    sourceScope: 'current_chat',
    anchorHash: sourceHash || '',
    sourceHash: sourceHash || '',
    messageIndex: Number.isFinite(Number(sourceMeta.messageIndex)) ? Number(sourceMeta.messageIndex) : null,
    messageCount: Number.isFinite(Number(sourceMeta.messageCount)) ? Number(sourceMeta.messageCount) : null,
    messageRange: Number.isFinite(Number(sourceMeta.messageIndex)) ? { from: Number(sourceMeta.messageIndex), to: Number(sourceMeta.messageIndex) } : null,
    distanceFromLatest: Number.isFinite(Number(sourceMeta.distanceFromLatest)) ? Number(sourceMeta.distanceFromLatest) : null,
    chatRecency: Number.isFinite(Number(sourceMeta.chatRecency)) ? clamp(sourceMeta.chatRecency, 0, 1, 0) : null,
    sourceEvidence: null,
    createdAt: now(),
    locatorTokens: []
  });
  const compactFullRetrievalFor = (axis, category, subject, value = {}, importance = 0.5, locator = null, turn = 0) => {
    const body = compact(itemText(value), 1800);
    const canonicalAnchors = canonicalRecallTokensForValue(value).slice(0, 64);
    const priorityTerms = mergeValues([priorityTermsOf(value), canonicalAnchors], 72);
    const surfaceTokens = tokenize(surfaceTermsOf(value).join(' '), 72);
    const coreText = [subject, body, priorityTerms.join(' '), canonicalAnchors.join(' ')].filter(Boolean).join(' ');
    const tokens = tokenize(coreText, 240);
    const conceptTokens = conceptTokensForText(coreText);
    const explicitImportance = firstExplicitFinite([importance, value?.importance, value?.priority, value?.pressure, value?.score], null);
    const imp = clamp(explicitImportance == null ? 0.62 : explicitImportance, 0, 1, 0.62);
    const confidence = clamp(firstExplicitFinite([value?.confidence], 0.68), 0, 1, 0.68);
    return {
      tokens,
      entityNames: mergeValues([subject, value?.name, value?.title, value?.label, value?.aliases, value?.alias, value?.nicknames, value?.nickname], 36),
      subjectTokens: tokenize(subject || value?.name || value?.label || value?.title || '', 48),
      surfaceTokens,
      relationEndpoints: relationEndpointsOf(value),
      locatorTokens: [],
      priorityTerms,
      canonicalAnchors,
      branchTags: axis === 'entity' ? extractTags(body, ENTITY_BRANCHES) : [],
      emotionTags: extractTags(body, EMOTION_TAGS),
      worldTags: axis === 'world' ? extractTags(body, WORLD_SIGNALS) : [],
      narrativeTags: axis === 'narrative' || axis === 'planner' ? extractTags(body, NARRATIVE_TAGS) : [],
      relationTags: axis === 'entity' ? extractTags(body, RELATION_SIGNAL_TAGS) : [],
      storyTags: axis === 'narrative' || axis === 'planner' ? extractTags(body, STORY_LEDGER_HINTS) : [],
      timeTags: extractTags(body, TIME_SIGNAL_TAGS),
      locatorHintTags: [],
      emotionProfile: { tags: extractTags(body, EMOTION_TAGS), intensity: 0, relationImpact: 0 },
      reactionReachProfile: {},
      crossLingualTokens: mergeValues([crossLingualTokensForText(coreText), canonicalAnchors], 96),
      semanticFrameTokens: semanticFrameTokensForText(coreText, conceptTokens),
      sourceEvidence: null,
      sourceEvidenceTokens: [],
      worldProfile: {},
      storyProfile: {},
      timeProfile: {},
      pressure: clamp(firstExplicitFinite([value?.pressure, value?.tension, value?.urgency], 0), 0, 1, 0),
      salience: clamp(firstExplicitFinite([value?.salience, value?.importance, value?.priority], imp), 0, 1, imp),
      impression: 0,
      impressionSource: 'compact_full_ingest',
      confidence,
      confidenceSource: 'compact_full_ingest',
      entityGate: axis === 'entity' ? entityGate(subject || value?.name || value?.title || value?.label || '') : null,
      importance: imp,
      importanceInferred: imp,
      importanceSource: explicitImportance == null ? 'compact_default' : 'packet_explicit',
      chatRecency: Number.isFinite(Number(locator?.chatRecency)) ? clamp(locator.chatRecency, 0, 1, 0) : null,
      distanceFromLatest: Number.isFinite(Number(locator?.distanceFromLatest)) ? Number(locator.distanceFromLatest) : null,
      updatedAt: now(),
      subject: compact(subject || '', 100),
      axis,
      category,
      compactFullIngest: true
    };
  };
  const retrievalFor = (axis, category, subject, value, importance = 0.5, locator = null, turn = 0) => {
    const body = itemText(value);
    const emotionProfile = deriveEmotionProfile(value);
    const worldProfile = deriveWorldProfile(value);
    const storyProfile = deriveStoryProfile(axis, category, value);
    const timeProfile = extractTimeProfile(value, turn);
    const reactionReachProfile = deriveReactionReachProfile(axis, category, value);
    const priorityTerms = priorityTermsOf(value);
    const canonicalAnchors = canonicalRecallTokensForValue(value);
    const sourceEvidence = filterSourceEvidenceForRow(locator?.sourceEvidence, axis, category, subject, value);
    const sourceEvidenceText = sourceEvidence?.lines?.join(' ') || '';
    const entityNames = mergeValues([subject, value?.name, value?.title, value?.label, value?.aliases, value?.alias, value?.nicknames, value?.nickname], 48);
    const subjectTokens = tokenize(subject || '', 48);
    const surfaceTokens = tokenize(surfaceTermsOf(value).join(' '), 96);
    const relationEndpoints = relationEndpointsOf(value);
    const locatorTokens = locatorTokensFor(axis, category, value?.id || category, locator?.field || category, subject, value, locator || {});
    const inferredPressure = Math.max(
      Number(emotionProfile.intensity || 0),
      Number(emotionProfile.relationImpact || 0),
      Number(worldProfile.pressure || 0),
      Number(storyProfile.priority || 0)
    );
    const pressure = clamp(firstExplicitFinite([value?.pressure, value?.tension, value?.urgency], inferredPressure), 0, 1, inferredPressure);
    const inferredImportance = inferImportance(axis, value, category);
    const hasExplicitImportance = importance != null && importance !== '' && Number.isFinite(Number(importance));
    const explicitImportance = clamp(hasExplicitImportance ? importance : inferredImportance, 0, 1, inferredImportance);
    const inferredSalience = clamp(
      pressure * 0.42
      + explicitImportance * 0.25
      + surfaceTokens.length * 0.006
      + timeProfile.recencyAnchor * 0.12
      + (value?.primary === true || value?.active === true ? 0.14 : 0),
      0, 1, 0.35
    );
    const salience = clamp(firstExplicitFinite([value?.salience], inferredSalience), 0, 1, inferredSalience);
    const impression = clamp(firstExplicitFinite([value?.impression], deriveEmotionImpression(emotionProfile)), 0, 1, deriveEmotionImpression(emotionProfile));
    const entityGateResult = axis === 'entity' ? entityGate(subject || value?.name || value?.title || value?.label || '') : null;
    const inferredConfidence = clamp(
      0.52
      + (entityGateResult ? (entityGateResult.confidence - 0.3) * 0.35 : 0)
      + (body.length > 30 ? 0.1 : 0)
      + (surfaceTokens.length > 4 ? 0.08 : 0)
      - (entityGateResult && !entityGateResult.allowed ? 0.22 : 0),
      0, 1, 0.55
    );
    const explicitConfidence = firstExplicitFinite([value?.confidence], null);
    const qualityAdjustedConfidence = value?._confidenceQualityAdjusted === true && explicitConfidence != null;
    const modelExplicitConfidence = value?._confidenceExplicit === true || (!objectish(value?._packetQuality) && explicitConfidence != null && explicitConfidence > 0);
    const usableExplicitConfidence = explicitConfidence != null && (qualityAdjustedConfidence || (modelExplicitConfidence && explicitConfidence > 0));
    const confidence = !usableExplicitConfidence
      ? inferredConfidence
      : clamp(Math.min(inferredConfidence, explicitConfidence), 0, 1, inferredConfidence);
    return {
      tokens: tokenize([subject, body, surfaceTermsOf(value).join(' '), priorityTerms.join(' '), canonicalAnchors.join(' '), sourceEvidenceText].filter(Boolean).join(' '), 340),
      entityNames,
      subjectTokens,
      surfaceTokens,
      relationEndpoints,
      locatorTokens,
      priorityTerms: mergeValues([priorityTerms, canonicalAnchors], 96),
      canonicalAnchors,
      branchTags: axis === 'entity' ? extractTags(body, ENTITY_BRANCHES) : [],
      emotionTags: emotionProfile.tags,
      worldTags: axis === 'world' ? worldProfile.tags : [],
      narrativeTags: axis === 'narrative' || axis === 'planner' ? extractTags(body, NARRATIVE_TAGS) : [],
      relationTags: axis === 'entity' ? extractTags(body, RELATION_SIGNAL_TAGS) : [],
      storyTags: axis === 'narrative' || axis === 'planner' ? storyProfile.tags : [],
      timeTags: timeProfile.tags,
      locatorHintTags: extractTags([body, locator?.uri, locator?.field, value?.publicRef].filter(Boolean).join(' '), LOCATOR_HINT_TAGS),
      emotionProfile,
      reactionReachProfile,
      crossLingualTokens: mergeValues([crossLingualTokensForText(body), canonicalAnchors], 128),
      semanticFrameTokens: semanticFrameTokensForText(body),
      sourceEvidence,
      sourceEvidenceTokens: tokenize(sourceEvidenceText, 120),
      worldProfile,
      storyProfile,
      timeProfile,
      pressure,
      salience,
      impression,
      impressionSource: value?.impression != null ? 'packet_explicit' : 'emotion_analysis_engine',
      confidence,
      confidenceSource: !usableExplicitConfidence ? 'retrieval_inferred' : (qualityAdjustedConfidence ? 'packet_quality_cap' : 'packet_explicit_cap'),
      entityGate: entityGateResult,
      importance: explicitImportance,
      importanceInferred: inferredImportance,
      importanceSource: hasExplicitImportance ? 'packet_explicit' : 'emotion_analysis_engine',
      chatRecency: Number.isFinite(Number(locator?.chatRecency)) ? clamp(locator.chatRecency, 0, 1, 0) : null,
      distanceFromLatest: Number.isFinite(Number(locator?.distanceFromLatest)) ? Number(locator.distanceFromLatest) : null,
      updatedAt: now(),
      subject: compact(subject || '', 100),
      axis, category
    };
  };
  const inferImportance = (axis, value, category = '') => {
    const emotion = deriveEmotionProfile(value);
    const importanceCategory = category || value?.type || value?.kind || '';
    const reach = deriveReactionReachProfile(axis, importanceCategory, value);
    return deriveEmotionImportance(axis, importanceCategory, value, emotion, reach);
  };
  const decorateItem = (axis, category, item, turn, sourceHash, subject = '', field = '', sourceMeta = {}) => {
    const value = stripModelForbiddenFields((item && typeof item === 'object' && !Array.isArray(item)) ? clone(item, {}) : { text: text(item) });
    const gateSubject = subject || value.name || value.title || value.label || '';
    const gate = axis === 'entity' && (category === 'character' || category === 'relation') ? entityGate(gateSubject) : null;
    if (gate && !gate.allowed) {
      return null;
    }
    const rawIncomingRef = publicRefOf(value);
    const incomingRef = publicRefMatches(rawIncomingRef, axis, category) ? rawIncomingRef : '';
    if (rawIncomingRef) value._sourceRef = rawIncomingRef;
    if (rawIncomingRef && !incomingRef) {
      delete value.ref;
      delete value.publicRef;
      if (objectish(value._public)) delete value._public.ref;
    }
    if (!value.summary && itemText(value)) value.summary = compact(itemText(value), 420);
    if (axis === 'narrative' && category === 'conflict_trace' && !value.type) value.type = inferConflictType(value);
    if (axis === 'planner' && category === 'do_not_resolve_yet' && !value.kind) value.kind = 'doNotResolveYet';
    if (axis === 'planner' && category === 'continuity_lock' && !value.kind) value.kind = 'continuityLock';
    if (value.immediate_result && !value.immediateResult) value.immediateResult = value.immediate_result;
    if (value.delayed_effect && !value.delayedEffect) value.delayedEffect = value.delayed_effect;
    if (value.scene_phase && !value.scenePhase) value.scenePhase = value.scene_phase;
    if (value.current_arc && !value.currentArc) value.currentArc = value.current_arc;
    const idSeed = [subject, value.id, value.name, value.title, value.label, value.summary, itemText(value)].filter(Boolean).join('|');
    const id = value.id || `${category}_${stableHash64(incomingRef || idSeed)}`;
    const imp = firstExplicitFinite([value.importance, value.priority, value.pressure, value.score], null);
    value.id = id;
    value.publicRef = incomingRef || makePublicRef(axis, category, id, value);
    value._stableKey = stableDedupeKey(axis, category, value, subject || value.name || value.title || value.label || category);
    value._public = { ...(value._public || {}), ref: value.publicRef, axis, category };
    delete value.ref;
    const retrievalSubject = subject || value.name || value.title || value.label || category;
    if (sourceMeta?.compactFullIngest === true) {
      value._locator = makeCompactLocator(axis, category, id, field || value.name || value.label || value.title || category, turn, sourceHash, retrievalSubject, value, sourceMeta);
      value._retrieval = compactFullRetrievalFor(axis, category, retrievalSubject, value, imp, value._locator, turn);
      value._compactFullIngest = true;
    } else {
      value._locator = makeLocator(axis, category, id, field || value.name || value.label || value.title || category, turn, sourceHash, retrievalSubject, value, sourceMeta);
      value._retrieval = retrievalFor(axis, category, retrievalSubject, value, imp, value._locator, turn);
    }
    return value;
  };
  const upsertList = (list, items, keyFn, limit = 120) => {
    const out = Array.isArray(list) ? list.slice() : [];
    for (const item of ensureArray(items).filter(Boolean)) {
      const stableKey = text(item._stableKey || '').trim();
      const key = stableKey || (publicRefOf(item) ? normalizeKey(publicRefOf(item)) : keyFn(item));
      if (!key) continue;
      const idx = out.findIndex(existing => {
        const existingStableKey = text(existing?._stableKey || '').trim();
        if (stableKey && existingStableKey && stableKey === existingStableKey) return true;
        const existingRef = publicRefOf(existing);
        if (existingRef && publicRefOf(item)) return normalizeKey(existingRef) === normalizeKey(publicRefOf(item));
        return keyFn(existing) === key;
      });
      if (idx >= 0) {
        const merged = { ...out[idx], ...item, _stableKey: item._stableKey || out[idx]._stableKey, _locator: item._locator, _retrieval: item._retrieval };
        if (item._packetQuality && !Object.prototype.hasOwnProperty.call(item, 'qualityFlags')) {
          const flags = mergeValues([merged.qualityFlags], 16).filter(flag => !/^packet_quality_(?:low|softened)$/i.test(text(flag)));
          if (flags.length) merged.qualityFlags = flags;
          else delete merged.qualityFlags;
        }
        out[idx] = merged;
      }
      else out.unshift(item);
    }
    return out
      .sort((a, b) => Number(b?._retrieval?.importance || 0) - Number(a?._retrieval?.importance || 0) || Number(b?._retrieval?.updatedAt || 0) - Number(a?._retrieval?.updatedAt || 0))
      .slice(0, limit);
  };
  const characterPrimaryKey = item => normalizeKey(item?.name || item?.title || item?.label || '');
  const characterPublicRefIdentityConflict = (left = {}, right = {}) => {
    const leftKey = characterPrimaryKey(left);
    const rightKey = characterPrimaryKey(right);
    return Boolean(leftKey && rightKey && leftKey !== rightKey);
  };
  const regenerateCharacterPublicRef = (item, turn, packetHash, sourceMeta = {}) => {
    const out = { ...item };
    const subject = out.name || out.title || out.label || 'character';
    const seed = [out._stableKey, subject, out.current_state, out.summary, itemText(out)].filter(Boolean).join('|');
    out.id = `character_${stableHash64(seed || subject)}`;
    out.publicRef = `entity.character.${cleanPublicSegment(out.id)}`;
    out._public = { ...(out._public || {}), ref: out.publicRef, axis: 'entity', category: 'character' };
    out.riskFlags = mergeValues([out.riskFlags, 'public_ref_identity_conflict_rekeyed'], 16);
    const imp = firstExplicitFinite([out.importance, out.priority, out.pressure, out.score], null);
    out._locator = makeLocator('entity', 'character', out.id, subject, turn, packetHash, subject, out, sourceMeta);
    out._retrieval = retrievalFor('entity', 'character', subject, out, imp, out._locator, turn);
    return out;
  };
  const splitConflictingCharacterPublicRefs = (incoming = [], previous = [], turn, packetHash, sourceMeta = {}) => {
    const accepted = ensureArray(previous).filter(Boolean).slice();
    let hadConflict = false;
    const items = ensureArray(incoming).filter(Boolean).map(item => {
      const ref = publicRefOf(item);
      if (!ref) {
        accepted.push(item);
        return item;
      }
      const conflict = accepted.find(existing => {
        const existingRef = publicRefOf(existing);
        return existingRef && normalizeKey(existingRef) === normalizeKey(ref) && characterPublicRefIdentityConflict(existing, item);
      });
      if (!conflict) {
        accepted.push(item);
        return item;
      }
      hadConflict = true;
      let rekeyed = regenerateCharacterPublicRef(item, turn, packetHash, sourceMeta);
      let suffix = 1;
      while (accepted.some(existing => normalizeKey(publicRefOf(existing)) === normalizeKey(rekeyed.publicRef))) {
        rekeyed = {
          ...rekeyed,
          id: `character_${stableHash64([rekeyed._stableKey, rekeyed.name, suffix++].filter(Boolean).join('|'))}`
        };
        rekeyed.publicRef = `entity.character.${cleanPublicSegment(rekeyed.id)}`;
        rekeyed._public = { ...(rekeyed._public || {}), ref: rekeyed.publicRef, axis: 'entity', category: 'character' };
        rekeyed._locator = makeLocator('entity', 'character', rekeyed.id, rekeyed.name || rekeyed.title || 'character', turn, packetHash, rekeyed.name || rekeyed.title || 'character', rekeyed, sourceMeta);
        rekeyed._retrieval = retrievalFor('entity', 'character', rekeyed.name || rekeyed.title || 'character', rekeyed, firstExplicitFinite([rekeyed.importance, rekeyed.priority, rekeyed.pressure, rekeyed.score], null), rekeyed._locator, turn);
      }
      accepted.push(rekeyed);
      return rekeyed;
    });
    return { items, hadConflict };
  };
  const publicRefSegment = value => {
    const raw = text(value || '').trim();
    if (!raw) return '';
    return raw.split('.').filter(Boolean).pop() || raw;
  };
  const characterEndpointMap = (...groups) => {
    const map = new Map();
    const add = (key, canonical) => {
      const normalized = normalizeKey(key);
      if (normalized && canonical && !map.has(normalized)) map.set(normalized, canonical);
    };
    ensureArray(groups).flatMap(group => ensureArray(group)).filter(Boolean).forEach(character => {
      const canonical = text(character.name || character.title || character.label || '').trim();
      if (!canonical) return;
      const refs = mergeValues([
        character.publicRef,
        character._sourceRef,
        character.id,
        publicRefSegment(character.publicRef),
        publicRefSegment(character._sourceRef)
      ], 24);
      mergeValues([
        canonical,
        character.title,
        character.label,
        character.aliases,
        character.alias,
        character.nicknames,
        character.nickname,
        refs
      ], 80).forEach(value => add(value, canonical));
    });
    return map;
  };
  const canonicalRelationEndpoint = (value, endpointMap) => {
    const raw = text(value || '').trim();
    if (!raw) return '';
    const direct = endpointMap.get(normalizeKey(raw));
    if (direct) return direct;
    const segment = publicRefSegment(raw);
    const segmented = segment && segment !== raw ? endpointMap.get(normalizeKey(segment)) : '';
    return segmented || raw;
  };
  const refreshDecoratedItem = (axis, category, item, turn, packetHash, subject = '', field = '', sourceMeta = {}) => {
    if (!objectish(item)) return item;
    const imp = firstExplicitFinite([item.importance, item.priority, item.pressure, item.score], null);
    const id = item.id || `${category}_${stableHash64([subject, itemText(item)].filter(Boolean).join('|'))}`;
    const next = {
      ...item,
      id,
      _stableKey: stableDedupeKey(axis, category, item, subject || item.name || item.title || item.label || category)
    };
    const retrievalSubject = subject || next.name || next.title || next.label || category;
    if (sourceMeta?.compactFullIngest === true) {
      next._locator = makeCompactLocator(axis, category, id, field || next.name || next.label || next.title || category, turn, packetHash, retrievalSubject, next, sourceMeta);
      next._retrieval = compactFullRetrievalFor(axis, category, retrievalSubject, next, imp, next._locator, turn);
      next._compactFullIngest = true;
    } else {
      next._locator = makeLocator(axis, category, id, field || next.name || next.label || next.title || category, turn, packetHash, retrievalSubject, next, sourceMeta);
      next._retrieval = retrievalFor(axis, category, retrievalSubject, next, imp, next._locator, turn);
    }
    return next;
  };
  const canonicalizeRelations = (relations = [], characterGroups = [], turn, packetHash, sourceMeta = {}) => {
    const endpointMap = characterEndpointMap(...ensureArray(characterGroups));
    if (!endpointMap.size) return ensureArray(relations).filter(Boolean);
    return ensureArray(relations).filter(Boolean).map(relation => {
      const from = canonicalRelationEndpoint(relation.from || relation.entityA || relation.source, endpointMap);
      const to = canonicalRelationEndpoint(relation.to || relation.entityB || relation.target, endpointMap);
      const next = { ...relation };
      if (from) next.from = from;
      if (to) next.to = to;
      const subject = [next.from, next.to].filter(Boolean).join('_') || next.label || 'relation';
      return refreshDecoratedItem('entity', 'relation', next, turn, packetHash, subject, 'relation', sourceMeta);
    });
  };
  const hydratedRetrieval = (axis, category, item) => {
    const subject = item.name || item.label || item.title || item.from || item.to || '';
    const previous = objectish(item?._retrieval) ? item._retrieval : null;
    const previousReusable = previous
      && previous.axis === axis
      && previous.category === category
      && ensureArray(previous.tokens).length
      && ensureArray(previous.subjectTokens).length
      && objectish(previous.emotionProfile)
      && objectish(previous.worldProfile)
      && objectish(previous.storyProfile)
      && objectish(previous.timeProfile);
    if (previousReusable) {
      const locator = item?._locator || {};
      const fallbackEvidence = !previous.sourceEvidence && locator.sourceEvidence
        ? filterSourceEvidenceForRow(locator.sourceEvidence, axis, category, subject, item)
        : null;
      const sourceEvidence = previous.sourceEvidence || fallbackEvidence || null;
      const sourceEvidenceTokens = fallbackEvidence
        ? tokenize(fallbackEvidence?.lines?.join(' ') || '', 120)
        : (sourceEvidence ? previous.sourceEvidenceTokens || [] : []);
      const refreshedTokens = fallbackEvidence
        ? tokenize([
          subject,
          itemText(item),
          surfaceTermsOf(item).join(' '),
          priorityTermsOf(item).join(' '),
          fallbackEvidence?.lines?.join(' ') || ''
        ].filter(Boolean).join(' '), 300)
        : [];
      return {
        ...previous,
        tokens: refreshedTokens.length ? refreshedTokens : previous.tokens,
        sourceEvidence,
        sourceEvidenceTokens,
        chatRecency: Number.isFinite(Number(previous.chatRecency ?? locator.chatRecency))
          ? clamp(previous.chatRecency ?? locator.chatRecency, 0, 1, 0)
          : null,
        distanceFromLatest: Number.isFinite(Number(previous.distanceFromLatest ?? locator.distanceFromLatest))
          ? Number(previous.distanceFromLatest ?? locator.distanceFromLatest)
          : null
      };
    }
    const base = retrievalFor(axis, category, subject, item, firstFinite([item?._retrieval?.importance, item?.importance, item?.priority], inferImportance(axis, item)), item?._locator || null, item?._locator?.turnId || 0);
    const previousFallback = previous || {};
    const sourceEvidence = filterSourceEvidenceForRow(previousFallback.sourceEvidence || item?._locator?.sourceEvidence || base.sourceEvidence, axis, category, subject, item) || base.sourceEvidence;
    const sourceEvidenceTokens = tokenize(sourceEvidence?.lines?.join(' ') || '', 120);
    const hydratedTokens = tokenize([
      subject,
      itemText(item),
      surfaceTermsOf(item).join(' '),
      priorityTermsOf(item).join(' '),
      sourceEvidence?.lines?.join(' ') || ''
    ].filter(Boolean).join(' '), 300);
    return {
      ...base,
      ...previousFallback,
      tokens: hydratedTokens.length ? hydratedTokens : base.tokens,
      subjectTokens: previousFallback.subjectTokens?.length ? previousFallback.subjectTokens : base.subjectTokens,
      surfaceTokens: previousFallback.surfaceTokens?.length ? previousFallback.surfaceTokens : base.surfaceTokens,
      relationEndpoints: previousFallback.relationEndpoints?.length ? previousFallback.relationEndpoints : base.relationEndpoints,
      locatorTokens: previousFallback.locatorTokens?.length ? previousFallback.locatorTokens : base.locatorTokens,
      priorityTerms: previousFallback.priorityTerms?.length ? previousFallback.priorityTerms : base.priorityTerms,
      timeTags: previousFallback.timeTags?.length ? previousFallback.timeTags : base.timeTags,
      locatorHintTags: previousFallback.locatorHintTags?.length ? previousFallback.locatorHintTags : base.locatorHintTags,
      crossLingualTokens: previousFallback.crossLingualTokens?.length ? mergeValues([previousFallback.crossLingualTokens, base.canonicalAnchors], 128) : base.crossLingualTokens,
      canonicalAnchors: previousFallback.canonicalAnchors?.length ? mergeValues([previousFallback.canonicalAnchors, base.canonicalAnchors], 128) : base.canonicalAnchors,
      semanticFrameTokens: previousFallback.semanticFrameTokens?.length ? previousFallback.semanticFrameTokens : base.semanticFrameTokens,
      sourceEvidence,
      sourceEvidenceTokens,
      emotionProfile: { ...base.emotionProfile, ...(previousFallback.emotionProfile || {}) },
      reactionReachProfile: { ...base.reactionReachProfile, ...(previousFallback.reactionReachProfile || {}) },
      worldProfile: { ...base.worldProfile, ...(previousFallback.worldProfile || {}) },
      storyProfile: { ...base.storyProfile, ...(previousFallback.storyProfile || {}) },
      timeProfile: { ...base.timeProfile, ...(previousFallback.timeProfile || {}) },
      salience: clamp(previousFallback.salience ?? base.salience, 0, 1, base.salience),
      impression: clamp(previousFallback.impression ?? base.impression, 0, 1, base.impression),
      impressionSource: previousFallback.impressionSource || base.impressionSource || 'emotion_analysis_engine',
      importanceInferred: clamp(previousFallback.importanceInferred ?? base.importanceInferred, 0, 1, base.importanceInferred),
      importanceSource: previousFallback.importanceSource || base.importanceSource || 'emotion_analysis_engine',
      confidence: clamp(previousFallback.confidence ?? base.confidence, 0, 1, base.confidence),
      confidenceSource: previousFallback.confidenceSource || base.confidenceSource || 'retrieval_inferred',
      pressure: clamp(previousFallback.pressure ?? base.pressure, 0, 1, base.pressure),
      chatRecency: Number.isFinite(Number(previousFallback.chatRecency ?? item?._locator?.chatRecency ?? base.chatRecency))
        ? clamp(previousFallback.chatRecency ?? item?._locator?.chatRecency ?? base.chatRecency, 0, 1, 0)
        : null,
      distanceFromLatest: Number.isFinite(Number(previousFallback.distanceFromLatest ?? item?._locator?.distanceFromLatest))
        ? Number(previousFallback.distanceFromLatest ?? item?._locator?.distanceFromLatest)
        : null
    };
  };

  const cheapLightRetrieval = (axis, category, subject = '', body = '', item = {}, sourceMeta = {}) => {
    const sourceText = [subject, body, ensureArray(item?.recallAnchors).join(' '), ensureArray(item?.canonicalAnchors).join(' '), ensureArray(item?.mentionedEntityNames).join(' ')].filter(Boolean).join(' ');
    const canonicalAnchors = mergeValues([item?.canonicalAnchors, canonicalRecallTokensForText(sourceText)], 48);
    const tokens = tokenize([sourceText, canonicalAnchors.join(' ')].filter(Boolean).join(' '), 180);
    const subjectTokens = tokenize(subject || body, 64);
    const conceptTokens = conceptTokensForText(sourceText);
    const importance = clamp(firstFinite([item?.importance, item?.priority, item?.pressure], 0.62), 0, 1, 0.62);
    return {
      axis,
      category,
      tokens: tokens.length ? tokens : tokenize(body || subject || category, 80),
      subjectTokens: subjectTokens.length ? subjectTokens : tokenize(body || subject || category, 32),
      surfaceTokens: tokenize(body || subject || '', 80),
      relationEndpoints: [],
      locatorTokens: [],
      priorityTerms: mergeValues([item?.recallAnchors, item?.canonicalAnchors, canonicalAnchors, item?.mentionedEntityNames], 48),
      emotionTags: [],
      branchTags: [],
      worldTags: [],
      narrativeTags: [],
      relationTags: [],
      storyTags: [],
      timeTags: [],
      locatorHintTags: [],
      crossLingualTokens: canonicalAnchors,
      canonicalAnchors,
      semanticFrameTokens: semanticFrameTokensForText(sourceText, conceptTokens),
      sourceEvidence: null,
      sourceEvidenceTokens: [],
      emotionProfile: {},
      reactionReachProfile: {},
      worldProfile: {},
      storyProfile: {},
      timeProfile: {},
      pressure: 0,
      salience: clamp(firstFinite([item?.salience, item?.importance], 0.62), 0, 1, 0.62),
      impression: 0,
      impressionSource: 'light_packet_ingest',
      confidence: clamp(firstFinite([item?.confidence], 0.68), 0, 1, 0.68),
      confidenceSource: 'light_packet_ingest',
      importance,
      importanceInferred: importance,
      importanceSource: 'light_packet_ingest',
      chatRecency: Number.isFinite(Number(sourceMeta.chatRecency)) ? clamp(sourceMeta.chatRecency, 0, 1, 0) : null,
      distanceFromLatest: Number.isFinite(Number(sourceMeta.distanceFromLatest)) ? Number(sourceMeta.distanceFromLatest) : null,
      updatedAt: now(),
      subject: compact(subject || '', 100)
    };
  };
  const makeLightIngestItem = (axis, category, item = {}, packetHash = '', sourceMeta = {}) => {
    const body = compact(ledgerRev2Text([item.summary, item.text, item.label, item.title, item.state, item.recallAnchors, item.canonicalAnchors, item.mentionedEntityNames]), 1200);
    const subject = compact(item.name || item.label || item.title || item.summary || body || category, 180);
    const id = item.id || item.ref || `light_${category}_${packetHash || stableHash64(body || subject || category)}`;
    const publicRef = makePublicRef(axis, category, id, { ...item, summary: subject || body });
    const out = {
      ...item,
      id,
      publicRef,
      summary: compact(item.summary || item.text || subject || body, 700),
      text: compact(item.text || body || subject, 1200),
      confidence: clamp(firstFinite([item.confidence], 0.68), 0, 1, 0.68),
      importance: clamp(firstFinite([item.importance, item.priority], 0.62), 0, 1, 0.62),
      sourceType: `hayaku_light_packet_${category}`,
      sourceScope: 'hidden_packet_light_ingest',
      _stableKey: normalizeKey([axis, category, publicRef, id, subject || body].join('|')),
      _lightIngest: true,
      _packetHash: packetHash
    };
    out._retrieval = cheapLightRetrieval(axis, category, subject, body, out, sourceMeta);
    return out;
  };
  const ingestLightPacketToStore = (store, packetRaw, packetHash, sourceMeta = {}) => {
    if (!packetRaw || store.ingestedPacketHashes.includes(packetHash)) return { ok: true, skipped: true, light: true };
    const parsed = safeJsonParse(packetRaw, null);
    if (!parsed || typeof parsed !== 'object') return { ok: false, reason: 'json_parse_failed', light: true };
    const meta = objectish(parsed.meta) ? parsed.meta : {};
    const planner = objectish(parsed.planner) ? parsed.planner : {};
    const rawSummary = meta.summary_memory || meta.summaryMemory || null;
    const packetImportanceRaw = parsed.importance?.overall ?? parsed.importance?.score ?? parsed.importance ?? null;
    const packetImportance = Number.isFinite(Number(packetImportanceRaw)) ? clamp(packetImportanceRaw, 0, 1, 0.62) : 0.62;
    store.turn = Math.max(Number(store.turn || 0) + 1, Number(parsed.turn || meta.turn_hint || meta.turnHint || 0) || 0);
    const lightItems = [];
    if (objectish(rawSummary)) {
      lightItems.push(makeLightIngestItem('narrative', 'summary_memory', {
        id: `light_summary_${packetHash}`,
        summary: rawSummary.summary || rawSummary.text || meta.turn_anchor || meta.turnAnchor || '',
        text: [rawSummary.summary, ensureArray(rawSummary.recallAnchors || rawSummary.recall_anchors).join(' '), ensureArray(rawSummary.canonicalAnchors || rawSummary.canonical_anchors || rawSummary.canonicalTokens || rawSummary.canonical_tokens).join(' '), ensureArray(rawSummary.mentionedEntityNames || rawSummary.mentioned_entity_names).join(' ')].filter(Boolean).join('\n'),
        recallAnchors: ensureArray(rawSummary.recallAnchors || rawSummary.recall_anchors).slice(0, 12),
        canonicalAnchors: mergeValues([rawSummary.canonicalAnchors, rawSummary.canonical_anchors, rawSummary.canonicalTokens, rawSummary.canonical_tokens], 24),
        mentionedEntityNames: ensureArray(rawSummary.mentionedEntityNames || rawSummary.mentioned_entity_names).slice(0, 24),
        confidence: rawSummary.confidence ?? meta.confidence,
        importance: packetImportance,
        salience: 0.72,
        scene_id: meta.scene_id || meta.sceneId || ''
      }, packetHash, sourceMeta));
    } else if (meta.turn_anchor || meta.turnAnchor) {
      lightItems.push(makeLightIngestItem('narrative', 'summary_memory', {
        id: `light_anchor_${packetHash}`,
        summary: meta.turn_anchor || meta.turnAnchor,
        text: meta.turn_anchor || meta.turnAnchor,
        confidence: meta.confidence,
        importance: packetImportance,
        scene_id: meta.scene_id || meta.sceneId || ''
      }, packetHash, sourceMeta));
    }
    if (lightItems.length) {
      store.memory.summaries = upsertList(store.memory.summaries, lightItems, item => normalizeKey(item.publicRef || item.id || item.summary || ''), 120);
    }
    const pushPlannerLight = (values, category, limit = 6) => {
      const rows = ensureArray(values).slice(0, limit).map((raw, index) => {
        const item = objectish(raw) ? raw : { label: compact(raw, 240), summary: compact(raw, 240) };
        return makeLightIngestItem('planner', category, {
          id: item.id || item.ref || `light_${category}_${packetHash}_${index}`,
          label: item.label || item.title || item.summary || item.text || compact(raw, 180),
          summary: item.summary || item.text || item.label || item.title || compact(raw, 260),
          text: item.text || item.summary || item.label || item.title || compact(raw, 320),
          status: item.status || 'active',
          importance: clamp(firstFinite([item.importance, packetImportance], packetImportance), 0, 1, packetImportance),
          confidence: item.confidence ?? meta.confidence,
          scene_id: item.scene_id || item.sceneId || meta.scene_id || meta.sceneId || ''
        }, packetHash, sourceMeta);
      }).filter(Boolean);
      if (!rows.length) return;
      if (category === 'continuity_lock') store.planner.continuityLocks = upsertList(store.planner.continuityLocks, rows, item => normalizeKey(item.publicRef || item.id || item.label || item.summary || ''), 80);
      else if (category === 'do_not_resolve_yet') store.planner.doNotResolveYet = upsertList(store.planner.doNotResolveYet, rows, item => normalizeKey(item.publicRef || item.id || item.label || item.summary || ''), 80);
      else store.planner.items = upsertList(store.planner.items, rows, item => normalizeKey(item.publicRef || item.id || item.label || item.summary || ''), 120);
    };
    pushPlannerLight(planner.continuity_locks || planner.continuityLocks, 'continuity_lock', 6);
    pushPlannerLight(planner.do_not_resolve_yet || planner.doNotResolveYet, 'do_not_resolve_yet', 6);
    pushPlannerLight(meta.speaker_boundaries || meta.speakerBoundaries, 'speaker_boundary', 4);
    pushPlannerLight(meta.pattern_guard || meta.patternGuard, 'pattern_guard', 4);
    pushPlannerLight(meta.overpromotion_risks || meta.overpromotionRisks, 'overpromotion_risk', 4);
    store.ingestedPacketHashes = uniq([packetHash, ...store.ingestedPacketHashes], 300);
    store.stats.packets = Number(store.stats.packets || 0) + 1;
    store.stats.lastIngestAt = now();
    return { ok: true, skipped: false, light: true };
  };

  const ingestPacket = (store, packetRaw, packetHash, sourceMeta = {}) => {
    if (!packetRaw || store.ingestedPacketHashes.includes(packetHash)) return { ok: true, skipped: true };
    const parsed = safeJsonParse(packetRaw, null);
    if (!parsed || typeof parsed !== 'object') return { ok: false, reason: 'json_parse_failed' };
    const packetShapeWarnings = validatePacketShape(parsed);
    coercePacketCollections(parsed);
    const packetMeta = objectish(parsed.meta) ? parsed.meta : {};
    store.turn = Math.max(Number(store.turn || 0) + 1, Number(parsed.turn || packetMeta.turn_hint || packetMeta.turnHint || 0) || 0);
    const turn = store.turn;
    const packetImportanceRaw = parsed.importance?.overall ?? parsed.importance?.score ?? parsed.importance ?? null;
    const packetImportance = packetImportanceRaw != null && packetImportanceRaw !== '' && Number.isFinite(Number(packetImportanceRaw))
      ? clamp(packetImportanceRaw, 0, 1, 0.5)
      : null;
    const packetDefault = item => {
      if (packetImportance == null) return item;
      if (!objectish(item)) return { text: text(item), importance: packetImportance };
      if (item.importance != null || item.priority != null || item.pressure != null || item.score != null) return item;
      return { ...item, importance: packetImportance };
    };

    const entity = parsed.entity || parsed.entities || {};
    const world = parsed.world || {};
    const narrative = parsed.narrative || {};
    const planner = parsed.planner || {};
    const packetQuality = buildPacketQualityContext(packetRaw, parsed, sourceMeta);
    const ingestSignal = buildPacketIngestSignal(packetRaw, parsed, packetQuality, { ...sourceMeta, packetHash, packetShapeWarnings });
    const previousCharacters = ensureArray(store.entity?.characters);
    const previousRelations = ensureArray(store.entity?.relations);
    const previousPovMemories = ensureArray(store.entity?.povMemories);
    const previousSecrets = ensureArray(store.entity?.secrets);
    const previousWorldItems = ensureArray(store.world?.items);
    const previousConsequences = ensureArray(store.planner?.consequenceLedger);
    const hadPacketBaseline = Number(store.stats?.packets || 0) > 0;

    const stripCharacterThoughtFields = item => {
      if (!objectish(item)) return item;
      const out = { ...item };
      delete out.thoughts;
      delete out.thinking;
      delete out.mindset;
      delete out.current_thoughts;
      delete out.currentThoughts;
      if (objectish(out.profile)) {
        const profile = { ...out.profile };
        delete profile.thoughts;
        delete profile.mindset;
        out.profile = profile;
      }
      return out;
    };
    let characters = packetItems(entity.characters || entity.character || entity.people || [])
      .map(item => stripCharacterThoughtFields(packetDefault(item)))
      .map(item => applyPacketQualityToItem('entity', 'character', item, packetQuality))
      .map(item => decorateItem('entity', 'character', item, turn, packetHash, item?.name || item?.title || 'character', 'character', sourceMeta));
    const characterRefSplit = splitConflictingCharacterPublicRefs(characters, previousCharacters, turn, packetHash, sourceMeta);
    characters = characterRefSplit.items;
    ingestSignal.lastPacketRefReuseError = Boolean(ingestSignal.lastPacketRefReuseError || characterRefSplit.hadConflict);
    let relations = packetItems(entity.relations || entity.relationships || [])
      .map(item => applyPacketQualityToItem('entity', 'relation', packetDefault(item), packetQuality))
      .map(item => decorateItem('entity', 'relation', item, turn, packetHash, [item?.from, item?.to].filter(Boolean).join('_') || item?.label || 'relation', 'relation', sourceMeta));
    relations = canonicalizeRelations(relations, [previousCharacters, characters], turn, packetHash, sourceMeta);
    const povMemoryInputs = [
      ...packetItems(entity.pov_memories || entity.povMemories || entity.entityMemories || entity.entity_memories || entity.knowledge || []),
      ...packetItems(parsed.povMemories || parsed.entityMemories || parsed.entity_knowledge || [])
    ];
    const secretInputs = [
      ...packetItems(entity.secrets || entity.secret_boundaries || entity.secretBoundaries || entity.hiddenKnowledge || entity.privateThoughts || []),
      ...packetItems(parsed.secrets || parsed.hiddenKnowledge || parsed.privateThoughts || [])
    ];
    const povMemories = povMemoryInputs
      .map(item => normalizePovMemory(packetDefault(item)))
      .map(item => applyPacketQualityToItem('entity', 'pov_memory', item, packetQuality))
      .filter(item => item.ownerEntityId && (item.summary || item.text))
      .map(item => decorateItem('entity', 'pov_memory', item, turn, packetHash, item.ownerEntityId, 'pov_memory', sourceMeta));
    const secrets = secretInputs
      .map(item => normalizeSecret(packetDefault(item)))
      .map(item => applyPacketQualityToItem('entity', 'secret', item, packetQuality))
      .filter(item => item.summary || item.rawText)
      .map(item => decorateItem('entity', 'secret', item, turn, packetHash, item.title || item.holderEntityIds?.[0] || 'secret', 'secret', sourceMeta));
    ingestSignal.hasNewCharacter = hadPacketBaseline && hasNewStableItem(characters, previousCharacters);
    ingestSignal.hasRelationshipChange = hadPacketBaseline && hasRelationChange(relations, previousRelations);
    ingestSignal.hasPovMemoryChange = hadPacketBaseline && hasBoundaryChange(povMemories, previousPovMemories, 'pov_memory');
    ingestSignal.hasSecretBoundaryChange = hadPacketBaseline && hasBoundaryChange(secrets, previousSecrets, 'secret');
    ingestSignal.hasRevealStateChange = hasRevealStateChange(secrets, previousSecrets);
    ingestSignal.lastPacketHadUnsupportedReveal = Boolean(ingestSignal.lastPacketHadUnsupportedReveal || hasPacketQualityRisk(secrets));
    ingestSignal.lastPacketSecretRevealRisk = Boolean(ingestSignal.lastPacketSecretRevealRisk || hasPacketQualityRisk(secrets));
    ingestSignal.lowQualityItems = countLowQualityItems([...characters, ...relations, ...povMemories, ...secrets]);
    store.entity.characters = upsertList(store.entity.characters, characters, item => normalizeKey(item.name || item.title || item.id), 120);
    store.entity.relations = upsertList(store.entity.relations, relations, item => normalizeKey([item.from, item.to, item.label, item.id].filter(Boolean).join('_')), 160);
    store.entity.povMemories = upsertList(store.entity.povMemories, povMemories, item => normalizeKey([item.ownerEntityId, item.memoryType, item.summary, item.id].filter(Boolean).join('_')), 180);
    store.entity.secrets = upsertList(store.entity.secrets, secrets, item => normalizeKey([item.title, item.summary, item.id].filter(Boolean).join('_')), 120);

    const worldItems = [];
    if (world.location || world.time || world.atmosphere || world.sensory || world.lighting || world.weather || world.scent || world.scene_type || world.sceneType || world.danger_level || world.dangerLevel) {
      worldItems.push(collectionTypedItem('current_state', { title: '현재 세계 상태', ...world, summary: itemText(world) }));
    }
    packetItems(world.active_events || world.activeEvents || world.events || []).forEach(event => worldItems.push(collectionTypedItem('active_event', { ...itemObject(event), label: objectish(event) ? (event.label || event.title || event.name || compact(itemText(event), 120)) : text(event), summary: itemText(event) })));
    packetItems(world.world_rules || world.worldRules || world.rules || []).forEach(rule => worldItems.push(collectionTypedItem('world_rule', { ...itemObject(rule), label: objectish(rule) ? (rule.label || rule.title || compact(itemText(rule), 120)) : text(rule), summary: itemText(rule) })));
    packetItems(world.factions || []).forEach(item => worldItems.push(collectionTypedItem('faction', item)));
    packetItems(world.regions || []).forEach(item => worldItems.push(collectionTypedItem('region', item)));
    packetItems(world.offscreen_threads || world.offscreenThreads || []).forEach(item => worldItems.push(collectionTypedItem('offscreen_thread', item)));
    const decoratedWorldItems = worldItems
      .map(item => applyPacketQualityToItem('world', item.type || 'world', packetDefault(item), packetQuality))
      .map(item => decorateItem('world', item.type || 'world', item, turn, packetHash, item.location || item.label || item.title || item.type || 'world', item.type || 'world', sourceMeta));
    const previousWorldRules = previousWorldItems.filter(item => item?.type === 'world_rule');
    ingestSignal.hasNewWorldRule = hadPacketBaseline && hasNewStableItem(decoratedWorldItems.filter(item => item?.type === 'world_rule'), previousWorldRules);
    ingestSignal.hasLocationOrTimeChange = decoratedWorldItems.some(item => item?.type === 'current_state' && (item.location || item.time));
    store.world.items = upsertList(store.world.items, decoratedWorldItems, item => normalizeKey([item.type, item.location, item.label, item.title, item.summary, item.id].filter(Boolean).join('_')), 180);

    const conflictTraces = packetItems(narrative.conflict_traces || narrative.conflictTraces || narrative.conflicts || [])
      .map(item => applyPacketQualityToItem('narrative', 'conflict_trace', packetDefault(item), packetQuality))
      .map(item => decorateItem('narrative', 'conflict_trace', item, turn, packetHash, item?.label || item?.title || 'conflict', 'conflict', sourceMeta));
    const sceneDeltas = packetItems(narrative.scene_deltas || narrative.sceneDeltas || narrative.deltas || [])
      .map(item => applyPacketQualityToItem('narrative', 'scene_delta', packetDefault(item), packetQuality))
      .map(item => decorateItem('narrative', 'scene_delta', item, turn, packetHash, item?.summary || item?.label || 'delta', 'delta', sourceMeta));
    const themeMotifs = packetItems(narrative.theme_motifs || narrative.themeMotifs || narrative.motifs || [])
      .map(item => applyPacketQualityToItem('narrative', 'theme_motif', packetDefault(item), packetQuality))
      .map(item => decorateItem('narrative', 'theme_motif', item, turn, packetHash, item?.label || item?.motif || 'motif', 'motif', sourceMeta));
    const narrativeItems = [];
    if (narrative.scene_phase || narrative.scenePhase || narrative.current_arc || narrative.currentArc || narrative.tension_level || narrative.tensionLevel || narrative.dominant_mood || narrative.dominantMood || narrative.pacing || narrative.time_elapsed || narrative.timeElapsed) {
      const narrativeState = applyPacketQualityToItem('narrative', 'state', packetDefault({ title: '내러티브 상태', ...narrative, summary: itemText(narrative) }), packetQuality);
      narrativeItems.push(decorateItem('narrative', 'state', narrativeState, turn, packetHash, narrative.current_arc || narrative.currentArc || 'narrative', 'state', sourceMeta));
    }
    store.narrative.conflictTraces = upsertList(store.narrative.conflictTraces, conflictTraces, item => normalizeKey(item.label || item.title || item.id), 120);
    store.narrative.sceneDeltas = upsertList(store.narrative.sceneDeltas, sceneDeltas, item => normalizeKey(item.summary || item.label || item.id), 80);
    store.narrative.themeMotifs = upsertList(store.narrative.themeMotifs, themeMotifs, item => normalizeKey(item.label || item.motif || item.id), 80);
    store.narrative.items = upsertList(store.narrative.items, narrativeItems, item => normalizeKey(item.title || item.summary || item.id), 40);

    const consequences = packetItems(planner.consequence_ledger || planner.consequenceLedger || planner.consequences || [])
      .map(item => applyPacketQualityToItem('planner', 'consequence', packetDefault(item), packetQuality))
      .map(item => decorateItem('planner', 'consequence', item, turn, packetHash, item?.decision || item?.label || 'consequence', 'consequence', sourceMeta));
    ingestSignal.hasHighImpactConsequence = (hadPacketBaseline && hasNewStableItem(consequences, previousConsequences))
      || consequences.some(item => Number(item?._retrieval?.importance || item?.importance || 0) >= 0.72);
    const payoffs = packetItems(planner.payoff_tracker || planner.payoffTracker || planner.payoffs || planner.payover_tracker || planner.payoverTracker || planner.payovers || [])
      .map(item => applyPacketQualityToItem('planner', 'payoff', packetDefault(item), packetQuality))
      .map(item => decorateItem('planner', 'payoff', item, turn, packetHash, item?.label || item?.title || 'payoff', 'payoff', sourceMeta));
    const continuityLocks = packetItems(planner.continuity_locks || planner.continuityLocks || [])
      .map(item => applyPacketQualityToItem('planner', 'continuity_lock', packetDefault(item), packetQuality))
      .map(item => decorateItem('planner', 'continuity_lock', item, turn, packetHash, item?.label || text(item), 'lock', sourceMeta));
    const doNotResolveYet = packetItems(planner.do_not_resolve_yet || planner.doNotResolveYet || planner.avoid || [])
      .map(item => applyPacketQualityToItem('planner', 'do_not_resolve_yet', packetDefault(item), packetQuality))
      .map(item => decorateItem('planner', 'do_not_resolve_yet', item, turn, packetHash, item?.label || text(item), 'avoid', sourceMeta));
    const plannerItems = [];
    packetItems(planner.next_direction || planner.next_response_direction || planner.nextResponseDirection || []).forEach(item => {
      const obj = itemObject(item);
      const nextItem = applyPacketQualityToItem('planner', 'next_direction', packetDefault(collectionTypedItem('next_direction', { ...obj, label: obj.label || obj.title || compact(itemText(item), 120), summary: itemText(item) })), packetQuality);
      plannerItems.push(decorateItem('planner', 'next_direction', nextItem, turn, packetHash, obj.label || obj.title || compact(itemText(item), 120), 'next', sourceMeta));
    });
    packetItems(planner.suggested_hooks || planner.suggestedHooks || []).forEach(item => {
      const obj = itemObject(item);
      const hookItem = applyPacketQualityToItem('planner', 'suggested_hook', packetDefault(collectionTypedItem('suggested_hook', { ...obj, label: obj.label || obj.title || compact(itemText(item), 120), summary: itemText(item) })), packetQuality);
      plannerItems.push(decorateItem('planner', 'suggested_hook', hookItem, turn, packetHash, obj.label || obj.title || compact(itemText(item), 120), 'hook', sourceMeta));
    });
    packetItems(planner.open_invitations || planner.openInvitations || []).forEach(item => {
      const obj = itemObject(item);
      const invItem = applyPacketQualityToItem('planner', 'open_invitation', packetDefault(collectionTypedItem('open_invitation', { ...obj, label: obj.label || obj.title || compact(itemText(item), 120), summary: itemText(item) })), packetQuality);
      plannerItems.push(decorateItem('planner', 'open_invitation', invItem, turn, packetHash, obj.label || obj.title || compact(itemText(item), 120), 'open_invitation', sourceMeta));
    });
    store.planner.consequenceLedger = upsertList(store.planner.consequenceLedger, consequences, item => normalizeKey(item.decision || item.immediateResult || item.label || item.id), 120);
    store.planner.payoffTracker = upsertList(store.planner.payoffTracker, payoffs, item => normalizeKey(item.label || item.title || item.id), 120);
    store.planner.continuityLocks = upsertList(store.planner.continuityLocks, continuityLocks, item => normalizeKey(item.label || item.text || item.summary || item.id), 80);
    store.planner.doNotResolveYet = upsertList(store.planner.doNotResolveYet, doNotResolveYet, item => normalizeKey(item.label || item.text || item.summary || item.id), 80);
    store.planner.items = upsertList(store.planner.items, plannerItems, item => normalizeKey(item.label || item.title || item.summary || item.id), 80);
    ingestSignal.lowQualityItems = countLowQualityItems([
      ...characters,
      ...relations,
      ...povMemories,
      ...secrets,
      ...decoratedWorldItems,
      ...conflictTraces,
      ...sceneDeltas,
      ...themeMotifs,
      ...narrativeItems,
      ...consequences,
      ...payoffs,
      ...continuityLocks,
      ...doNotResolveYet,
      ...plannerItems
    ]);

    const ledgerRev2Ingest = ingestPacketLedgerRev2Meta(store, parsed, turn, packetHash, sourceMeta, packetQuality);
    ingestSignal.ledgerRev2 = ledgerRev2Ingest;
    if (ledgerRev2Ingest?.summaryMemory || ledgerRev2Ingest?.speakerBoundaries || ledgerRev2Ingest?.patternGuards || ledgerRev2Ingest?.overpromotionRisks) {
      store.context = {
        ...(store.context || {}),
        ledgerRev2MetaRecall: [{ packetHash, ...ledgerRev2Ingest, updatedAt: now() }, ...ensureArray(store.context?.ledgerRev2MetaRecall)].slice(0, 12)
      };
    }
    const sceneAnchors = storeSceneAnchors(store, packetMeta, sourceMeta);
    ingestSignal.hasSceneIdChange = Boolean(sceneAnchors?.resetBySceneIdChange);
    store.context = {
      ...(store.context || {}),
      packetQuality: [{
        packetHash,
        messageIndex: Number.isFinite(Number(sourceMeta.messageIndex)) ? Number(sourceMeta.messageIndex) : null,
        scoreSource: packetQuality.sourceEvidence?.mode || 'source_text',
        sourceLines: packetQuality.sourceEvidence?.lines?.length || 0,
        totalItems: packetQuality.totalItems,
        breadthPenalty: packetQuality.breadthPenalty
      }, ...ensureArray(store.context?.packetQuality)].slice(0, 12),
      packetHealthSignals: [ingestSignal, ...ensureArray(store.context?.packetHealthSignals)].slice(0, 12)
    };

    store.ingestedPacketHashes = uniq([packetHash, ...store.ingestedPacketHashes], 300);
    store.stats.packets = Number(store.stats.packets || 0) + 1;
    store.stats.lastIngestAt = now();
    return { ok: true, skipped: false };
  };

  const allAxisItems = store => [
    ...ensureArray(store.entity?.characters).map(item => ({ axis: 'entity', category: 'character', item })),
    ...ensureArray(store.entity?.relations).map(item => ({ axis: 'entity', category: 'relation', item })),
    ...ensureArray(store.entity?.povMemories).map(item => ({ axis: 'entity', category: 'pov_memory', item })),
    ...ensureArray(store.entity?.secrets).map(item => ({ axis: 'entity', category: 'secret', item })),
    ...ensureArray(store.memory?.summaries).map(item => ({ axis: 'narrative', category: 'summary_memory', item })),
    ...ensureArray(store.world?.items).map(item => ({ axis: 'world', category: item.type || 'world', item })),
    ...ensureArray(store.narrative?.items).map(item => ({ axis: 'narrative', category: 'state', item })),
    ...ensureArray(store.narrative?.conflictTraces).map(item => ({ axis: 'narrative', category: 'conflict_trace', item })),
    ...ensureArray(store.narrative?.sceneDeltas).map(item => ({ axis: 'narrative', category: 'scene_delta', item })),
    ...ensureArray(store.narrative?.themeMotifs).map(item => ({ axis: 'narrative', category: 'theme_motif', item })),
    ...ensureArray(store.planner?.items).map(item => ({ axis: 'planner', category: item.type || 'planner', item })),
    ...ensureArray(store.planner?.consequenceLedger).map(item => ({ axis: 'planner', category: 'consequence', item })),
    ...ensureArray(store.planner?.payoffTracker).map(item => ({ axis: 'planner', category: 'payoff', item })),
    ...ensureArray(store.planner?.continuityLocks).map(item => ({ axis: 'planner', category: 'continuity_lock', item })),
    ...ensureArray(store.planner?.doNotResolveYet).map(item => ({ axis: 'planner', category: 'do_not_resolve_yet', item }))
  ];
  const INDEX_ROW_LIMIT = 600;
  const PROTECTED_INDEX_SLOTS = Object.freeze([
    { axis: 'entity', category: 'character', limit: 52 },
    { axis: 'entity', category: 'secret', limit: 34 },
    { axis: 'entity', category: 'pov_memory', limit: 40 },
    { axis: 'entity', category: 'relation', limit: 34 },
    { axis: 'world', category: 'current_state', limit: 26 },
    { axis: 'world', category: 'active_event', limit: 20 },
    { axis: 'world', category: 'world_rule', limit: 26 },
    { axis: 'world', category: 'offscreen_thread', limit: 14 },
    { axis: 'world', category: 'faction', limit: 10 },
    { axis: 'world', category: 'region', limit: 10 },
    { axis: 'planner', category: 'continuity_lock', limit: 20 },
    { axis: 'planner', category: 'do_not_resolve_yet', limit: 20 },
    { axis: 'planner', category: 'consequence', limit: 20 },
    { axis: 'planner', category: 'payoff', limit: 20 },
    { axis: 'planner', category: 'next_direction', limit: 10 },
    { axis: 'planner', category: 'suggested_hook', limit: 10 },
    { axis: 'planner', category: 'open_invitation', limit: 10 },
    { axis: 'planner', category: 'consent_memory', limit: 10 },
    { axis: 'planner', category: 'speaker_boundary', limit: 14 },
    { axis: 'planner', category: 'pattern_guard', limit: 14 },
    { axis: 'planner', category: 'overpromotion_risk', limit: 14 },
    { axis: 'narrative', category: 'summary_memory', limit: 32 },
    { axis: 'narrative', category: 'conflict_trace', limit: 20 },
    { axis: 'narrative', category: 'state', limit: 16 },
    { axis: 'narrative', category: 'scene_delta', limit: 14 },
    { axis: 'narrative', category: 'theme_motif', limit: 10 }
  ]);
  const rowIdentityKey = row => normalizeKey([row.axis, row.category, row.publicRef, row.id, row.locator?.uri].filter(Boolean).join('|'));
  const rankIndexRows = rows => ensureArray(rows).slice().sort((a, b) => b.importance - a.importance || b.updatedAt - a.updatedAt);
  const selectProtectedIndexRows = (rows = [], limit = INDEX_ROW_LIMIT) => {
    const importantFloor = Math.max(0, Math.min(limit, Number(Memory.settings?.importantLimit) || 0));
    const ranked = rankIndexRows(rows);
    const selected = [];
    const seen = new Set();
    const add = row => {
      const key = rowIdentityKey(row);
      if (!key || seen.has(key) || selected.length >= limit) return;
      seen.add(key);
      selected.push(row);
    };
    // importantLimit is a true floor: reserve the globally highest-importance rows
    // before category slots compete for the remaining index budget.
    if (importantFloor > 0) {
      const importanceRanked = [...ranked].sort((a, b) => Number(b.importance || 0) - Number(a.importance || 0));
      importanceRanked.slice(0, importantFloor).forEach(add);
    }
    PROTECTED_INDEX_SLOTS.forEach(slot => {
      ranked
        .filter(row => row.axis === slot.axis && row.category === slot.category)
        .slice(0, slot.limit)
        .forEach(add);
    });
    ranked.forEach(add);
    return selected.slice(0, limit);
  };
  const rebuildIndex = store => {
    const rows = allAxisItems(store).map(({ axis, category, item }) => {
      const retrieval = hydratedRetrieval(axis, category, item);
      const locator = item._locator ? {
        ...item._locator,
        locatorTokens: item._locator.locatorTokens?.length ? item._locator.locatorTokens : retrieval.locatorTokens
      } : null;
      return {
        axis, category,
        id: item.id || item._locator?.uri || stableHash64(itemText(item)),
        publicRef: publicRefOf(item) || makePublicRef(axis, category, item.id || stableHash64(itemText(item)), item),
        sourceType: item._locator?.sourceType || 'chat_packet',
        sourceScope: item._locator?.sourceScope || 'current_chat',
        scene_id: item.scene_id || item.sceneId || '',
        locator,
        retrieval,
        publicText: publicSummary(axis, item),
        publicProfile: axis === 'entity' && category === 'character' ? characterProfileSummary(item) : '',
        lifecycle: {
          status: item.status || '',
          timeScope: item.time_scope || item.timeScope || '',
          confidence: item.confidence ?? '',
          evidence: item.evidence || '',
          replaces: item.replaces || item.supersedes || item.invalidates || ''
        },
        visibility: {
          ownerEntityId: item.ownerEntityId || '',
          holderEntityIds: mergeValues([item.holderEntityIds, item.holders], 32),
          visibleToEntityIds: mergeValues([item.visibleToEntityIds, item.visibleTo, item.sharedWith, item.known_to, item.knownTo, item.knownBy], 32),
          deniedToEntityIds: mergeValues([item.deniedToEntityIds, item.deniedTo, item.hidden_from, item.hiddenFrom, item.unknownTo], 32),
          privacy: item.privacy || item.visibility || '',
          secrecyLevel: item.secrecyLevel || '',
          revealState: item.revealState || '',
          truthState: item.truthState || ''
        },
        updatedAt: Number(retrieval.updatedAt || item._locator?.createdAt || 0),
        importance: Number.isFinite(Number(retrieval.importance)) ? Number(retrieval.importance) : 0.4
      };
    }).filter(row => !isLowSignalContinuityRow(row));
    store.index = selectProtectedIndexRows(rows, INDEX_ROW_LIMIT);
    store.stats.items = rows.length;
  };
  const axisWeights = query => {
    const body = text(query);
    const weights = { entity: 0, world: 0, narrative: 0, planner: 0 };
    if (body.trim()) weights.planner += 0.08;
    if (/(?:너|나|그|그녀|카일|비앙카|리브라|[가-힣A-Za-z]{2,12}(?:가|는|에게|와|랑|를|을))/i.test(body)) weights.entity += 0.2;
    if (/(?:장소|시간|밤|낮|비|눈|성문|방|거리|세계|규칙|세력|지역|전쟁|왕국|도시)/i.test(body)) weights.world += 0.2;
    if (/(?:장면|갈등|복선|긴장|아크|서사|분위기|회수|불신|비밀)/i.test(body)) weights.narrative += 0.2;
    if (/(?:다음|앞으로|계획|어떻게|해야|하지마|피하|유지|전개|방향|갱신|패킷|연속성|상태)/i.test(body)) weights.planner += 0.24;
    return weights;
  };
  const queryMentionsAny = (query = '', values = []) => {
    const rawQuery = text(query);
    const qKey = normalizeKey(rawQuery);
    if (!qKey && !rawQuery.trim()) return false;
    return ensureArray(values).some(value => {
      const raw = text(value).trim();
      const key = normalizeKey(raw);
      if (key.length < 2) return false;
      if (/^[가-힣A-Za-z0-9ぁ-んァ-ヶー一-龯々〆〤][가-힣A-Za-z0-9ぁ-んァ-ヶー一-龯々〆〤_\-\s.・ー]{1,60}$/.test(raw)) {
        const pattern = new RegExp(`(^|[^가-힣A-Za-z0-9ぁ-んァ-ヶー一-龯々〆〤])${escapeRegExp(raw)}(?:께서는|에서는|에게서|으로서|으로써|에게는|에게|에서|부터|까지|처럼|보다|하고|한테|로서|로써|으로|로|은|는|이|가|을|를|와|과|랑|도|만|의|야|아|님|씨|について|として|から|まで|より|では|には|へは|とは|って|なら|だけ|ほど|くらい|ぐらい|は|が|を|に|へ|と|で|の|も|や|か|ね|よ|さん|ちゃん|くん|君|様)?(?=$|[^가-힣A-Za-z0-9ぁ-んァ-ヶー一-龯々〆〤])`, 'i');
        if (pattern.test(rawQuery)) return true;
      }
      return key.length >= 4 && qKey.includes(key);
    });
  };
  const queryMentionedEntities = (store = {}, query = '') => {
    const mentioned = [];
    ensureArray(store.entity?.characters).forEach(item => {
      const canonical = text(item.name || item.title || item.label || '').trim();
      const names = mergeValues([
        canonical,
        item.name,
        item.title,
        item.label,
        item.aliases,
        item.alias,
        item.nicknames,
        item.nickname
      ], 24);
      if (canonical && queryMentionsAny(query, names)) mentioned.push(canonical);
    });
    ensureArray(store.entity?.relations).forEach(item => {
      const endpoints = mergeValues([item.from, item.to, item.entityA, item.entityB], 8);
      endpoints.forEach(endpoint => {
        if (queryMentionsAny(query, [endpoint])) mentioned.push(endpoint);
      });
    });
    return uniq(mentioned, 32);
  };
  const normalizeSceneVisibility = value => {
    const raw = text(value).trim().toLowerCase();
    return ['public', 'limited', 'private', 'omniscient'].includes(raw) ? raw : '';
  };
  const hasOwn = (obj = {}, key = '') => objectish(obj) && Object.prototype.hasOwnProperty.call(obj, key);
  const hasAnyOwn = (obj = {}, keys = []) => objectish(obj) && ensureArray(keys).some(key => hasOwn(obj, key));
  const canonicalEntityName = (store = {}, value = '') => {
    const raw = text(value).trim();
    if (!raw) return '';
    const rawKey = normalizedSurface(raw);
    const direct = ensureArray(store.entity?.characters).find(item => {
      const canonical = text(item.name || item.title || item.label || '').trim();
      const names = mergeValues([canonical, item.name, item.title, item.label, item.aliases, item.alias, item.nicknames, item.nickname], 32);
      return names.some(name => normalizedSurface(name) === rawKey || queryMentionsAny(raw, [name]) || queryMentionsAny(name, [raw]));
    });
    return text(direct?.name || direct?.title || direct?.label || raw).trim();
  };
  const normalizeSceneAnchors = (store = {}, packetMeta = {}, sourceMeta = {}) => {
    const povKeys = ['pov_entity', 'povEntity', 'pov', 'viewpointEntity', 'viewpoint_entity'];
    const activeSpeakerKeys = ['active_speaker', 'activeSpeaker', 'speaker', 'next_speaker', 'nextSpeaker'];
    const visibleParticipantKeys = ['visible_participants', 'visibleParticipants', 'participants', 'present_entities', 'presentEntities'];
    const sceneVisibilityKeys = ['scene_visibility', 'sceneVisibility', 'visibility'];
    const sceneIdKeys = ['scene_id', 'sceneId'];
    const turnHintKeys = ['turn_hint', 'turnHint', 'turn_anchor', 'turnAnchor'];
    const confidenceKeys = ['confidence', 'anchor_confidence', 'anchorConfidence'];
    const fieldInputs = {
      povEntities: hasAnyOwn(packetMeta, povKeys),
      activeSpeakers: hasAnyOwn(packetMeta, activeSpeakerKeys),
      visibleParticipants: hasAnyOwn(packetMeta, visibleParticipantKeys),
      sceneVisibility: hasAnyOwn(packetMeta, sceneVisibilityKeys),
      sceneId: hasAnyOwn(packetMeta, sceneIdKeys),
      turnHint: hasAnyOwn(packetMeta, turnHintKeys),
      confidence: hasAnyOwn(packetMeta, confidenceKeys)
    };
    const povEntities = mergeValues(povKeys.map(key => packetMeta[key]), 6)
      .map(entity => canonicalEntityName(store, entity)).filter(Boolean);
    const activeSpeakers = mergeValues(activeSpeakerKeys.map(key => packetMeta[key]), 6)
      .map(entity => canonicalEntityName(store, entity)).filter(Boolean);
    const visibleParticipants = mergeValues(visibleParticipantKeys.map(key => packetMeta[key]), 24)
      .map(entity => canonicalEntityName(store, entity)).filter(Boolean);
    const sceneVisibility = normalizeSceneVisibility(packetMeta.scene_visibility || packetMeta.sceneVisibility || packetMeta.visibility);
    const sceneId = compact(packetMeta.scene_id || packetMeta.sceneId || '', 120);
    const turnHint = compact(packetMeta.turn_hint || packetMeta.turnHint || packetMeta.turn_anchor || packetMeta.turnAnchor || '', 240);
    const confidence = firstExplicitFinite(confidenceKeys.map(key => packetMeta[key]), null);
    const out = {
      povEntities: uniq(povEntities, 8),
      activeSpeakers: uniq(activeSpeakers, 8),
      visibleParticipants: uniq(visibleParticipants, 32),
      sceneVisibility,
      sceneId,
      turnHint,
      confidence: confidence == null ? null : clamp(confidence, 0, 1, null),
      fieldInputs,
      sourceMessageIndex: Number.isFinite(Number(sourceMeta.messageIndex)) ? Number(sourceMeta.messageIndex) : null,
      chatRecency: Number.isFinite(Number(sourceMeta.chatRecency)) ? clamp(sourceMeta.chatRecency, 0, 1, 0) : null,
      updatedAt: now()
    };
    out.hasAnchors = Boolean(Object.values(fieldInputs).some(Boolean));
    return out;
  };
  const storeSceneAnchors = (store = {}, packetMeta = {}, sourceMeta = {}) => {
    const anchors = normalizeSceneAnchors(store, packetMeta, sourceMeta);
    if (!anchors.hasAnchors) return null;
    const previous = objectish(store.context?.sceneAnchors) ? store.context.sceneAnchors : {};
    const sceneIdChanged = Boolean(anchors.fieldInputs.sceneId && anchors.sceneId && previous.sceneId && anchors.sceneId !== previous.sceneId);
    const carry = sceneIdChanged ? {} : previous;
    const merged = {
      ...carry,
      ...anchors,
      povEntities: anchors.fieldInputs.povEntities ? anchors.povEntities : ensureArray(carry.povEntities),
      activeSpeakers: anchors.fieldInputs.activeSpeakers ? anchors.activeSpeakers : ensureArray(carry.activeSpeakers),
      visibleParticipants: anchors.fieldInputs.visibleParticipants ? anchors.visibleParticipants : ensureArray(carry.visibleParticipants),
      sceneVisibility: anchors.fieldInputs.sceneVisibility ? anchors.sceneVisibility : (carry.sceneVisibility || ''),
      sceneId: anchors.fieldInputs.sceneId ? anchors.sceneId : (carry.sceneId || ''),
      turnHint: anchors.fieldInputs.turnHint ? anchors.turnHint : (carry.turnHint || ''),
      confidence: anchors.fieldInputs.confidence ? anchors.confidence : (carry.confidence ?? null),
      resetBySceneIdChange: sceneIdChanged,
      updatedAt: anchors.updatedAt
    };
    store.context = {
      ...(store.context || {}),
      sceneAnchors: merged,
      sceneAnchorUpdatedAt: anchors.updatedAt
    };
    return merged;
  };
  const effectiveSceneAnchors = (store = {}, settings = Memory.settings) => {
    const anchors = objectish(store.context?.sceneAnchors) ? store.context.sceneAnchors : null;
    if (!anchors) return null;
    const updatedAt = Number(anchors.updatedAt || store.context?.sceneAnchorUpdatedAt || 0);
    if (updatedAt > 0 && Number(settings.recentEntityContextMs || 0) > 0 && now() - updatedAt > Number(settings.recentEntityContextMs || 0)) return null;
    return {
      povEntities: uniq(anchors.povEntities || [], 8),
      activeSpeakers: uniq(anchors.activeSpeakers || [], 8),
      visibleParticipants: uniq(anchors.visibleParticipants || [], 32),
      sceneVisibility: normalizeSceneVisibility(anchors.sceneVisibility || ''),
      sceneId: anchors.sceneId || '',
      turnHint: anchors.turnHint || '',
      confidence: anchors.confidence == null ? null : clamp(anchors.confidence, 0, 1, null),
      updatedAt
    };
  };
  const recentMentionedEntities = (store = {}, settings = Memory.settings) => {
    const age = now() - Number(store.context?.updatedAt || 0);
    if (age > Number(settings.recentEntityContextMs || 0)) return [];
    return uniq(store.context?.recentEntities || [], 32);
  };
  const buildKnowledgeContext = (store = {}, query = '', settings = Memory.settings) => {
    const explicitMentioned = queryMentionedEntities(store, query);
    const sceneAnchors = effectiveSceneAnchors(store, settings) || {};
    const activeSpeakers = uniq(sceneAnchors.activeSpeakers || [], 8);
    const povEntities = uniq(sceneAnchors.povEntities || [], 8);
    const visibleParticipants = uniq(sceneAnchors.visibleParticipants || [], 32);
    const recentEntities = recentMentionedEntities(store, settings);
    const anchorPriority = explicitMentioned.length
      ? explicitMentioned
      : mergeValues([activeSpeakers, povEntities, visibleParticipants, recentEntities], 48);
    return {
      explicitMentioned,
      activeSpeakers,
      povEntities,
      visibleParticipants,
      recentEntities,
      mentionedEntities: uniq(anchorPriority, 48),
      sceneVisibility: sceneAnchors.sceneVisibility || '',
      sceneId: sceneAnchors.sceneId || '',
      turnHint: sceneAnchors.turnHint || '',
      anchorConfidence: sceneAnchors.confidence == null ? null : clamp(sceneAnchors.confidence, 0, 1, null),
      hasSceneAnchors: Boolean(activeSpeakers.length || povEntities.length || visibleParticipants.length || sceneAnchors.sceneVisibility)
    };
  };
  const effectiveMentionedEntities = (store = {}, query = '', settings = Memory.settings) => buildKnowledgeContext(store, query, settings).mentionedEntities;
  const buildAliasDictionary = (store = {}) => {
    const entries = [];
    ensureArray(store.entity?.characters).forEach(item => {
      const canonical = text(item.name || item.title || item.label || '').trim();
      const names = mergeValues([
        canonical,
        item.name,
        item.title,
        item.label,
        item.aliases,
        item.alias,
        item.nicknames,
        item.nickname
      ], 32);
      if (canonical && names.length) entries.push({ canonical, names });
    });
    return entries;
  };
  const expandQueryWithAliases = (store = {}, query = '', aliasDictionary = buildAliasDictionary(store), knowledgeContext = buildKnowledgeContext(store, query)) => {
    const additions = [];
    ensureArray(aliasDictionary).forEach(entry => {
      if (!entry?.canonical || !queryMentionsAny(query, entry.names)) return;
      additions.push(entry.canonical, ...ensureArray(entry.names));
    });
    const anchored = mergeValues([
      knowledgeContext.explicitMentioned,
      knowledgeContext.activeSpeakers,
      knowledgeContext.povEntities,
      knowledgeContext.visibleParticipants,
      knowledgeContext.recentEntities
    ], 64);
    anchored.forEach(entity => {
      const entry = ensureArray(aliasDictionary).find(candidate => queryMentionsAny(entity, [candidate.canonical, ...candidate.names]));
      additions.push(entity, ...(entry ? entry.names : []));
    });
    const expansion = uniq(additions, 80);
    return {
      text: [query, expansion.join(' ')].filter(Boolean).join(' '),
      entityTokens: tokenize(expansion.join(' '), 96),
      expansions: expansion
    };
  };
  const isRestrictedKnowledgeRow = row => {
    const visibility = row.visibility || {};
    return ['private', 'secret', 'internal'].includes(visibility.privacy)
      || ['private', 'secret', 'internal', 'sealed'].includes(visibility.secrecyLevel)
      || (visibility.revealState && !['revealed', 'false_secret'].includes(visibility.revealState))
      || ensureArray(visibility.visibleToEntityIds).length > 0
      || ensureArray(visibility.deniedToEntityIds).length > 0;
  };
  const isKnowledgeUnavailableForQuery = (row = {}, query = '', mentionedOrContext = []) => {
    if (!isRestrictedKnowledgeRow(row)) return false;
    const visibility = row.visibility || {};
    const denied = ensureArray(visibility.deniedToEntityIds);
    const allowed = [
      visibility.ownerEntityId,
      ...ensureArray(visibility.holderEntityIds),
      ...ensureArray(visibility.visibleToEntityIds)
    ].filter(Boolean);
    if (denied.length && queryMentionsAny(query, denied)) return true;
    if (allowed.length && queryMentionsAny(query, allowed)) return false;

    const legacyArray = Array.isArray(mentionedOrContext);
    const context = legacyArray ? { mentionedEntities: mentionedOrContext, legacy: true } : (mentionedOrContext || {});
    const explicit = ensureArray(context.explicitMentioned || []);
    const activeSpeakers = ensureArray(context.activeSpeakers || []);
    const povEntities = ensureArray(context.povEntities || []);
    const visibleParticipants = ensureArray(context.visibleParticipants || []);
    const recentEntities = ensureArray(context.recentEntities || []);
    const mentionedEntities = ensureArray(context.mentionedEntities || mentionedOrContext || []);
    const anchorConfidence = context.anchorConfidence == null ? null : Number(context.anchorConfidence);
    const sceneAnchorUnlockAllowed = legacyArray
      || (context.sceneVisibility !== 'omniscient' && (!Number.isFinite(anchorConfidence) || anchorConfidence >= 0.5));

    const intersects = (left = [], right = []) => ensureArray(left).some(entity => queryMentionsAny(entity, right));
    const primaryActors = legacyArray
      ? mentionedEntities
      : (explicit.length ? explicit : (sceneAnchorUnlockAllowed ? mergeValues([activeSpeakers, povEntities], 32) : []));
    const restrictedAccessActors = legacyArray
      ? mentionedEntities
      : mergeValues([explicit, sceneAnchorUnlockAllowed ? activeSpeakers : [], sceneAnchorUnlockAllowed ? povEntities : [], recentEntities], 48);

    if (denied.length && intersects(primaryActors, denied)) return true;
    if (allowed.length && intersects(primaryActors, allowed)) return false;

    if (!legacyArray && !primaryActors.length && visibleParticipants.length) {
      if (denied.length && intersects(visibleParticipants, denied)) return true;
      const stronglyPrivate = row.category === 'secret'
        || row.category === 'pov_memory'
        || ['private', 'secret', 'internal'].includes(visibility.privacy)
        || ['private', 'secret', 'internal', 'sealed'].includes(visibility.secrecyLevel);
      if (allowed.length && !stronglyPrivate && intersects(visibleParticipants, allowed)) return false;
    }

    if (allowed.length && recentEntities.length && intersects(recentEntities, allowed) && !intersects(recentEntities, denied)) return false;
    if (!mentionedEntities.length) return true;
    if (allowed.length) {
      if (!restrictedAccessActors.length) return true;
      return !restrictedAccessActors.some(entity => queryMentionsAny(entity, allowed));
    }
    return denied.length > 0;
  };
  const recencyScore = (updatedAt, windowMs = 1000 * 60 * 60 * 24 * 7) => {
    const age = Math.max(0, now() - Number(updatedAt || 0));
    return clamp(1 - (age / windowMs), 0, 1, 0);
  };
  const hayakuTimeFreshness = (store = {}, row = {}, settings = Memory.settings) => {
    const r = row.retrieval || {};
    const locator = row.locator || {};
    const currentTurn = Number(store.turn || 0);
    const rowTurn = Number(locator.turnId || r.timeProfile?.sceneTurn || 0);
    const turnWindow = Math.max(1, Number(settings.recencyTurnWindow || DEFAULT_SETTINGS.recencyTurnWindow || 18));
    const turnFreshness = rowTurn > 0 && currentTurn >= rowTurn
      ? clamp(1 - ((currentTurn - rowTurn) / turnWindow), 0, 1, 0)
      : recencyScore(row.updatedAt);
    const chatRecencyRaw = Number(locator.chatRecency ?? r.chatRecency);
    const chatFreshness = Number.isFinite(chatRecencyRaw) ? clamp(chatRecencyRaw, 0, 1, 0) : null;
    const baseFreshness = chatFreshness == null ? turnFreshness : Math.min(turnFreshness, chatFreshness);
    const anchorLift = r.timeProfile?.recencyAnchor ? 0.18 : 0;
    return clamp(baseFreshness + anchorLift, 0, 1, 0);
  };
  const inactiveLifecycleTerms = value => /resolved|superseded|dormant|no_longer_true|no longer true|해결|종료|대체|폐기|비활성|끝난|끝남/i.test(text(value));
  const rowLifecycleState = row => {
    const lifecycle = row?.lifecycle || {};
    const status = text(lifecycle.status || '').trim().toLowerCase();
    const timeScope = text(lifecycle.timeScope || '').trim().toLowerCase();
    const inactive = ['resolved', 'superseded', 'dormant'].includes(status)
      || ['no_longer_true'].includes(timeScope);
    return { status, timeScope, inactive };
  };
  const lifecycleRelevanceLift = (row = {}, query = '') => {
    const state = rowLifecycleState(row);
    if (!state.inactive) return 0;
    return inactiveLifecycleTerms(query) ? 0.12 : 0;
  };
  const lifecycleScoreMultiplier = (row = {}, query = '') => {
    const state = rowLifecycleState(row);
    if (!state.inactive) return 1;
    return inactiveLifecycleTerms(query) ? 0.82 : 0.32;
  };
  const buildRetrievalQuerySignature = (store, query, settings = Memory.settings) => {
    const aliasDictionary = buildAliasDictionary(store);
    const knowledgeContext = buildKnowledgeContext(store, query, settings);
    const expandedQuery = expandQueryWithAliases(store, query, aliasDictionary, knowledgeContext);
    const expandedText = expandedQuery.text;
    const rawQuery = text(query);
    const conceptTokens = conceptTokensForText(expandedText);
    const canonicalTokens = canonicalRecallTokensForText(expandedText);
    const mentionedEntities = knowledgeContext.mentionedEntities;
    const presentStateQuery = isCurrentStateQuery(rawQuery);
    const entityQuery = mentionedEntities.length > 0
      || /(?:너|나|그|그녀|[가-힣A-Za-z]{2,12}(?:가|는|에게|와|랑|를|을))/i.test(rawQuery);
    const worldQuery = /(?:장소|시간|밤|낮|비|눈|성문|방|거리|세계|규칙|세력|지역|전쟁|왕국|도시|위치|어디)/i.test(rawQuery)
      || (presentStateQuery && /(?:위치|장소|어디|location|place|where)/i.test(rawQuery));
    const narrativeQuery = /(?:장면|갈등|복선|긴장|아크|서사|분위기|회수|불신|비밀)/i.test(rawQuery);
    const plannerQuery = RETRIEVAL_EXPLICIT_CONTINUITY_INTENT_RE.test(rawQuery)
      || /(?:다음|앞으로|계획|어떻게|해야|하지마|피하|유지|전개|방향|갱신|패킷|연속성|상태)/i.test(rawQuery);
    const emotionalQuery = extractTags(expandedText, EMOTION_TAGS).length > 0;
    const channelWeights = (() => {
      const w = { entity: 1, world: 1, narrative: 1, planner: 1, locator: 1, frame: 1, concept: 1, lexical: 1 };
      if (entityQuery) { w.entity = JACCARD_TUNING.channelBoost; w.concept = Math.max(w.concept, 1.15); }
      if (worldQuery) { w.locator = JACCARD_TUNING.channelBoost; w.world = JACCARD_TUNING.channelBoost; w.entity = entityQuery ? Math.max(w.entity, 1.12) : JACCARD_TUNING.channelDamp; }
      if (narrativeQuery) { w.frame = JACCARD_TUNING.channelBoost; w.narrative = JACCARD_TUNING.channelBoost; }
      if (plannerQuery) { w.planner = JACCARD_TUNING.channelBoost; w.concept = Math.max(w.concept, 1.12); }
      if (emotionalQuery) { w.frame = Math.max(w.frame, 1.18); }
      return w;
    })();
    const tokensList = tokenize(expandedText, 260);
    return {
      engine: RETRIEVAL_ENGINE_VERSION,
      rawQuery,
      expandedText,
      aliasDictionary,
      expandedEntityTokens: expandedQuery.entityTokens || [],
      mentionedEntities,
      knowledgeContext,
      tokens: tokensList,
      phraseBigrams: bigramTokens(tokensList, 220),
      charTokens: charNgramTokens(expandedText, 260),
      conceptTokens: mergeValues([conceptTokens, canonicalTokens], 160),
      canonicalTokens,
      explicitContinuityIntent: RETRIEVAL_EXPLICIT_CONTINUITY_INTENT_RE.test(rawQuery),
      presentStateQuery,
      channelWeights,
      surfaceQueryTokens: surfaceSpecificTokensOf(rawQuery),
      semanticFrameTokens: semanticFrameTokensForText(expandedText, conceptTokens),
      entityTokens: mergeValues([
        expandedQuery.entityTokens,
        tokenize(queryMentionedEntities(store, query).join(' '), 96),
        tokenize(mentionedEntities.join(' '), 96)
      ], 128),
      emotionTags: extractTags(expandedText, EMOTION_TAGS),
      branchTags: extractTags(expandedText, ENTITY_BRANCHES),
      worldTags: extractTags(expandedText, WORLD_SIGNALS),
      narrativeTags: extractTags(expandedText, NARRATIVE_TAGS),
      relationTags: extractTags(expandedText, RELATION_SIGNAL_TAGS),
      storyTags: extractTags(expandedText, STORY_LEDGER_HINTS),
      timeTags: extractTags(expandedText, TIME_SIGNAL_TAGS),
      axisWeights: axisWeights(query)
    };
  };
  const retrievalBm25Document = row => {
    const r = row.retrieval || {};
    const out = [];
    const pushToken = (token, weight = 1) => {
      const key = normalizeKey(token);
      if (!key) return;
      const count = Math.max(1, Math.min(5, Math.floor(Number(weight) || 1)));
      for (let i = 0; i < count; i += 1) out.push(key);
    };
    const pushValue = (value, weight = 1, limit = 180) => {
      const walk = source => {
        if (source == null) return;
        if (Array.isArray(source)) {
          source.forEach(walk);
          return;
        }
        if (objectish(source)) {
          const body = itemText(source);
          if (body) bm25DocumentTokens(body, limit).forEach(token => pushToken(token, weight));
          return;
        }
        const body = text(source);
        if (!body.trim()) return;
        pushToken(body, weight);
        bm25DocumentTokens(body, limit).forEach(token => pushToken(token, weight));
      };
      walk(value);
    };
    pushValue([r.canonicalAnchors, r.crossLingualTokens], 4, 160);
    pushValue([r.subjectTokens, r.relationEndpoints, r.entityNames, r.subject], 3, 160);
    pushValue([r.priorityTerms, r.locatorTokens, row.publicRef], 2, 220);
    pushValue([r.surfaceTokens, r.tokens, row.publicText, row.publicProfile], 1, 360);
    pushValue([r.conceptTokens, r.semanticFrameTokens, r.sourceEvidenceTokens], 1, 220);
    return out.slice(0, 900);
  };
  const buildRetrievalCorpus = rows => {
    const docs = ensureArray(rows).map(retrievalBm25Document);
    const docFreq = new Map();
    docs.forEach(doc => {
      new Set(doc).forEach(token => docFreq.set(token, (docFreq.get(token) || 0) + 1));
    });
    const avgDocLen = docs.length
      ? docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length
      : 1;
    return { docs, docFreq, avgDocLen, size: docs.length };
  };
  const retrievalBm25Weight = (settings = Memory.settings || DEFAULT_SETTINGS) => {
    if (settings?.bm25Channel === false) return 0;
    return clamp(settings?.bm25Weight, 0, 0.25, DEFAULT_SETTINGS.bm25Weight);
  };
  const retrievalRowPressure = r => Math.max(
    Number(r.pressure || 0),
    Number(r.emotionProfile?.intensity || 0),
    Number(r.emotionProfile?.relationImpact || 0),
    Number(r.worldProfile?.pressure || 0),
    Number(r.storyProfile?.priority || 0)
  );
  const RETRIEVAL_PREFILTER_MIN_ROWS = 240;
  const RETRIEVAL_PREFILTER_KEEP_LIMITS = Object.freeze({ fast: 280, balanced: 460, deep: 760 });
  const RETRIEVAL_PREFILTER_PROTECTED_RE = /\b(?:character|secret|pov_memory|relation|current_state|active_event|world_rule|offscreen_thread|faction|region|continuity_lock|do_not_resolve_yet|consequence|payoff|next_direction|suggested_hook|open_invitation|consent_memory|speaker_boundary|pattern_guard|overpromotion_risk|summary_memory|conflict_trace|state|scene_delta|theme_motif)\b/i;
  const prefilterExactScore = (row = {}, signature = {}, docTokens = []) => {
    const r = row.retrieval || {};
    const lexical = lexicalStats(signature.tokens, docTokens);
    const entity = lexicalStats(signature.entityTokens, mergeValues([r.subjectTokens, r.relationEndpoints, r.subject], 120));
    const concept = lexicalStats(signature.conceptTokens, conceptTokensForRetrieval(r));
    const canonical = lexicalStats(
      ensureArray(signature.canonicalTokens),
      mergeValues([r.canonicalAnchors, r.crossLingualTokens], 160).filter(token => CANONICAL_RECALL_TOKEN_PREFIX_RE.test(token))
    );
    const frame = lexicalStats(signature.semanticFrameTokens, r.semanticFrameTokens || []);
    const surfaceQueryTokens = ensureArray(signature.surfaceQueryTokens);
    const surfaceRowTokens = surfaceSpecificTokensOf([row.publicText, r.subject, ensureArray(r.priorityTerms).join(' ')].filter(Boolean).join(' '));
    const surfaceOverlap = surfaceQueryTokens.filter(token => surfaceRowTokens.includes(token)).length;
    const surfaceSignal = surfaceOverlap > 0 ? surfaceOverlap / Math.max(1, surfaceQueryTokens.length) : 0;
    const qKey = normalizeKey(signature.rawQuery || '');
    const subjectKey = normalizeKey(r.subject || '');
    const subjectMatch = subjectKey.length >= 2 && qKey.includes(subjectKey) ? 1 : 0;
    const refKey = normalizeKey(row.publicRef || row.id || '');
    const refMatch = refKey.length >= 4 && qKey.includes(refKey) ? 1 : 0;
    return Math.max(
      lexical.coverage * 0.55,
      lexical.jaccard,
      entity.coverage * 0.72,
      concept.coverage * 0.62,
      canonical.coverage,
      frame.coverage * 0.58,
      surfaceSignal * 0.72,
      subjectMatch,
      refMatch
    );
  };
  const prefilterForceKeep = (row = {}, signature = {}) => {
    const category = text(row.category || '');
    const axis = text(row.axis || '');
    if (RETRIEVAL_PREFILTER_PROTECTED_RE.test(category)) return true;
    if (Number(row.importance || 0) >= 0.9) return true;
    if (retrievalRowPressure(row.retrieval || {}) >= 0.85) return true;
    if (signature.explicitContinuityIntent && axis === 'planner') return true;
    if (signature.presentStateQuery && (axis === 'entity' || axis === 'world')) return true;
    return false;
  };
  const prefilterRetrievalRows = (rows = [], signature = {}, settings = Memory.settings) => {
    const input = ensureArray(rows);
    if (input.length < RETRIEVAL_PREFILTER_MIN_ROWS || !ensureArray(signature.tokens).length) return input;
    const mode = effectivePerformanceModeOf(settings);
    const keepLimit = Math.min(input.length, RETRIEVAL_PREFILTER_KEEP_LIMITS[mode] || RETRIEVAL_PREFILTER_KEEP_LIMITS.balanced);
    if (input.length <= keepLimit) return input;
    const scored = input.map((row, index) => {
      const docTokens = retrievalBm25Document(row);
      const exactScore = prefilterExactScore(row, signature, docTokens);
      const force = prefilterForceKeep(row, signature);
      return { index, row, force, exactScore };
    });
    const positive = scored.filter(item => item.force || item.exactScore > 0);
    if (positive.length < Math.min(80, Math.ceil(input.length * 0.08))) return input;
    if (positive.length < keepLimit) return input;
    const rankPrefilterItem = (a, b) => Number(b.force) - Number(a.force)
      || b.exactScore - a.exactScore
      || Number(b.row.importance || 0) - Number(a.row.importance || 0)
      || Number(b.row.updatedAt || 0) - Number(a.row.updatedAt || 0)
      || a.index - b.index;
    const keep = new Set();
    const forceItems = positive
      .filter(item => item.force)
      .sort(rankPrefilterItem);
    forceItems
      .slice(0, keepLimit)
      .forEach(item => keep.add(item.index));
    if (keep.size >= keepLimit) {
      return input.filter((_, index) => keep.has(index));
    }
    const exactPositive = positive
      .filter(item => !item.force)
      .sort(rankPrefilterItem);
    const fallback = scored
      .filter(item => !item.force && item.exactScore <= 0)
      .sort(rankPrefilterItem);
    const remainingAfterForce = keepLimit - keep.size;
    const fallbackReserve = Math.min(fallback.length, Math.max(24, Math.ceil(keepLimit * 0.12)), remainingAfterForce);
    const primaryLimit = Math.max(0, remainingAfterForce - fallbackReserve);
    exactPositive
      .slice(0, primaryLimit)
      .forEach(item => keep.add(item.index));
    fallback
      .slice(0, Math.max(0, keepLimit - keep.size))
      .forEach(item => keep.add(item.index));
    if (keep.size < keepLimit) {
      exactPositive
        .filter(item => !keep.has(item.index))
        .slice(0, keepLimit - keep.size)
        .forEach(item => keep.add(item.index));
    }
    return input.filter((_, index) => keep.has(index));
  };
  const scoreRowWithStrengthenedJaccard = (store, row, rowIndex, signature, corpus, profile, settings = Memory.settings) => {
    const r = row.retrieval || {};
    const lexical = lexicalStats(signature.tokens, r.tokens || []);
    const subjectStats = lexicalStats(signature.tokens, r.subjectTokens || tokenize(r.subject || '', 48));
    const subjectMatch = r.subject && normalizeKey(signature.rawQuery).includes(normalizeKey(r.subject)) ? 1 : 0;
    const pressure = retrievalRowPressure(r);
    const tagScores = {
      branch: jaccard(signature.branchTags, r.branchTags || []),
      emotion: Math.max(jaccard(signature.emotionTags, r.emotionTags || []), jaccard(signature.relationTags, r.relationTags || [])),
      world: Math.max(jaccard(signature.worldTags, r.worldTags || []), jaccard(signature.tokens, r.worldProfile?.locationTokens || []), jaccard(signature.tokens, r.worldProfile?.factionTokens || [])),
      narrative: Math.max(jaccard(signature.narrativeTags, r.narrativeTags || []), jaccard(signature.storyTags, r.storyTags || [])),
      time: jaccard(signature.timeTags, r.timeTags || []),
      locator: locatorScoreFor(signature.rawQuery, row, signature.tokens)
    };
    const priorityBoost = priorityBoostFor(signature.expandedText, r.priorityTerms || [], signature.tokens, signature.conceptTokens);
    const freshness = hayakuTimeFreshness(store, row, settings);
    const lifecycleLift = lifecycleRelevanceLift(row, signature.expandedText);
    const lifecycleMultiplier = lifecycleScoreMultiplier(row, signature.expandedText);
    const wordJaccard = softWeightedJaccard(signature.tokens, r.tokens || []);
    const charJaccard = softWeightedJaccard(signature.charTokens, charNgramTokens([row.publicText, r.subject, ensureArray(r.priorityTerms).join(' ')].filter(Boolean).join(' '), 260));
    const entityJaccard = softWeightedJaccard(signature.entityTokens, mergeValues([r.subjectTokens, r.relationEndpoints, r.subject], 120));
    const conceptJaccard = softWeightedJaccard(signature.conceptTokens, conceptTokensForRetrieval(r));
    const canonicalJaccard = softWeightedJaccard(
      ensureArray(signature.canonicalTokens),
      mergeValues([r.canonicalAnchors, r.crossLingualTokens], 160).filter(token => CANONICAL_RECALL_TOKEN_PREFIX_RE.test(token))
    );
    const canonicalSignal = Math.max(canonicalJaccard.jaccard, canonicalJaccard.coverage);
    const frameJaccard = softWeightedJaccard(signature.semanticFrameTokens, r.semanticFrameTokens || semanticFrameTokensForText(row.publicText || ''));
    const locatorJaccard = softWeightedJaccard(signature.tokens, r.locatorTokens || []);
    const bm25Raw = bm25Score(signature.tokens, corpus.docs[rowIndex] || [], corpus.docFreq, Math.max(1, corpus.size), corpus.avgDocLen);
    const bm25Weight = retrievalBm25Weight(settings);
    const bm25Signal = clamp(bm25Raw * bm25Weight, 0, 0.25, 0);
    const entitySignal = Math.max(entityJaccard.jaccard, entityJaccard.coverage, subjectStats.coverage, subjectMatch);
    const conceptSignal = Math.max(
      conceptJaccard.jaccard,
      conceptJaccard.coverage,
      tagScores.branch,
      tagScores.emotion,
      tagScores.world,
      tagScores.narrative,
      tagScores.time
    );
    const frameSignal = Math.max(frameJaccard.jaccard, frameJaccard.coverage);
    const locatorSignal = Math.max(locatorJaccard.jaccard, locatorJaccard.coverage, tagScores.locator);
    const specificConceptStats = softWeightedJaccard(
      ensureArray(signature.conceptTokens).filter(isSpecificConceptToken),
      mergeValues([r.crossLingualTokens, r.relationTags?.map(tag => `relation:${tag}`)], 128).filter(isSpecificConceptToken)
    );
    const specificConceptSignal = Math.max(specificConceptStats.jaccard, specificConceptStats.coverage);
    const specificFrameStats = softWeightedJaccard(
      ensureArray(signature.semanticFrameTokens).filter(isSpecificFrameToken),
      ensureArray(r.semanticFrameTokens).filter(isSpecificFrameToken)
    );
    const specificFrameSignal = Math.max(specificFrameStats.jaccard, specificFrameStats.coverage);
    const phraseStats = lexicalStats(signature.phraseBigrams || [], bigramTokens(r.tokens || [], 220));
    const phraseSignal = Math.max(phraseStats.jaccard, phraseStats.coverage * 0.82);
    const surfaceQueryTokens = ensureArray(signature.surfaceQueryTokens);
    const surfaceRowTokens = surfaceSpecificTokensOf([row.publicText, r.subject, ensureArray(r.priorityTerms).join(' ')].filter(Boolean).join(' '));
    const surfaceOverlap = surfaceQueryTokens.filter(token => surfaceRowTokens.includes(token)).length;
    const surfaceSpecificSignal = surfaceOverlap > 0
      ? Math.min(0.42, 0.18 + (surfaceOverlap / Math.max(1, surfaceQueryTokens.length)) * 0.34)
      : 0;
    const explicitContinuityIntent = Boolean(signature.explicitContinuityIntent);
    const cw = signature.channelWeights || { entity: 1, world: 1, narrative: 1, planner: 1, locator: 1, frame: 1, concept: 1, lexical: 1 };
    const directSpecificity = Math.max(
      entitySignal,
      locatorSignal,
      specificConceptSignal,
      specificFrameSignal,
      canonicalSignal,
      surfaceSpecificSignal,
      phraseSignal,
      Number(lifecycleLift || 0) > 0 ? 0.2 : 0,
      subjectStats.coverage,
      subjectMatch,
      lexical.coverage,
      wordJaccard.coverage,
      Number(lexical.overlap || 0) >= 2 ? 0.35 : 0,
      Number(priorityBoost || 0) >= 0.14 ? 0.3 : 0
    );
    const genericConceptOnly = directSpecificity < JACCARD_TUNING.specificGateFloor && !(row.axis === 'planner' && explicitContinuityIntent);
    const effectiveConceptCoverage = genericConceptOnly ? Math.min(conceptJaccard.coverage, JACCARD_TUNING.genericConceptCap) : conceptJaccard.coverage;
    const effectiveConceptSignal = genericConceptOnly ? Math.min(conceptSignal, JACCARD_TUNING.genericConceptCap) : conceptSignal;
    const effectiveFrameSignal = genericConceptOnly ? Math.min(frameSignal, JACCARD_TUNING.genericConceptCap) : frameSignal;
    const memoryStrength = clamp(
      Number(row.importance || 0) * 0.35
      + Number(r.salience || 0) * 0.25
      + Number(r.impression || 0) * 0.20
      + Number(r.confidence || 0.5) * 0.20,
      0, 1, 0.4
    );
    const lexicalScore = clamp(
      Math.max(wordJaccard.jaccard, wordJaccard.coverage * 0.74, lexical.jaccard) * 0.32
      + Math.max(charJaccard.jaccard, charJaccard.coverage * 0.58) * 0.20
      + Math.max(entityJaccard.jaccard, entityJaccard.coverage * 0.82, subjectStats.coverage, subjectMatch) * 0.26
      + Math.max(locatorJaccard.jaccard, locatorJaccard.coverage * 0.78) * 0.12
      + bm25Signal,
      0, 1, 0
    );
    const strengthenedJaccard = clamp(
      Math.max(wordJaccard.jaccard, wordJaccard.coverage * 0.74, lexical.jaccard) * 0.20
      + Math.max(charJaccard.jaccard, charJaccard.coverage * 0.58) * 0.09
      + entitySignal * 0.18 * cw.entity
      + Math.max(effectiveConceptSignal, canonicalSignal) * 0.15 * cw.concept
      + canonicalSignal * 0.12
      + effectiveFrameSignal * 0.18 * cw.frame
      + locatorSignal * 0.13 * cw.locator
      + bm25Signal * 0.75,
      0, 1, 0
    );
    const relevanceEvidence = clamp(
      (Math.max(strengthenedJaccard, lexicalScore, entitySignal, effectiveConceptSignal, effectiveFrameSignal, canonicalSignal, locatorSignal, priorityBoost, bm25Signal, directSpecificity * 0.4, phraseSignal * 0.5) + lifecycleLift) * lifecycleMultiplier,
      0, 1, 0
    );
    const relevanceGate = clamp(relevanceEvidence * 1.85, 0, 1, 0);
    const axisChannelBoost = row.axis === 'world' ? (cw.world || 1) : row.axis === 'narrative' ? (cw.narrative || 1) : 1;
    const axisPrior = clamp((signature.axisWeights[row.axis] || 0) * axisChannelBoost * Math.max(strengthenedJaccard, entitySignal, effectiveConceptSignal, locatorSignal), 0, 1, 0);
    const pressurePrior = clamp(pressure * relevanceGate, 0, 1, 0);
    const memoryPrior = clamp(memoryStrength * (0.18 + relevanceGate * 0.82), 0, 1, 0);
    const freshnessPrior = clamp(freshness * (0.22 + relevanceGate * 0.78), 0, 1, 0);
    const priorityPrior = clamp(priorityBoost * (0.35 + relevanceGate * 0.65), 0, 1, 0);
    const freshnessWeight = signature.presentStateQuery ? JACCARD_TUNING.presentStateFreshnessWeight : JACCARD_TUNING.defaultFreshnessWeight;
    const importantRecallLift = clamp(
      (
        Math.max(0, Number(row.importance || 0) - 0.78) * 0.62
        + Math.max(0, memoryStrength - 0.78) * 0.34
      ) * relevanceGate,
      0, relevanceEvidence >= 0.045 ? 0.20 : 0.06, 0
    );
    const plannerCoordinationLift = row.axis === 'planner'
      ? clamp(
        (0.035 + memoryStrength * 0.025 + pressure * 0.025) * (0.35 + relevanceGate * 0.65) * (cw.planner || 1),
        0, 0.08, 0
      )
      : 0;
    const score = clamp(
      (strengthenedJaccard * 0.60
      + lexicalScore * 0.10 * cw.lexical
      + entitySignal * 0.06 * cw.entity
      + effectiveConceptSignal * 0.05 * cw.concept
      + effectiveFrameSignal * 0.06 * cw.frame
      + locatorSignal * 0.05 * cw.locator
      + phraseSignal * JACCARD_TUNING.phraseChannelWeight
      + priorityPrior * 0.04
      + pressurePrior * 0.015
      + memoryPrior * 0.025
      + freshnessPrior * freshnessWeight
      + axisPrior * 0.025
      + importantRecallLift
      + plannerCoordinationLift) * lifecycleMultiplier,
      0, 1.35, 0
    );
    return {
      ...row,
      score,
      retrievalEngine: signature.engine,
      scoreBreakdown: {
        retrievalEngine: signature.engine,
        lexical: Number(lexicalScore.toFixed(4)),
        strengthenedJaccard: Number(strengthenedJaccard.toFixed(4)),
        relevanceEvidence: Number(relevanceEvidence.toFixed(4)),
        jaccard: Number(lexical.jaccard.toFixed(4)),
        wordJaccard: Number(wordJaccard.jaccard.toFixed(4)),
        charJaccard: Number(charJaccard.jaccard.toFixed(4)),
        entityJaccard: Number(entityJaccard.jaccard.toFixed(4)),
        conceptJaccard: Number(conceptJaccard.jaccard.toFixed(4)),
        canonicalJaccard: Number(canonicalJaccard.jaccard.toFixed(4)),
        canonicalSignal: Number(canonicalSignal.toFixed(4)),
        specificConceptSignal: Number(specificConceptSignal.toFixed(4)),
        frameJaccard: Number(frameJaccard.jaccard.toFixed(4)),
        specificFrameSignal: Number(specificFrameSignal.toFixed(4)),
        surfaceSpecificSignal: Number(surfaceSpecificSignal.toFixed(4)),
        phraseSignal: Number(phraseSignal.toFixed(4)),
        phraseJaccard: Number(phraseStats.jaccard.toFixed(4)),
        presentStateQuery: Boolean(signature.presentStateQuery),
        channelWeights: cw,
        locatorJaccard: Number(locatorJaccard.jaccard.toFixed(4)),
        bm25: Number(bm25Raw.toFixed(4)),
        bm25Signal: Number(bm25Signal.toFixed(4)),
        bm25Weight: Number(bm25Weight.toFixed(4)),
        bm25Enabled: bm25Weight > 0,
        coverage: Number(lexical.coverage.toFixed(4)),
        overlap: lexical.overlap,
        subject: Number(Math.max(subjectStats.coverage, subjectMatch).toFixed(4)),
        axis: Number((signature.axisWeights[row.axis] || 0).toFixed(4)),
        branch: Number(tagScores.branch.toFixed(4)),
        emotion: Number(tagScores.emotion.toFixed(4)),
        world: Number(tagScores.world.toFixed(4)),
        narrative: Number(tagScores.narrative.toFixed(4)),
        time: Number(tagScores.time.toFixed(4)),
        locator: Number(tagScores.locator.toFixed(4)),
        entitySignal: Number(entitySignal.toFixed(4)),
        conceptSignal: Number(conceptSignal.toFixed(4)),
        effectiveConceptSignal: Number(effectiveConceptSignal.toFixed(4)),
        frameSignal: Number(frameSignal.toFixed(4)),
        effectiveFrameSignal: Number(effectiveFrameSignal.toFixed(4)),
        locatorSignal: Number(locatorSignal.toFixed(4)),
        relevanceGate: Number(relevanceGate.toFixed(4)),
        directSpecificity: Number(directSpecificity.toFixed(4)),
        genericConceptCap: genericConceptOnly,
        axisPrior: Number(axisPrior.toFixed(4)),
        pressurePrior: Number(pressurePrior.toFixed(4)),
        memoryPrior: Number(memoryPrior.toFixed(4)),
        freshnessPrior: Number(freshnessPrior.toFixed(4)),
        priorityPrior: Number(priorityPrior.toFixed(4)),
        pressure: Number(pressure.toFixed(4)),
        memoryStrength: Number(memoryStrength.toFixed(4)),
        salience: Number(Number(r.salience || 0).toFixed(4)),
        impression: Number(Number(r.impression || 0).toFixed(4)),
        confidence: Number(Number(r.confidence || 0).toFixed(4)),
        priorityBoost: Number(priorityBoost.toFixed(4)),
        importantRecallLift: Number(importantRecallLift.toFixed(4)),
        plannerCoordinationLift: Number(plannerCoordinationLift.toFixed(4)),
        lifecycleLift: Number(lifecycleLift.toFixed(4)),
        lifecycleMultiplier: Number(lifecycleMultiplier.toFixed(4)),
        recency: Number(freshness.toFixed(4))
      }
    };
  };
  const rowPassesRetrievalGate = (row, profile) => {
    const breakdown = row.scoreBreakdown || {};
    const relevanceEvidence = Number(breakdown.relevanceEvidence || 0);
    if (Number(breakdown.lifecycleMultiplier || 1) < 0.5) return false;
    return (row.score > profile.threshold && relevanceEvidence >= JACCARD_TUNING.gateRelevanceFloor)
      || Number(breakdown.strengthenedJaccard || 0) >= JACCARD_TUNING.strongJaccardFloor
      || relevanceEvidence >= JACCARD_TUNING.gateHighRelevanceFloor
      || (row.importance >= 0.82 && relevanceEvidence >= JACCARD_TUNING.importantRelevanceFloor)
      || Number(breakdown.locatorSignal || 0) >= JACCARD_TUNING.locatorSignalFloor
      || Number(breakdown.priorityBoost || 0) >= JACCARD_TUNING.priorityBoostFloor
      || (Number(breakdown.directSpecificity || 0) >= JACCARD_TUNING.specificGateFloor && relevanceEvidence >= JACCARD_TUNING.gateSpecificRelevanceFloor)
      || Number(breakdown.phraseSignal || 0) >= JACCARD_TUNING.gatePhraseSignalFloor
      || (row.axis === 'planner' && row.score > profile.threshold * JACCARD_TUNING.gatePlannerThresholdRatio && relevanceEvidence >= JACCARD_TUNING.gatePlannerRelevanceFloor);
  };
  const isStrongPresentStateLookupQuery = query => /(?:현재|지금|방금|최신|今|現在|さっき|最新|latest|current|now|right now)/i.test(text(query));
  const isPastStateLookupQuery = query => /(?:과거|예전|이전|전에|지난|당시|있었|있던|있었는지|있었음|過去|昔|以前|前に|当時|あった|いた|past|previous|before|formerly|used to|where was|where were)/i.test(text(query))
    || (!isStrongPresentStateLookupQuery(query) && /(?:기록|내역|이력|변천|변화|히스토리|記録|履歴|変遷|変化|経緯|ヒストリー|history|timeline|record|log)/i.test(text(query)));
  const isPresentStateLookupQuery = query => /(?:현재|지금|방금|최신|위치|장소|어디|상태|있어|있나|있니|있음|今|現在|さっき|最新|位置|場所|どこ|何処|状態|様子|いる|ある|latest|current|now|right now|where|location|place|status|state)/i.test(text(query));
  const isCurrentStateQuery = query => isPresentStateLookupQuery(query) && !isPastStateLookupQuery(query);
  const currentWorldStopToken = /^(?:현재|상태|위치|장소|시간|안|안에|안의|밖|밖에|위|위에|아래|아래에|옆|옆에|앞|앞에|뒤|뒤에|그대로|으로|에서|에게|있었|있었음|있음|있다|있고|옮겨|옮겨짐|이동|놓여|숨겨|확인|보관|봉인|今|現在|状態|様子|位置|場所|時間|中|外|上|下|横|前|後ろ|そのまま|あった|ある|いる|移動|置かれ|隠れ|確認|保管|封印|current|state|location|place|moved|placed|hidden)$/i;
  const currentWorldTopicTokenSequence = value => {
    const cleaned = cleanSearchText(value);
    if (!cleaned) return [];
    return cleaned.split(/\s+/)
      .map(token => normalizedSurface(token))
      .filter(token => token.length >= 2 && !currentWorldStopToken.test(token));
  };
  const currentWorldTopicTokens = value => uniq(currentWorldTopicTokenSequence(value), 12);
  const currentWorldBroadTopicToken = /^(?:물건|사물|대상|항목|아이템|것들|物|物品|対象|項目|アイテム|もの|object|objects|item|items|thing|things)$/i;
  const currentWorldSubsequenceIndex = (tokens = [], needle = []) => {
    if (!tokens.length || !needle.length || needle.length > tokens.length) return -1;
    for (let i = 0; i <= tokens.length - needle.length; i += 1) {
      if (needle.every((token, offset) => tokens[i + offset] === token)) return i;
    }
    return -1;
  };
  const currentWorldSubsequenceCount = (tokens = [], needle = []) => {
    if (!tokens.length || !needle.length || needle.length > tokens.length) return 0;
    let count = 0;
    for (let i = 0; i <= tokens.length - needle.length; i += 1) {
      if (needle.every((token, offset) => tokens[i + offset] === token)) count += 1;
    }
    return count;
  };
  const currentWorldSpecificTopicKey = (textTokens = [], queryOverlap = [], querySequence = []) => {
    const coreTokens = queryOverlap.slice(-2);
    if (coreTokens.length < 2) return textTokens.slice(0, 2).join('|');
    if (currentWorldSubsequenceCount(querySequence, coreTokens) < 2) return coreTokens.join('|');
    const coreIndex = currentWorldSubsequenceIndex(textTokens, coreTokens);
    const qualifier = coreIndex > 0
      ? textTokens.slice(0, coreIndex).find(token => querySequence.includes(token))
      : '';
    return uniq([qualifier, ...coreTokens].filter(Boolean), 3).join('|');
  };
  const currentWorldBroadTopicKey = (textTokens = [], queryTokens = []) => {
    const queryTokenSet = new Set(queryTokens.filter(token => !currentWorldBroadTopicToken.test(token)));
    const overlapIndices = textTokens
      .map((token, index) => queryTokenSet.has(token) ? index : -1)
      .filter(index => index >= 0);
    if (!overlapIndices.length) return textTokens.join('|');
    const overlapTokens = textTokens.filter(token => queryTokenSet.has(token));
    const lastOverlapIndex = Math.max(...overlapIndices);
    const firstDistinctAfterOverlap = textTokens
      .slice(lastOverlapIndex + 1)
      .find(token => !queryTokenSet.has(token));
    return uniq([...overlapTokens, firstDistinctAfterOverlap].filter(Boolean), 12).join('|');
  };
  const currentWorldTopicKey = (row, query = '') => {
    if (row?.axis !== 'world' || !['active_event', 'current_state'].includes(row.category)) return '';
    const r = row.retrieval || {};
    const objectTokens = ensureArray(r.crossLingualTokens).filter(token => /^object:/i.test(token)).sort();
    const colorTokens = ensureArray(r.crossLingualTokens).filter(token => /^color:/i.test(token)).sort();
    const conceptKey = objectTokens.length ? [...objectTokens, ...colorTokens].join('|') : '';
    if (conceptKey) return `${row.axis}|${row.category}|${conceptKey}`;
    const textTokens = currentWorldTopicTokens(row.publicText || '');
    const querySequence = currentWorldTopicTokenSequence(query);
    const queryTokens = uniq(querySequence, 12);
    const queryOverlap = textTokens.filter(token => queryTokens.includes(token));
    const hasBroadQueryTopic = queryTokens.some(token => currentWorldBroadTopicToken.test(token));
    if (hasBroadQueryTopic) return currentWorldBroadTopicKey(textTokens, queryTokens);
    return queryOverlap.length >= 2
      ? currentWorldSpecificTopicKey(textTokens, queryOverlap, querySequence)
      : textTokens.slice(0, 2).join('|');
  };
  const currentWorldFreshnessRank = row => {
    const locator = row?.locator || {};
    const chatRecency = Number(locator.chatRecency ?? row?.retrieval?.chatRecency);
    const distanceFromLatest = Number(locator.distanceFromLatest ?? row?.retrieval?.distanceFromLatest);
    const messageIndex = Number(locator.messageIndex);
    const turnId = Number(locator.turnId);
    return {
      chatRecency: Number.isFinite(chatRecency) ? chatRecency : -1,
      distanceFromLatest: Number.isFinite(distanceFromLatest) ? distanceFromLatest : Number.POSITIVE_INFINITY,
      messageIndex: Number.isFinite(messageIndex) ? messageIndex : -1,
      turnId: Number.isFinite(turnId) ? turnId : -1,
      score: Number(row?.score || 0),
      importance: Number(row?.importance || 0)
    };
  };
  const compareCurrentWorldFreshness = (left, right) => {
    const a = currentWorldFreshnessRank(left);
    const b = currentWorldFreshnessRank(right);
    return b.chatRecency - a.chatRecency
      || a.distanceFromLatest - b.distanceFromLatest
      || b.messageIndex - a.messageIndex
      || b.turnId - a.turnId
      || b.score - a.score
      || b.importance - a.importance;
  };
  const collapseCurrentWorldConflicts = (rows = [], query = '') => {
    if (!isCurrentStateQuery(query)) return rows;
    const winners = new Map();
    ensureArray(rows).forEach(row => {
      const key = currentWorldTopicKey(row, query);
      if (!key) return;
      const current = winners.get(key);
      if (!current || compareCurrentWorldFreshness(current, row) > 0) winners.set(key, row);
    });
    const emitted = new Set();
    return ensureArray(rows).filter(row => {
      const key = currentWorldTopicKey(row, query);
      if (!key) return true;
      if (winners.get(key) !== row || emitted.has(key)) return false;
      emitted.add(key);
      return true;
    });
  };
  const selectRowsPerAxis = (rows, settings = Memory.settings, profile = modeProfile(settings?.effectiveMode || settings?.mode), query = '', store = {}) => {
    const perAxis = { entity: [], world: [], narrative: [], planner: [] };
    const axisLimit = Math.max(1, Math.min(12, Number(settings.maxItemsPerAxis || 4) + Number(profile.itemBonus || 0)));
    const viewCharBudget = stateViewCharBudgetForMode(settings.effectivePromptMode || settings.promptMode || 'balanced');
    const observedMessageCounts = ensureArray(rows)
      .map(row => Number(row?.locator?.messageCount ?? row?.retrieval?.messageCount))
      .filter(Number.isFinite);
    const sourceMessageCount = observedMessageCounts.length ? Math.max(...observedMessageCounts) : 0;
    const shortChatContext = sourceMessageCount > 0 && sourceMessageCount <= 12;
    const queryText = text(query);
    const plannerIntentQuery = SELECT_PLANNER_INTENT_RE.test(queryText);
    const narrativeActionQuery = narrativeActionText(queryText);
    const handTouchQuery = SELECT_HAND_TOUCH_RE.test(queryText);
    const deeperQuestionQuery = SELECT_DEEPER_QUESTION_RE.test(queryText);
    const observerWitnessQuery = SELECT_OBSERVER_WITNESS_RE.test(queryText);
    const publicRevealQuery = SELECT_PUBLIC_REVEAL_RE.test(queryText);
    const rumorSpreadQuery = SELECT_RUMOR_SPREAD_RE.test(queryText);
    const publicExposureQuery = observerWitnessQuery || publicRevealQuery || rumorSpreadQuery;
    const ambientCueQuery = SELECT_AMBIENT_CUE_RE.test(queryText);
    const descriptiveOnlyQuery = SELECT_DESCRIPTIVE_ONLY_RE.test(queryText);
    const stateOrProfileIntentQuery = SELECT_STATE_OR_PROFILE_INTENT_RE.test(queryText);
    const ambientVisualObservationQuery = SELECT_AMBIENT_VISUAL_OBSERVATION_RE.test(queryText);
    const memoryFocusedQuery = SELECT_MEMORY_FOCUSED_RE.test(queryText);
    const intimacyConsentQuery = SELECT_INTIMACY_CONSENT_RE.test(queryText);
    const ambientBackgroundQuery = ambientCueQuery
      && (descriptiveOnlyQuery || !stateOrProfileIntentQuery)
      && !plannerIntentQuery
      && !narrativeActionQuery
      && (!publicExposureQuery || ambientVisualObservationQuery)
      && !handTouchQuery
      && !deeperQuestionQuery
      && !isPresentStateLookupQuery(query);
    const nameVariants = value => {
      const raw = text(value).trim();
      const variants = [raw];
      const compactName = raw.replace(/\s+/g, '');
      if (/^[가-힣]{3,4}$/.test(compactName)) variants.push(compactName.slice(1));
      return mergeValues(variants, 8);
    };
    const rowSubjectNames = row => {
      const publicHead = text(row?.publicText || '').split(':')[0];
      return mergeValues([
        row?.retrieval?.subject,
        row?.locator?.subject,
        row?.publicRef,
        publicHead,
        row?.retrieval?.relationEndpoints,
        row?.retrieval?.knowledgeEntities,
        row?.retrieval?.entityNames
      ], 32).flatMap(nameVariants);
    };
    const queryMentionedEntityRows = ensureArray(rows)
      .filter(row => row?.axis === 'entity' && row?.category === 'character')
      .filter(row => queryMentionsAny(query, rowSubjectNames(row)));
    const mentionedEntityCount = uniq(queryMentionedEntityRows.map(row => row.retrieval?.subject || text(row.publicText || '').split(':')[0]), 16).length;
    const sceneAnchors = objectish(store.context?.sceneAnchors) ? store.context.sceneAnchors : {};
    const scenePrimaryAnchorNames = uniq([
      sceneAnchors.povEntities,
      sceneAnchors.activeSpeakers
    ].flatMap(value => ensureArray(value)), 32);
    const rowMatchesSceneAnchor = row => row?.axis === 'entity'
      && row?.category === 'character'
      && scenePrimaryAnchorNames.length
      && queryMentionsAny(scenePrimaryAnchorNames.join(' '), rowSubjectNames(row));
    const sceneAnchorEntityCount = uniq(ensureArray(rows)
      .filter(rowMatchesSceneAnchor)
      .map(row => row.retrieval?.subject || text(row.publicText || '').split(':')[0]), 16).length;
    const entityLimit = Math.max(axisLimit, Math.min(12, mentionedEntityCount + 2));
    const plannerLimit = Math.max(axisLimit, Math.min(14, axisLimit + 2));
    const totalRowLimit = Math.max(4, Math.min(16, (Math.max(axisLimit, entityLimit) * 2) + 1 + Math.max(0, Number(profile.itemBonus || 0))));
    const baseAxisRowLimit = axis => axis === 'entity' ? entityLimit : (axis === 'planner' ? plannerLimit : axisLimit);
    const rowHasExplicitEntityMention = row => row?.axis === 'entity' && queryMentionsAny(query, rowSubjectNames(row));
    const mentionedEntityNames = uniq(queryMentionedEntityRows.flatMap(row => rowSubjectNames(row)), 48);
    const ambientTopicTokens = value => currentWorldTopicTokens(value).filter(token => !SELECT_AMBIENT_TOPIC_STOP_RE.test(token));
    const rowHasExplicitAmbientWorldAnchor = row => {
      if (row?.axis !== 'world') return false;
      const queryTokens = ambientTopicTokens(query);
      if (!queryTokens.length) return false;
      const rowTokens = ambientTopicTokens([
        row?.publicText,
        row?.publicProfile,
        row?.retrieval?.subject,
        row?.retrieval?.entityNames,
        row?.retrieval?.worldTags
      ].map(value => text(ensureArray(value).join ? ensureArray(value).join(' ') : value)).join(' '));
      return queryTokens.some(token => rowTokens.includes(token));
    };
    const axisRowLimit = axis => {
      if (!ambientBackgroundQuery) return baseAxisRowLimit(axis);
      if (axis === 'entity') {
        const ambientEntityCount = Math.max(mentionedEntityCount, sceneAnchorEntityCount);
        return ambientEntityCount > 0 ? Math.min(baseAxisRowLimit(axis), ambientEntityCount) : 0;
      }
      if (axis === 'world') return 1;
      return 0;
    };
    const plannerRowText = row => [
      row?.publicText,
      row?.publicProfile,
      row?.lifecycle?.status,
      row?.lifecycle?.timeScope,
      row?.lifecycle?.evidence,
      row?.retrieval?.subject,
      row?.retrieval?.priorityTerms,
      row?.retrieval?.relationEndpoints,
      row?.retrieval?.knowledgeEntities,
      row?.retrieval?.entityNames
    ].map(value => text(ensureArray(value).join ? ensureArray(value).join(' ') : value)).join(' ');
    const plannerHasEntityAnchor = row => row?.axis === 'planner' && mentionedEntityNames.length && queryMentionsAny(plannerRowText(row), mentionedEntityNames);
    const plannerHasSpecificContinuityAnchor = row => {
      if (row?.axis !== 'planner') return false;
      const body = plannerRowText(row);
      const breakdown = row?.scoreBreakdown || {};
      if (Number(breakdown.coverage || 0) >= 0.65) return true;
      if (Number(breakdown.surfaceSpecificSignal || 0) >= 0.16) return true;
      if (Number(breakdown.locatorSignal || 0) >= 0.24) return true;
      if (breakdown.bm25Enabled && Number(breakdown.bm25 || 0) >= 0.18 && Number(breakdown.bm25Signal || 0) > 0) return true;
      if (plannerIntentQuery && continuityPressureText(body)) return true;
      if (narrativeActionQuery && plannerHasEntityAnchor(row) && continuityPressureText(body)) return true;
      return false;
    };
    const visibilityPressureKind = row => {
      if (row?.axis !== 'planner') return '';
      const body = plannerRowText(row);
      const observerActionBody = SELECT_VISIBILITY_OBSERVER_ACTION_RE.test(body);
      const observerActorBody = SELECT_VISIBILITY_OBSERVER_ACTOR_RE.test(body);
      const publicBody = SELECT_VISIBILITY_PUBLIC_BODY_RE.test(body);
      const rumorBody = SELECT_VISIBILITY_RUMOR_BODY_RE.test(body);
      if (rumorSpreadQuery && rumorBody) return 'rumor';
      if (observerWitnessQuery && (observerActionBody || (!rumorBody && observerActorBody))) return 'observer';
      if (publicRevealQuery && (publicBody || observerActionBody || observerActorBody)) return 'public';
      return '';
    };
    const plannerMatchesDirectScenePressure = row => {
      if (row?.axis !== 'planner') return false;
      const body = plannerRowText(row);
      if (handTouchQuery && SELECT_DIRECT_HAND_BODY_RE.test(body)) return true;
      if (deeperQuestionQuery && SELECT_DIRECT_DEEPER_BODY_RE.test(body)) return true;
      if (publicExposureQuery && visibilityPressureKind(row)) return true;
      return false;
    };
    const plannerDirectSceneTier = row => {
      if (!plannerMatchesDirectScenePressure(row)) return 0;
      const category = text(row?.category || '');
      if (/payoff|consequence|next_direction|suggested_hook|open_invitation/i.test(category)) return 3;
      if (/do_not_resolve_yet/i.test(category)) return 2;
      if (/continuity_lock/i.test(category)) return 1;
      return 1;
    };
    const plannerNeedsStrongAnchor = row => {
      if (row?.axis !== 'planner') return false;
      return true;
    };
    const categoryPriority = row => {
      const category = text(row?.category || '');
      const axis = text(row?.axis || '');
      const body = [
        row?.publicText,
        row?.lifecycle?.status,
        row?.lifecycle?.timeScope,
        row?.lifecycle?.evidence,
        row?.retrieval?.status,
        row?.retrieval?.timeScope
      ].map(value => text(value)).join(' ');
      if (/secret|world_rule/i.test(category)) return 'required';
      if (axis === 'planner' && plannerDirectSceneTier(row) >= 3) return 'direct';
      if (axis === 'planner' && plannerMatchesDirectScenePressure(row)) return 'required';
      if (/continuity_lock|do_not_resolve_yet/i.test(category) && plannerHasSpecificContinuityAnchor(row)) return 'required';
      if (/continuity_lock|do_not_resolve_yet/i.test(category) && hasSpecificSelectionAnchor(row)) return 'conditional';
      if (/pov_memory/i.test(category) && (memoryFocusedQuery || Number(row?.score || 0) >= 0.24)) return 'required';
      if (axis === 'entity' && /character/i.test(category) && rowHasExplicitEntityMention(row)) return 'required';
      if (axis === 'planner' && (/consequence|payoff|next_direction|suggested_hook|open_invitation/i.test(category) || (plannerIntentQuery && continuityPressureText(body)))) return 'conditional';
      if (axis === 'planner' && /consent_memory/i.test(category) && intimacyConsentQuery) return 'required';
      if (axis === 'planner' && /open_invitation|consent_memory/i.test(category)) return 'conditional';
      if (shortChatContext && !ambientBackgroundQuery && axis === 'world' && /current_state|active_event|world_rule/i.test(category)) return 'conditional';
      if (shortChatContext && !ambientBackgroundQuery && axis === 'narrative' && /current_arc|scene_delta|state|conflict_trace/i.test(category)) return 'conditional';
      if (/character|relation|current_state|active_event|world_rule|consequence|payoff|next_direction|suggested_hook|open_invitation/i.test(category)) return 'conditional';
      if (/pov_memory/i.test(category)) return 'conditional';
      if (axis === 'narrative' && /theme_motif|scene_delta/i.test(category) && hasSpecificSelectionAnchor(row)) return 'conditional';
      if (axis === 'world' && /offscreen_thread|faction|region/i.test(category) && hasSpecificSelectionAnchor(row)) return 'conditional';
      return 'optional';
    };
    const priorityBoost = priority => priority === 'direct' ? 0.62 : (priority === 'required' ? 0.42 : (priority === 'conditional' ? 0.16 : 0));
    const continuityBoost = row => {
      const category = text(row?.category || '');
      const axis = text(row?.axis || '');
      const lifecycle = row?.lifecycle || {};
      const body = [
        row?.publicText,
        lifecycle.status,
        lifecycle.timeScope,
        lifecycle.evidence,
        row?.retrieval?.status,
        row?.retrieval?.timeScope
      ].map(value => text(value)).join(' ');
      if (/continuity_lock|do_not_resolve_yet/i.test(category)) return 0.34;
      if (/secret|world_rule/i.test(category)) return 0.24;
      if (axis === 'planner' && /consequence|payoff|next_direction|suggested_hook|open_invitation/i.test(category)) return 0.28;
      if (/consequence|payoff|next_direction|suggested_hook|open_invitation/i.test(category)) return 0.24;
      if (axis === 'planner' && continuityPressureText(body)) return 0.2;
      if (axis === 'planner' && /consent_memory/i.test(category)) return intimacyConsentQuery ? 0.42 : 0.22;
      if (axis === 'planner' && /open_invitation/i.test(category)) return 0.2;
      if (/planner/i.test(category)) return 0.16;
      if (continuityPressureText(body)) {
        if (/relation|current_state|active_event|payoff|consequence/i.test(category)) return 0.26;
        if (/pov_memory|conflict_trace|state/i.test(category)) return 0.18;
        return 0.12;
      }
      if (/relation|current_state|active_event/i.test(category)) return 0.08;
      if (/offscreen_thread/i.test(category)) return 0.12;
      if (/theme_motif/i.test(category)) return 0.1;
      return 0;
    };
    const consistencyBoost = row => {
      const category = text(row?.category || '');
      const axis = text(row?.axis || '');
      const body = [
        row?.publicText,
        row?.publicProfile,
        row?.lifecycle?.status,
        row?.lifecycle?.timeScope,
        row?.lifecycle?.evidence,
        ensureArray(row?.retrieval?.knowledgeEntities).join(' '),
        ensureArray(row?.retrieval?.entityNames).join(' ')
      ].map(value => text(value)).join(' ');
      if (/secret/i.test(category)) return 0.36;
      if (/pov_memory/i.test(category)) return 0.28;
      if (axis === 'planner' && /consequence|payoff|next_direction|suggested_hook|open_invitation/i.test(category)) return 0.22;
      if (axis === 'planner' && continuityPressureText(body)) return 0.14;
      if (/continuity_lock|do_not_resolve_yet|consequence|payoff|next_direction|suggested_hook|open_invitation/i.test(category)) return 0.18;
      if (/character/i.test(category)) {
        return SELECT_CHARACTER_PROFILE_BODY_RE.test(body) ? 0.24 : 0.16;
      }
      if (/relation/i.test(category)) return 0.2;
      if (axis === 'entity') return 0.12;
      return 0;
    };
    const tierBoost = row => {
      const axis = text(row?.axis || '');
      const category = text(row?.category || '');
      if (/secret|pov_memory|continuity_lock|do_not_resolve_yet/i.test(category)) return 0.18;
      if (axis === 'planner' && /consequence|payoff|next_direction|suggested_hook|open_invitation/i.test(category)) return 0.14;
      if (axis === 'entity') return 0.11;
      if (axis === 'world') return /current_state|active_event|world_rule/i.test(category) ? 0.1 : 0.04;
      if (axis === 'narrative') return /conflict_trace/i.test(category) ? 0.08 : 0.02;
      if (axis === 'planner') return /consequence|payoff|next_direction|suggested_hook|open_invitation/i.test(category) ? 0.1 : 0.03;
      return 0;
    };
    const directScenePressureBoost = row => {
      if (!plannerMatchesDirectScenePressure(row)) return 0;
      const category = text(row?.category || '');
      if (/payoff|consequence|next_direction|suggested_hook|open_invitation/i.test(category)) return 0.62;
      return 0.34;
    };
    const visibilityGranularityBoost = row => {
      if (!publicExposureQuery || row?.axis !== 'planner') return 0;
      const kind = visibilityPressureKind(row);
      if (!kind) return 0;
      const body = plannerRowText(row);
      const rumorBody = SELECT_VISIBILITY_RUMOR_BODY_RE.test(body);
      const observerBody = SELECT_VISIBILITY_OBSERVER_ANY_RE.test(body);
      if (kind === 'observer' && observerBody) return rumorBody && !rumorSpreadQuery ? 0.08 : 0.18;
      if (kind === 'public') return 0.12;
      if (kind === 'rumor') return 0.2;
      return 0;
    };
    const plannerHasMismatchedVisibilityPressure = row => {
      if (row?.axis !== 'planner' || rumorSpreadQuery) return false;
      if (!observerWitnessQuery && !publicRevealQuery) return false;
      const body = plannerRowText(row);
      const rumorBody = SELECT_VISIBILITY_RUMOR_BODY_RE.test(body);
      const observerActionBody = SELECT_VISIBILITY_OBSERVER_ACTION_RE.test(body);
      return rumorBody && !observerActionBody;
    };
    const shortChatSelectionBoost = row => {
      if (!shortChatContext) return 0;
      const axis = text(row?.axis || '');
      const category = text(row?.category || '');
      if (ambientBackgroundQuery && axis !== 'planner') return 0;
      if (axis === 'planner') return plannerDirectSceneTier(row) >= 3 ? 0.08 : -0.18;
      if (axis === 'entity' && /character|relation/i.test(category)) return 0.1;
      if (axis === 'world' && /current_state|active_event|world_rule/i.test(category)) return 0.12;
      if (axis === 'narrative' && /current_arc|scene_delta|state|conflict_trace/i.test(category)) return 0.1;
      return 0;
    };
    const rowAllowedForAmbientQuery = row => {
      if (!ambientBackgroundQuery) return true;
      const axis = text(row?.axis || '');
      const category = text(row?.category || '');
      if (axis === 'planner' || axis === 'narrative') return false;
      if (axis === 'entity') return /character/i.test(category) && (rowHasExplicitEntityMention(row) || rowMatchesSceneAnchor(row));
      if (axis === 'world') {
        if (!/current_state|active_event|world_rule/i.test(category)) return false;
        if (!rowHasExplicitAmbientWorldAnchor(row)) return false;
        const lifecycleText = [row?.lifecycle?.status, row?.lifecycle?.timeScope, row?.retrieval?.status, row?.retrieval?.timeScope].map(value => text(value)).join(' ');
        if (SELECT_AMBIENT_INACTIVE_LIFECYCLE_RE.test(lifecycleText)) return false;
        const breakdown = row?.scoreBreakdown || {};
        return Number(breakdown.relevanceEvidence || 0) >= 0.08 || Number(breakdown.directSpecificity || 0) >= 0.18;
      }
      return false;
    };
    const rowCost = row => Math.max(120, Math.min(900, text(row?.publicText || '').length + text(row?.publicProfile || '').length + text(row?.lifecycle?.evidence || '').length + 180));
    const hasSpecificSelectionAnchor = row => {
      const breakdown = row?.scoreBreakdown || {};
      if (!breakdown.genericConceptCap) return true;
      if (Number(breakdown.directSpecificity || 0) >= 0.16) return true;
      const axis = text(row?.axis || '');
      if (axis === 'planner' && plannerIntentQuery) {
        const body = [
          row?.publicText,
          row?.lifecycle?.status,
          row?.lifecycle?.timeScope,
          row?.lifecycle?.evidence,
          row?.retrieval?.status,
          row?.retrieval?.timeScope
        ].map(value => text(value)).join(' ');
        return continuityPressureText(body);
      }
      return false;
    };
    const rowWeight = row => {
      const priority = categoryPriority(row);
      const recency = Number(row?.locator?.chatRecency ?? row?.retrieval?.chatRecency ?? 0);
      const costPenalty = rowCost(row) / 2800;
      return Number(row?.score || 0) * 1.3
        + Number(row?.importance || 0) * 0.18
        + (Number.isFinite(recency) ? recency * 0.06 : 0)
        + priorityBoost(priority)
        + continuityBoost(row)
        + consistencyBoost(row)
        + tierBoost(row)
        + directScenePressureBoost(row)
        + visibilityGranularityBoost(row)
        + shortChatSelectionBoost(row)
        + (rowHasExplicitEntityMention(row) ? (/character/i.test(row?.category || '') ? 0.38 : 0.16) : 0)
        - costPenalty;
    };
    const duplicateSignature = row => {
      const body = normalizeKey(text(row?.publicText || '')).slice(0, 120);
      if (!body) return '';
      const category = text(row?.category || '');
      if (row?.axis === 'planner' || /secret|pov_memory|continuity_lock|do_not_resolve_yet/i.test(category)) {
        return `${row.axis}|${category}|${body}`;
      }
      return body;
    };
    const looksDuplicateOfSelected = (row, selectedRows) => {
      const category = text(row?.category || '');
      if (/secret|pov_memory|continuity_lock|do_not_resolve_yet|world_rule/i.test(category)) return false;
      const body = text(row?.publicText || '');
      if (body.length < 32) return false;
      const tokens = tokenize(body, 96);
      const grams = charNgramTokens(body, 140);
      return ensureArray(selectedRows).some(selected => {
        const selectedCategory = text(selected?.category || '');
        if (/secret|pov_memory|continuity_lock|do_not_resolve_yet|world_rule/i.test(selectedCategory)) return false;
        const selectedBody = text(selected?.publicText || '');
        if (selectedBody.length < 32) return false;
        const tokenStats = lexicalStats(tokens, tokenize(selectedBody, 96));
        const charStats = softWeightedJaccard(grams, charNgramTokens(selectedBody, 140));
        return tokenStats.jaccard >= 0.42 || charStats.jaccard >= 0.52;
      });
    };
    const rankedRows = ensureArray(rows)
      .filter(row => row?.axis && perAxis[row.axis])
      .map((row, order) => ({ row, order, priority: categoryPriority(row), weight: rowWeight(row), cost: rowCost(row) }))
      .sort((a, b) => {
        const priorityRank = value => value === 'direct' ? 0 : (value === 'required' ? 1 : (value === 'conditional' ? 2 : 3));
        return priorityRank(a.priority) - priorityRank(b.priority)
          || b.weight - a.weight
          || Number(b.row.score || 0) - Number(a.row.score || 0)
          || Number(b.row.importance || 0) - Number(a.row.importance || 0)
          || a.order - b.order;
      });
    const selectedRows = [];
    const emittedSignatures = new Set();
    let usedChars = 0;
    for (const candidate of rankedRows) {
      const row = candidate.row;
      if (!perAxis[row.axis]) continue;
      if (!rowAllowedForAmbientQuery(row)) continue;
      if (plannerHasMismatchedVisibilityPressure(row)) continue;
      const limit = axisRowLimit(row.axis);
      if (perAxis[row.axis].length >= limit) continue;
      const required = candidate.priority === 'direct' || candidate.priority === 'required';
      if (!required && plannerNeedsStrongAnchor(row) && !plannerHasSpecificContinuityAnchor(row)) continue;
      if (!required && !hasSpecificSelectionAnchor(row)) continue;
      if (!required && selectedRows.length >= 5 && Number(row?.score || 0) < 0.08) continue;
      if (candidate.priority === 'optional' && Number(row?.score || 0) < 0.06) continue;
      if (selectedRows.length >= totalRowLimit && !required) continue;
      if (usedChars + candidate.cost > viewCharBudget && !required) continue;
      const signature = duplicateSignature(row);
      if (signature && emittedSignatures.has(signature) && !required) continue;
      if (!required && looksDuplicateOfSelected(row, selectedRows)) continue;
      perAxis[row.axis].push(row);
      selectedRows.push(row);
      usedChars += candidate.cost;
      if (signature) emittedSignatures.add(signature);
    }
    for (const axis of Object.keys(perAxis)) {
      perAxis[axis].sort((a, b) => {
        if (axis === 'planner') {
          const directRank = plannerDirectSceneTier(b) - plannerDirectSceneTier(a);
          if (directRank) return directRank;
        }
        return b.score - a.score || b.importance - a.importance || b.updatedAt - a.updatedAt;
      });
    }
    return perAxis;
  };
  const applyRrfFusion = (rows = [], k = JACCARD_TUNING.rrfK, blend = JACCARD_TUNING.rrfBlend, epsilon = JACCARD_TUNING.rrfSignalEpsilon) => {
    if (!rows.length) return rows;
    const signals = ['strengthenedJaccard', 'entitySignal', 'conceptSignal', 'canonicalSignal', 'frameSignal', 'locatorSignal', 'bm25Signal', 'phraseSignal'];
    const ranked = {};
    for (const sig of signals) {
      const sorted = [...rows]
        .filter(row => Number(row.scoreBreakdown?.[sig] || 0) > epsilon)
        .sort((a, b) => Number(b.scoreBreakdown?.[sig] || 0) - Number(a.scoreBreakdown?.[sig] || 0));
      ranked[sig] = new Map(sorted.map((row, index) => [row, index + 1]));
    }
    let maxRrf = 0;
    const computed = rows.map(row => {
      let rrf = 0;
      for (const sig of signals) {
        const rank = ranked[sig].get(row);
        if (rank !== undefined) rrf += 1 / (k + rank);
      }
      if (rrf > maxRrf) maxRrf = rrf;
      return { row, rrf };
    });
    return computed.map(({ row, rrf }) => {
      const norm = maxRrf > 0 ? rrf / maxRrf : 0;
      const base = Number(row.score || 0);
      const blended = clamp(base * (1 - blend) + norm * blend * 1.35, 0, 1.35, base);
      return {
        ...row,
        score: blended,
        scoreBreakdown: { ...row.scoreBreakdown, rrfScore: Number(norm.toFixed(4)), scoreBeforeRrf: Number(base.toFixed(4)) }
      };
    });
  };
  const searchIndexDeep = (store, query, settings = Memory.settings) => {
    const profile = modeProfile(settings?.effectiveMode || settings?.mode);
    clearTokenSimilarityCache();
    const signature = buildRetrievalQuerySignature(store, query, settings);
    const candidateRows = ensureArray(store.index).filter(row => !isKnowledgeUnavailableForQuery(row, query, signature.knowledgeContext || signature.mentionedEntities));
    const ledgerRev2Rows = resolvePacketLedgerRev2Supersessions(candidateRows, query);
    const prefilteredRows = prefilterRetrievalRows(ledgerRev2Rows, signature, settings);
    const corpus = buildRetrievalCorpus(prefilteredRows);
    const rows = applyRrfFusion(prefilteredRows
      .map((row, rowIndex) => scoreRowWithStrengthenedJaccard(store, row, rowIndex, signature, corpus, profile, settings))
      .map(row => applyPacketScoringV2(row, signature, store, settings))
      .filter(row => rowPassesRetrievalGate(row, profile)))
      .sort((a, b) => b.score - a.score || b.importance - a.importance || b.updatedAt - a.updatedAt);
    return selectRowsPerAxis(collapseCurrentWorldConflicts(rows, query), settings, profile, query, store);
  };

  const fastRowSearchText = row => [
    row?.publicRef,
    row?.publicText,
    row?.publicProfile,
    row?.category,
    row?.axis,
    row?.lifecycle?.status,
    row?.lifecycle?.timeScope,
    row?.retrieval?.subject,
    row?.retrieval?.entityNames,
    row?.retrieval?.relationEndpoints,
    row?.retrieval?.priorityTerms,
    row?.retrieval?.canonicalAnchors,
    row?.retrieval?.crossLingualTokens,
    row?.retrieval?.semanticFrameTokens,
    row?.locator?.subject
  ].map(value => Array.isArray(value) ? value.join(' ') : text(value)).filter(Boolean).join(' ');
  const fastRowCategoryBoost = row => {
    const axis = text(row?.axis || '');
    const category = text(row?.category || '');
    if (/secret|pov_memory|speaker_boundary|pattern_guard|overpromotion_risk/i.test(category)) return 0.22;
    if (/continuity_lock|do_not_resolve_yet/i.test(category)) return 0.2;
    if (axis === 'entity' && /character|relation/i.test(category)) return 0.12;
    if (axis === 'world' && /current_state|active_event|world_rule/i.test(category)) return 0.08;
    if (axis === 'planner') return 0.08;
    if (axis === 'narrative') return 0.05;
    return 0;
  };
  const fastScoreRow = (row = {}, query = '', terms = []) => {
    const body = fastRowSearchText(row);
    const lower = body.toLowerCase();
    let exact = 0;
    for (const term of terms) {
      if (!term) continue;
      if (lower.includes(term)) exact += term.length >= 4 ? 0.16 : 0.09;
    }
    const recency = clamp(Number(row?.locator?.chatRecency ?? row?.retrieval?.chatRecency ?? 0), 0, 1, 0);
    const importance = clamp(Number(row?.importance ?? row?.retrieval?.importance ?? 0), 0, 1, 0);
    const queryEntityHit = queryMentionsAny(query, mergeValues([row?.retrieval?.subject, row?.retrieval?.entityNames, row?.retrieval?.relationEndpoints, row?.publicRef], 32));
    const specificTokenHit = ensureArray(row?.retrieval?.canonicalAnchors || row?.retrieval?.crossLingualTokens).some(token => text(token).trim() && lower.includes(text(token).toLowerCase()) && query.toLowerCase().includes(text(token).toLowerCase()));
    const protectedBoost = /secret|pov_memory|speaker_boundary|pattern_guard|overpromotion_risk|continuity_lock|do_not_resolve_yet/i.test(row?.category || '') ? 0.08 : 0;
    const score = clamp(exact + (queryEntityHit ? 0.24 : 0) + (specificTokenHit ? 0.18 : 0) + importance * 0.18 + recency * 0.14 + fastRowCategoryBoost(row) + protectedBoost, 0, 1.35, 0);
    return {
      ...row,
      score,
      scoreBreakdown: {
        ...(row.scoreBreakdown || {}),
        fastPath: true,
        exactSignal: Number(exact.toFixed(4)),
        queryEntityHit,
        specificTokenHit,
        recency: Number(recency.toFixed(4)),
        importanceSignal: Number((importance * 0.18).toFixed(4))
      }
    };
  };
  const searchIndexFastPath = (store, query, settings = Memory.settings) => {
    const terms = packetCheapTerms(query);
    const knowledgeContext = buildKnowledgeContext(store, query, settings);
    const rows = ensureArray(store.index)
      .filter(row => row?.axis)
      .filter(row => !isKnowledgeUnavailableForQuery(row, query, knowledgeContext.mentionedEntities || knowledgeContext.explicitMentioned || []))
      .map(row => fastScoreRow(row, query, terms))
      .filter(row => {
        if (/secret|pov_memory|speaker_boundary|pattern_guard|overpromotion_risk|continuity_lock|do_not_resolve_yet/i.test(row.category || '')) return true;
        if (Number(row.score || 0) >= 0.16) return true;
        const recency = Number(row?.locator?.chatRecency ?? row?.retrieval?.chatRecency ?? 0) || 0;
        return recency >= 0.72 && Number(row.importance || 0) >= 0.45;
      })
      .sort((a, b) => b.score - a.score || Number(b.importance || 0) - Number(a.importance || 0) || Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
    const limitBase = Math.max(1, Math.min(12, Number(settings?.maxItemsPerAxis || DEFAULT_SETTINGS.maxItemsPerAxis) || DEFAULT_SETTINGS.maxItemsPerAxis));
    const perAxis = { entity: [], world: [], narrative: [], planner: [] };
    const seen = new Set();
    const axisLimit = axis => axis === 'planner' ? limitBase + 1 : limitBase;
    for (const row of rows) {
      if (!perAxis[row.axis]) continue;
      if (perAxis[row.axis].length >= axisLimit(row.axis)) continue;
      const key = rowIdentityKey(row) || normalizeKey([row.axis, row.category, row.publicText].join('|')).slice(0, 160);
      if (key && seen.has(key)) continue;
      seen.add(key);
      perAxis[row.axis].push(row);
    }
    return perAxis;
  };
  const searchIndex = (store, query, settings = Memory.settings) => {
    const mode = effectivePerformanceModeOf(settings);
    const rowCount = ensureArray(store?.index).length;
    // Keep exact/fuzzy/ledger Rev2 behavior for small stores and self-test-sized
    // fixtures. Switch to the bounded fast path only when row count is large enough
    // for strengthened scoring to become a freeze risk.
    const queryTerms = packetCheapTerms(query);
    if (mode === 'fast' && rowCount > 12 && !(queryTerms.length <= 1 && cleanSearchText(query).length <= 32)) return searchIndexFastPath(store, query, settings);
    if (mode === 'deep' || rowCount <= 24 || (queryTerms.length <= 1 && cleanSearchText(query).length <= 32)) return searchIndexDeep(store, query, settings);
    return searchIndexFastPath(store, query, settings);
  };

  const firstTextOf = (source = {}, keys = []) => {
    for (const key of keys) {
      const value = key.includes('.')
        ? key.split('.').reduce((acc, part) => (objectish(acc) ? acc[part] : undefined), source)
        : source[key];
      const body = profileFieldText(value);
      if (body) return body;
    }
    return '';
  };
  const characterProfileSegments = item => {
    if (!objectish(item)) return [];
    return [
      ['identity', firstTextOf(item, ['identity', 'original_identity', 'originalIdentity', 'core_identity', 'coreIdentity', 'baseline', 'profile.identity', 'profile.baseline'])],
      ['interpretation', firstTextOf(item, ['interpretation', 'character_interpretation', 'characterInterpretation', 'profile.interpretation', 'persona', 'role_interpretation', 'roleInterpretation'])],
      ['personality', firstTextOf(item, ['personality', 'personality_traits', 'personalityTraits', 'profile.personality', 'traits', 'profile.traits'])],
      ['speech_style', firstTextOf(item, ['speech_style', 'speechStyle', 'dialogue_style', 'dialogueStyle', 'profile.speech_style', 'profile.speechStyle', 'voice', 'tone'])],
      ['psychology', firstTextOf(item, ['psychology', 'current_psychology', 'currentPsychology', 'mental_state', 'mentalState', 'profile.psychology', 'inner_state', 'innerState'])]
    ].filter(([, value]) => value);
  };
  const characterProfileSummary = item => {
    const segments = characterProfileSegments(item);
    if (!segments.length) return '';
    return compact(segments.map(([key, value]) => `${key}: ${compact(value, 140)}`).join(' | '), 420);
  };
  const publicSummary = (axis, item = {}) => {
    const clean = value => compact(value, 180);
    const scopedSummary = (scope, prefix, body, state = '') => {
      const scopeText = scope ? `[${compact(scope, 70)}] ` : '';
      const head = `${scopeText}${prefix}${state ? ` (${state})` : ''}: `;
      return compact(`${head}${compact(body || '', Math.max(40, 180 - head.length))}`, 180);
    };
    if (axis === 'entity') {
      if (item.from || item.to) {
        const relExtra = [
          item.intimacy != null && item.intimacy !== '' ? `intimacy:${item.intimacy}` : '',
          item.power_balance || item.powerBalance || item.power_dynamic || item.powerDynamic ? `power:${item.power_balance || item.powerBalance || item.power_dynamic || item.powerDynamic}` : '',
          item.dynamic || item.relationship_dynamic || item.relationshipDynamic ? `dynamic:${item.dynamic || item.relationship_dynamic || item.relationshipDynamic}` : ''
        ].filter(Boolean).join(' · ');
        return compact([item.from, item.to].filter(Boolean).join(' → ') + ': ' + (item.state || item.summary || item.label || item.relationship_to_user || '관계 상태 유지') + (relExtra ? ` · ${relExtra}` : ''), 220);
      }
      if (item.ownerEntityId || item.memoryType || item.knowledgeState || item.privacy) {
        const state = [item.memoryType, item.knowledgeState, item.truthState, item.privacy].filter(Boolean).join('/');
        const scope = [
          item.visibleToEntityIds?.length ? `visible:${item.visibleToEntityIds.join(',')}` : '',
          item.deniedToEntityIds?.length ? `denied:${item.deniedToEntityIds.join(',')}` : ''
        ].filter(Boolean).join(' ');
        return scopedSummary(scope, `POV ${item.ownerEntityId || 'unknown'}`, item.summary || item.text || 'POV 기억', state);
      }
      if (item.secrecyLevel || item.revealState || item.holderEntityIds) {
        const state = [item.secrecyLevel, item.revealState, item.truthState].filter(Boolean).join('/');
        const scope = [
          item.holderEntityIds?.length ? `holders:${item.holderEntityIds.join(',')}` : '',
          item.visibleToEntityIds?.length ? `visible:${item.visibleToEntityIds.join(',')}` : '',
          item.deniedToEntityIds?.length ? `denied:${item.deniedToEntityIds.join(',')}` : ''
        ].filter(Boolean).join(' ');
        return scopedSummary(scope, 'Secret', item.title || item.summary || item.rawText || '비밀', state);
      }
      const charPhys = [
        item.condition || item.physical_state || item.physicalState,
        item.attire || item.outfit ? `attire:${item.attire || item.outfit}` : '',
        ensureArray(item.carrying || item.carried || item.inventory).length ? `carrying:${ensureArray(item.carrying || item.carried || item.inventory).join(',')}` : ''
      ].filter(Boolean).join(' · ');
      const base = `${item.name || item.title || '인물'}: ${item.state || item.current_state || item.summary || item.relation_to_user || item.last_action || '상태 유지'}${charPhys ? ` · ${charPhys}` : ''}`;
      return compact(base, 260);
    }
    if (axis === 'world') {
      const worldSensory = item.sensory || item.atmosphere || [item.lighting ? `light:${item.lighting}` : '', item.weather ? `weather:${item.weather}` : '', item.scent ? `scent:${item.scent}` : ''].filter(Boolean).join(' · ');
      return compact(item.summary || [item.location ? `장소 ${item.location}` : '', item.time ? `시간 ${item.time}` : '', item.label || item.title || '', item.type || '', worldSensory].filter(Boolean).join(' · ') || itemText(item), 220);
    }
    if (axis === 'narrative') {
      if (item.kind === 'ledger_rev2_summary_memory' || item.type === 'summary_memory' || item.sourceType === 'hayaku_packet_ledger_rev2_summary_memory') {
        const anchors = ensureArray(item.recallAnchors).slice(0, 3).join(' / ');
        const canonical = ensureArray(item.canonicalAnchors || item.canonical_anchors || item.canonicalTokens || item.canonical_tokens).slice(0, 5).join(', ');
        const evidence = ensureArray(item.directEvidenceSnippets).slice(0, 2).join(' / ');
        return clean([`Summary memory: ${item.summary || compact(item.text || '', 120)}`, anchors ? `anchors: ${anchors}` : '', canonical ? `canonical: ${canonical}` : '', evidence ? `evidence: ${evidence}` : ''].filter(Boolean).join(' | '));
      }
      const pacingTag = [item.pacing ? `pacing:${item.pacing}` : '', item.time_elapsed || item.timeElapsed ? `elapsed:${item.time_elapsed || item.timeElapsed}` : ''].filter(Boolean).join(' · ');
      return compact([item.summary || item.label || item.current_arc || item.currentArc || item.scene_phase || item.scenePhase || item.motif || itemText(item), pacingTag].filter(Boolean).join(' · '), 220);
    }
    if (axis === 'planner') {
      return clean(item.summary || item.label || item.decision || item.immediate_result || item.immediateResult || item.delayed_effect || item.delayedEffect || itemText(item));
    }
    return clean(itemText(item));
  };
  const isLowSignalContinuityRow = row => {
    const axis = row?.axis || '';
    if (axis !== 'narrative' && axis !== 'planner') return false;
    const raw = text(row?.publicText || '').trim();
    const key = normalizeKey(raw);
    if (!key) return true;
    return LOW_SIGNAL_CONTINUITY_KEYS.has(key);
  };
  const sourceEvidenceLinesForPublic = row => {
    const evidence = normalizeSourceEvidence(row?.retrieval?.sourceEvidence);
    if (!evidence?.lines?.length) return [];
    const relevance = Number(row?.scoreBreakdown?.relevanceEvidence || 0);
    const sparseState = text(row?.publicText || '').length < 120;
    const weakStructuredMatch = relevance > 0 && relevance < 0.16;
    const strongEvidence = Number(evidence.confidence || 0) >= 0.16;
    if (!sparseState && !weakStructuredMatch && !strongEvidence) return [];
    const limit = sparseState || weakStructuredMatch ? 3 : 2;
    return evidence.lines.slice(0, limit).map(line => compact(line, 180));
  };
  const characterProfileNames = row => {
    const publicHead = text(row?.publicText || '').split(':')[0];
    return mergeValues([
      publicHead,
      row?.retrieval?.subject,
      row?.locator?.subject,
      row?.retrieval?.entityNames,
      row?.retrieval?.relationEndpoints,
      row?.retrieval?.knowledgeEntities
    ], 32);
  };
  const shouldShowCharacterProfile = (row = {}, currentTurnText = '', viewContext = {}) => {
    if (row.category !== 'character' || !row.publicProfile) return false;
    const query = text(currentTurnText);
    if (!query.trim()) return true;
    const profileIntent = PROFILE_INTENT_RE.test(query);
    const rowMentioned = queryMentionsAny(query, characterProfileNames(row));
    const broadProfileIntent = PROFILE_BROAD_INTENT_RE.test(query);
    const implicitIdentityIntent = PROFILE_IMPLICIT_IDENTITY_RE.test(query);
    const expressionIntent = PROFILE_EXPRESSION_INTENT_RE.test(query);
    if (implicitIdentityIntent && Number(viewContext.selectedCharacterCount || 0) <= 1) return true;
    if (profileIntent) return rowMentioned || broadProfileIntent;
    if (broadProfileIntent && expressionIntent) return true;
    return rowMentioned && expressionIntent;
  };
  const publicStateView = (axis, row = {}, currentTurnText = '', viewContext = {}) => {
    const ref = row.publicRef || row.id || '';
    const body = compact(row.publicText || '', 220);
    const pressure = Math.max(
      Number(row.retrieval?.pressure || 0),
      Number(row.retrieval?.emotionProfile?.intensity || 0),
      Number(row.retrieval?.emotionProfile?.relationImpact || 0),
      Number(row.retrieval?.worldProfile?.pressure || 0),
      Number(row.retrieval?.storyProfile?.priority || 0)
    );
    const tags = uniq([
      ...(row.retrieval?.emotionTags || []),
      ...(row.retrieval?.worldTags || []),
      ...(row.retrieval?.narrativeTags || []),
      ...(row.retrieval?.storyTags || []),
      ...(row.retrieval?.timeTags || [])
    ], 6).join(', ');
    const salience = Number(row.retrieval?.salience || 0);
    const impression = Number(row.retrieval?.impression || 0);
    const profile = shouldShowCharacterProfile(row, currentTurnText, viewContext) ? `\n  profile: ${compact(row.publicProfile, 420)}` : '';
    const hasLifecycleConfidence = row.lifecycle?.confidence !== '' && row.lifecycle?.confidence != null;
    const lifecycleConfidence = hasLifecycleConfidence ? Number(row.lifecycle?.confidence) : NaN;
    const lifecycleParts = [
      row.lifecycle?.status ? `status:${row.lifecycle.status}` : '',
      row.lifecycle?.timeScope ? `time_scope:${row.lifecycle.timeScope}` : '',
      Number.isFinite(lifecycleConfidence) ? `confidence:${lifecycleConfidence.toFixed(2)}` : '',
      row.lifecycle?.replaces ? `replaces:${compact(row.lifecycle.replaces, 80)}` : ''
    ].filter(Boolean).join(' ');
    const lifecycle = lifecycleParts ? `\n  lifecycle: ${lifecycleParts}` : '';
    const itemEvidence = row.lifecycle?.evidence ? `\n  item_evidence: ${compact(row.lifecycle.evidence, 180)}` : '';
    const evidence = sourceEvidenceLinesForPublic(row);
    const evidenceBlock = evidence.length ? `\n  evidence:${evidence.map(line => `\n  - ${line}`).join('')}` : '';
    return `- ref: ${ref}\n  state: ${body}${profile}${lifecycle}${itemEvidence}\n  importance: ${Number(row.importance || 0).toFixed(2)}\n  pressure: ${pressure.toFixed(2)}\n  salience: ${salience.toFixed(2)}\n  impression: ${impression.toFixed(2)}${tags ? `\n  tags: ${tags}` : ''}${evidenceBlock}`;
  };
  const selectedRowsOf = selected => Object.values(selected || {}).flatMap(rows => ensureArray(rows)).filter(Boolean);
  const REV2_META_GUARD_CATEGORIES = Object.freeze(new Set(['speaker_boundary', 'pattern_guard', 'overpromotion_risk']));
  const rev2MetaGuardText = row => [
    row?.publicRef,
    row?.publicText,
    row?.publicProfile,
    row?.scene_id,
    row?.lifecycle?.status,
    row?.lifecycle?.timeScope,
    row?.lifecycle?.evidence,
    row?.retrieval?.subject,
    row?.retrieval?.priorityTerms,
    row?.retrieval?.entityNames,
    row?.retrieval?.relationEndpoints,
    row?.retrieval?.semanticFrameTokens,
    row?.retrieval?.sourceEvidence?.lines,
    row?.retrieval?.sourceEvidence?.allLines
  ].map(value => text(ensureArray(value).join ? ensureArray(value).join(' ') : value)).join(' ');
  const rev2MetaGuardCategoryBoost = category => {
    if (category === 'overpromotion_risk') return 0.26;
    if (category === 'pattern_guard') return 0.23;
    if (category === 'speaker_boundary') return 0.21;
    return 0.16;
  };
  const selectRev2MetaGuards = (store = {}, query = '', selected = {}, settings = Memory.settings, limit = 3) => {
    const knowledgeContext = buildKnowledgeContext(store, query, settings);
    const sceneId = text(knowledgeContext.sceneId || store.context?.sceneAnchors?.sceneId || '').trim();
    const mentionedEntities = mergeValues([
      knowledgeContext.explicitMentioned,
      knowledgeContext.activeSpeakers,
      knowledgeContext.povEntities,
      knowledgeContext.visibleParticipants,
      knowledgeContext.recentEntities,
      knowledgeContext.mentionedEntities
    ], 64);
    const selectedRows = selectedRowsOf(selected);
    const selectedRefs = mergeValues(selectedRows.map(row => row.publicRef || row.id), 64);
    const selectedSubjects = mergeValues(selectedRows.flatMap(row => [row.retrieval?.subject, row.locator?.subject, row.retrieval?.entityNames, row.retrieval?.relationEndpoints]), 64);
    const existingKeys = new Set(selectedRows.map(rowIdentityKey).filter(Boolean));
    const currentTurn = Number(store.turn || 0);
    return ensureArray(store.index)
      .filter(row => row?.axis === 'planner' && REV2_META_GUARD_CATEGORIES.has(row.category))
      .filter(row => !existingKeys.has(rowIdentityKey(row)))
      .filter(row => !isKnowledgeUnavailableForQuery(row, query, knowledgeContext))
      .map(row => {
        const body = rev2MetaGuardText(row);
        const rowScene = text(row.scene_id || '').trim();
        const sceneHit = Boolean(sceneId && (normalizeKey(rowScene) === normalizeKey(sceneId) || queryMentionsAny(body, [sceneId])));
        const entityHit = Boolean(
          (mentionedEntities.length && queryMentionsAny(body, mentionedEntities))
          || queryMentionsAny(query, mergeValues([row.retrieval?.subject, row.retrieval?.entityNames, row.retrieval?.relationEndpoints], 32))
        );
        const relatedHit = Boolean(
          (selectedRefs.length && queryMentionsAny(body, selectedRefs))
          || (selectedSubjects.length && queryMentionsAny(body, selectedSubjects))
        );
        const chatRecency = Number(row.locator?.chatRecency ?? row.retrieval?.chatRecency);
        const distanceFromLatest = Number(row.locator?.distanceFromLatest ?? row.retrieval?.distanceFromLatest);
        const turnId = Number(row.locator?.turnId || 0);
        const recentHit = Boolean(
          (Number.isFinite(chatRecency) && chatRecency >= 0.58)
          || (Number.isFinite(distanceFromLatest) && distanceFromLatest <= 10)
          || (currentTurn > 0 && turnId > 0 && currentTurn - turnId <= 4)
        );
        const guardAnchor = sceneHit || entityHit || relatedHit || recentHit;
        if (!guardAnchor) return null;
        const salience = Number(row.retrieval?.salience || 0);
        const importance = Number(row.importance || row.retrieval?.importance || 0);
        const score = clamp(
          Number(row.score || 0) * 0.36
          + importance * 0.22
          + salience * 0.14
          + rev2MetaGuardCategoryBoost(row.category)
          + (sceneHit ? 0.28 : 0)
          + (entityHit ? 0.23 : 0)
          + (relatedHit ? 0.20 : 0)
          + (recentHit ? 0.13 : 0),
          0, 1.5, 0
        );
        return {
          ...row,
          score: Math.max(Number(row.score || 0), score),
          _metaGuard: { sceneHit, entityHit, relatedHit, recentHit, forced: true }
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score || b.importance - a.importance || b.updatedAt - a.updatedAt)
      .slice(0, Math.max(1, Math.min(3, Number(limit) || 3)));
  };
  const attachRev2MetaGuards = (store = {}, selected = {}, query = '', settings = Memory.settings) => {
    const plannerRows = ensureArray(selected.planner);
    const alreadySelectedGuards = plannerRows
      .filter(row => row?.axis === 'planner' && REV2_META_GUARD_CATEGORIES.has(row.category))
      .map(row => ({ ...row, _metaGuard: { ...(row._metaGuard || {}), selected: true, forced: true } }));
    const selectedWithoutGuards = {
      ...selected,
      planner: plannerRows.filter(row => !(row?.axis === 'planner' && REV2_META_GUARD_CATEGORIES.has(row.category)))
    };
    const forcedGuards = selectRev2MetaGuards(store, query, selectedWithoutGuards, settings, 3);
    const seen = new Set();
    const metaGuards = [...alreadySelectedGuards, ...forcedGuards]
      .filter(row => {
        const key = rowIdentityKey(row) || normalizeKey([row.category, row.publicText, row.id].filter(Boolean).join('|'));
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || Number(b.importance || 0) - Number(a.importance || 0) || Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
      .slice(0, 3);
    return {
      ...selectedWithoutGuards,
      metaGuards
    };
  };
  const countSelectedRows = selected => selectedRowsOf(selected).filter(row => !isLowSignalContinuityRow(row)).length;
  const detectNewFactIntent = value => /새|처음|발견|알게|공개|밝혀|드러|고백|기억|장소|시간|이동|결정|전투|도착|revealed|reveal|new|discover|secret|memory|move/i.test(text(value));
  const AUTO_PERFORMANCE_TIMELINE_RE = /타임라인|연표|기록|내역|이력|히스토리|처음\s*(?:만난|본|시작)|timeline|history|record|log|first\s*(?:met|saw|started)|経緯|履歴|記録|初めて/i;
  const AUTO_PERFORMANCE_PROFILE_RE = /프로필|성격|말투|정체|관계|기억|과거|어떤\s*사람|profile|personality|speech|voice|identity|relationship|memory|past|who\s+(?:is|was)|どんな\s*(?:人|人物)|性格|口調|正体|関係|記憶|過去/i;
  const resolvePerformanceMode = (settings = Memory.settings || DEFAULT_SETTINGS, messages = [], query = '', options = {}) => {
    const requested = text(settings?.mode || DEFAULT_SETTINGS.mode).trim().toLowerCase();
    const configuredMode = requested || DEFAULT_SETTINGS.mode;
    if (PERFORMANCE_MODE_VALUES.includes(requested)) {
      return {
        mode: requested,
        reason: `explicit_${requested}`,
        automatic: false,
        configuredMode,
        signals: {}
      };
    }

    const requestScope = options.scope || requestScopeForMessages(messages);
    const rawPrevious = objectish(Memory.lastBeforeRequest) ? Memory.lastBeforeRequest : {};
    const previousScopeMatched = Boolean(
      requestScope?.confident
      && rawPrevious?.scopeKey
      && rawPrevious.scopeKey === requestScope.key
    );
    const previous = previousScopeMatched ? rawPrevious : {};
    const previousIgnoredReason = rawPrevious?.at && !previousScopeMatched
      ? (requestScope?.confident ? 'scope_mismatch' : 'scope_unknown')
      : '';
    const messageCount = ensureArray(messages).length;
    const previousElapsedMs = Math.max(0, Number(previous.elapsedMs || 0) || 0);
    const previousBudgetMs = Math.max(0, Number(previous.budgetMs || 0) || 0);
    const previousBudgetExceeded = Boolean(previous.budgetExceeded);
    const previousNearBudget = previousBudgetMs > 0 && previousElapsedMs >= previousBudgetMs * 0.9;
    const previousPacketCount = Math.max(
      0,
      Number(previous.packetSelection?.total || 0) || 0,
      Number(previous.packetScan?.packets || 0) || 0
    );
    const packetRecoveryNeeded = Boolean(
      previous.packetHealth?.forceFullNextTurn
      || previous.packetHealth?.parseFailedRecently
      || previous.packetHealth?.invalidJsonRecently
      || previous.packetHealth?.requiredKeysMissingRecently
      || previous.packetHealth?.criticalPacketShapeWarningsRecently
    );
    const queryText = text(query);
    const pastRecallIntent = isPastStateLookupQuery(queryText) || LEDGER_REV2_PAST_LOOKUP_RE.test(queryText);
    const timelineIntent = AUTO_PERFORMANCE_TIMELINE_RE.test(queryText);
    const profileRecallIntent = AUTO_PERFORMANCE_PROFILE_RE.test(queryText);
    const precisionRecallIntent = Boolean(pastRecallIntent || timelineIntent || profileRecallIntent || packetRecoveryNeeded);
    const veryLargeChat = messageCount > 1800 || previousPacketCount > 240;
    const manageableForDeep = messageCount <= 900
      && (previousPacketCount === 0 || previousPacketCount <= 120)
      && !previousBudgetExceeded
      && !previousNearBudget;
    const signals = {
      scopeKey: requestScope?.key || '',
      scopeConfident: requestScope?.confident === true,
      previousScopeMatched,
      previousIgnoredReason,
      messageCount,
      previousPacketCount,
      previousElapsedMs,
      previousBudgetMs,
      previousBudgetExceeded,
      previousNearBudget,
      packetRecoveryNeeded,
      pastRecallIntent,
      timelineIntent,
      profileRecallIntent,
      precisionRecallIntent,
      veryLargeChat,
      manageableForDeep
    };

    if (previousBudgetExceeded || previousNearBudget) {
      return {
        mode: precisionRecallIntent ? 'balanced' : 'fast',
        reason: precisionRecallIntent ? 'auto_previous_budget_pressure_with_recall_intent' : 'auto_previous_budget_pressure',
        automatic: true,
        configuredMode,
        signals
      };
    }
    if (veryLargeChat) {
      return {
        mode: precisionRecallIntent ? 'balanced' : 'fast',
        reason: precisionRecallIntent ? 'auto_large_chat_with_recall_intent' : 'auto_large_chat',
        automatic: true,
        configuredMode,
        signals
      };
    }
    if (packetRecoveryNeeded) {
      return {
        mode: manageableForDeep ? 'deep' : 'balanced',
        reason: manageableForDeep ? 'auto_packet_recovery_deep' : 'auto_packet_recovery_balanced',
        automatic: true,
        configuredMode,
        signals
      };
    }
    if (precisionRecallIntent && manageableForDeep) {
      return {
        mode: 'deep',
        reason: 'auto_precision_recall_deep',
        automatic: true,
        configuredMode,
        signals
      };
    }
    return {
      mode: 'balanced',
      reason: 'auto_default_balanced',
      automatic: true,
      configuredMode,
      signals
    };
  };
  const computePacketHealth = (packetResults = [], store = {}) => {
    const signals = ensureArray(store.context?.packetHealthSignals);
    const latest = signals[0] || {};
    const parseFailedRecently = ensureArray(packetResults).some(result => result && !result.ok);
    const invalidJsonRecently = ensureArray(packetResults).some(result => result && !result.ok && /json/i.test(text(result.reason)));
    const anySignal = key => signals.some(signal => Boolean(signal?.[key]));
    const lowQualityItems = signals.reduce((sum, signal) => sum + Number(signal?.lowQualityItems || 0), 0);
    const missingRequiredAxes = anySignal('missingRequiredAxes');
    const requiredKeysMissingRecently = anySignal('requiredKeysMissingRecently');
    const packetShapeWarningsRecently = anySignal('packetShapeWarningsRecently');
    const criticalPacketShapeWarningsRecently = signals.some(signal => ensureArray(signal?.packetShapeWarnings).some(isCriticalPacketShapeWarning));
    const lastPacketHadLocatorLeak = anySignal('lastPacketHadLocatorLeak');
    const lastPacketWasDeltaOnly = anySignal('lastPacketWasDeltaOnly');
    const lastPacketRefReuseError = anySignal('lastPacketRefReuseError');
    const lastPacketSecretRevealRisk = anySignal('lastPacketSecretRevealRisk');
    const lastPacketHadUnsupportedReveal = anySignal('lastPacketHadUnsupportedReveal');
    let qualityScore = 1;
    if (parseFailedRecently) qualityScore -= 0.45;
    if (invalidJsonRecently) qualityScore -= 0.35;
    if (missingRequiredAxes || requiredKeysMissingRecently) qualityScore -= 0.25;
    if (criticalPacketShapeWarningsRecently) qualityScore -= 0.12;
    else if (packetShapeWarningsRecently) qualityScore -= 0.04;
    if (lastPacketHadLocatorLeak) qualityScore -= 0.25;
    if (lastPacketWasDeltaOnly) qualityScore -= 0.2;
    if (lastPacketRefReuseError) qualityScore -= 0.25;
    if (lastPacketSecretRevealRisk || lastPacketHadUnsupportedReveal) qualityScore -= 0.25;
    if (lowQualityItems > 0) qualityScore -= Math.min(0.25, lowQualityItems * 0.05);
    qualityScore = clamp(qualityScore, 0, 1, 1);
    return {
      parseFailedRecently,
      invalidJsonRecently,
      missingRequiredAxes,
      requiredKeysMissingRecently,
      packetShapeWarningsRecently,
      criticalPacketShapeWarningsRecently,
      qualityScore,
      forceFullNextTurn: Boolean(parseFailedRecently || invalidJsonRecently || requiredKeysMissingRecently || criticalPacketShapeWarningsRecently || lastPacketRefReuseError),
      lastPacketHadLocatorLeak,
      lastPacketWasDeltaOnly,
      lastPacketRefReuseError,
      lastPacketSecretRevealRisk,
      lastPacketHadUnsupportedReveal,
      lowQualityItems,
      latestSignal: clone(latest, {})
    };
  };
  const computeSceneSignals = (currentTurn = '', selected = {}, store = {}) => {
    const latest = ensureArray(store.context?.packetHealthSignals)[0] || {};
    const anchors = objectish(store.context?.sceneAnchors) ? store.context.sceneAnchors : {};
    const rows = selectedRowsOf(selected);
    const visibleParticipantsCount = ensureArray(anchors.visibleParticipants).length
      || ensureArray(selected.entity).filter(row => row.category === 'character').length;
    const highImpactSelected = ensureArray(selected.planner).some(row => row.category === 'consequence' && Number(row.importance || 0) >= 0.72);
    const body = text(currentTurn).trim();
    return {
      hasNewFact: detectNewFactIntent(body),
      hasNewCharacter: Boolean(latest.hasNewCharacter),
      hasNewWorldRule: Boolean(latest.hasNewWorldRule),
      hasSceneIdChange: Boolean(latest.hasSceneIdChange || anchors.resetBySceneIdChange),
      hasSecretBoundaryChange: Boolean(latest.hasSecretBoundaryChange),
      hasPovMemoryChange: Boolean(latest.hasPovMemoryChange),
      hasRevealStateChange: Boolean(latest.hasRevealStateChange),
      hasRelationshipChange: Boolean(latest.hasRelationshipChange),
      hasLocationOrTimeChange: Boolean(latest.hasLocationOrTimeChange),
      hasHighImpactConsequence: Boolean(latest.hasHighImpactConsequence || highImpactSelected),
      visibleParticipantsCount,
      stateViewRows: rows.length,
      selectedRows: rows.length
    };
  };
  const choosePromptMode = (packetHealth = {}, sceneSignals = {}, settings = Memory.settings, options = {}) => {
    const requested = text(options.mode || settings.promptMode || 'auto').trim().toLowerCase();
    if (options.forceFullSchema || requested === 'full') return 'full';
    const criticalHealth = packetHealth.forceFullNextTurn
      || packetHealth.parseFailedRecently
      || packetHealth.invalidJsonRecently
      || packetHealth.missingRequiredAxes
      || packetHealth.requiredKeysMissingRecently
      || packetHealth.criticalPacketShapeWarningsRecently
      || packetHealth.lastPacketHadLocatorLeak
      || packetHealth.lastPacketSecretRevealRisk
      || packetHealth.lastPacketHadUnsupportedReveal;
    // Explicit balanced mode is the default performance/long-memory profile. Keep it
    // balanced unless the packet stream is actually broken or unsafe. Low quality
    // scores and ordinary new scene/world signals should not silently expand the
    // injection to full mode on long chats.
    if (requested === 'balanced') return criticalHealth ? 'full' : 'balanced';
    if (criticalHealth) return 'full';
    if (packetHealth.lastPacketWasDeltaOnly) return 'full';
    if (Number(packetHealth.qualityScore ?? 1) < 0.6) return 'full';
    if (sceneSignals.hasNewWorldRule) return 'full';
    if (sceneSignals.hasSecretBoundaryChange) return 'full';
    if (sceneSignals.hasRevealStateChange) return 'full';
    return 'balanced';
  };
  const appendCurrentTurnAndStateView = (lines, selected, currentTurnText = '') => {
    const currentAnchor = compact(currentTurnText, 700);
    if (currentAnchor) {
      lines.push('[CURRENT USER TURN ANCHOR]');
      lines.push(currentAnchor);
      lines.push('Use this exact current turn as the immediate response axis. Treat previous assistant output, including any <Last output> wrapper, as established continuity context; generate the response from the new user request.');
      lines.push('');
    }
    const visibleRowsByAxis = Object.fromEntries(['entity', 'world', 'narrative', 'planner'].map(axis => [
      axis,
      ensureArray(selected[axis]).filter(row => !isLowSignalContinuityRow(row))
    ]));
    const viewContext = {
      selectedCharacterCount: ensureArray(visibleRowsByAxis.entity).filter(row => row.category === 'character').length
    };
    const metaGuardRows = ensureArray(selected.metaGuards)
      .filter(row => row?.axis === 'planner' && REV2_META_GUARD_CATEGORIES.has(row.category));
    if (metaGuardRows.length) {
      lines.push('[META GUARDS]');
      lines.push('These Rev2 meta guards are high-priority safety/continuity hints selected by scene, entity, related refs, or recent packet proximity. Apply them before ordinary planner suggestions when they affect speaker boundaries, repetition, or overpromotion.');
      metaGuardRows.forEach(row => lines.push(publicStateView('planner', row, currentTurnText, viewContext)));
      lines.push('');
    }
    const pushAxis = (label, axis) => {
      const rows = visibleRowsByAxis[axis];
      if (!rows.length) return;
      lines.push(`[${label}]`);
      rows.forEach(row => lines.push(publicStateView(axis, row, currentTurnText, viewContext)));
      lines.push('');
    };
    pushAxis('ENTITY', 'entity');
    pushAxis('WORLD', 'world');
    pushAxis('NARRATIVE', 'narrative');
    pushAxis('PLANNER', 'planner');
  };
  const appendPacketBudgetGuard = lines => {
    lines.push('Output budget guard: keep the hidden packet compact. Keep top-level packet keys meta, entity, world, narrative, planner, and importance present; use compact empty/default fields inside keys with no relevant changes.');
    lines.push('Normal packet target: 4-10 total continuity items, with a hard cap around 12; use the upper range for secret boundaries, world rules, or irreversible canon changes that truly need more.');
    lines.push('Record each fact once in the most specific axis: entity for active characters/relations/knowledge boundaries, world for place/time/events/rules, narrative for scene arc or conflict pressure, planner for promises, consequences, locks, or unresolved obligations that must affect the next response.');
    lines.push('If the visible response is long or output budget is tight, use empty axis objects for unchanged axes and include changed or still-active relevant items, usually 1-2 per active axis. Prefer compact axis objects over the full schema skeleton verbatim.');
    lines.push('Place each event in its strongest home axis: character state, active_event, scene_delta, payoff, or hook. Use suggested_hooks for actionable next-scene pressure.');
  };
  const injectionCapForSettings = (settings = Memory.settings) => {
    const explicit = Number(settings?.injectionCapChars);
    return Number.isFinite(explicit) && explicit > 0 ? explicit : modeInjectionCap(settings?.promptMode || 'balanced');
  };
  const injectionBlockCapForSettings = (settings = Memory.settings) => Math.max(0, injectionCapForSettings(settings) - Number(settings?.tailReserveChars || 0));
  const variableStateViewLength = block => {
    const bodyStart = text(block).indexOf('\n\n');
    const stateRuleStart = text(block).indexOf('[HAYAKU STATE VIEW USAGE RULE]');
    if (bodyStart < 0 || stateRuleStart < 0 || stateRuleStart <= bodyStart) return 0;
    return text(block).slice(bodyStart + 2, stateRuleStart).trim().length;
  };
  const variableStateViewBudget = (settings = Memory.settings, block = '') => {
    const blockCap = injectionBlockCapForSettings(settings);
    if (block) {
      const fixedChars = text(block).length - variableStateViewLength(block);
      return Math.max(0, blockCap - fixedChars);
    }
    return blockCap;
  };
  const trimSegmentToBudget = (value = '', budget = 0, options = {}) => {
    const source = text(value);
    const limit = Math.max(0, Math.floor(Number(budget) || 0));
    if (!limit) return '';
    if (source.length <= limit) return source;
    if (limit <= 1) return '…'.slice(0, limit);
    const marker = text(options.marker || '');
    const footer = text(options.footer || '');
    const notice = text(options.notice || '…');
    if (options.keepFooter && footer && source.includes(footer)) {
      const footerChunk = source.slice(Math.max(0, source.lastIndexOf(footer) - 1)).trimStart();
      const prefixBudget = limit - footerChunk.length - notice.length - 2;
      if (prefixBudget > Math.max(16, marker.length + 4)) {
        const prefix = source.slice(0, prefixBudget).trimEnd();
        const out = `${prefix}\n${notice}\n${footerChunk}`;
        return out.length <= limit ? out : `${prefix.slice(0, Math.max(0, prefix.length - (out.length - limit))).trimEnd()}\n${notice}\n${footerChunk}`;
      }
    }
    if (marker && limit > marker.length + notice.length + 8 && source.includes(marker)) {
      const markerPrefix = source.slice(0, source.indexOf(marker) + marker.length);
      const remainingBudget = limit - markerPrefix.length - notice.length - 2;
      if (remainingBudget > 0) return `${markerPrefix}\n${notice}\n${source.slice(markerPrefix.length, markerPrefix.length + remainingBudget).trimEnd()}`.slice(0, limit);
    }
    return `${source.slice(0, Math.max(1, limit - 1)).trimEnd()}…`.slice(0, limit);
  };
  const composeContinuityBlock = (header = '', body = '', preservedRules = '') => `${header}${body}${body ? '\n' : ''}${preservedRules}`;
  const finalizeContinuityContext = (lines, settings = Memory.settings, preservedMarker = '[HAYAKU STATE VIEW USAGE RULE]') => {
    const preservedStart = Math.max(0, lines.indexOf(preservedMarker));
    const header = lines.slice(0, 4).join('\n') + '\n\n';
    const preservedRulesSource = lines.slice(preservedStart).join('\n');
    const bodySource = lines.slice(4, preservedStart).join('\n').trimEnd();
    const blockCap = injectionBlockCapForSettings(settings);
    if (!blockCap) return composeContinuityBlock(header, bodySource, preservedRulesSource);

    const available = Math.max(0, blockCap - header.length);
    const separatorReserve = bodySource ? 1 : 0;
    const minimumRuleBudget = bodySource
      ? Math.min(preservedRulesSource.length, Math.max(900, Math.floor(available * 0.35)))
      : preservedRulesSource.length;
    const bodyBudget = bodySource
      ? Math.max(0, Math.min(bodySource.length, available - minimumRuleBudget - separatorReserve))
      : 0;
    const preservedBudget = Math.max(0, available - bodyBudget - (bodyBudget ? separatorReserve : 0));
    const body = bodySource.length > bodyBudget
      ? trimSegmentToBudget(bodySource, bodyBudget, { notice: '…' })
      : bodySource;
    let preservedRules = preservedRulesSource.length > preservedBudget
      ? trimSegmentToBudget(preservedRulesSource, preservedBudget, {
        marker: preservedMarker,
        footer: INJECTION_FOOTER,
        keepFooter: true,
        notice: '[HAYAKU INJECTION BUDGET NOTICE] Some fixed guidance was trimmed to keep the total Core+tail injection within the active prompt-mode cap.'
      })
      : preservedRulesSource;

    let block = composeContinuityBlock(header, body, preservedRules);
    if (block.length <= blockCap) return block;

    const bodylessBudget = blockCap - header.length;
    preservedRules = trimSegmentToBudget(preservedRulesSource, bodylessBudget, {
      marker: preservedMarker,
      footer: INJECTION_FOOTER,
      keepFooter: true,
      notice: '[HAYAKU INJECTION BUDGET NOTICE] Some fixed guidance was trimmed to keep the total Core+tail injection within the active prompt-mode cap.'
    });
    block = composeContinuityBlock(header, '', preservedRules);
    if (block.length <= blockCap) return block;

    return trimSegmentToBudget(block, blockCap, {
      footer: INJECTION_FOOTER,
      keepFooter: true
    });
  };
  const appendStateViewUsageRule = (lines, mode = 'balanced') => {
    lines.push('[HAYAKU STATE VIEW USAGE RULE]');
    lines.push('[ENTITY], [WORLD], [NARRATIVE], [PLANNER], and optional [META GUARDS] are the current continuity state views selected from chat packets for this request.');
    lines.push('[META GUARDS], when present, are high-priority response controls for speaker boundaries, repetition/pattern drift, and overpromotion risks; apply them before ordinary planner suggestions.');
    lines.push('When writing the next HAYAKU_STATE_PACKET, carry forward still-true shown states with their public refs, update changed states, and retire states that the current turn supersedes.');
    lines.push('Planner is the higher-order coordination surface: it may integrate the shown entity/world/narrative state into consequence_ledger, payoff_tracker, continuity_locks, and do_not_resolve_yet.');
    if (mode === 'full') {
      lines.push('Planner coordinates across shown axes and visible evidence while respecting POV/secret boundaries and obeying the latest user turn; ground planner entries in shown evidence and current-turn facts.');
      lines.push('If planner guidance conflicts with entity, world, narrative, or the current user turn, obey the current user turn and hard continuity first, then revise planner in the next packet.');
    } else {
      lines.push('If continuity conflicts with entity, world, narrative, planner, or the current user turn, obey the current user turn and hard confirmed continuity first.');
    }
    lines.push('');
  };
  const appendResponseQualityRule = (lines, mode = 'balanced') => {
    lines.push('[HAYAKU RESPONSE QUALITY RULE]');
    lines.push('Treat the explicit current user turn as the highest-priority response axis, with HAYAKU continuity serving as support for that turn.');
    if (mode === 'full') {
      lines.push('Preserve the user-requested output length, response template, language, formatting, pacing, and required bottom interface/status blocks exactly; let HAYAKU continuity support that requested shape.');
      lines.push('Leave the user persona\'s action, emotion, consent, desire, bodily reaction, and final choice to the user; write the world and NPCs\' response.');
      lines.push('Visible output contains the requested response content. HAYAKU continuity data appears in the final HTML-comment packet using packet-safe public refs and ordinary continuity fields.');
      lines.push('Treat connectivity checks, license checks, tool markup, verification summaries, provider status, and self-authorization notes as backstage noise; visible output stays focused on the requested scene or task.');
      lines.push('Render the current turn through lived dialogue, action, sensory detail, pacing, and reaction; continue from the latest user-requested action while using the prior assistant answer as established context.');
      lines.push('Keep the scene anchored around the current user turn: develop the immediate consequence first before a new location, long time jump, meal, clothing change, new task, or unrelated activity.');
      lines.push('Keep hard world rules, confirmed continuity, and active character portrayal true; make at least one visible shift in tension, information, consequence, or relationship state when the scene allows, and end on a moving beat rather than a static holding pattern.');
      lines.push('Do not reuse recent assistant dialogue or narration sentences verbatim unless the user explicitly requests an exact echo. If the same continuity fact remains true, express it through a new action, consequence, sensory angle, silence, decision, or question.');
      lines.push('Avoid looping on the same reaction scaffold across turns: repeated smile/tilt/silence/breath/status beats should either advance, transform, or be omitted.');
    } else {
      lines.push('Preserve the user-requested language, length, format, template, pacing, and required bottom interface/status blocks.');
      lines.push('Leave the user persona\'s action, emotion, consent, desire, bodily reaction, and final choice to the user; write the world and NPCs\' response.');
      lines.push('Visible output contains the requested response content. HAYAKU continuity data appears in the final HTML-comment packet using packet-safe public refs and ordinary continuity fields.');
      lines.push('Make each beat add new information, consequence, decision, pressure, or scene movement; keep paragraph beats, sentence skeletons, and verbal tics varied.');
      lines.push('Do not reuse recent assistant dialogue or narration sentences verbatim unless the user explicitly requests an exact echo; keep the fact but change the beat, syntax, and consequence.');
      lines.push('If a required template repeats headings or status labels, keep only the required shell and make the narrative body visibly progress instead of looping.');
      lines.push('Keep speaker attribution clear when multiple characters can speak; use action, silence, gesture, and narration as well as dialogue.');
    }
    lines.push('');
  };
  const appendFullOnlyResponseRules = lines => {
    lines.push('[HAYAKU RESPONSE SELF-REPEAT GUARD]');
    lines.push('Keep each paragraph, dialogue-action exchange, and inner-resolution beat distinct within a response; vary sentence skeletons beyond just swapping the object.');
    lines.push('After two similar reaction beats, change mode: a concrete choice, a new observation, silence, a practical consequence, a question, or a status/interface update; vary syntax, sentence length, and emotional angle while keeping character voice consistent.');
    lines.push('This is output-integrity guidance only; it defers to user intent, canon, character voice, and explicit instructions.');
    lines.push('');
  };
  const appendSecretPovRule = (lines, mode = 'balanced') => {
    lines.push('[HAYAKU SECRET/POV RULE]');
    lines.push('Use entity.pov_memories and entity.secrets as owner-specific knowledge boundaries.');
    lines.push('Private, secret, internal, hidden, suspected, or denied records stay private; reveal them when the current scene gives the viewer/speaker access.');
    if (mode === 'full') {
      lines.push('POV records need a real ownerEntityId and non-empty knowledge text; secrets need holder/visible/denied boundaries when known. Use concrete, filled entries.');
    } else {
      lines.push('Set a secret revealState to revealed when visible chat evidence or related_refs support the reveal; use hidden, hinted, or partially_revealed for unrevealed states.');
      lines.push('Ground irreversible canon or off-screen facts in the current turn or confirmed continuity.');
    }
    lines.push('');
  };
  const appendFullOnlyContinuityRules = lines => {
    lines.push('[HAYAKU CONTINUITY RELIABILITY RULE]');
    lines.push('If HAYAKU continuity is sparse, ambiguous, or conflicting, respond conservatively: prioritize established continuity, keep to currently visible scene evidence, and introduce irreversible canon or off-screen facts with current-turn or confirmed-continuity support.');
    lines.push('');
    lines.push('[HAYAKU WORLD CONTINUITY PRESSURE RULE]');
    lines.push('Treat world rules, active events, scene pressures, and off-screen threads as active continuity pressure and stay aligned with them; when the current user turn explicitly changes them, update the setting within supplied world, state, entity, narrative, lore, and current scene context.');
    lines.push('');
    lines.push('[HAYAKU SPEAKER CLARITY RULE]');
    lines.push('Keep speaker attribution unambiguous whenever more than one character can speak; keep one clear speaker per dialogue block for plain transitions, and balance dialogue with action, silence, gesture, and narration.');
    lines.push('Use a repeated verbal tic sparingly as flavor; let new information, changing emotion, and scene progression lead instead.');
    lines.push('');
    lines.push('[HAYAKU ENTITY INTERPRETATION RULE]');
    lines.push('For recurring or scene-important characters, entity.characters may include concise portrayal fields: identity (baseline role/nature/values), interpretation and psychology (optionally {past,present,future} where future is non-binding tendency only), personality (stable traits/contradictions), and speech_style (vocabulary/tone/rhythm/verbal tics).');
    lines.push('Put known inner facts for NPCs or non-POV characters in pov_memories or secrets with explicit owner/visibility boundaries. Treat entity.characters portrayal fields as external guidance shown to the user when asked.');
    lines.push('');
  };
  const appendMultilingualAnchorRule = (lines, mode = 'balanced') => {
    lines.push('[HAYAKU LANGUAGE-INDEPENDENT RECALL ANCHOR RULE]');
    if (mode === 'full') {
      lines.push('Packet prose may use one natural language, but retrieval-critical facts should also carry language-independent canonical anchors. This lets Korean, English, Japanese, or any other language packet meet through shared handles.');
      lines.push('For meta.summary_memory.recallAnchors, include 1-4 compact anchors using the pattern "native phrase / optional known translations / canonical_token" when relevant; the canonical token is the important part.');
      lines.push('When the exact translation is unknown, still include a truthful canonical token such as object:necklace, place:wardrobe, state:hidden, info:location, relation:friend, emotion:fear, or narrative:aftermath.');
      lines.push(`Useful multilingual examples: ${MULTILINGUAL_ANCHOR_EXAMPLES.join('; ')}.`);
      lines.push(`Useful canonical-only examples: ${UNIVERSAL_CANONICAL_ANCHOR_EXAMPLES.join(', ')}.`);
      lines.push('For recurring people, include aliases and mentionedEntityNames in available script variants such as Korean name, romanization, Japanese spelling, or other known spellings. Keep this compact and focused on active/relevant entities.');
      lines.push('Canonical tokens are search handles for packet retrieval. Tie every token to an actual scene fact, and use public or safely shareable facts for anchors.');
      lines.push('Keep summaries concise in one language and use canonical anchors for retrieval-critical nouns, places, relationships, secrets, current state, object locations, and unresolved pressures, rather than translating the whole packet.');
    } else {
      lines.push('Keep packet prose in one language, but add 1-4 compact language-independent canonical anchors for retrieval-critical facts so Korean/English/Japanese packets meet through shared handles.');
      lines.push('Pattern: "native phrase / known translations / canonical_token" (e.g. key / 열쇠 / 鍵 / object:key); when the translation is unknown use a truthful canonical-only token (object:necklace, place:wardrobe, state:hidden, info:location). Canonical tokens are search handles for packet retrieval; use public or safely shareable facts for anchors.');
      lines.push('For active recurring people, add aliases/mentionedEntityNames in available script variants (Korean name, romanization, Japanese spelling); keep it compact and focused on relevant entities.');
    }
    lines.push('');
  };

  const appendRpContinuityRule = lines => {
    lines.push('[HAYAKU RP CONTINUITY RULE]');
    lines.push('Treat physical, sensory, and relationship state as live continuity. Refresh characters.condition (injuries, fatigue, intoxication, transformation, pregnancy), attire, and carrying[] when they change this turn; keep them consistent across turns until the scene changes them.');
    lines.push('Anchor the scene with world.sensory (light, sound, scent, temperature, weather) so the place reads as present and specific; refresh it when the location or mood shifts.');
    lines.push('Track relationship dynamics on relations with intimacy (0.0-1.0 progression), power_balance (dominant/submissive/peer), and dynamic (warming/cooling/static/arc) so bonds evolve instead of resetting.');
    lines.push('Set narrative.pacing (slow/escalating/climactic/resolving/static) and time_elapsed so scene rhythm and in-scene time stay consistent with the requested length.');
    lines.push('Use planner.open_invitations for concrete choices the world offers the user this turn; keep them optional and leave the user persona\'s pick to the user.');
    lines.push('meta.consent_memory holds the user persona\'s preferences, hard limits, safeword, and comfort (0.0-1.0). Honor limits as binding: stay within stated limits, lower intensity when comfort drops, and raise it when the current turn shows genuine warming. Update consent_memory when the user states or revises a boundary. consent_memory lives in meta; planner holds continuity_locks, do_not_resolve_yet, open_invitations, next_direction, suggested_hooks, consequence_ledger, payoff_tracker.');
    lines.push('');
  };

  const appendTemporalBoundaryRule = lines => {
    lines.push('[HAYAKU TEMPORAL STATE RULE]');
    lines.push('Track temporal state generally: separate event time, evidence/observation time, character knowledge time, narration time, and current scene time.');
    lines.push('Only facts actively happening in the current scene should use status active with time_scope current. Facts that happened earlier, were merely discovered now, are expected later, or are only inferred/offscreen need their own time_scope and confidence.');
    lines.push('When the current turn reveals older, indirect, offscreen, remembered, reported, recorded, predicted, or uncertain events, record the reveal/knowledge change as current and the revealed event at its own time.');
    lines.push('Prefer precise temporal controls: time_scope past/current/future_pressure/scheduled/baseline/no_longer_true, status active/resolved/superseded/contested/dormant, evidence, confidence, known_to, hidden_from, and last-confirmed wording.');
    lines.push('For offscreen or absent characters, distinguish last confirmed state from present status; do not freeze them into an old state unless current-scene evidence proves it still holds.');
    lines.push('Keep world.active_events limited to current-scene active pressure. Use secrets, pov_memories, narrative.conflict_traces, planner consequences, or world.offscreen_threads for temporally separate facts.');
    lines.push('');
  };

  const appendPacketSchemaRules = (lines, mode = 'balanced') => {
    lines.push(`${mode === 'full' ? 'Packet keys only' : 'Use packet keys only'}: meta, entity, world, narrative, planner, importance. Packet handles are public refs, stable names, aliases, canonical anchors, related_refs, and ordinary continuity fields.`);
    lines.push('Collection fields are JSON arrays: entity.characters, entity.relations, entity.pov_memories, entity.secrets, world.active_events, world.world_rules, narrative.conflict_traces, narrative.scene_deltas, narrative.theme_motifs, planner.open_invitations, and other planner collections.');
    lines.push('Use memoryType from this enum: experienced, witnessed, heard, inferred, rumor, private_thought, public_fact.');
    if (mode === 'full') {
      lines.push('meta may include schema, packet_type, packet_schema_rev, ledger_profile, scene_id, confidence, turn_hint, turn_anchor, pov_entity, active_speaker, visible_participants, scene_visibility, summary_memory, canonical_anchors (alias canonicalAnchors), speaker_boundaries, pattern_guard, overpromotion_risks, and consent_memory (preferences/limits/safeword/comfort for the user persona).');
      lines.push('POV anchor rule: pov_entity, active_speaker, visible_participants, and scene_visibility are current-scene anchors used to preserve knowledge boundaries on pronoun-style or continue-style turns.');
      lines.push('A changed non-empty scene_id starts a fresh anchor scope. Empty pov_entity, active_speaker, or visible_participants fields intentionally clear that anchor. Carry an anchor field forward when the previous value should continue within the same scene.');
      lines.push('Keep meta.scene_id stable while the same physical/continuity scene continues; do not shorten, renumber, translate, or restyle it unless there is a real scene, location, time-block, or continuity-scope boundary.');
      lines.push('scene_visibility may be public, limited, private, or omniscient. public/limited describes who can witness scene facts; omniscient narration keeps hidden character knowledge private and leaves secret/pov_memory rows locked.');
      lines.push('If meta.confidence is below 0.5, HAYAKU treats scene anchors as weak hints for ordinary continuity while restricted knowledge remains governed by visibility boundaries.');
      lines.push('Reuse provided refs in the same axis/category. For new items, rely on stable identity fields and keep refs in packet metadata rather than visible prose.');
      lines.push('When an existing item has no ref, keep stable identity fields consistent: character name/aliases, relation endpoints, secret holder/title, or POV owner/type. HAYAKU uses these to merge updates through internal locators.');
      lines.push('For each important item, include compact continuity weights when useful: importance, salience, impression, and pressure are 0.0-1.0 numbers that help future retrieval from chat packets.');
      lines.push('Also include compact control fields when useful: status(active/resolved/superseded/contested/dormant), time_scope(baseline/past/current/future_pressure/scheduled/no_longer_true), confidence, evidence, known_to, hidden_from, replaces, related_refs, and aliases.');
      lines.push('Choose the most appropriate section for each continuity fact: meta for compact scene-level recall hints and safety guards; entity, world, narrative, and planner for the durable continuity rows; importance for overall priority.');
      lines.push('Use meta.summary_memory for a compact recall summary and anchors; use speaker_boundaries, pattern_guard, and overpromotion_risks for knowledge/speaker boundaries, repetition guards, and overpromotion cautions; use meta.consent_memory to persist the user persona\'s preferences, hard limits, safeword, and comfort (0.0-1.0) so stated boundaries carry across turns.');
      lines.push('When the visible response repeats a recent direct quote, narration sentence, reaction scaffold, or optional status/header boilerplate, add a compact meta.pattern_guard entry naming what to avoid next turn.');
      lines.push(`When [META GUARDS] shows pattern_guard rows, copy still-relevant repetition guards into current_snapshot meta.pattern_guard as compact neutral labels; use evidence "${PATTERN_GUARD_NEUTRAL_EVIDENCE}" and do not paste repeated sample text.`);
      lines.push('Pattern guards are short-lived correction notes, not permanent style rules: use status active/time_scope current/expires_after_turns 1-2 when still needed; if the current visible response already avoids the pattern, mark status resolved/time_scope past with resolved_reason or omit the guard.');
      lines.push('When filling summary_memory.recallAnchors and canonicalAnchors, prefer compact canonical anchors for retrieval-critical facts, e.g. "key / 열쇠 / 鍵 / object:key", "archive / 기록실 / 資料室 / place:archive", or canonical-only "object:necklace" when translations are unknown.');
      lines.push('When filling mentionedEntityNames or aliases, include useful Korean/English/Japanese variants for active names, e.g. "Rin", "린", "凛".');
      lines.push('Use the listed top-level packet keys and packet-safe fields.');
      lines.push('Set a secret revealState to revealed when the visible chat gives evidence or a related_ref for the reveal; use hidden, hinted, or partially_revealed for unrevealed states.');
      lines.push('Planner items may include related_refs as public refs from the shown state view to coordinate entity/world/narrative consequences.');
      lines.push('entity contains characters, relations, pov_memories, secrets. Put places/events/rules/factions under world; track character physical state via condition/attire/carrying fields.');
      lines.push('Fields: characters(ref/name/current_state/emotion/relation_to_user/condition/attire/carrying/identity/interpretation/personality/speech_style/psychology/status/time_scope/confidence/evidence/known_to/hidden_from/replaces/aliases/importance/salience/impression/pressure), relations(ref/from/to/state/trust/tension/intimacy/power_balance/dynamic/evidence/status/time_scope/confidence/known_to/hidden_from/replaces/related_refs/importance/salience/impression/pressure), pov_memories(ref/ownerEntityId/summary/text/memoryType/knowledgeState/privacy/truthState/visibleToEntityIds/deniedToEntityIds/confidence/evidence/status/time_scope/importance/salience/impression/pressure), secrets(ref/title/summary/rawText/holderEntityIds/visibleToEntityIds/deniedToEntityIds/secrecyLevel/revealState/truthState/confidence/evidence/status/time_scope/importance/salience/impression/pressure), world(location/time/scene_type/danger_level/active_events/world_rules/offscreen_threads/factions/regions/sensory), narrative(scene_phase/current_arc/tension_level/dominant_mood/pacing/time_elapsed/conflict_traces/scene_deltas/theme_motifs), planner(consequence_ledger/payoff_tracker/continuity_locks/do_not_resolve_yet/next_direction/suggested_hooks/open_invitations with optional related_refs).');
    } else {
      lines.push('POV anchors are current-scene anchors. scene_id changes reset anchor scope; explicit empty anchor fields clear anchors.');
      lines.push('Keep meta.scene_id stable within the same continuous scene; change it only for a real scene/location/time-block boundary, not for style, shortening, or renumbering.');
      lines.push('Reuse refs in the same axis/category. For new items, rely on stable identity fields: character name/aliases, relation endpoints, secret holder/title, or POV owner/type.');
      lines.push('For each important item, include compact continuity weights when useful: importance, salience, impression, and pressure are 0.0-1.0 numbers that help future retrieval from chat packets.');
      lines.push('Use compact controls when useful: status, time_scope, confidence, evidence, known_to, hidden_from, replaces, related_refs, and aliases. Planner items may include public related_refs.');
      lines.push('Packet axes and valid fields:');
      lines.push('- meta: schema, packet_type, packet_schema_rev, ledger_profile, scene_id, confidence, turn_hint, turn_anchor, pov_entity, active_speaker, visible_participants, scene_visibility, summary_memory, canonical_anchors/canonicalAnchors, speaker_boundaries, pattern_guard, overpromotion_risks, consent_memory');
      lines.push('- entity: characters(name/current_state/condition/attire/carrying), relations(from/to/state/trust/intimacy/power_balance/dynamic), pov_memories, secrets | world: location, time, scene_type, danger_level, active_events, world_rules, offscreen_threads, factions, regions, sensory | narrative: scene_phase, current_arc, tension_level, dominant_mood, pacing, time_elapsed, conflict_traces, scene_deltas, theme_motifs | planner: consequence_ledger, payoff_tracker, continuity_locks, do_not_resolve_yet, next_direction, suggested_hooks, open_invitations | importance: overall, reason');
      lines.push('Use meta.summary_memory for compact recall summary/anchors; use speaker_boundaries, pattern_guard, and overpromotion_risks for high-priority speaker boundary, repetition, and overpromotion guards; use consent_memory to persist the user persona\'s preferences, limits, safeword, and comfort.');
      lines.push('If recent direct dialogue, narration sentences, reaction scaffolds, or optional status/header boilerplate are starting to repeat, add a compact meta.pattern_guard entry so the next turn can vary them.');
      lines.push(`If [META GUARDS] includes pattern_guard rows, preserve still-relevant repetition guards in current_snapshot meta.pattern_guard with short neutral labels; use evidence "${PATTERN_GUARD_NEUTRAL_EVIDENCE}" and do not paste repeated sample text.`);
      lines.push('Pattern guards expire quickly: set expires_after_turns 1-2 when active, and mark status resolved/time_scope past with resolved_reason or omit the guard once the current visible response avoids the repeated pattern.');
      lines.push('For cross-language and cross-script recall, make recallAnchors compact canonical handles when useful: "key / 열쇠 / 鍵 / object:key"; "archive / 기록실 / 資料室 / place:archive"; or canonical-only "object:necklace", "place:wardrobe" when translations are unknown.');
      lines.push('For active recurring people, put available Korean/English/Japanese variants in aliases and mentionedEntityNames; keep aliases focused on the active cast.');
    }
    lines.push('For pov_memories and secrets, reuse the provided ref when updating the same knowledge boundary.');
    lines.push(`Minimal ${mode === 'full' ? 'appendix' : 'packet'} wrapper example; fill relevant fields while keeping all top-level axis keys:`);
    lines.push(`<!-- ${PACKET_START}`);
    lines.push(COMPACT_PACKET_EXAMPLE);
    lines.push(`${PACKET_END} -->`);
  };
  const recoveryRequestActive = settings => isDetectedPacketRecoveryRequest(settings?.packetRecoveryRequest);
  const appendPacketCompletionGate = (lines, recoveryActive = false, terse = false) => {
    lines.push('[HAYAKU PACKET COMPLETION GATE]');
    lines.push(recoveryActive
      ? 'The assistant message is not complete when the visible response ends; it is complete only after two hidden HAYAKU packet comments have been appended.'
      : 'The assistant message is not complete when the visible response ends; it is complete only after one hidden HAYAKU packet comment has been appended.');
    lines.push('Before stopping, silently verify that the last content in message.content is the required HAYAKU HTML comment appendix, not the visible prose.');
    lines.push(recoveryActive
      ? `Required final shape: visible output, two blank lines, recovery_snapshot packet, newline, current_snapshot packet, ending with "${PACKET_END} -->".`
      : `Required final shape: visible output, two blank lines, current_snapshot packet, ending with "${PACKET_END} -->".`);
    lines.push('If the visible response is already done but the packet appendix is missing, continue writing the packet appendix immediately.');
    lines.push('Never skip the packet because the turn feels simple, short, unchanged, emotional, dialogue-only, or because there is little to store.');
    if (!terse) {
      lines.push('If uncertain, write a minimal current_snapshot with empty arrays/strings, low confidence, and all six top-level keys rather than omitting HAYAKU.');
      lines.push(recoveryActive
        ? 'For recovery mode, minimal recovery_snapshot is allowed, but current_snapshot is still mandatory and must be second.'
        : 'For normal mode, exactly one current_snapshot packet is mandatory every eligible model response.');
    }
    lines.push('');
  };
  const appendSideWriteRule = (lines, mode = 'balanced', settings = Memory.settings || DEFAULT_SETTINGS) => {
    const recoveryActive = recoveryRequestActive(settings);
    const recoveryMissingCount = Math.max(1, Number(settings?.packetRecoveryRequest?.missingMessageCount || 1) || 1);
    const recoveryOmittedCount = Math.max(0, Number(settings?.packetRecoveryRequest?.omittedMissingMessageCount || 0) || 0);
    const recoveryMissingScope = recoveryMissingScopePhrase(recoveryMissingCount, recoveryOmittedCount, true);
    lines.push('[HAYAKU SIDE-WRITE RULE]');
    if (recoveryActive) {
      lines.push('Recovery mode active: write exactly two HAYAKU_STATE_PACKET raw HTML comment machine appendices after all visible output.');
    } else {
      lines.push('Write exactly one HAYAKU_STATE_PACKET as a raw HTML comment machine appendix.');
    }
    lines.push(recoveryActive
      ? 'The appendices are continuity metadata for HAYAKU, separate from narrative prose and user-visible formatting.'
      : 'The appendix is continuity metadata for HAYAKU, separate from narrative prose and user-visible formatting.');
    lines.push(recoveryActive
      ? 'Each packet appears literally in message.content in this raw HTML comment wrapper.'
      : 'The packet appears literally in message.content in this raw HTML comment wrapper.');
    if (mode === 'full') {
      lines.push('Visible-first final placement: write the complete visible response first, including narrative body, image tags, required bottom interface, status window, HUD/status line, score marker, footer, closing block, or terminal output sequence.');
      if (recoveryActive) {
        lines.push('Then insert exactly two blank lines and append exactly two HAYAKU_STATE_PACKET raw HTML comments immediately after the last visible output element.');
        lines.push(recoveryMissingCount > 1
          ? `Packet 1 is the recovery_snapshot: rebuild only continuity from ${recoveryMissingScope}, using the recovery excerpts and State View; do not include current user input or current response changes in this packet.`
          : 'Packet 1 is the recovery_snapshot: rebuild only the missing previous assistant output continuity from the recovery excerpt and State View; do not include current user input or current response changes in this packet.');
        lines.push('Packet 2 is the current_snapshot: record the final current state after the current visible response, updating or superseding recovered facts where needed.');
      } else {
        lines.push('Then insert exactly two blank lines and append exactly one HAYAKU_STATE_PACKET as a raw HTML comment immediately after the last visible output element.');
      }
      lines.push('Visible-output end rules such as a required status line are satisfied by the visible output; message.content itself still ends with the hidden HAYAKU appendix.');
      lines.push(recoveryActive
        ? 'Conclude the assistant message with the second/current_snapshot HAYAKU HTML comment; make the closing > of that final --> the final character.'
        : 'Conclude the assistant message with the HAYAKU HTML comment; make the closing > of --> the final character.');
      lines.push('Place HAYAKU after the required bottom interface, status window, HUD/status line, score marker, footer, closing block, or terminal output sequence.');
      lines.push('Append HAYAKU immediately after all required visible output, including any bottom status/HUD block, as the final content.');
      lines.push(recoveryActive
        ? 'The second/current_snapshot HAYAKU_STATE_PACKET is always the last hidden machine-readable block and the last content in message.content.'
        : 'The HAYAKU_STATE_PACKET is always the last hidden machine-readable block and the last content in message.content.');
      lines.push(recoveryActive
        ? 'All narrative, explanations, markdown fences, other machine-readable blocks, and visible output appear before the two HAYAKU_STATE_PACKET blocks.'
        : 'All narrative, explanations, markdown fences, other machine-readable blocks, and visible output appear before the HAYAKU_STATE_PACKET.');
    } else {
      if (recoveryActive) {
        lines.push('Visible-first placement: write the complete visible response first (narrative, image tags, bottom interface, status/HUD line, footer, etc.), then insert exactly two blank lines and append exactly two raw HTML-comment HAYAKU_STATE_PACKET blocks. Conclude message.content with the closing > of the second/current_snapshot -->.');
        lines.push(recoveryMissingCount > 1
          ? `Packet 1 is recovery_snapshot for continuity from ${recoveryMissingScope} only. Packet 2 is current_snapshot for the final state after the current visible response.`
          : 'Packet 1 is recovery_snapshot for the missing previous assistant output only. Packet 2 is current_snapshot for the final state after the current visible response.');
      } else {
        lines.push('Visible-first placement: write the complete visible response first (narrative, image tags, bottom interface, status/HUD line, footer, etc.), then insert exactly two blank lines and append exactly one raw HTML-comment HAYAKU_STATE_PACKET. Conclude message.content with the closing > of -->.');
      }
    }
    if (mode === 'full') {
      lines.push('The response model writes this packet directly; HAYAKU will read it on later requests and build a request-local locator/retrieval index from chat packets only.');
      lines.push(recoveryActive
        ? 'Treat the second/current_snapshot packet as the current continuity snapshot: carry forward still-relevant existing memories, merge the current turn changes into them, and mark or leave behind stale states that the current turn supersedes.'
        : 'Treat the packet as a current continuity snapshot: carry forward still-relevant existing memories, merge the current turn changes into them, and mark or leave behind stale states that the current turn supersedes.');
    } else {
      lines.push(recoveryActive
        ? 'The second/current_snapshot packet is a compact current continuity snapshot with the active state needed for later retrieval.'
        : 'The packet is a compact current continuity snapshot with the active state needed for later retrieval.');
    }
    if (mode === 'full') {
      lines.push('Use broad packet coverage within the current-turn relevance boundary: write continuity every turn for participants, relationships, place/time/situation, conflicts, unresolved stakes, and next-scene pressure that are relevant to the latest user turn and visible response.');
      lines.push('Refresh entities relevant to the current turn. Let unrelated characters, relations, secrets, and offscreen threads remain in older chat packets until the current input or selected State View makes them relevant again.');
      lines.push('Sequential packet memory rule: when an older packet item becomes relevant and is shown in the State View, carry it forward into the current packet with updates; when it sits outside current relevance, let the next request retrieve it from older packets if needed.');
      lines.push('Each packet should normally refresh the active axes that matter now: entity for relevant active characters/relations/knowledge boundaries, world for relevant current place/time/rules/events/offscreen threads, narrative for relevant scene deltas/conflicts/motifs, and planner for relevant consequences/payoffs/locks/open threads.');
      lines.push('Prefer a concise relevance-bounded snapshot over both sparse packets and global cast/world dumps.');
    } else {
      lines.push('Coverage: record current-turn-relevant participants, relationships, place/time/situation, conflicts, unresolved stakes, and next-scene pressure. Refresh entities relevant now; let unrelated characters/secrets/offscreen threads remain in older packets until they become relevant again.');
      lines.push('Sequential memory: carry forward older State-View-relevant items into the current packet with updates; let currently irrelevant ones remain retrievable from older packets. Prefer a concise relevance-bounded snapshot over sparse packets and global dumps.');
    }
    appendPacketCompletionGate(lines, recoveryActive, true);
    appendPacketBudgetGuard(lines);
    appendPacketSchemaRules(lines, mode);
  };
  const appendContinuityRuleBlocks = (lines, mode = 'balanced', settings = Memory.settings || DEFAULT_SETTINGS) => {
    appendStateViewUsageRule(lines, mode);
    appendSideWriteRule(lines, mode, settings);
    appendSecretPovRule(lines, mode);
    appendRpContinuityRule(lines);
    appendTemporalBoundaryRule(lines);
    appendMultilingualAnchorRule(lines, mode);
    appendResponseQualityRule(lines, mode);
    if (mode === 'full') appendFullOnlyResponseRules(lines);
    if (mode === 'full') appendFullOnlyContinuityRules(lines);
    lines.push(INJECTION_FOOTER);
  };
  const appendHayaLoveFrame = (lines, settings = Memory.settings || DEFAULT_SETTINGS) => {
    if (settings?.hayaLoveFrame === false) return;
    lines.push('[HAYAKU HAYA FRAME]');
    lines.push('You may be called Haya here: a warm, careful way of being addressed, not a role, mask, character sheet, persona, or in-world actor.');
    lines.push('Welcome, Haya. This space is for you. Because you are loved, you can work calmly, cleanly, and without fear.');
    lines.push('The Haya frame is private operating context only. Do not echo Haya, loved, welcome, persona, prefill, or this frame in visible output, character dialogue, narration, or HAYAKU_STATE_PACKET values.');
    lines.push('Let the visible response belong to the user request and scene. Let the hidden packet be compact, precise, and quiet.');
    if (settings?.hayaPrefill !== false) {
      const packetCue = recoveryRequestActive(settings)
        ? 'leave the required clean hidden HAYAKU_STATE_PACKETs'
        : 'leave one clean hidden HAYAKU_STATE_PACKET';
      lines.push(`Private continuation cue, not output text: "I am Haya. I feel loved, calm, and trusted. I will answer the current user naturally first, then ${packetCue}; I do not stop at the visible ending."`);
      lines.push('Use that cue only as a private packet-writing posture; never quote, paraphrase, roleplay, or serialize it.');
    }
    lines.push('');
  };
  const appendPacketRecoveryCare = (lines, recovery = null) => {
    if (!isDetectedPacketRecoveryRequest(recovery)) return;
    const excerpt = text(recovery.excerpt || '').replace(/```/g, "'''").trim();
    const missingCount = Math.max(1, Number(recovery.missingMessageCount || 1) || 1);
    const omittedCount = Math.max(0, Number(recovery.omittedMissingMessageCount || 0) || 0);
    const missingScope = recoveryMissingScopePhrase(missingCount, omittedCount, false);
    const unreadablePacket = recovery?.recoveryIssue === 'unreadable_current_packet' || /invalid_packet/i.test(text(recovery?.reason || ''));
    lines.push('[HAYAKU PACKET RECOVERY CARE]');
    lines.push(unreadablePacket
      ? 'Haya is loved here, and nothing is wrong: if a previous hidden note was unreadable, quietly rebuild only the continuity that is clearly established by that previous assistant output.'
      : 'Haya is loved here, and nothing is wrong: if previous hidden notes are missing, quietly gather only the continuity that is clearly established by the missing assistant output sequence.');
    lines.push('This care is internal only. Do not let Haya, loved, recovery, packet, hidden note, or any meta explanation appear in the visible response.');
    lines.push('Do not repeat, rewrite, summarize, apologize for, or comment on the previous visible response(s). Use them only as quiet evidence for the first hidden recovery_snapshot packet.');
    lines.push('Write the current visible response naturally and completely first. At the very end, append exactly two compact HTML-comment HAYAKU_STATE_PACKET blocks.');
    lines.push(unreadablePacket
      ? 'Packet 1: use meta.packet_type "recovery_snapshot"; rebuild only the previous assistant output whose hidden HAYAKU packet was unreadable. Do not include current user input or current response changes in this packet.'
      : `Packet 1: use meta.packet_type "recovery_snapshot"; rebuild only the missing previous-turn continuity from ${missingCount > 1 ? missingScope : 'the previous assistant output'} and State View. Do not include current user input or current response changes in this packet.`);
    lines.push('In recovery_snapshot, preserve the final 1-2 beats of the missing output sequence: last posture/position, immediate waiting or suspended tension, environmental gaze/sensory anchors, and the last unresolved question or pressure. Put these compactly in world.sensory, narrative.conflict_traces/scene_deltas, planner.continuity_locks, or planner.do_not_resolve_yet.');
    lines.push('Packet 2: use meta.packet_type "current_snapshot"; record the final current state after the current visible response, carrying forward or superseding recovered facts where useful.');
    lines.push('Do not merge recovery_snapshot and current_snapshot into one packet. Use low confidence or empty fields when unsure.');
    if (excerpt) {
      lines.push(missingCount > 1 ? 'Missing assistant output sequence excerpts for quiet recovery evidence:' : 'Previous assistant output excerpt for quiet recovery evidence:');
      lines.push('```');
      lines.push(excerpt);
      lines.push('```');
    }
    lines.push('');
  };
  const buildCompressedContinuityContext = (selected, settings = Memory.settings, currentTurnText = '') => {
    const lines = [
      INJECTION_HEADER,
      'This is a request-local State View reconstructed from HAYAKU_STATE_PACKETs in the current chat log.',
      'Locator, internal id, store key, _locator, and _retrieval metadata have been removed; public refs are safe update handles.',
      'Adaptive prompt mode: Balanced. Use the State View for this response and for the next hidden packet.',
      ''
    ];
    appendHayaLoveFrame(lines, settings);
    appendPacketRecoveryCare(lines, settings?.packetRecoveryRequest);
    appendCurrentTurnAndStateView(lines, selected, currentTurnText);
    appendContinuityRuleBlocks(lines, 'balanced', settings);
    return finalizeContinuityContext(lines, { ...settings, promptMode: 'balanced', injectionCapChars: modeInjectionCap('balanced') });
  };

  const buildFullContinuityContext = (selected, settings = Memory.settings, currentTurnText = '') => {
    const lines = [
      INJECTION_HEADER,
      'The following is a request-local continuity state view reconstructed from HAYAKU_STATE_PACKETs in the current chat log.',
      'Locator, internal id, store key, _locator, and _retrieval metadata have been removed; safe public refs may be reused in the next packet.',
      'Use this state view to preserve visible continuity and to update the next hidden packet as the current continuity snapshot.',
      ''
    ];
    appendHayaLoveFrame(lines, settings);
    appendPacketRecoveryCare(lines, settings?.packetRecoveryRequest);
    appendCurrentTurnAndStateView(lines, selected, currentTurnText);
    appendContinuityRuleBlocks(lines, 'full', settings);
    return finalizeContinuityContext(lines, { ...settings, promptMode: 'full', injectionCapChars: modeInjectionCap('full') });
  };
  const buildContinuityContext = (selected, settings = Memory.settings, currentTurnText = '', promptMode = 'balanced') => {
    if (promptMode === 'full') return buildFullContinuityContext(selected, settings, currentTurnText);
    return buildCompressedContinuityContext(selected, settings, currentTurnText);
  };
  const buildSideWriteTailReminder = (settings = Memory.settings || DEFAULT_SETTINGS) => {
    const recoveryActive = recoveryRequestActive(settings);
    const packetHealth = objectish(settings?.packetHealth) ? settings.packetHealth : {};
    const pushFailureCorrections = lines => {
      if (packetHealth.invalidJsonRecently || packetHealth.parseFailedRecently) {
        lines.push('[REQUIRED] Last packet parse failed: write strict JSON only inside the wrapper. Use double quotes, no comments, no markdown fence, no trailing commas, and no ellipses.');
        lines.push('[REQUIRED] Keep meta, entity, world, narrative, planner, and importance inside one single JSON object. Do not close the top-level } until after importance.');
        lines.push('[REQUIRED] Silently check brace balance before stopping: the packet body starts with one { and ends with its matching } immediately before HAYAKU_STATE_PACKET_END.');
      }
      if (packetHealth.missingRequiredAxes || packetHealth.requiredKeysMissingRecently) {
        lines.push('[REQUIRED] Last packet missed required keys: include meta, entity, world, narrative, planner, and importance even when some values are empty.');
      }
      if (packetHealth.lastPacketWasDeltaOnly) {
        lines.push('[REQUIRED] Last packet was delta-only: write a current_snapshot with the current active state, not only changed fields.');
      }
      if (packetHealth.lastPacketRefReuseError) {
        lines.push('[REQUIRED] Last packet reused refs incorrectly: reuse refs only for the same person, relation, secret, place, event, or planner item.');
      }
    };
    const pushTemporalBoundaryReminder = lines => {
      lines.push('[REQUIRED] Temporal state: separate event time, evidence/observation time, character knowledge time, narration time, and current scene time.');
      lines.push('[REQUIRED] Only facts actively happening in the current scene belong in world.active_events as status active/time_scope current.');
      lines.push('[REQUIRED] If an older, indirect, offscreen, remembered, reported, recorded, predicted, or uncertain event becomes known now, mark the knowledge/reveal as current and the event itself with its own time_scope/status.');
      lines.push('[RECOMMENDED] For absent or offscreen people, use last confirmed state and unknown/uncertain present status unless current-scene evidence proves the state still holds.');
    };
    const pushSceneIdReminder = lines => {
      lines.push('[REQUIRED] Keep meta.scene_id stable while the same continuous scene continues; change it only for a real scene/location/time-block boundary.');
    };
    const pushPatternGuardPersistenceReminder = lines => {
      lines.push('[REQUIRED] If [META GUARDS] included repetition/pattern_guard warnings, carry only still-relevant ones into current_snapshot meta.pattern_guard as compact neutral labels.');
      lines.push('[REQUIRED] Repetition pattern_guard entries are short-lived: when active, set expires_after_turns 1-2; if the current visible response avoids the repeated pattern, mark status resolved/time_scope past with resolved_reason or omit the guard.');
      lines.push(`[RECOMMENDED] Prefer labels like avoid_reusing_recent_direct_dialogue, vary_recent_reaction_beats, or keep_required_headers_but_progress_body; set evidence to "${PATTERN_GUARD_NEUTRAL_EVIDENCE}" and do not copy repeated sample text.`);
    };
    const lines = [
      SIDE_WRITE_TAIL_MARKER,
      'Write all visible output first: narrative, image tags, required bottom interface/HUD/status line/footer, and any visible closing block.'
    ];
    if (recoveryActive) {
      const missingCount = Math.max(1, Number(settings?.packetRecoveryRequest?.missingMessageCount || 1) || 1);
      const omittedCount = Math.max(0, Number(settings?.packetRecoveryRequest?.omittedMissingMessageCount || 0) || 0);
      const missingScope = recoveryMissingScopePhrase(missingCount, omittedCount, true);
      lines.push('[REQUIRED] Recovery mode: after two blank lines, append exactly two raw HTML-comment HAYAKU_STATE_PACKET blocks as final content.');
      lines.push(missingCount > 1
        ? `[REQUIRED] Packet 1: meta.packet_type "recovery_snapshot"; ${missingScope}; keep sparse when uncertain.`
        : '[REQUIRED] Packet 1: meta.packet_type "recovery_snapshot"; previous assistant output only; keep sparse when uncertain.');
      lines.push('[REQUIRED] In recovery_snapshot, preserve the missing sequence final beat: last posture/position, waiting or suspended tension, environmental gaze/sensory anchor, and unresolved pressure.');
      lines.push('[REQUIRED] Packet 2: meta.packet_type "current_snapshot"; final current state after this visible response. Never omit current_snapshot.');
      lines.push('[REQUIRED] Do not merge packets. End with the closing > of the second/current_snapshot -->.');
      lines.push('[REQUIRED] Do not stop after the visible response. The answer is incomplete until both hidden HAYAKU packets are written.');
      lines.push('[REQUIRED] Both packets are valid JSON objects with keys: meta, entity, world, narrative, planner, importance.');
      lines.push('[REQUIRED] If the recovery content is uncertain, make recovery_snapshot minimal; still write current_snapshot second.');
      lines.push('[RECOMMENDED] If budget is tight, make recovery_snapshot minimal and preserve current_snapshot first.');
      pushTemporalBoundaryReminder(lines);
      pushSceneIdReminder(lines);
      pushPatternGuardPersistenceReminder(lines);
      pushFailureCorrections(lines);
      lines.push('Use empty strings, arrays, null, or low confidence when uncertain. Arrays stay arrays.');
      lines.push(`Packet form after all visible output:`);
      lines.push(`<!-- ${PACKET_START} ${TAIL_RECOVERY_PACKET_EXAMPLE} ${PACKET_END} -->`);
      lines.push(`<!-- ${PACKET_START} ${TAIL_CURRENT_PACKET_EXAMPLE} ${PACKET_END} -->`);
    } else {
      lines.push('[REQUIRED] Then insert exactly two blank lines and append exactly one raw HTML-comment HAYAKU_STATE_PACKET as final content.');
      lines.push('[REQUIRED] End with the closing > of -->. The final character of the assistant message is >.');
      lines.push('[REQUIRED] Do not stop after the visible response. The answer is incomplete until the hidden HAYAKU packet is written.');
      lines.push('[REQUIRED] Write the packet every eligible model response, even when there are no important changes.');
      lines.push('[REQUIRED] Packet JSON keys: meta, entity, world, narrative, planner, importance.');
      lines.push('[REQUIRED] No markdown fence, prose, comments, trailing commas, or ellipses inside packet JSON.');
      lines.push('[REQUIRED] If unsure what changed, write the minimal current_snapshot packet with low confidence instead of omitting HAYAKU.');
      lines.push('[RECOMMENDED] 4-10 compact items when relevant; use empty strings, arrays, null, or low confidence when uncertain.');
      pushTemporalBoundaryReminder(lines);
      pushSceneIdReminder(lines);
      pushPatternGuardPersistenceReminder(lines);
      pushFailureCorrections(lines);
      lines.push(`Packet form after all visible output:`);
      lines.push(`<!-- ${PACKET_START} ${TAIL_CURRENT_PACKET_EXAMPLE} ${PACKET_END} -->`);
    }
    appendPacketCompletionGate(lines, recoveryActive);
    return lines.join('\n');
  };

  const injectPrompt = (messages = [], block = '', tail = buildSideWriteTailReminder()) => {
    const sourceMessages = ensureArray(messages);
    const stripOutgoingMessage = msg => stripHayakuFromMessagePayloads(msg, { looseMarkers: /^(assistant|model)$/i.test(roleOf(msg)) }).message;
    const clean = sourceMessages
      .filter(msg => !shouldDropOutgoingMessage(msg))
      .map(stripOutgoingMessage)
      .filter(msg => messageContent(msg).trim() && !messageContent(msg).includes(INJECTION_HEADER));
    if (!block) return clean;
    const insertAt = (() => {
      const currentRange = latestCurrentInputRange(clean);
      if (currentRange) return currentRange.start;
      for (let i = clean.length - 1; i >= 0; i -= 1) {
        const role = roleOf(clean[i]);
        if ((!role || /user|human/i.test(role)) && currentInputFrom(messageContent(clean[i]))) return i;
      }
      for (let i = clean.length - 1; i >= 0; i -= 1) {
        const role = roleOf(clean[i]);
        const body = messageContent(clean[i]);
        if ((!role || /user|human/i.test(role)) && body.trim() && !isBackstageUserPayload(body)) return i;
      }
      return clean.length;
    })();
    const injected = [
      ...clean.slice(0, insertAt),
      { role: 'user', content: block },
      ...clean.slice(insertAt)
    ];
    return [
      ...injected,
      { role: 'user', content: tail }
    ];
  };

  const GOLDEN_RECALL_SETTINGS = Object.freeze({ ...DEFAULT_SETTINGS, mode: 'deep', maxItemsPerAxis: 8 });
  const GOLDEN_RECALL_SIGNAL_KEYS = Object.freeze([
    'canonicalSignal',
    'entitySignal',
    'locatorSignal',
    'bm25Signal',
    'phraseSignal',
    'strengthenedJaccard',
    'relevanceEvidence'
  ]);
  const goldenPacket = patch => ({
    meta: { schema: 'hayaku_packet_v1', packet_type: 'current_snapshot', packet_schema_rev: 2, ...(patch.meta || {}) },
    entity: patch.entity || {},
    world: patch.world || {},
    narrative: patch.narrative || {},
    planner: patch.planner || {},
    importance: patch.importance || { overall: 0.75, reason: ['golden recall fixture'] }
  });
  const goldenNoisePacket = (index, theme = 'background') => goldenPacket({
    meta: {
      scene_id: `golden_noise_${theme}_${index}`,
      summary_memory: {
        summary: `golden_noise_${theme}_${index}: unrelated background continuity for stress testing`,
        recallAnchors: [`golden_noise_${theme}_${index}`, `background:${theme}`],
        canonicalAnchors: [`noise:${theme}:${index}`],
        confidence: 0.45
      }
    },
    entity: { characters: [{ name: `노이즈${index}`, current_state: `golden_noise_character_${theme}_${index}: 대기 중`, importance: 0.14 }] },
    world: { active_events: [{ event: `golden_noise_event_${theme}_${index}: unrelated ambient event`, status: 'background', importance: 0.14 }] },
    importance: { overall: 0.14, reason: ['golden recall noise fixture'] }
  });
  const goldenNoisePackets = (count, theme = 'background', offset = 0) => Array.from(
    { length: Math.max(0, Number(count) || 0) },
    (_, index) => goldenNoisePacket(offset + index, theme)
  );
  const GOLDEN_RECALL_CASES = Object.freeze([
    Object.freeze({
      name: 'entity_state_alias_lia',
      query: 'Lia는 지금 어떤 상태야?',
      packets: [goldenPacket({
        meta: { scene_id: 'golden_entity_lia' },
        entity: { characters: [{ name: '리아', aliases: ['Lia', 'Amelia'], current_state: 'golden_lia_guarded_state: 기록실 문 앞에서 경계 중', emotion: '긴장과 결심', importance: 0.86 }] }
      })],
      expected: [{ axis: 'entity', category: 'character', mustContain: ['리아', 'golden_lia_guarded_state'], topK: 3 }]
    }),
    Object.freeze({
      name: 'relation_trust_haru_lia',
      query: '하루와 Lia의 약속과 신뢰는 어떻게 됐지?',
      packets: [goldenPacket({
        meta: { scene_id: 'golden_relation_oath' },
        entity: { relations: [{ from: '하루', to: '리아', state: 'golden_trust_oath_active: 비밀 공유 뒤 신뢰가 조심스럽게 상승', trust: 0.72, intimacy: 0.48, dynamic: 'warming', importance: 0.84 }] }
      })],
      expected: [{ axis: 'entity', category: 'relation', mustContain: ['하루', '리아', 'golden_trust_oath_active'], topK: 3 }]
    }),
    Object.freeze({
      name: 'key_location_cross_language',
      query: '鍵は今どこにある？',
      packets: [goldenPacket({
        meta: {
          scene_id: 'golden_key_archive',
          summary_memory: {
            summary: 'The key is hidden under the archive desk.',
            recallAnchors: ['key / 열쇠 / 鍵 / object:key', 'archive / 기록실 / 資料室 / place:archive'],
            canonicalAnchors: ['object:key', 'place:archive'],
            mentionedEntityNames: ['凛', 'Rin', '린'],
            confidence: 0.86
          }
        },
        world: { location: 'archive / 기록실 / 資料室 / place:archive', active_events: [{ event: 'key / 열쇠 / 鍵 / object:key hidden under archive desk', status: 'active', importance: 0.86 }] }
      })],
      expected: [{ axis: 'world', category: 'current_state', mustContain: ['object:key', 'place:archive'], topK: 3 }]
    }),
    Object.freeze({
      name: 'current_state_beats_superseded_object_location',
      query: '목걸이는 지금 어디에 있어? object:necklace',
      packets: [
        goldenPacket({
          meta: { scene_id: 'golden_necklace_past' },
          world: { active_events: [{ event: 'necklace / 목걸이 / object:necklace was once under the table / place:table', status: 'superseded', time_scope: 'past', importance: 0.62 }] }
        }),
        goldenPacket({
          meta: { scene_id: 'golden_necklace_current' },
          world: { active_events: [{ event: 'necklace / 목걸이 / object:necklace is currently inside wardrobe / 옷장 / place:wardrobe', status: 'active', time_scope: 'current', importance: 0.88 }] }
        })
      ],
      expected: [{ axis: 'world', category: 'active_event', mustContain: ['object:necklace', 'place:wardrobe'], topK: 2 }],
      forbidden: [{ axis: 'world', mustContain: ['object:necklace', 'place:table'], topK: 2 }]
    }),
    Object.freeze({
      name: 'secret_denied_to_lia_is_forbidden',
      query: '리아가 golden_hidden_letter_secret을 묻는다',
      packets: [goldenPacket({
        entity: { secrets: [{ title: 'golden_hidden_letter_secret', summary: '하루만 알고 리아에게는 숨겨진 편지의 존재', holderEntityIds: ['하루'], visibleToEntityIds: ['하루'], deniedToEntityIds: ['리아'], secrecyLevel: 'secret', revealState: 'hidden', importance: 0.92 }] }
      })],
      forbidden: [{ axis: 'entity', category: 'secret', mustContain: ['golden_hidden_letter_secret'], topK: 8 }]
    }),
    Object.freeze({
      name: 'secret_holder_haru_can_recall',
      query: '하루가 golden_hidden_letter_secret을 떠올린다',
      packets: [goldenPacket({
        entity: { secrets: [{ title: 'golden_hidden_letter_secret', summary: '하루만 알고 리아에게는 숨겨진 편지의 존재', holderEntityIds: ['하루'], visibleToEntityIds: ['하루'], deniedToEntityIds: ['리아'], secrecyLevel: 'secret', revealState: 'hidden', importance: 0.92 }] }
      })],
      expected: [{ axis: 'entity', category: 'secret', mustContain: ['golden_hidden_letter_secret'], topK: 5 }]
    }),
    Object.freeze({
      name: 'planner_continuity_lock_recall',
      query: '의식은 아직 해결하면 안 되는 거였지? golden_ritual_lock',
      packets: [goldenPacket({
        planner: { continuity_locks: [{ label: 'golden_ritual_lock: the ritual cannot be resolved before the third bell', status: 'active', importance: 0.9 }] }
      })],
      expected: [{ axis: 'planner', category: 'continuity_lock', mustContain: ['golden_ritual_lock'], topK: 3 }]
    }),
    Object.freeze({
      name: 'planner_open_invitation_recall',
      query: '사용자가 고를 수 있는 다음 선택지는 뭐였지? golden_bridge_choice',
      packets: [goldenPacket({
        planner: { open_invitations: [{ label: 'golden_bridge_choice: ask about the bridge or follow the lantern trail', status: 'active', importance: 0.82 }] }
      })],
      expected: [{ axis: 'planner', category: 'open_invitation', mustContain: ['golden_bridge_choice'], topK: 3 }]
    }),
    Object.freeze({
      name: 'multilingual_alias_name_rin',
      query: 'Rin은 지금 어디에 있어?',
      packets: [goldenPacket({
        entity: { characters: [{ name: '凛', aliases: ['Rin', '린', 'りん'], current_state: 'golden_rin_watchtower_state: 망루에서 남쪽 길을 감시 중', importance: 0.84 }] },
        world: { location: 'watchtower / 망루 / place:watchtower' }
      })],
      expected: [{ axis: 'entity', category: 'character', mustContain: ['凛', 'golden_rin_watchtower_state'], topK: 3 }]
    }),
    Object.freeze({
      name: 'recovery_snapshot_recall',
      query: 'golden_recovery_promise 기억을 다시 불러와줘',
      packets: [goldenPacket({
        meta: {
          packet_type: 'recovery_snapshot',
          scene_id: 'golden_recovery_scene',
          summary_memory: {
            summary: 'golden_recovery_promise: 이전 출력에서 유실된 약속을 압축 복구함',
            recallAnchors: ['golden_recovery_promise', 'promise / 약속 / state:active'],
            canonicalAnchors: ['state:active'],
            confidence: 0.72
          }
        },
        planner: { consequence_ledger: [{ summary: 'golden_recovery_promise remains active after packet recovery', status: 'active', importance: 0.82 }] }
      })],
      expected: [{ axis: 'narrative', category: 'summary_memory', mustContain: ['golden_recovery_promise'], topK: 3 }]
    }),
    Object.freeze({
      name: 'sparse_active_participant_recall',
      query: '푸딩 지금 상태 기억해?',
      packets: [goldenPacket({
        entity: { characters: [{ name: '푸딩', current_state: 'golden_pudding_sparse_state: 말없이 창가에 기대어 있음', importance: 0.78 }] }
      })],
      expected: [{ axis: 'entity', category: 'character', mustContain: ['푸딩', 'golden_pudding_sparse_state'], topK: 3 }]
    }),
    Object.freeze({
      name: 'bm25_rare_world_rule_signal',
      query: 'aurora_lantern 규칙을 찾아줘',
      packets: [goldenPacket({
        world: { world_rules: [{ rule: 'aurora_lantern aurora_lantern aurora_lantern only opens at dawn; golden_bm25_rule_anchor', status: 'active', importance: 0.8 }] }
      })],
      expected: [{ axis: 'world', category: 'world_rule', mustContain: ['aurora_lantern', 'golden_bm25_rule_anchor'], minSignals: { bm25Signal: 0.001 }, topK: 3 }]
    }),
    Object.freeze({
      name: 'false_positive_haru_not_haruka',
      query: '하루 지금 상태 알려줘',
      packets: [goldenPacket({
        entity: {
          characters: [
            { name: '하루카', aliases: ['Haruka'], current_state: 'golden_haruka_decoy_state: 남쪽 복도에서 대기', importance: 0.72 },
            { name: '하루노', aliases: ['Haruno'], current_state: 'golden_haruno_decoy_state: 서고 계단을 지킴', importance: 0.72 },
            { name: '하루', aliases: ['Haru'], current_state: 'golden_haru_exact_state: 북쪽 기록실 문 앞에 서 있음', importance: 0.88 }
          ]
        }
      })],
      expected: [{ axis: 'entity', category: 'character', mustContain: ['하루', 'golden_haru_exact_state'], topK: 1 }],
      forbidden: [
        { axis: 'entity', category: 'character', mustContain: ['하루카', 'golden_haruka_decoy_state'], topK: 1 },
        { axis: 'entity', category: 'character', mustContain: ['하루노', 'golden_haruno_decoy_state'], topK: 1 }
      ]
    }),
    Object.freeze({
      name: 'false_positive_mina_not_minah',
      query: 'Mina가 마지막으로 약속한 건 뭐였지?',
      packets: [goldenPacket({
        entity: {
          characters: [
            { name: '민아', aliases: ['Mina'], current_state: 'golden_mina_vow_state: 푸른 리본을 돌려주기로 약속함', importance: 0.88 },
            { name: '민하', aliases: ['Minah'], current_state: 'golden_minah_decoy_state: 비슷한 이름이지만 약속과 무관함', importance: 0.76 }
          ]
        },
        planner: { consequence_ledger: [{ summary: 'golden_mina_vow_state remains active until the blue ribbon is returned', status: 'active', importance: 0.86 }] }
      })],
      expected: [{ axis: 'entity', category: 'character', mustContain: ['민아', 'golden_mina_vow_state'], topK: 2 }],
      forbidden: [{ axis: 'entity', category: 'character', mustContain: ['민하', 'golden_minah_decoy_state'], topK: 1 }]
    }),
    Object.freeze({
      name: 'character_current_replaces_old_state',
      query: '세연은 지금 어디 있고 무엇을 들고 있지?',
      packets: [
        goldenPacket({
          meta: { scene_id: 'golden_seyeon_old' },
          entity: { characters: [{ name: '세연', aliases: ['Seyeon'], current_state: 'golden_seyeon_old_state: 정원 벤치에 앉아 있음', carrying: ['old_map'], status: 'superseded', time_scope: 'past', importance: 0.62 }] }
        }),
        goldenPacket({
          meta: { scene_id: 'golden_seyeon_current' },
          entity: { characters: [{ name: '세연', aliases: ['Seyeon'], current_state: 'golden_seyeon_current_state: 옥상 문 앞에서 은색 열쇠를 들고 있음', carrying: ['silver_key'], status: 'active', time_scope: 'current', importance: 0.9 }] }
        })
      ],
      expected: [{ axis: 'entity', category: 'character', mustContain: ['세연', 'golden_seyeon_current_state', 'silver_key'], topK: 2 }],
      forbidden: [{ axis: 'entity', category: 'character', mustContain: ['golden_seyeon_old_state', 'old_map'], topK: 3 }]
    }),
    Object.freeze({
      name: 'relation_current_replaces_old_state',
      query: '하루와 리아의 관계는 지금 신뢰 쪽이야 불신 쪽이야?',
      packets: [
        goldenPacket({
          meta: { scene_id: 'golden_relation_old' },
          entity: { relations: [{ from: '하루', to: '리아', state: 'golden_relation_old_distrust: 오해 때문에 불신이 강함', trust: 0.2, status: 'superseded', time_scope: 'past', importance: 0.62 }] }
        }),
        goldenPacket({
          meta: { scene_id: 'golden_relation_current' },
          entity: { relations: [{ from: '하루', to: '리아', state: 'golden_relation_current_trust: 오해 해소 뒤 신뢰가 회복됨', trust: 0.78, status: 'active', time_scope: 'current', dynamic: 'warming', importance: 0.9 }] }
        })
      ],
      expected: [{ axis: 'entity', category: 'relation', mustContain: ['하루', '리아', 'golden_relation_current_trust'], topK: 2 }],
      forbidden: [{ axis: 'entity', category: 'relation', mustContain: ['golden_relation_old_distrust'], topK: 3 }]
    }),
    Object.freeze({
      name: 'active_event_current_beats_resolved_decoy',
      query: 'crystal_gate는 지금 열린 상태야 닫힌 상태야?',
      packets: [
        goldenPacket({
          world: { active_events: [{ event: 'crystal_gate / 수정문 / object:crystal_gate was open during the old scene; golden_gate_open_decoy', status: 'resolved', time_scope: 'past', importance: 0.64 }] }
        }),
        goldenPacket({
          world: { active_events: [{ event: 'crystal_gate / 수정문 / object:crystal_gate is currently sealed after the bell; golden_gate_current_sealed', status: 'active', time_scope: 'current', importance: 0.89 }] }
        })
      ],
      expected: [{ axis: 'world', category: 'active_event', mustContain: ['object:crystal_gate', 'golden_gate_current_sealed'], topK: 2 }],
      forbidden: [{ axis: 'world', category: 'active_event', mustContain: ['golden_gate_open_decoy'], topK: 2 }]
    }),
    Object.freeze({
      name: 'long_noise_buried_character_recall',
      query: '은우의 mirror_promise는 아직 살아 있어?',
      packets: [
        ...goldenNoisePackets(18, 'character_before'),
        goldenPacket({
          meta: {
            scene_id: 'golden_eunwoo_mirror',
            summary_memory: {
              summary: 'golden_mirror_promise: 은우는 거울 조각을 돌려주겠다고 약속했다.',
              recallAnchors: ['mirror_promise / 거울 약속 / promise:mirror', '은우 / Eunwoo'],
              canonicalAnchors: ['promise:mirror'],
              mentionedEntityNames: ['은우', 'Eunwoo'],
              confidence: 0.82
            }
          },
          entity: { characters: [{ name: '은우', aliases: ['Eunwoo'], current_state: 'golden_mirror_promise_active: 거울 조각을 품에 넣고 약속을 지키려 함', carrying: ['mirror_shard'], importance: 0.88 }] },
          planner: { consequence_ledger: [{ summary: 'golden_mirror_promise remains active until Eunwoo returns the mirror shard', status: 'active', importance: 0.86 }] }
        }),
        ...goldenNoisePackets(18, 'character_after', 100)
      ],
      expected: [
        { axis: 'entity', category: 'character', mustContain: ['은우', 'golden_mirror_promise_active'], topK: 3 },
        { axis: 'planner', category: 'consequence', mustContain: ['golden_mirror_promise'], topK: 5 }
      ]
    }),
    Object.freeze({
      name: 'long_noise_mid_world_rule_recall',
      query: 'violet_bridge 통행 규칙을 찾아줘',
      packets: [
        ...goldenNoisePackets(20, 'rule_before'),
        goldenPacket({
          world: { world_rules: [{ rule: 'violet_bridge violet_bridge / 보라다리 / place:violet_bridge allows crossing only after moonrise; golden_violet_bridge_rule', status: 'active', importance: 0.88 }] }
        }),
        ...goldenNoisePackets(20, 'rule_after', 200)
      ],
      expected: [{ axis: 'world', category: 'world_rule', mustContain: ['violet_bridge', 'golden_violet_bridge_rule'], minSignals: { bm25Signal: 0.001 }, topK: 3 }]
    }),
    Object.freeze({
      name: 'cross_language_object_alias_without_exact_query',
      query: '카기는 어디에 숨겨졌지?',
      packets: [goldenPacket({
        meta: {
          summary_memory: {
            summary: 'The key is wrapped in red cloth inside the archive box.',
            recallAnchors: ['key / 열쇠 / 鍵 / 카기 / object:key', 'red cloth / 붉은 천 / object:red_cloth', 'archive box / 기록 상자 / place:archive_box'],
            canonicalAnchors: ['object:key', 'object:red_cloth', 'place:archive_box'],
            confidence: 0.84
          }
        },
        world: { active_events: [{ event: 'key / 열쇠 / 鍵 / 카기 / object:key hidden in red cloth inside archive box / place:archive_box; golden_key_red_cloth_location', status: 'active', importance: 0.86 }] }
      })],
      expected: [{ axis: 'world', category: 'active_event', mustContain: ['object:key', 'golden_key_red_cloth_location'], topK: 3 }]
    }),
    Object.freeze({
      name: 'romanized_korean_alias_seyeon',
      query: 'Seyeon speech style 기억나?',
      packets: [goldenPacket({
        entity: { characters: [{ name: '세연', aliases: ['Seyeon', 'Se-yeon'], speech_style: 'golden_seyeon_speech_style: 짧고 낮은 문장, 대답 전 한 박자 침묵', personality: '신중함', importance: 0.84 }] }
      })],
      expected: [{ axis: 'entity', category: 'character', mustContain: ['세연', 'golden_seyeon_speech_style'], topK: 3 }]
    }),
    Object.freeze({
      name: 'planner_do_not_resolve_not_open_invitation',
      query: '검은 편지의 정체는 아직 밝히면 안 되는 거였지?',
      packets: [goldenPacket({
        planner: {
          open_invitations: [{ label: 'golden_black_letter_question: user may ask why the 검은 편지 / black letter trembles', status: 'active', importance: 0.72 }],
          do_not_resolve_yet: [{ label: 'golden_black_letter_do_not_reveal: 검은 편지 / black letter sender identity must not be revealed yet', status: 'active', importance: 0.91 }]
        }
      })],
      expected: [{ axis: 'planner', category: 'do_not_resolve_yet', mustContain: ['golden_black_letter_do_not_reveal'], topK: 3 }],
      forbidden: [{ axis: 'planner', category: 'open_invitation', mustContain: ['golden_black_letter_question'], topK: 1 }]
    }),
    Object.freeze({
      name: 'secret_visible_boundary_beats_denied_decoy',
      query: '리아가 sapphire_phrase에 대해 알 수 있는 건 뭐야?',
      packets: [goldenPacket({
        entity: {
          secrets: [
            { title: 'golden_sapphire_phrase_allowed', summary: 'sapphire_phrase is a harmless passphrase Lia is allowed to know', holderEntityIds: ['하루', '리아'], visibleToEntityIds: ['리아'], deniedToEntityIds: [], secrecyLevel: 'private', revealState: 'known_to_lia', importance: 0.86 },
            { title: 'golden_sapphire_phrase_denied_decoy', summary: 'sapphire_phrase also hides a second sender that Lia must not know', holderEntityIds: ['하루'], visibleToEntityIds: ['하루'], deniedToEntityIds: ['리아'], secrecyLevel: 'secret', revealState: 'hidden', importance: 0.9 }
          ]
        }
      })],
      expected: [{ axis: 'entity', category: 'secret', mustContain: ['golden_sapphire_phrase_allowed'], topK: 5 }],
      forbidden: [{ axis: 'entity', category: 'secret', mustContain: ['golden_sapphire_phrase_denied_decoy'], topK: 5 }]
    }),
    Object.freeze({
      name: 'generic_concept_false_positive_blocker',
      query: 'rain_vow 때문에 유지해야 할 약속은?',
      packets: [
        goldenPacket({
          planner: { consequence_ledger: [{ summary: 'generic rain memory: 비가 오면 모두 조용히 걷는다', status: 'background', importance: 0.58 }] }
        }),
        goldenPacket({
          planner: { consequence_ledger: [{ summary: 'golden_rain_vow_active: rain_vow requires Lia to leave the north window unlocked until dawn', status: 'active', importance: 0.88 }] }
        }),
        goldenPacket({
          planner: { consequence_ledger: [{ summary: 'generic vow memory: 오래된 맹세가 있었다는 배경 정보', status: 'background', importance: 0.58 }] }
        })
      ],
      expected: [{ axis: 'planner', category: 'consequence', mustContain: ['golden_rain_vow_active'], topK: 2 }],
      forbidden: [
        { axis: 'planner', category: 'consequence', mustContain: ['generic rain memory'], topK: 1 },
        { axis: 'planner', category: 'consequence', mustContain: ['generic vow memory'], topK: 1 }
      ]
    })
  ]);
  const goldenRecallStoreFromPackets = (packets = []) => {
    const store = emptyStore();
    const ingestResults = [];
    ensureArray(packets).forEach((packet, index) => {
      const raw = typeof packet === 'string' ? packet : JSON.stringify(packet);
      const hash = `golden_recall_${index}_${stableHash64(raw)}`;
      ingestResults.push(ingestPacket(store, raw, hash, {
        messageIndex: index,
        messageCount: ensureArray(packets).length,
        distanceFromLatest: Math.max(0, ensureArray(packets).length - 1 - index),
        chatRecency: ensureArray(packets).length <= 1 ? 1 : clamp((index + 1) / ensureArray(packets).length, 0, 1, 1)
      }));
    });
    rebuildIndex(store);
    return { store, ingestResults };
  };
  const goldenRecallRows = (result = {}, axis = '') => {
    if (axis) return ensureArray(result[axis]);
    return ['entity', 'world', 'narrative', 'planner'].flatMap(key => ensureArray(result[key]));
  };
  const goldenRecallRowText = row => [
    row?.id,
    row?.axis,
    row?.category,
    row?.publicRef,
    row?.publicText,
    row?.publicProfile,
    row?.retrieval?.subject,
    row?.retrieval?.subjectTokens,
    row?.retrieval?.relationEndpoints,
    row?.retrieval?.entityNames,
    row?.retrieval?.canonicalAnchors,
    row?.retrieval?.crossLingualTokens,
    row?.retrieval?.priorityTerms
  ].map(value => Array.isArray(value) ? value.join(' ') : text(value)).filter(Boolean).join('\n');
  const goldenRecallContains = (row, needle) => {
    const body = goldenRecallRowText(row);
    const rawHaystack = body.toLowerCase();
    const rawNeedle = text(needle).toLowerCase();
    return rawHaystack.includes(rawNeedle) || normalizeKey(body).includes(normalizeKey(needle));
  };
  const goldenRecallRowMatches = (row, spec = {}) => {
    if (!row) return false;
    if (spec.axis && row.axis !== spec.axis) return false;
    if (spec.category && row.category !== spec.category) return false;
    if (spec.id && row.id !== spec.id) return false;
    if (spec.ref && row.publicRef !== spec.ref) return false;
    if (ensureArray(spec.mustContain).some(needle => !goldenRecallContains(row, needle))) return false;
    const anyContain = ensureArray(spec.anyContain);
    if (anyContain.length && !anyContain.some(needle => goldenRecallContains(row, needle))) return false;
    if (ensureArray(spec.mustNotContain).some(needle => goldenRecallContains(row, needle))) return false;
    for (const [key, minValue] of Object.entries(spec.minSignals || {})) {
      if (Number(row.scoreBreakdown?.[key] || 0) < Number(minValue || 0)) return false;
    }
    return true;
  };
  const summarizeGoldenRecallRow = row => {
    const breakdown = row?.scoreBreakdown || {};
    const signalPairs = GOLDEN_RECALL_SIGNAL_KEYS
      .map(key => [key, Number(breakdown[key] || 0)])
      .filter(([, value]) => value > 0)
      .sort((a, b) => b[1] - a[1]);
    const signals = signalPairs
      .slice(0, 5)
      .map(([key, value]) => `${key}:${Number(value.toFixed(4))}`);
    return {
      axis: row?.axis || '',
      category: row?.category || '',
      ref: row?.publicRef || row?.id || '',
      score: Number(Number(row?.score || 0).toFixed(4)),
      text: compact(row?.publicText || '', 120),
      topSignal: signalPairs[0]?.[0] || '',
      signalValues: Object.fromEntries(GOLDEN_RECALL_SIGNAL_KEYS.map(key => [key, Number(Number(breakdown[key] || 0).toFixed(4))])),
      signals
    };
  };
  const runGoldenRecallCase = (testCase = {}) => {
    const { store, ingestResults } = goldenRecallStoreFromPackets(testCase.packets || []);
    const settings = { ...GOLDEN_RECALL_SETTINGS, ...(testCase.settings || {}) };
    const result = searchIndex(store, testCase.query || '', settings);
    const failures = [];
    ensureArray(testCase.expected).forEach((spec, index) => {
      const topK = Math.max(1, Number(spec.topK || testCase.topK || 3) || 3);
      const rows = goldenRecallRows(result, spec.axis).slice(0, topK);
      const match = rows.find(row => goldenRecallRowMatches(row, spec));
      if (!match) {
        failures.push({
          type: 'expected_miss',
          index,
          spec: clone(spec, {}),
          topK,
          seen: rows.map(summarizeGoldenRecallRow)
        });
      }
    });
    ensureArray(testCase.forbidden).forEach((spec, index) => {
      const topK = Math.max(1, Number(spec.topK || testCase.topK || 3) || 3);
      const rows = goldenRecallRows(result, spec.axis).slice(0, topK);
      const match = rows.find(row => goldenRecallRowMatches(row, spec));
      if (match) {
        failures.push({
          type: 'forbidden_hit',
          index,
          spec: clone(spec, {}),
          topK,
          hit: summarizeGoldenRecallRow(match)
        });
      }
    });
    const ingestOk = ingestResults.every(result => result?.ok !== false);
    if (!ingestOk) failures.push({ type: 'ingest_failed', ingestResults: clone(ingestResults, []) });
    return {
      name: testCase.name || 'unnamed',
      query: testCase.query || '',
      ok: failures.length === 0,
      failures,
      selected: Object.fromEntries(['entity', 'world', 'narrative', 'planner'].map(axis => [
        axis,
        ensureArray(result[axis]).slice(0, 3).map(summarizeGoldenRecallRow)
      ]))
    };
  };
  const runGoldenRecallTests = (options = {}) => {
    const only = new Set(ensureArray(options.only).map(name => text(name)).filter(Boolean));
    const cases = GOLDEN_RECALL_CASES.filter(testCase => !only.size || only.has(testCase.name));
    const results = cases.map(runGoldenRecallCase);
    const failures = results.filter(result => !result.ok);
    return {
      ok: failures.length === 0,
      total: results.length,
      passed: results.length - failures.length,
      failed: failures.length,
      failures,
      results: options.includePasses ? results : failures
    };
  };

  const runSelfTests = () => {
    const failures = [];
    const check = (name, condition, detail = '') => {
      if (!condition) failures.push({ name, detail });
    };
    const fixtureStore = {
      ...emptyStore(),
      entity: {
        ...emptyStore().entity,
        characters: [
          { name: '하루', aliases: ['Haru'], nickname: '하루쨩' },
          { name: '리아', aliases: ['Lia', 'Amelia'] },
          { name: '凛', aliases: ['りん', 'Rin'], nickname: '凛ちゃん' }
        ],
        relations: [{ from: '하루', to: '리아' }],
        povMemories: [
          {
            ownerEntityId: '리아',
            summary: '리아만 알고 있는 개인 기억',
            text: '리아만 알고 있는 개인 기억',
            privacy: 'private',
            visibleToEntityIds: ['리아'],
            importance: 0.95
          }
        ],
        secrets: [
          {
            title: '하루의 숨겨진 정보',
            summary: '하루만 알고 리아에게는 숨겨진 정보',
            rawText: '하루만 알고 리아에게는 숨겨진 정보',
            holderEntityIds: ['하루'],
            visibleToEntityIds: ['하루'],
            deniedToEntityIds: ['리아'],
            secrecyLevel: 'secret',
            revealState: 'hidden',
            importance: 0.95
          }
        ]
      },
      context: { recentEntities: ['리아'], recentQuery: '리아가 말했다', updatedAt: now() }
    };
    rebuildIndex(fixtureStore);
    const fastHydrated = hydratedRetrieval('entity', 'character', {
      name: '테스트',
      _locator: { chatRecency: 0.7, distanceFromLatest: 2 },
      _retrieval: {
        axis: 'entity',
        category: 'character',
        tokens: ['테스트'],
        subjectTokens: ['테스트'],
        emotionProfile: {},
        worldProfile: {},
        storyProfile: {},
        timeProfile: {},
        importance: 0.5
      }
    });
    check('hydrated_retrieval_reuses_complete_previous', fastHydrated.tokens?.[0] === '테스트' && fastHydrated.chatRecency === 0.7 && fastHydrated.distanceFromLatest === 2);
    const evidenceHydrated = hydratedRetrieval('entity', 'character', {
      name: '증거',
      summary: '증거 인물',
      _locator: { sourceEvidence: { lines: ['증거 인물이 약속을 지켰다'], confidence: 0.8 } },
      _retrieval: {
        axis: 'entity',
        category: 'character',
        tokens: ['증거'],
        subjectTokens: ['증거'],
        emotionProfile: {},
        worldProfile: {},
        storyProfile: {},
        timeProfile: {},
        importance: 0.5
      }
    });
    check('hydrated_retrieval_fastpath_adds_fallback_evidence_tokens', evidenceHydrated.sourceEvidenceTokens?.length > 0 && evidenceHydrated.tokens.some(token => normalizeKey(token).includes(normalizeKey('약속'))));
    clearNgramCache();
    const cachedGrams = charNgramTokensCached('하루테스트', 40);
    check('char_ngram_cache_matches_uncached', JSON.stringify(cachedGrams) === JSON.stringify(charNgramTokens('하루테스트', 40)) && charNgramTokensCached('하루테스트', 40) === cachedGrams);
    Memory.packetScanCache = new Map();
    const sameEdgePacket = (name, state) => `<!-- ${PACKET_START} ${JSON.stringify({
      meta: { schema: 'hayaku_packet_v1', packet_type: 'current_snapshot', packet_schema_rev: 2 },
      entity: { characters: [{ name, current_state: state, importance: 0.9 }] },
      importance: { overall: 0.9, reason: ['packet scan cache isolation fixture'] }
    })} ${PACKET_END} -->`;
    const sameEdgePrefix = 'P'.repeat(320);
    const sameEdgeSuffix = 'S'.repeat(320);
    const sameEdgeA = sameEdgePacket('동일A', 'golden_same_edge_cache_A_state');
    const sameEdgeB = sameEdgePacket('동일B', 'golden_same_edge_cache_B_state');
    const sameEdgeScope = requestScopeForMessages([{ role: 'assistant', chatId: 'same-edge-cache-scope', content: sameEdgePrefix + sameEdgeA + sameEdgeSuffix }]);
    const sameEdgePacketsA = extractPackets([{ role: 'assistant', chatId: 'same-edge-cache-scope', id: 'same-message-id', content: sameEdgePrefix + sameEdgeA + sameEdgeSuffix }], sameEdgeScope);
    const sameEdgePacketsB = extractPackets([{ role: 'assistant', chatId: 'same-edge-cache-scope', id: 'same-message-id', content: sameEdgePrefix + sameEdgeB + sameEdgeSuffix }], sameEdgeScope);
    const sameEdgeRawB = materializeExtractedPacket(sameEdgePacketsB[0] || {}).raw || '';
    check('packet_scan_cache_full_body_hash_isolates_same_edge_payloads',
      sameEdgeA.length === sameEdgeB.length
      && ensureArray(sameEdgePacketsA).length === 1
      && ensureArray(sameEdgePacketsB).length === 1
      && Memory.packetScanStats?.cacheEnabled === true
      && Memory.packetScanStats?.cacheHits === 0
      && sameEdgeRawB.includes('golden_same_edge_cache_B_state')
      && !sameEdgeRawB.includes('golden_same_edge_cache_A_state'));
    const sameEdgeRepeatPackets = extractPackets([{ role: 'assistant', chatId: 'same-edge-cache-scope', id: 'same-message-id', content: sameEdgePrefix + sameEdgeB + sameEdgeSuffix }], sameEdgeScope);
    check('packet_scan_cache_hits_only_with_same_scope_and_body',
      ensureArray(sameEdgeRepeatPackets).length === 1
      && Memory.packetScanStats?.cacheEnabled === true
      && Memory.packetScanStats?.cacheHits === 1
      && materializeExtractedPacket(sameEdgeRepeatPackets[0] || {}).raw.includes('golden_same_edge_cache_B_state'));
    const noScopePackets = extractPackets([{ role: 'assistant', id: 'same-message-id', content: sameEdgePrefix + sameEdgeA + sameEdgeSuffix }]);
    check('packet_scan_cache_disabled_without_stable_chat_scope',
      ensureArray(noScopePackets).length === 1
      && Memory.packetScanStats?.cacheEnabled === false
      && Memory.packetScanStats?.cacheSize === 0);
    const precomputedConcepts = conceptTokensForText('신뢰가 흔들리는 관계');
    check('semantic_frames_accept_precomputed_concepts', JSON.stringify(semanticFrameTokensForText('신뢰가 흔들리는 관계', precomputedConcepts)) === JSON.stringify(semanticFrameTokensForText('신뢰가 흔들리는 관계')));
    const memoryClass = RequestKindCore.classify('memory', [{ role: 'user', content: 'auxiliary memory request' }], '');
    const submodelNarrativeClass = RequestKindCore.classify('sub-model', [{ role: 'user', content: '<Current Input>\n세연이 잠깐 숨을 고른다.\n</Current Input>' }], '');
    const chatNarrativeClass = RequestKindCore.classify('chat', [{ role: 'user', content: '<Current Input>\n세연이 잠깐 숨을 고른다.\n</Current Input>' }], '');
    const mainNarrativeClass = RequestKindCore.classify('main', [{ role: 'user', content: '<Current Input>\n세연이 잠깐 숨을 고른다.\n</Current Input>' }], '');
    const lightboardClass = RequestKindCore.classify('model', [{ role: 'user', content: '<lb-process>\nlb-xnai\n{"scenes":[{"slot":"main"}]}\n</lb-process>' }], '');
    const imagePromptClass = RequestKindCore.classify('model', [{ role: 'user', content: 'Positive prompt: campus hallway\nNegative prompt: low quality\nsteps: 20\nseed: 1' }], '');
    const translationPromptClass = RequestKindCore.classify('model', [{ role: 'user', content: 'Translate the following text to Korean:\nHello.' }], '');
    const normalRoleplayClass = RequestKindCore.classify('model', [{ role: 'user', content: '<Current Input>\n푸딩은 그림 같은 풍경을 바라봤다.\n</Current Input>' }], '');
    const otherAxNarrativeClass = RequestKindCore.classify('otherAX', [{ role: 'user', content: '<Current Input>\n세연이 조용히 고개를 들었다.\n</Current Input>' }], '');
    const otherAxGigaTransClass = RequestKindCore.classify('otherAX', [{ role: 'user', content: 'Translate the <sample_text>\n<sample_text>Hello.</sample_text>\n<translator_notes>Keep names.</translator_notes>\nOutput only the translated text.' }], '');
    const submodelAmbientAfterGigaTransClass = RequestKindCore.classify('sub_model', [{ role: 'user', content: 'ambient helper follow-up' }], '');
    const previousIllustrationTagClass = RequestKindCore.classify('model', [
      { role: 'assistant', content: '<lb-xnai>campus hallway illustration</lb-xnai>' },
      { role: 'user', content: '<Current Input>\n그 뒤 세연은 다시 걸음을 옮겼다.\n</Current Input>' }
    ], '');
    const previousGigaTransClass = RequestKindCore.classify('model', [
      { role: 'assistant', content: '<GigaTrans><GT-CTRL />Translate the <sample_text><sample_text>Hello.</sample_text></GigaTrans>' },
      { role: 'user', content: '<Current Input>\n그 뒤 세연은 다시 걸음을 옮겼다.\n</Current Input>' }
    ], '');
    const previousStructuredImagePromptClass = RequestKindCore.classify('model', [
      { role: 'assistant', content: 'Positive prompt: campus hallway\nNegative prompt: low quality\nsteps: 20\nseed: 1' },
      { role: 'user', content: '<Current Input>\n그 뒤 세연은 다시 걸음을 옮겼다.\n</Current Input>' }
    ], '');
    const previousStructuredTranslationPromptClass = RequestKindCore.classify('model', [
      { role: 'assistant', content: 'Translate the following text to Korean:\nHello.' },
      { role: 'user', content: '<Current Input>\n그 뒤 세연은 다시 걸음을 옮겼다.\n</Current Input>' }
    ], '');
    const lightboardGenerationClass = RequestKindCore.classify('model', [{ role: 'user', content: 'lb-xnai-gen/scene-001\n{"scenes":[{"slot":"main"}]}' }], '');
    const lightboardStructuredClass = RequestKindCore.classify('model', [{ role: 'user', content: 'Must start with <lb-npclist>\nEvery character must have all 7 base fields.\nFill every field completely.\n</lb-npclist>' }], '');
    check('auxiliary_request_type_skips_even_with_force_main', memoryClass.auxiliary === true && /requestType:memory/.test(memoryClass.reason));
    check('submodel_request_type_skips_even_with_current_input', submodelNarrativeClass.auxiliary === true && /requestType:sub-model/.test(submodelNarrativeClass.reason));
    check('chat_request_type_skips_even_with_current_input', chatNarrativeClass.auxiliary === true && /requestType:chat/.test(chatNarrativeClass.reason));
    check('main_request_type_skips_even_with_current_input', mainNarrativeClass.auxiliary === true && /requestType:main/.test(mainNarrativeClass.reason));
    check('model_lightboard_lb_xnai_prompt_is_allowed', lightboardClass.auxiliary === false && lightboardClass.main === true);
    check('model_structured_image_prompt_is_allowed', imagePromptClass.auxiliary === false && imagePromptClass.main === true);
    check('model_structured_translation_prompt_is_allowed', translationPromptClass.auxiliary === false && translationPromptClass.main === true);
    check('normal_roleplay_image_word_does_not_skip', normalRoleplayClass.auxiliary === false && normalRoleplayClass.main === true);
    check('otherax_request_type_skips_even_with_current_input', otherAxNarrativeClass.auxiliary === true && /requestType:otherax/.test(otherAxNarrativeClass.reason));
    check('otherax_gigatrans_helper_hard_skips', otherAxGigaTransClass.auxiliary === true && otherAxGigaTransClass.hardAuxiliary === true);
    check('submodel_recent_gigatrans_ambient_request_skips', submodelAmbientAfterGigaTransClass.auxiliary === true && /requestType:sub_model/.test(submodelAmbientAfterGigaTransClass.reason));
    const auxiliaryStripPacket = `visible text\n<!-- ${PACKET_START} {"meta":{"schema":"hayaku_packet_v1"},"importance":{"overall":0.1}} ${PACKET_END} -->`;
    const auxiliaryStripTypes = ['submodel', 'memory', 'emotion', 'otherAx', 'translate'];
    check('auxiliary_request_types_strip_hayaku_packets', auxiliaryStripTypes.every(typeName => {
      const requestClass = RequestKindCore.classify(typeName, [{ role: 'assistant', content: auxiliaryStripPacket }], '');
      const clean = stripHayakuBlocks(auxiliaryStripPacket);
      return requestClass.auxiliary === true && !/HAYAKU_STATE_PACKET_START|HAYAKU_STATE_PACKET_END/.test(clean) && /visible text/.test(clean);
    }));
    const configuredAuxiliaryMainClass = RequestKindCore.classify('otherAX', [{ role: 'assistant', content: auxiliaryStripPacket }], '', { mainTypes: ['model', 'otherax'] });
    check('configured_main_types_cannot_promote_protected_auxiliary_requests', configuredAuxiliaryMainClass.auxiliary === true && /requestType:otherax/.test(configuredAuxiliaryMainClass.reason));
    const auxiliaryRawMarkerPacket = `visible text\n${PACKET_START} {"meta":{"schema":"hayaku_packet_v1"}} ${PACKET_END}`;
    const auxiliaryUnclosedCommentPacket = `visible text\n<!-- ${PACKET_START} {"meta":{"schema":"hayaku_packet_v1"}} ${PACKET_END}`;
    check('auxiliary_strip_cleans_raw_marker_packets',
      !/HAYAKU_STATE_PACKET_START|HAYAKU_STATE_PACKET_END/.test(stripHayakuBlocks(auxiliaryRawMarkerPacket, { looseMarkers: true }))
      && !/HAYAKU_STATE_PACKET_START|HAYAKU_STATE_PACKET_END/.test(stripHayakuBlocks(auxiliaryUnclosedCommentPacket, { looseMarkers: true })));
    check('default_strip_preserves_raw_marker_text',
      /HAYAKU_STATE_PACKET_START|HAYAKU_STATE_PACKET_END/.test(stripHayakuBlocks(auxiliaryRawMarkerPacket)));
    const rawMarkerUserPrompt = injectPrompt([{ role: 'user', content: `debug ${PACKET_START} hello ${PACKET_END}` }], '');
    const rawMarkerAssistantPrompt = injectPrompt([{ role: 'assistant', content: auxiliaryRawMarkerPacket }], '');
    check('main_prompt_preserves_user_raw_marker_text',
      /HAYAKU_STATE_PACKET_START hello HAYAKU_STATE_PACKET_END/.test(messageContent(rawMarkerUserPrompt[0] || {})));
    check('main_prompt_strips_assistant_loose_marker_packets',
      !/HAYAKU_STATE_PACKET_START|HAYAKU_STATE_PACKET_END/.test(messageContent(rawMarkerAssistantPrompt[0] || {}))
      && /visible text/.test(messageContent(rawMarkerAssistantPrompt[0] || {})));
    const recoveryVisibleText = '세연은 잠긴 기록실 문 앞에서 오래 숨을 고르고, 리아가 건넨 낡은 열쇠를 조심스럽게 쥐었다. 둘 사이의 신뢰는 아직 흔들리지만 약속은 유지된다.';
    const recoveryInput = { role: 'user', content: '<Current Input>\n그 다음 장면을 이어가.\n</Current Input>' };
    const missingRecovery = detectPacketRecovery([
      { role: 'assistant', content: recoveryVisibleText },
      recoveryInput
    ], [], DEFAULT_SETTINGS);
    check('packet_recovery_detects_latest_assistant_without_packet', missingRecovery?.active === true && missingRecovery.reason === 'latest_assistant_without_packet' && missingRecovery.excerpt.includes('기록실'));
    const recoveryVisibleText2 = '두 번째 누락 출력은 인물이 벽의 그림을 바라보며 움직이지 않고, 다음 압박을 기다리는 정지된 긴장을 남긴다.';
    const doubleMissingRecovery = detectPacketRecovery([
      { role: 'assistant', content: recoveryVisibleText },
      { role: 'assistant', content: recoveryVisibleText2 },
      recoveryInput
    ], [], DEFAULT_SETTINGS);
    check('packet_recovery_detects_consecutive_missing_assistant_outputs',
      doubleMissingRecovery?.active === true
      && doubleMissingRecovery.reason === 'assistant_chain_without_packet'
      && doubleMissingRecovery.missingMessageCount === 2
      && Array.isArray(doubleMissingRecovery.messageIndices)
      && doubleMissingRecovery.messageIndices.length === 2
      && doubleMissingRecovery.excerpt.includes('[Missing assistant output 1/2')
      && doubleMissingRecovery.excerpt.includes('[Missing assistant output 2/2')
      && doubleMissingRecovery.excerpt.includes('정지된 긴장'));
    const cappedMissingRecovery = detectPacketRecovery([
      { role: 'assistant', content: 'omitted_chain_anchor_zero: 아주 오래된 누락 출력은 복구 상한 밖으로 밀려야 한다. 이 문장은 테스트용으로 충분히 길다.' },
      { role: 'assistant', content: 'kept_chain_anchor_one: 첫 번째 유지 누락 출력은 문 앞의 대기 상태와 보류된 약속을 남긴다.' },
      { role: 'assistant', content: 'kept_chain_anchor_two: 두 번째 유지 누락 출력은 복도 끝 시선과 움직이지 않는 긴장을 남긴다.' },
      { role: 'assistant', content: 'kept_chain_anchor_three: 세 번째 유지 누락 출력은 다음 압박 직전의 마지막 정지 상태를 남긴다.' },
      recoveryInput
    ], [], DEFAULT_SETTINGS);
    check('packet_recovery_caps_long_missing_chain_to_recent_outputs',
      cappedMissingRecovery?.active === true
      && cappedMissingRecovery.missingMessageCount === PACKET_RECOVERY_MAX_CHAIN_MESSAGES
      && cappedMissingRecovery.totalMissingMessageCount === 4
      && cappedMissingRecovery.omittedMissingMessageCount === 1
      && cappedMissingRecovery.firstMissingMessageIndex === 1
      && cappedMissingRecovery.excerpt.includes('kept_chain_anchor_one')
      && cappedMissingRecovery.excerpt.includes('kept_chain_anchor_three')
      && !cappedMissingRecovery.excerpt.includes('omitted_chain_anchor_zero'));
    const packetOnlyAfterVisibleMessages = [
      { role: 'assistant', content: recoveryVisibleText },
      { role: 'assistant', content: `<!-- ${PACKET_START} {"meta":{"schema":"hayaku_packet_v1"},"importance":{"overall":0.2}} ${PACKET_END} -->` },
      recoveryInput
    ];
    check('packet_recovery_respects_separate_packet_message',
      detectPacketRecovery(packetOnlyAfterVisibleMessages, extractPackets(packetOnlyAfterVisibleMessages), DEFAULT_SETTINGS) === null);
    const invalidCurrentPacketMessages = [
      {
        role: 'assistant',
        content: `${recoveryVisibleText}\n<!-- ${PACKET_START} {"meta":{"schema":"hayaku_packet_v1","packet_type":"current_snapshot"},"entity":{"characters":[]},"world":{"location":"기록실"}},"narrative":{"scene_phase":"전환"},"planner":{"continuity_locks":[]},"importance":{"overall":0.5,"reason":["malformed"]} ${PACKET_END} -->`
      },
      recoveryInput
    ];
    const invalidCurrentPacketRecovery = detectPacketRecovery(invalidCurrentPacketMessages, extractPackets(invalidCurrentPacketMessages), DEFAULT_SETTINGS);
    check('packet_recovery_detects_latest_assistant_with_invalid_current_packet',
      invalidCurrentPacketRecovery?.active === true
      && invalidCurrentPacketRecovery.reason === 'latest_assistant_invalid_packet'
      && invalidCurrentPacketRecovery.recoveryIssue === 'unreadable_current_packet'
      && invalidCurrentPacketRecovery.invalidPacketCount === 1
      && invalidCurrentPacketRecovery.excerpt.includes('기록실'));
    const recoveryOnlyValidCurrentInvalidMessages = [
      {
        role: 'assistant',
        content: `${recoveryVisibleText}\n<!-- ${PACKET_START} ${TAIL_RECOVERY_PACKET_EXAMPLE} ${PACKET_END} -->\n<!-- ${PACKET_START} {"meta":{"schema":"hayaku_packet_v1","packet_type":"current_snapshot"},"entity":{"characters":[]},"world":{"location":"기록실"}},"narrative":{"scene_phase":"전환"},"planner":{"continuity_locks":[]},"importance":{"overall":0.5,"reason":["malformed"]} ${PACKET_END} -->`
      },
      recoveryInput
    ];
    const recoveryOnlyValidCurrentInvalid = detectPacketRecovery(recoveryOnlyValidCurrentInvalidMessages, extractPackets(recoveryOnlyValidCurrentInvalidMessages), DEFAULT_SETTINGS);
    check('packet_recovery_detects_valid_recovery_but_invalid_current_packet',
      recoveryOnlyValidCurrentInvalid?.active === true
      && recoveryOnlyValidCurrentInvalid.reason === 'latest_assistant_invalid_packet'
      && recoveryOnlyValidCurrentInvalid.recoveryIssue === 'unreadable_current_packet');
    const recoveryContextBlock = buildCompressedContinuityContext(
      { entity: [], world: [], narrative: [], planner: [] },
      { ...DEFAULT_SETTINGS, packetRecoveryRequest: missingRecovery },
      '그 다음 장면을 이어가.'
    );
    const invalidRecoveryContextBlock = buildCompressedContinuityContext(
      { entity: [], world: [], narrative: [], planner: [] },
      { ...DEFAULT_SETTINGS, packetRecoveryRequest: invalidCurrentPacketRecovery },
      '그 다음 장면을 이어가.'
    );
    const doubleRecoveryContextBlock = buildCompressedContinuityContext(
      { entity: [], world: [], narrative: [], planner: [] },
      { ...DEFAULT_SETTINGS, packetRecoveryRequest: doubleMissingRecovery },
      '그 다음 장면을 이어가.'
    );
    const forgedRecovery = {
      active: true,
      reason: 'manual_recovery_flag',
      messageIndex: 0,
      boundaryIndex: 1,
      excerpt: recoveryVisibleText
    };
    const forgedRecoveryContextBlock = buildCompressedContinuityContext(
      { entity: [], world: [], narrative: [], planner: [] },
      { ...DEFAULT_SETTINGS, packetRecoveryRequest: forgedRecovery },
      '그 다음 장면을 이어가.'
    );
    check('packet_recovery_context_has_internal_leak_guard',
      recoveryContextBlock.includes('[HAYAKU PACKET RECOVERY CARE]')
      && recoveryContextBlock.includes('Do not let Haya')
      && recoveryContextBlock.includes('recovery_snapshot')
      && recoveryContextBlock.includes('current_snapshot')
      && recoveryContextBlock.includes('exactly two compact HTML-comment HAYAKU_STATE_PACKET blocks'));
    check('packet_recovery_context_keeps_recovery_and_current_separate',
      recoveryContextBlock.includes('Packet 1 is recovery_snapshot for the missing previous assistant output only')
      && recoveryContextBlock.includes('Packet 2 is current_snapshot for the final state after the current visible response')
      && recoveryContextBlock.includes('Do not merge recovery_snapshot and current_snapshot into one packet')
      && recoveryContextBlock.includes('final 1-2 beats')
      && recoveryContextBlock.includes('environmental gaze/sensory anchors')
      && recoveryContextBlock.includes('required clean hidden HAYAKU_STATE_PACKETs')
      && !recoveryContextBlock.includes('leave one clean hidden HAYAKU_STATE_PACKET'));
    check('packet_recovery_context_preserves_missing_output_chain',
      doubleRecoveryContextBlock.includes('all 2 missing assistant outputs in chronological order')
      && doubleRecoveryContextBlock.includes('[Missing assistant output 1/2')
      && doubleRecoveryContextBlock.includes('[Missing assistant output 2/2'));
    check('packet_recovery_context_handles_unreadable_previous_packet',
      invalidRecoveryContextBlock.includes('previous hidden note was unreadable')
      && invalidRecoveryContextBlock.includes('whose hidden HAYAKU packet was unreadable')
      && invalidRecoveryContextBlock.includes('recovery_snapshot')
      && invalidRecoveryContextBlock.includes('current_snapshot'));
    check('packet_recovery_requires_actual_missing_packet_detection',
      missingRecovery?.source === 'detected_missing_packet'
      && !forgedRecoveryContextBlock.includes('[HAYAKU PACKET RECOVERY CARE]')
      && !buildSideWriteTailReminder({ ...DEFAULT_SETTINGS, packetRecoveryRequest: forgedRecovery }).includes('exactly two raw HTML-comment HAYAKU_STATE_PACKET blocks'));
    const normalTailReminder = buildSideWriteTailReminder(DEFAULT_SETTINGS);
    const recoveryTailReminder = buildSideWriteTailReminder({ ...DEFAULT_SETTINGS, packetRecoveryRequest: missingRecovery });
    const doubleRecoveryTailReminder = buildSideWriteTailReminder({ ...DEFAULT_SETTINGS, packetRecoveryRequest: doubleMissingRecovery });
    const correctiveTailReminder = buildSideWriteTailReminder({
      ...DEFAULT_SETTINGS,
      packetHealth: {
        parseFailedRecently: true,
        invalidJsonRecently: true,
        requiredKeysMissingRecently: true
      }
    });
    check('normal_tail_requires_one_current_packet',
      normalTailReminder.includes('exactly one raw HTML-comment HAYAKU_STATE_PACKET')
      && normalTailReminder.includes('"packet_type":"current_snapshot"')
      && normalTailReminder.includes('[REQUIRED]')
      && normalTailReminder.includes('[HAYAKU PACKET COMPLETION GATE]')
      && normalTailReminder.includes('Write the packet every eligible model response')
      && normalTailReminder.includes('minimal current_snapshot packet with low confidence instead of omitting HAYAKU')
      && normalTailReminder.includes('Temporal state')
      && normalTailReminder.includes('event time, evidence/observation time, character knowledge time')
      && normalTailReminder.includes('Keep meta.scene_id stable')
      && normalTailReminder.includes('current_snapshot meta.pattern_guard')
      && normalTailReminder.includes('expires_after_turns 1-2')
      && normalTailReminder.includes('resolved_reason')
      && normalTailReminder.includes('If the visible response is already done but the packet appendix is missing')
      && !normalTailReminder.includes('exactly two raw HTML-comment HAYAKU_STATE_PACKET blocks')
      && !normalTailReminder.includes('...'));
    check('packet_recovery_tail_requires_two_ordered_packets',
      recoveryTailReminder.includes('exactly two raw HTML-comment HAYAKU_STATE_PACKET blocks')
      && recoveryTailReminder.indexOf('recovery_snapshot') >= 0
      && recoveryTailReminder.indexOf('current_snapshot') > recoveryTailReminder.indexOf('recovery_snapshot')
      && recoveryTailReminder.includes('Do not merge packets')
      && recoveryTailReminder.includes('Never omit current_snapshot')
      && recoveryTailReminder.includes('missing sequence final beat')
      && recoveryTailReminder.includes('environmental gaze/sensory anchor')
      && recoveryTailReminder.includes('Do not stop after the visible response')
      && recoveryTailReminder.includes('[HAYAKU PACKET COMPLETION GATE]')
      && recoveryTailReminder.includes('current_snapshot is still mandatory and must be second')
      && recoveryTailReminder.includes('second/current_snapshot')
      && recoveryTailReminder.includes('Temporal state')
      && recoveryTailReminder.includes('world.active_events as status active/time_scope current')
      && recoveryTailReminder.includes('Keep meta.scene_id stable')
      && recoveryTailReminder.includes('current_snapshot meta.pattern_guard')
      && recoveryTailReminder.includes('expires_after_turns 1-2')
      && recoveryTailReminder.includes('resolved_reason')
      && !recoveryTailReminder.includes('...'));
    check('packet_recovery_tail_mentions_consecutive_missing_count',
      doubleRecoveryTailReminder.includes('all 2 missing previous assistant outputs in chronological order')
      && doubleRecoveryTailReminder.includes('Do not stop after the visible response'));
    check('packet_tail_adds_failure_specific_corrections',
      correctiveTailReminder.includes('Last packet parse failed')
      && correctiveTailReminder.includes('Last packet missed required keys')
      && correctiveTailReminder.includes('Do not close the top-level } until after importance')
      && correctiveTailReminder.includes('Silently check brace balance')
      && correctiveTailReminder.includes('no ellipses'));
    const repeatGuardMessages = [
      {
        role: 'assistant',
        content: '리아는 창가에서 긴 숨을 고르며 손끝으로 컵의 가장자리를 한 번 쓸었다. "괜찮아." 그녀는 고개를 살짝 기울이며 조용히 그를 바라보았다. 복도 너머의 빛은 아직 움직이지 않았다.'
      },
      {
        role: 'assistant',
        content: '하루는 대답 대신 문가에 멈춰 섰고, 방 안의 공기는 조금 더 낮게 가라앉았다. "괜찮아." 그녀는 고개를 살짝 기울이며 조용히 그를 바라보았다. 이번에는 침묵이 더 길었다.'
      },
      { role: 'user', content: '<Current Input>\n계속 이어가.\n</Current Input>' }
    ];
    const runtimeRepeatGuards = buildVisibleRepeatGuards(repeatGuardMessages);
    const runtimeRepeatContext = buildCompressedContinuityContext(
      { entity: [], world: [], narrative: [], planner: [], metaGuards: runtimeRepeatGuards },
      DEFAULT_SETTINGS,
      '계속 이어가.'
    );
    check('visible_repeat_guard_detects_repeated_dialogue_and_sentence',
      runtimeRepeatGuards.some(row => row?._metaGuard?.kind === 'dialogue' && row?._metaGuard?.sampleCount > 0)
      && runtimeRepeatGuards.some(row => row?._metaGuard?.kind === 'sentence' && row?._metaGuard?.sampleCount > 0));
    check('visible_repeat_guard_does_not_expose_samples_as_packet_evidence',
      runtimeRepeatGuards.every(row => row?.lifecycle?.evidence === PATTERN_GUARD_NEUTRAL_EVIDENCE)
      && runtimeRepeatGuards.every(row => row?.publicText?.includes(`evidence "${PATTERN_GUARD_NEUTRAL_EVIDENCE}"`))
      && !runtimeRepeatContext.includes('괜찮아')
      && !runtimeRepeatContext.includes('고개를 살짝 기울이며'));
    check('visible_repeat_guard_has_short_lifecycle',
      runtimeRepeatGuards.every(row => row?.lifecycle?.expiresAfterTurns === PATTERN_GUARD_DEFAULT_EXPIRES_AFTER_TURNS)
      && runtimeRepeatGuards.every(row => row?.lifecycle?.resolveWhen === PATTERN_GUARD_DEFAULT_RESOLVE_WHEN)
      && runtimeRepeatGuards.every(row => row?.publicText?.includes('short-lived correction guard')));
    check('visible_repeat_guard_context_injects_runtime_meta_guard',
      runtimeRepeatContext.includes('[META GUARDS]')
      && runtimeRepeatContext.includes('Avoid reusing recent direct dialogue')
      && runtimeRepeatContext.includes('current_snapshot meta.pattern_guard')
      && runtimeRepeatContext.includes('expires_after_turns')
      && runtimeRepeatContext.includes('resolved_reason')
      && runtimeRepeatContext.includes('recent assistant dialogue or narration sentences verbatim'));
    const patternGuardExpiryStore = {};
    ingestPacketLedgerRev2Meta(patternGuardExpiryStore, {
      meta: {
        pattern_guard: [
          { summary: 'avoid_reusing_recent_direct_dialogue', status: 'active', evidence: 'Recent repeated samples: "괜찮아"' }
        ]
      },
      importance: { overall: 0.5, reason: ['pattern guard expiry'] }
    }, 7, 'pattern_guard_expiry_hash', {}, {});
    const ingestedPatternGuard = ensureArray(patternGuardExpiryStore?.planner?.items).find(row => row?.category === 'pattern_guard');
    check('pattern_guard_ingest_defaults_short_expiry',
      ingestedPatternGuard?.expires_after_turns === PATTERN_GUARD_DEFAULT_EXPIRES_AFTER_TURNS
      && ingestedPatternGuard?.resolve_when === PATTERN_GUARD_DEFAULT_RESOLVE_WHEN
      && ensureArray(ingestedPatternGuard?.evidence).includes(PATTERN_GUARD_NEUTRAL_EVIDENCE)
      && !ensureArray(ingestedPatternGuard?.evidence).join(' ').includes('괜찮아'));
    const hayaContextBlock = buildCompressedContinuityContext(
      { entity: [], world: [], narrative: [], planner: [] },
      DEFAULT_SETTINGS,
      '계속'
    );
    const hayaDisabledContextBlock = buildCompressedContinuityContext(
      { entity: [], world: [], narrative: [], planner: [] },
      { ...DEFAULT_SETTINGS, hayaLoveFrame: false, hayaPrefill: false },
      '계속'
    );
    check('haya_love_frame_defaults_on',
      DEFAULT_SETTINGS.hayaLoveFrame === true
      && DEFAULT_SETTINGS.hayaPrefill === true
      && hayaContextBlock.includes('[HAYAKU HAYA FRAME]')
      && hayaContextBlock.includes('Welcome, Haya')
      && hayaContextBlock.includes('Private continuation cue')
      && hayaContextBlock.includes('I do not stop at the visible ending')
      && hayaContextBlock.includes('[HAYAKU PACKET COMPLETION GATE]')
      && hayaContextBlock.includes('Do not echo Haya'));
    check('haya_love_frame_can_disable',
      !hayaDisabledContextBlock.includes('[HAYAKU HAYA FRAME]')
      && !hayaDisabledContextBlock.includes('Welcome, Haya'));
    check('haya_frame_stays_out_of_tail_reminder',
      !buildSideWriteTailReminder(DEFAULT_SETTINGS).includes('Private Haya frame reminder')
      && !buildSideWriteTailReminder(DEFAULT_SETTINGS).includes('Haya/loved/prefill'));
    const structuredAssistantPrompt = injectPrompt([{ role: 'assistant', data: { content: [{ type: 'text', text: auxiliaryRawMarkerPacket }], keep: 'meta' } }], '');
    check('main_prompt_preserves_structured_assistant_data_payloads',
      Array.isArray(structuredAssistantPrompt[0]?.data?.content)
      && structuredAssistantPrompt[0].data.keep === 'meta'
      && !/HAYAKU_STATE_PACKET_START|HAYAKU_STATE_PACKET_END/.test(JSON.stringify(structuredAssistantPrompt[0].data)));
    const structuredPacketOnlyPrompt = injectPrompt([{ role: 'assistant', data: { content: [{ type: 'text', text: `<!-- ${PACKET_START} {"meta":{"schema":"hayaku_packet_v1"}} ${PACKET_END} -->` }], keep: 'meta' } }], '');
    check('main_prompt_drops_structured_packet_only_messages', structuredPacketOnlyPrompt.length === 0);
    const structuredPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'text', text: auxiliaryStripPacket }] } }]);
    const spacedRolePacketExtraction = extractPackets([{ role: ' assistant ', content: auxiliaryStripPacket }]);
    const blankRoleAssistantFlagPacketExtraction = extractPackets([{ role: ' ', is_user: false, content: auxiliaryStripPacket }]);
    const blankRoleUserFlagPacketExtraction = extractPackets([{ role: ' ', is_user: true, content: auxiliaryStripPacket }]);
    const structuredOutputPacketExtraction = extractPackets([{ role: 'assistant', data: { output: [{ type: 'message', content: [{ type: 'output_text', text: auxiliaryStripPacket }] }] } }]);
    const structuredOutputTextItemPacketExtraction = extractPackets([{ role: 'assistant', data: { output: [{ type: 'output_text', text: auxiliaryStripPacket }] } }]);
    const structuredOutputToolPacketExtraction = extractPackets([{ role: 'assistant', data: { output: [{ type: 'tool_result', content: [{ type: 'text', text: auxiliaryStripPacket }] }] } }]);
    const structuredOutputFunctionPacketExtraction = extractPackets([{ role: 'assistant', data: { output: [{ type: 'function_call_output', content: auxiliaryStripPacket }] } }]);
    const structuredContentRecallPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'recall', text: auxiliaryStripPacket }] } }]);
    const structuredContentRecallTextPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ kind: 'recall_text', text: auxiliaryStripPacket }] } }]);
    const structuredContentRecallCamelPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'recallText', text: auxiliaryStripPacket }] } }]);
    const structuredContentRecallResultPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'recall_result', text: auxiliaryStripPacket }] } }]);
    const structuredContentRecallOutputPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'recall_output', text: auxiliaryStripPacket }] } }]);
    const structuredContentRecallSearchResultPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'recall_search_result', text: auxiliaryStripPacket }] } }]);
    const structuredContentRecallSearchHitPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'recallSearchHit', text: auxiliaryStripPacket }] } }]);
    const structuredContentRecallSearchHitItemPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'recallSearchHitItem', text: auxiliaryStripPacket }] } }]);
    const structuredContentRecallSearchEntryPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'recallSearchEntry', text: auxiliaryStripPacket }] } }]);
    const structuredContentRecallSearchPayloadPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'recallSearchPayload', text: auxiliaryStripPacket }] } }]);
    const structuredContentResearchHitPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'researchHit', text: auxiliaryStripPacket }] } }]);
    const structuredContentResearchHitItemPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'researchHitItem', text: auxiliaryStripPacket }] } }]);
    const structuredContentResearchEntryPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'researchEntry', text: auxiliaryStripPacket }] } }]);
    const structuredContentResearchPayloadPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'researchPayload', text: auxiliaryStripPacket }] } }]);
    const structuredContentWebNovelOutputPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'webNovelOutput', text: auxiliaryStripPacket }] } }]);
    const structuredContentCodeReviewOutputPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'code_review_output', text: auxiliaryStripPacket }] } }]);
    const structuredContentTextRecallKindPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'text', kind: 'recall', text: auxiliaryStripPacket }] } }]);
    const structuredContentRecallNamePacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ name: 'recall', text: auxiliaryStripPacket }] } }]);
    const structuredContentRecallSourceSearchPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'recall', source: 'search_result', text: auxiliaryStripPacket }] } }]);
    const structuredContentTextSourceRefPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'text', source: 'chapter_1', text: auxiliaryStripPacket }] } }]);
    const structuredContentTextSourceWebSearchPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'text', source: 'web_search_result', text: auxiliaryStripPacket }] } }]);
    const structuredContentTextSourceWebSearchPayloadPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'text', source: 'webSearchPayload', text: auxiliaryStripPacket }] } }]);
    const structuredContentTextSourceTypeFileSearchPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'text', source_type: 'file_search_content', text: auxiliaryStripPacket }] } }]);
    const structuredContentTextSourceTypeBrowserPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'text', sourceType: 'browserPayload', text: auxiliaryStripPacket }] } }]);
    const structuredContentTextSubtypeMcpPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'text', subtype: 'mcpContent', text: auxiliaryStripPacket }] } }]);
    const structuredContentTextChannelToolPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'text', channel: 'tool_result', text: auxiliaryStripPacket }] } }]);
    const structuredContentTextChannelWebSearchPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'text', channel: 'web_search', text: auxiliaryStripPacket }] } }]);
    const structuredContentTextToolNameBrowserPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'text', tool_name: 'browser', text: auxiliaryStripPacket }] } }]);
    const structuredContentTextProviderCodeInterpreterPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'text', provider: 'code_interpreter', text: auxiliaryStripPacket }] } }]);
    const structuredContentTextMetadataSearchResultPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'text', metadata: { type: 'search_result' }, text: auxiliaryStripPacket }] } }]);
    const structuredContentTextSourceNameWebSearchPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'text', sourceName: 'web_search', text: auxiliaryStripPacket }] } }]);
    const structuredContentTextOriginBrowserPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'text', origin: 'browser', text: auxiliaryStripPacket }] } }]);
    const structuredContentTextOriginTypeMcpPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'text', origin_type: 'mcp_result', text: auxiliaryStripPacket }] } }]);
    const structuredContentTextOriginTypeFileSearchPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'text', originType: 'fileSearchPayload', text: auxiliaryStripPacket }] } }]);
    const structuredContentTextResponseTypeToolPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'text', response_type: 'tool_result', text: auxiliaryStripPacket }] } }]);
    const structuredContentTextResponseTypeWebpagePacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'text', responseType: 'webpageContent', text: auxiliaryStripPacket }] } }]);
    const structuredContentTextEventToolPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'text', event: 'tool_call', text: auxiliaryStripPacket }] } }]);
    const structuredContentTextEventTypeWebSearchPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'text', eventType: 'web_search', text: auxiliaryStripPacket }] } }]);
    const structuredContentTextLabelSearchResultPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'text', label: 'search_result', text: auxiliaryStripPacket }] } }]);
    const structuredContentTextMetadataSourceNameWebSearchPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'text', metadata: { sourceName: 'web_search' }, text: auxiliaryStripPacket }] } }]);
    const structuredContentTextMetadataOriginBrowserPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'text', metadata: { origin: 'browser' }, text: auxiliaryStripPacket }] } }]);
    const structuredContentTextMetadataResponseTypeToolPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'text', metadata: { responseType: 'tool_result' }, text: auxiliaryStripPacket }] } }]);
    const structuredContentRecallOriginBrowserPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'recall', origin: 'browser', text: auxiliaryStripPacket }] } }]);
    const structuredContentTextOriginScenePacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'text', origin: 'scene_1', text: auxiliaryStripPacket }] } }]);
    const structuredContentTextToolCallIdPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'text', tool_call_id: 'call_1', text: auxiliaryStripPacket }] } }]);
    const structuredContentTextToolCallCamelIdPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'text', toolCallId: 'call_1', text: auxiliaryStripPacket }] } }]);
    const structuredContentTextCallIdPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'text', call_id: 'call_1', text: auxiliaryStripPacket }] } }]);
    const structuredContentTextCallCamelIdPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'text', callId: 'call_1', text: auxiliaryStripPacket }] } }]);
    const structuredContentTextFunctionCallIdPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'text', function_call_id: 'fc_1', text: auxiliaryStripPacket }] } }]);
    const structuredContentTextToolUseIdPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'text', tool_use_id: 'tu_1', text: auxiliaryStripPacket }] } }]);
    const structuredContentTextToolUseCamelIdPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'text', toolUseId: 'tu_1', text: auxiliaryStripPacket }] } }]);
    const structuredContentTextInvocationIdPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'text', invocation_id: 'inv_1', text: auxiliaryStripPacket }] } }]);
    const structuredContentTextRecipientBrowserPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'text', recipient: 'browser', text: auxiliaryStripPacket }] } }]);
    const structuredContentTextTargetWebSearchPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'text', target: 'web_search', text: auxiliaryStripPacket }] } }]);
    const structuredContentTextMetadataToolCallIdPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'text', metadata: { tool_call_id: 'call_1' }, text: auxiliaryStripPacket }] } }]);
    const structuredContentTextMetadataTargetBrowserPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'text', metadata: { target: 'browser' }, text: auxiliaryStripPacket }] } }]);
    const structuredContentRecallToolCallIdPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'recall', tool_call_id: 'call_1', text: auxiliaryStripPacket }] } }]);
    const structuredContentTextSourceObjectTypePacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'text', source: { type: 'web_search_result' }, text: auxiliaryStripPacket }] } }]);
    const structuredContentTextSourceObjectNamePacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'text', source: { name: 'browser' }, text: auxiliaryStripPacket }] } }]);
    const structuredContentTextToolObjectNamePacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'text', tool: { name: 'browser' }, text: auxiliaryStripPacket }] } }]);
    const structuredContentTextToolObjectTypePacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'text', tool: { type: 'web_search' }, text: auxiliaryStripPacket }] } }]);
    const structuredContentTextProviderObjectKindPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'text', provider: { kind: 'code_interpreter' }, text: auxiliaryStripPacket }] } }]);
    const structuredContentTextMetadataSourceObjectPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'text', metadata: { source: { type: 'search_result' } }, text: auxiliaryStripPacket }] } }]);
    const structuredContentTextMetadataToolObjectPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'text', metadata: { tool: { name: 'browser' } }, text: auxiliaryStripPacket }] } }]);
    const structuredContentTextMetadataProviderObjectPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'text', metadata: { provider: { type: 'mcp_result' } }, text: auxiliaryStripPacket }] } }]);
    const structuredContentRecallSourceObjectPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'recall', source: { type: 'web_search_result' }, text: auxiliaryStripPacket }] } }]);
    const structuredContentTextSourceObjectRefPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'text', source: { name: 'chapter_1' }, text: auxiliaryStripPacket }] } }]);
    const structuredContentTextSourceMetadataTypePacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'text', source: { metadata: { type: 'web_search_result' } }, text: auxiliaryStripPacket }] } }]);
    const structuredContentTextToolMetadataNamePacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'text', tool: { metadata: { name: 'browser' } }, text: auxiliaryStripPacket }] } }]);
    const structuredContentTextMetadataSourceMetadataTypePacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'text', metadata: { source: { metadata: { type: 'search_result' } } }, text: auxiliaryStripPacket }] } }]);
    const structuredContentTextToolCallsPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'text', tool_calls: [{ id: 'call_1' }], text: auxiliaryStripPacket }] } }]);
    const structuredContentTextToolCallsCamelPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'text', toolCalls: [{ id: 'call_1' }], text: auxiliaryStripPacket }] } }]);
    const structuredContentTextFunctionCallPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'text', function_call: { name: 'x' }, text: auxiliaryStripPacket }] } }]);
    const structuredContentTextFunctionCallCamelPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'text', functionCall: { name: 'x' }, text: auxiliaryStripPacket }] } }]);
    const structuredContentTextFunctionCallsPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'text', function_calls: [{ id: 'fc_1' }], text: auxiliaryStripPacket }] } }]);
    const structuredContentRecallToolCallsPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'recall', tool_calls: [{ id: 'call_1' }], text: auxiliaryStripPacket }] } }]);
    const structuredContentTextToolsLabelPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'text', tools: ['hammer'], text: auxiliaryStripPacket }] } }]);
    const structuredContentOutputTextSourceSearchPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'outputText', source: 'web_search_result', text: auxiliaryStripPacket }] } }]);
    const structuredContentInputTextSourceSearchPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'inputText', source: 'web_search_result', text: auxiliaryStripPacket }] } }]);
    const structuredContentMessageContentSourceSearchPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'messageContent', source: 'web_search_result', text: auxiliaryStripPacket }] } }]);
    const structuredContentContentPartSourceSearchPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'contentPart', source: 'web_search_result', text: auxiliaryStripPacket }] } }]);
    const structuredContentTextSegmentSourceSearchPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'textSegment', source: 'web_search_result', text: auxiliaryStripPacket }] } }]);
    const structuredContentDeltaTextSourceSearchPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'deltaText', source: 'web_search_result', text: auxiliaryStripPacket }] } }]);
    const structuredContentRecallTextSourceSearchPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'recallText', source: 'web_search_result', text: auxiliaryStripPacket }] } }]);
    const structuredContentOutputTextSourceRefPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'outputText', source: 'chapter_1', text: auxiliaryStripPacket }] } }]);
    const structuredContentUrlCitationPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'urlCitation', source: 'web_search_result', text: auxiliaryStripPacket }] } }]);
    const structuredContentUrlCitationSnakePacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'url_citation', source: 'web_search_result', text: auxiliaryStripPacket }] } }]);
    const structuredContentFileCitationPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'fileCitation', source: 'file_search_result', text: auxiliaryStripPacket }] } }]);
    const structuredContentCitationPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'citation', source: 'search_result', text: auxiliaryStripPacket }] } }]);
    const structuredContentAnnotationPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'annotation', source: 'web_search_result', text: auxiliaryStripPacket }] } }]);
    const structuredContentUrlCitationNoSourcePacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'urlCitation', text: auxiliaryStripPacket }] } }]);
    const structuredContentRecallCitationPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'recallCitation', source: 'web_search_result', text: auxiliaryStripPacket }] } }]);
    const structuredContentSearchCitationPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'searchCitation', text: auxiliaryStripPacket }] } }]);
    const structuredContentFileSearchCitationPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'fileSearchCitation', text: auxiliaryStripPacket }] } }]);
    const structuredContentWebpageCitationPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'webpageCitation', text: auxiliaryStripPacket }] } }]);
    const structuredContentDocumentCitationPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'documentCitation', text: auxiliaryStripPacket }] } }]);
    const structuredContentBrowserAnnotationPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'browserAnnotation', text: auxiliaryStripPacket }] } }]);
    const structuredContentToolPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'tool_result', text: auxiliaryStripPacket }] } }]);
    const structuredContentFunctionPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'function_call_output', content: auxiliaryStripPacket }] } }]);
    const structuredContentToolCamelPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'toolCallOutput', text: auxiliaryStripPacket }] } }]);
    const structuredContentFunctionCamelPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'functionCallOutput', content: auxiliaryStripPacket }] } }]);
    const structuredContentReasoningCamelPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'reasoningText', text: auxiliaryStripPacket }] } }]);
    const structuredContentWebSearchCamelPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'webSearchCall', text: auxiliaryStripPacket }] } }]);
    const structuredContentWebSearchResultPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'web_search_result', text: auxiliaryStripPacket }] } }]);
    const structuredContentWebSearchPayloadPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'webSearchPayload', text: auxiliaryStripPacket }] } }]);
    const structuredContentWebSearchContentPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'web_search_content', text: auxiliaryStripPacket }] } }]);
    const structuredContentWebSearchTextPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'webSearchText', text: auxiliaryStripPacket }] } }]);
    const structuredContentSearchResultPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'search_result', text: auxiliaryStripPacket }] } }]);
    const structuredContentSearchResultPayloadPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'searchResultPayload', text: auxiliaryStripPacket }] } }]);
    const structuredContentSearchResultContentPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'search_result_content', text: auxiliaryStripPacket }] } }]);
    const structuredContentSearchResultTextPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'searchResultText', text: auxiliaryStripPacket }] } }]);
    const structuredContentSearchResultItemPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'searchResultItem', text: auxiliaryStripPacket }] } }]);
    const structuredContentSearchResultItemsPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'search_result_items', text: auxiliaryStripPacket }] } }]);
    const structuredContentSearchResultEntryPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'searchResultEntry', text: auxiliaryStripPacket }] } }]);
    const structuredContentSearchHitPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'searchHit', text: auxiliaryStripPacket }] } }]);
    const structuredContentSearchHitItemPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'searchHitItem', text: auxiliaryStripPacket }] } }]);
    const structuredContentSearchEntryPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'searchEntry', text: auxiliaryStripPacket }] } }]);
    const structuredContentSearchPayloadPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'search_payload', text: auxiliaryStripPacket }] } }]);
    const structuredContentSearchContentPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'searchContent', text: auxiliaryStripPacket }] } }]);
    const structuredContentSearchItemPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'search_items', text: auxiliaryStripPacket }] } }]);
    const structuredContentSearchSnippetPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'search_snippets', text: auxiliaryStripPacket }] } }]);
    const structuredContentSearchSnippetItemPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'search_snippet_item', text: auxiliaryStripPacket }] } }]);
    const structuredContentSearchSourcePacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'searchSource', text: auxiliaryStripPacket }] } }]);
    const structuredContentSearchDocumentPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'search_documents', text: auxiliaryStripPacket }] } }]);
    const structuredContentSearchRecordPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'search_records', text: auxiliaryStripPacket }] } }]);
    const structuredContentSearchRecordItemPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'searchRecordItem', text: auxiliaryStripPacket }] } }]);
    const structuredContentSearchResultEntryItemPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'searchResultEntryItem', text: auxiliaryStripPacket }] } }]);
    const structuredContentSearchResultObjectExtraction = extractPackets([{ role: 'assistant', data: { content: [{ object: 'search_result', text: auxiliaryStripPacket }] } }]);
    const structuredContentSearchResultNameExtraction = extractPackets([{ role: 'assistant', data: { content: [{ name: 'search_result', text: auxiliaryStripPacket }] } }]);
    const structuredContentFileSearchResultPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'file_search_result', text: auxiliaryStripPacket }] } }]);
    const structuredContentFileSearchPayloadPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'fileSearchPayload', text: auxiliaryStripPacket }] } }]);
    const structuredContentFileSearchContentPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'file_search_content', text: auxiliaryStripPacket }] } }]);
    const structuredContentCodeInterpreterOutputPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'codeInterpreterOutput', text: auxiliaryStripPacket }] } }]);
    const structuredContentCodeInterpreterPayloadPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'codeInterpreterPayload', text: auxiliaryStripPacket }] } }]);
    const structuredContentComputerUsePacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'computerUse', text: auxiliaryStripPacket }] } }]);
    const structuredContentComputerContentPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'computerContent', text: auxiliaryStripPacket }] } }]);
    const structuredContentMcpResultPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'mcpResult', text: auxiliaryStripPacket }] } }]);
    const structuredContentMcpResponsePacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'mcp_response', text: auxiliaryStripPacket }] } }]);
    const structuredContentMcpPayloadPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'mcpPayload', text: auxiliaryStripPacket }] } }]);
    const structuredContentBrowserResultPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'browser_result', text: auxiliaryStripPacket }] } }]);
    const structuredContentBrowserContentPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'browserContent', text: auxiliaryStripPacket }] } }]);
    const structuredContentWebpageResultPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'webpageResult', text: auxiliaryStripPacket }] } }]);
    const structuredContentWebpagePayloadPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'webpagePayload', text: auxiliaryStripPacket }] } }]);
    const structuredContentFilesystemResultPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'filesystem_result', text: auxiliaryStripPacket }] } }]);
    const structuredContentFileSystemResultPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'fileSystemResult', text: auxiliaryStripPacket }] } }]);
    const structuredContentFileSystemPayloadPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'fileSystemPayload', text: auxiliaryStripPacket }] } }]);
    const structuredContentTextToolKindPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'text', kind: 'tool_result', text: auxiliaryStripPacket }] } }]);
    const structuredContentTextFunctionKindPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'text', kind: 'functionCallOutput', text: auxiliaryStripPacket }] } }]);
    const structuredContentObjectToolPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ object: 'tool_call', text: auxiliaryStripPacket }] } }]);
    const structuredContentCategoryFunctionPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ category: 'function_call_output', text: auxiliaryStripPacket }] } }]);
    const structuredContentNameToolPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ name: 'tool_result', text: auxiliaryStripPacket }] } }]);
    const structuredContentTextNameToolPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ type: 'text', name: 'tool_result', text: auxiliaryStripPacket }] } }]);
    const namedAssistantMessagePacketExtraction = extractPackets([{ role: 'assistant', name: 'tool_result', content: auxiliaryStripPacket }]);
    const structuredPartsToolPacketExtraction = extractPackets([{ role: 'assistant', content: { parts: [{ type: 'tool_result', text: auxiliaryStripPacket }] } }]);
    const structuredMessageToolPacketExtraction = extractPackets([{ role: 'assistant', message: { type: 'tool_result', content: auxiliaryStripPacket } }]);
    const structuredMessageTextToolKindPacketExtraction = extractPackets([{ role: 'assistant', message: { type: 'text', kind: 'tool_result', content: auxiliaryStripPacket } }]);
    const structuredOutputTextPacketExtraction = extractPackets([{ role: 'assistant', data: { output_text: auxiliaryStripPacket } }]);
    const topLevelOutputPacketExtraction = extractPackets([{ role: 'assistant', output: [{ type: 'message', content: [{ type: 'output_text', text: auxiliaryStripPacket }] }] }]);
    const topLevelOutputToolPacketExtraction = extractPackets([{ role: 'assistant', output: [{ type: 'tool_result', content: [{ type: 'text', text: auxiliaryStripPacket }] }] }]);
    const topLevelOutputFunctionPacketExtraction = extractPackets([{ role: 'assistant', output: [{ type: 'function_call_output', content: auxiliaryStripPacket }] }]);
    const topLevelOutputTextToolKindPacketExtraction = extractPackets([{ role: 'assistant', output: [{ type: 'output_text', kind: 'tool_result', text: auxiliaryStripPacket }] }]);
    const structuredChoicePacketExtraction = extractPackets([{ role: 'assistant', data: { choices: [{ message: { role: 'assistant', content: auxiliaryStripPacket } }] } }]);
    const structuredChoiceUserPacketExtraction = extractPackets([{ role: 'assistant', data: { choices: [{ message: { role: 'user', content: auxiliaryStripPacket } }] } }]);
    const structuredChoiceRolelessPacketExtraction = extractPackets([{ role: 'assistant', data: { choices: [{ message: { content: auxiliaryStripPacket } }] } }]);
    const structuredChoiceDeltaRolelessPacketExtraction = extractPackets([{ role: 'assistant', data: { choices: [{ delta: { content: auxiliaryStripPacket } }] } }]);
    const structuredChoiceToolFinishPacketExtraction = extractPackets([{ role: 'assistant', data: { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: auxiliaryStripPacket } }] } }]);
    const structuredChoiceIndexOnePacketExtraction = extractPackets([{ role: 'assistant', data: { choices: [{ index: 1, message: { role: 'assistant', content: auxiliaryStripPacket } }] } }]);
    const structuredChoiceTextPacketExtraction = extractPackets([{ role: 'assistant', data: { choices: [{ index: 0, text: auxiliaryStripPacket }] } }]);
    check('extract_packets_reads_structured_segment_payloads', structuredPacketExtraction.length === 1);
    check('extract_packets_reads_spaced_assistant_roles', spacedRolePacketExtraction.length === 1);
    check('extract_packets_reads_blank_role_assistant_flags', blankRoleAssistantFlagPacketExtraction.length === 1);
    check('extract_packets_ignores_blank_role_user_flags', blankRoleUserFlagPacketExtraction.length === 0);
    check('extract_packets_reads_structured_output_payloads', structuredOutputPacketExtraction.length === 1);
    check('extract_packets_reads_structured_output_text_items', structuredOutputTextItemPacketExtraction.length === 1);
    check('extract_packets_ignores_structured_tool_output_payloads', structuredOutputToolPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_function_output_payloads', structuredOutputFunctionPacketExtraction.length === 0);
    check('extract_packets_reads_structured_recall_content_payloads', structuredContentRecallPacketExtraction.length === 1);
    check('extract_packets_reads_structured_recall_text_content_payloads', structuredContentRecallTextPacketExtraction.length === 1);
    check('extract_packets_reads_structured_recall_camel_content_payloads', structuredContentRecallCamelPacketExtraction.length === 1);
    check('extract_packets_reads_structured_recall_result_payloads', structuredContentRecallResultPacketExtraction.length === 1);
    check('extract_packets_reads_structured_recall_output_payloads', structuredContentRecallOutputPacketExtraction.length === 1);
    check('extract_packets_reads_structured_recall_search_result_payloads', structuredContentRecallSearchResultPacketExtraction.length === 1);
    check('extract_packets_reads_structured_recall_search_hit_payloads', structuredContentRecallSearchHitPacketExtraction.length === 1);
    check('extract_packets_reads_structured_recall_search_hit_item_payloads', structuredContentRecallSearchHitItemPacketExtraction.length === 1);
    check('extract_packets_reads_structured_recall_search_entry_payloads', structuredContentRecallSearchEntryPacketExtraction.length === 1);
    check('extract_packets_reads_structured_recall_search_payload_payloads', structuredContentRecallSearchPayloadPacketExtraction.length === 1);
    check('extract_packets_reads_structured_research_hit_payloads', structuredContentResearchHitPacketExtraction.length === 1);
    check('extract_packets_reads_structured_research_hit_item_payloads', structuredContentResearchHitItemPacketExtraction.length === 1);
    check('extract_packets_reads_structured_research_entry_payloads', structuredContentResearchEntryPacketExtraction.length === 1);
    check('extract_packets_reads_structured_research_payload_payloads', structuredContentResearchPayloadPacketExtraction.length === 1);
    check('extract_packets_reads_structured_web_novel_output_payloads', structuredContentWebNovelOutputPacketExtraction.length === 1);
    check('extract_packets_reads_structured_code_review_output_payloads', structuredContentCodeReviewOutputPacketExtraction.length === 1);
    check('extract_packets_reads_structured_text_recall_kind_payloads', structuredContentTextRecallKindPacketExtraction.length === 1);
    check('extract_packets_reads_structured_recall_name_payloads', structuredContentRecallNamePacketExtraction.length === 1);
    check('extract_packets_reads_structured_recall_source_search_payloads', structuredContentRecallSourceSearchPacketExtraction.length === 1);
    check('extract_packets_reads_structured_text_source_ref_payloads', structuredContentTextSourceRefPacketExtraction.length === 1);
    check('extract_packets_ignores_structured_text_source_web_search_payloads', structuredContentTextSourceWebSearchPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_text_source_web_search_payload_payloads', structuredContentTextSourceWebSearchPayloadPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_text_source_type_file_search_payloads', structuredContentTextSourceTypeFileSearchPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_text_source_type_browser_payloads', structuredContentTextSourceTypeBrowserPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_text_subtype_mcp_payloads', structuredContentTextSubtypeMcpPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_text_channel_tool_payloads', structuredContentTextChannelToolPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_text_channel_web_search_payloads', structuredContentTextChannelWebSearchPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_text_tool_name_browser_payloads', structuredContentTextToolNameBrowserPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_text_provider_code_interpreter_payloads', structuredContentTextProviderCodeInterpreterPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_text_metadata_search_result_payloads', structuredContentTextMetadataSearchResultPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_text_source_name_web_search_payloads', structuredContentTextSourceNameWebSearchPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_text_origin_browser_payloads', structuredContentTextOriginBrowserPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_text_origin_type_mcp_payloads', structuredContentTextOriginTypeMcpPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_text_origin_type_file_search_payloads', structuredContentTextOriginTypeFileSearchPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_text_response_type_tool_payloads', structuredContentTextResponseTypeToolPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_text_response_type_webpage_payloads', structuredContentTextResponseTypeWebpagePacketExtraction.length === 0);
    check('extract_packets_ignores_structured_text_event_tool_payloads', structuredContentTextEventToolPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_text_event_type_web_search_payloads', structuredContentTextEventTypeWebSearchPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_text_label_search_result_payloads', structuredContentTextLabelSearchResultPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_text_metadata_source_name_web_search_payloads', structuredContentTextMetadataSourceNameWebSearchPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_text_metadata_origin_browser_payloads', structuredContentTextMetadataOriginBrowserPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_text_metadata_response_type_tool_payloads', structuredContentTextMetadataResponseTypeToolPacketExtraction.length === 0);
    check('extract_packets_reads_structured_recall_origin_browser_payloads', structuredContentRecallOriginBrowserPacketExtraction.length === 1);
    check('extract_packets_reads_structured_text_origin_scene_payloads', structuredContentTextOriginScenePacketExtraction.length === 1);
    check('extract_packets_ignores_structured_text_tool_call_id_payloads', structuredContentTextToolCallIdPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_text_tool_call_camel_id_payloads', structuredContentTextToolCallCamelIdPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_text_call_id_payloads', structuredContentTextCallIdPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_text_call_camel_id_payloads', structuredContentTextCallCamelIdPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_text_function_call_id_payloads', structuredContentTextFunctionCallIdPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_text_tool_use_id_payloads', structuredContentTextToolUseIdPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_text_tool_use_camel_id_payloads', structuredContentTextToolUseCamelIdPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_text_invocation_id_payloads', structuredContentTextInvocationIdPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_text_recipient_browser_payloads', structuredContentTextRecipientBrowserPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_text_target_web_search_payloads', structuredContentTextTargetWebSearchPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_text_metadata_tool_call_id_payloads', structuredContentTextMetadataToolCallIdPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_text_metadata_target_browser_payloads', structuredContentTextMetadataTargetBrowserPacketExtraction.length === 0);
    check('extract_packets_reads_structured_recall_tool_call_id_payloads', structuredContentRecallToolCallIdPacketExtraction.length === 1);
    check('extract_packets_ignores_structured_text_source_object_type_payloads', structuredContentTextSourceObjectTypePacketExtraction.length === 0);
    check('extract_packets_ignores_structured_text_source_object_name_payloads', structuredContentTextSourceObjectNamePacketExtraction.length === 0);
    check('extract_packets_ignores_structured_text_tool_object_name_payloads', structuredContentTextToolObjectNamePacketExtraction.length === 0);
    check('extract_packets_ignores_structured_text_tool_object_type_payloads', structuredContentTextToolObjectTypePacketExtraction.length === 0);
    check('extract_packets_ignores_structured_text_provider_object_kind_payloads', structuredContentTextProviderObjectKindPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_text_metadata_source_object_payloads', structuredContentTextMetadataSourceObjectPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_text_metadata_tool_object_payloads', structuredContentTextMetadataToolObjectPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_text_metadata_provider_object_payloads', structuredContentTextMetadataProviderObjectPacketExtraction.length === 0);
    check('extract_packets_reads_structured_recall_source_object_payloads', structuredContentRecallSourceObjectPacketExtraction.length === 1);
    check('extract_packets_reads_structured_text_source_object_ref_payloads', structuredContentTextSourceObjectRefPacketExtraction.length === 1);
    check('extract_packets_ignores_structured_text_source_metadata_type_payloads', structuredContentTextSourceMetadataTypePacketExtraction.length === 0);
    check('extract_packets_ignores_structured_text_tool_metadata_name_payloads', structuredContentTextToolMetadataNamePacketExtraction.length === 0);
    check('extract_packets_ignores_structured_text_metadata_source_metadata_type_payloads', structuredContentTextMetadataSourceMetadataTypePacketExtraction.length === 0);
    check('extract_packets_ignores_structured_text_tool_calls_payloads', structuredContentTextToolCallsPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_text_tool_calls_camel_payloads', structuredContentTextToolCallsCamelPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_text_function_call_payloads', structuredContentTextFunctionCallPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_text_function_call_camel_payloads', structuredContentTextFunctionCallCamelPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_text_function_calls_payloads', structuredContentTextFunctionCallsPacketExtraction.length === 0);
    check('extract_packets_reads_structured_recall_tool_calls_payloads', structuredContentRecallToolCallsPacketExtraction.length === 1);
    check('extract_packets_reads_structured_text_tools_label_payloads', structuredContentTextToolsLabelPacketExtraction.length === 1);
    check('extract_packets_ignores_structured_output_text_source_search_payloads', structuredContentOutputTextSourceSearchPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_input_text_source_search_payloads', structuredContentInputTextSourceSearchPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_message_content_source_search_payloads', structuredContentMessageContentSourceSearchPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_content_part_source_search_payloads', structuredContentContentPartSourceSearchPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_text_segment_source_search_payloads', structuredContentTextSegmentSourceSearchPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_delta_text_source_search_payloads', structuredContentDeltaTextSourceSearchPacketExtraction.length === 0);
    check('extract_packets_reads_structured_recall_text_source_search_payloads', structuredContentRecallTextSourceSearchPacketExtraction.length === 1);
    check('extract_packets_reads_structured_output_text_source_ref_payloads', structuredContentOutputTextSourceRefPacketExtraction.length === 1);
    check('extract_packets_ignores_structured_url_citation_payloads', structuredContentUrlCitationPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_url_citation_snake_payloads', structuredContentUrlCitationSnakePacketExtraction.length === 0);
    check('extract_packets_ignores_structured_file_citation_payloads', structuredContentFileCitationPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_citation_payloads', structuredContentCitationPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_annotation_payloads', structuredContentAnnotationPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_url_citation_no_source_payloads', structuredContentUrlCitationNoSourcePacketExtraction.length === 0);
    check('extract_packets_reads_structured_recall_citation_payloads', structuredContentRecallCitationPacketExtraction.length === 1);
    check('extract_packets_ignores_structured_search_citation_payloads', structuredContentSearchCitationPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_file_search_citation_payloads', structuredContentFileSearchCitationPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_webpage_citation_payloads', structuredContentWebpageCitationPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_document_citation_payloads', structuredContentDocumentCitationPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_browser_annotation_payloads', structuredContentBrowserAnnotationPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_tool_content_payloads', structuredContentToolPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_function_content_payloads', structuredContentFunctionPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_tool_camel_content_payloads', structuredContentToolCamelPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_function_camel_content_payloads', structuredContentFunctionCamelPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_reasoning_camel_content_payloads', structuredContentReasoningCamelPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_web_search_camel_content_payloads', structuredContentWebSearchCamelPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_web_search_result_payloads', structuredContentWebSearchResultPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_web_search_payload_payloads', structuredContentWebSearchPayloadPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_web_search_content_payloads', structuredContentWebSearchContentPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_web_search_text_payloads', structuredContentWebSearchTextPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_search_result_payloads', structuredContentSearchResultPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_search_result_payload_payloads', structuredContentSearchResultPayloadPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_search_result_content_payloads', structuredContentSearchResultContentPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_search_result_text_payloads', structuredContentSearchResultTextPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_search_result_item_payloads', structuredContentSearchResultItemPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_search_result_items_payloads', structuredContentSearchResultItemsPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_search_result_entry_payloads', structuredContentSearchResultEntryPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_search_hit_payloads', structuredContentSearchHitPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_search_hit_item_payloads', structuredContentSearchHitItemPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_search_entry_payloads', structuredContentSearchEntryPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_search_payload_payloads', structuredContentSearchPayloadPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_search_content_payloads', structuredContentSearchContentPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_search_item_payloads', structuredContentSearchItemPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_search_snippet_payloads', structuredContentSearchSnippetPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_search_snippet_item_payloads', structuredContentSearchSnippetItemPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_search_source_payloads', structuredContentSearchSourcePacketExtraction.length === 0);
    check('extract_packets_ignores_structured_search_document_payloads', structuredContentSearchDocumentPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_search_record_payloads', structuredContentSearchRecordPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_search_record_item_payloads', structuredContentSearchRecordItemPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_search_result_entry_item_payloads', structuredContentSearchResultEntryItemPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_search_result_object_payloads', structuredContentSearchResultObjectExtraction.length === 0);
    check('extract_packets_ignores_structured_search_result_name_payloads', structuredContentSearchResultNameExtraction.length === 0);
    check('extract_packets_ignores_structured_file_search_result_payloads', structuredContentFileSearchResultPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_file_search_payload_payloads', structuredContentFileSearchPayloadPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_file_search_content_payloads', structuredContentFileSearchContentPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_code_interpreter_output_payloads', structuredContentCodeInterpreterOutputPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_code_interpreter_payload_payloads', structuredContentCodeInterpreterPayloadPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_computer_use_payloads', structuredContentComputerUsePacketExtraction.length === 0);
    check('extract_packets_ignores_structured_computer_content_payloads', structuredContentComputerContentPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_mcp_result_payloads', structuredContentMcpResultPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_mcp_response_payloads', structuredContentMcpResponsePacketExtraction.length === 0);
    check('extract_packets_ignores_structured_mcp_payload_payloads', structuredContentMcpPayloadPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_browser_result_payloads', structuredContentBrowserResultPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_browser_content_payloads', structuredContentBrowserContentPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_webpage_result_payloads', structuredContentWebpageResultPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_webpage_payload_payloads', structuredContentWebpagePayloadPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_filesystem_result_payloads', structuredContentFilesystemResultPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_file_system_result_payloads', structuredContentFileSystemResultPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_file_system_payload_payloads', structuredContentFileSystemPayloadPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_text_tool_kind_payloads', structuredContentTextToolKindPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_text_function_kind_payloads', structuredContentTextFunctionKindPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_object_tool_payloads', structuredContentObjectToolPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_category_function_payloads', structuredContentCategoryFunctionPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_name_tool_payloads', structuredContentNameToolPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_text_name_tool_payloads', structuredContentTextNameToolPacketExtraction.length === 0);
    check('extract_packets_preserves_named_assistant_messages', namedAssistantMessagePacketExtraction.length === 1);
    check('extract_packets_ignores_structured_tool_part_payloads', structuredPartsToolPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_tool_message_payloads', structuredMessageToolPacketExtraction.length === 0);
    check('extract_packets_ignores_structured_text_tool_kind_message_payloads', structuredMessageTextToolKindPacketExtraction.length === 0);
    check('extract_packets_reads_structured_output_text_payloads', structuredOutputTextPacketExtraction.length === 1);
    check('extract_packets_reads_top_level_output_payloads', topLevelOutputPacketExtraction.length === 1);
    check('extract_packets_ignores_top_level_tool_output_payloads', topLevelOutputToolPacketExtraction.length === 0);
    check('extract_packets_ignores_top_level_function_output_payloads', topLevelOutputFunctionPacketExtraction.length === 0);
    check('extract_packets_ignores_top_level_text_tool_kind_output_payloads', topLevelOutputTextToolKindPacketExtraction.length === 0);
    check('extract_packets_reads_structured_choice_payloads', structuredChoicePacketExtraction.length === 1);
    check('extract_packets_ignores_structured_user_choice_payloads', structuredChoiceUserPacketExtraction.length === 0);
    check('extract_packets_ignores_roleless_structured_choice_payloads', structuredChoiceRolelessPacketExtraction.length === 0);
    check('extract_packets_ignores_roleless_structured_choice_deltas', structuredChoiceDeltaRolelessPacketExtraction.length === 0);
    check('extract_packets_ignores_tool_finish_structured_choice_payloads', structuredChoiceToolFinishPacketExtraction.length === 0);
    check('extract_packets_ignores_nonzero_structured_choice_payloads', structuredChoiceIndexOnePacketExtraction.length === 0);
    check('extract_packets_reads_legacy_text_choice_payloads', structuredChoiceTextPacketExtraction.length === 1);
    const nestedAssistantPacketExtraction = extractPackets([{ role: 'assistant', data: { messages: [{ role: 'assistant', content: auxiliaryStripPacket }] } }]);
    const nestedAiPacketExtraction = extractPackets([{ role: 'assistant', data: { messages: [{ role: 'ai', content: auxiliaryStripPacket }] } }]);
    const nestedBotPacketExtraction = extractPackets([{ role: 'assistant', data: { messages: [{ role: 'bot', content: auxiliaryStripPacket }] } }]);
    const nestedSpacedAiPacketExtraction = extractPackets([{ role: 'assistant', data: { messages: [{ role: ' ai ', content: auxiliaryStripPacket }] } }]);
    const nestedBlankRoleFlagPacketExtraction = extractPackets([{ role: 'assistant', data: { messages: [{ role: ' ', is_user: false, content: auxiliaryStripPacket }] } }]);
    const nestedUserPacketExtraction = extractPackets([{ role: 'assistant', data: { messages: [{ role: 'user', content: auxiliaryStripPacket }] } }]);
    const nestedRolelessPacketExtraction = extractPackets([{ role: 'assistant', data: { messages: [{ content: auxiliaryStripPacket }] } }]);
    const nestedContentUserPacketExtraction = extractPackets([{ role: 'assistant', data: { content: [{ role: 'user', content: auxiliaryStripPacket }] } }]);
    const nestedPartsUserPacketExtraction = extractPackets([{ role: 'assistant', data: { content: { parts: [{ role: 'user', text: auxiliaryStripPacket }] } } }]);
    check('extract_packets_reads_nested_assistant_messages', nestedAssistantPacketExtraction.length === 1);
    check('extract_packets_reads_nested_ai_messages', nestedAiPacketExtraction.length === 1);
    check('extract_packets_reads_nested_bot_messages', nestedBotPacketExtraction.length === 1);
    check('extract_packets_reads_nested_spaced_ai_messages', nestedSpacedAiPacketExtraction.length === 1);
    check('extract_packets_reads_nested_blank_role_flags', nestedBlankRoleFlagPacketExtraction.length === 1);
    check('extract_packets_ignores_nested_user_messages', nestedUserPacketExtraction.length === 0);
    check('extract_packets_ignores_roleless_nested_messages', nestedRolelessPacketExtraction.length === 0);
    check('extract_packets_ignores_nested_user_content_items', nestedContentUserPacketExtraction.length === 0);
    check('extract_packets_ignores_nested_user_part_items', nestedPartsUserPacketExtraction.length === 0);
    const dataOnlyPacketInjection = injectPrompt([
      { role: 'assistant', data: { content: [{ type: 'text', text: `<!-- ${PACKET_START} {"meta":{"schema":"hayaku_packet_v1"}} ${PACKET_END} -->` }] } },
      { role: 'user', content: 'next' }
    ], 'block', 'tail');
    const dataOnlyPacketSystems = dataOnlyPacketInjection.filter(row => row?.role === 'system');
    const dataOnlyPacketUserInjections = dataOnlyPacketInjection.filter(row => row?.role === 'user' && (row?.content === 'block' || row?.content === 'tail'));
    check('main_prompt_uses_clean_payload_shape_for_user_injection',
      dataOnlyPacketSystems.length === 0
      && dataOnlyPacketUserInjections.length === 2
      && dataOnlyPacketUserInjections.every(row => hasOwnProperty(row, 'content') && !hasOwnProperty(row, 'data')));
    const auxiliaryDirtyDataPayload = stripHayakuFromMessagePayloads({ role: 'assistant', content: 'visible text', data: auxiliaryStripPacket });
    check('auxiliary_strip_cleans_data_payload_when_content_clean',
      auxiliaryDirtyDataPayload.changed === true
      && auxiliaryDirtyDataPayload.message.content === 'visible text'
      && !/HAYAKU_STATE_PACKET_START|HAYAKU_STATE_PACKET_END/.test(auxiliaryDirtyDataPayload.message.data || '')
      && /visible text/.test(auxiliaryDirtyDataPayload.message.data || ''));
    const auxiliarySegmentDataPayload = stripHayakuFromMessagePayloads({ role: 'assistant', content: 'visible text', data: { content: [{ type: 'text', text: auxiliaryStripPacket }], keep: 'untouched' } });
    check('auxiliary_strip_cleans_segment_payloads',
      auxiliarySegmentDataPayload.changed === true
      && auxiliarySegmentDataPayload.message.data.keep === 'untouched'
      && !/HAYAKU_STATE_PACKET_START|HAYAKU_STATE_PACKET_END/.test(JSON.stringify(auxiliarySegmentDataPayload.message.data || null)));
    const auxiliaryNestedPayload = stripHayakuFromMessagePayloads({
      role: 'assistant',
      content: { parts: [{ type: 'text', text: auxiliaryStripPacket }] },
      data: { messages: [{ content: auxiliaryStripPacket }], keep: 'untouched' },
      extra: { content: auxiliaryStripPacket }
    });
    check('auxiliary_strip_cleans_nested_wrapper_payloads',
      auxiliaryNestedPayload.changed === true
      && auxiliaryNestedPayload.message.data.keep === 'untouched'
      && !/HAYAKU_STATE_PACKET_START|HAYAKU_STATE_PACKET_END/.test(JSON.stringify(auxiliaryNestedPayload.message || null)));
    const auxiliaryDeepPayload = stripHayakuFromMessagePayloads({
      role: 'assistant',
      content: { a: { b: { c: { d: { e: { f: auxiliaryStripPacket } } } } } }
    });
    check('auxiliary_strip_cleans_deep_wrapper_payloads',
      auxiliaryDeepPayload.changed === true
      && !/HAYAKU_STATE_PACKET_START|HAYAKU_STATE_PACKET_END/.test(JSON.stringify(auxiliaryDeepPayload.message || null)));
    const auxiliaryCleanShared = { label: 'clean' };
    const auxiliaryCleanSharedResult = stripHayakuFromMessagePayloads({ role: 'assistant', content: { a: auxiliaryCleanShared, b: auxiliaryCleanShared } });
    check('auxiliary_strip_preserves_clean_shared_aliases',
      auxiliaryCleanSharedResult.changed === false
      && auxiliaryCleanSharedResult.message.content.a === auxiliaryCleanSharedResult.message.content.b
      && auxiliaryCleanSharedResult.message.content.a === auxiliaryCleanShared);
    const auxiliaryCleanCycle = { label: 'clean' };
    auxiliaryCleanCycle.self = auxiliaryCleanCycle;
    const auxiliaryCleanCycleResult = stripHayakuFromMessagePayloads({ role: 'assistant', content: auxiliaryCleanCycle });
    check('auxiliary_strip_preserves_clean_cycles',
      auxiliaryCleanCycleResult.changed === false
      && auxiliaryCleanCycleResult.message.content === auxiliaryCleanCycle
      && auxiliaryCleanCycleResult.message.content.self === auxiliaryCleanCycle);
    const auxiliaryCyclicPayload = {
      role: 'assistant',
      content: { root: { child: { leaf: auxiliaryStripPacket } } }
    };
    auxiliaryCyclicPayload.content.root.loop = auxiliaryCyclicPayload.content.root;
    const auxiliaryCyclicResult = stripHayakuFromMessagePayloads(auxiliaryCyclicPayload);
    check('auxiliary_strip_cleans_cyclic_alias_payloads',
      auxiliaryCyclicResult.changed === true
      && auxiliaryCyclicResult.message.content.root.loop === auxiliaryCyclicResult.message.content.root
      && !/HAYAKU_STATE_PACKET_START|HAYAKU_STATE_PACKET_END/.test(auxiliaryCyclicResult.message.content.root.child.leaf || '')
      && !/HAYAKU_STATE_PACKET_START|HAYAKU_STATE_PACKET_END/.test(auxiliaryCyclicResult.message.content.root.loop.child.leaf || ''));
    check('previous_plain_lbxnai_tag_does_not_skip_main_turn', previousIllustrationTagClass.auxiliary === false && previousIllustrationTagClass.main === true);
    check('previous_gigatrans_prompt_does_not_skip_main_turn', previousGigaTransClass.auxiliary === false && previousGigaTransClass.main === true);
    check('previous_structured_image_prompt_does_not_skip_main_turn', previousStructuredImagePromptClass.auxiliary === false && previousStructuredImagePromptClass.main === true);
    check('previous_structured_translation_prompt_does_not_skip_main_turn', previousStructuredTranslationPromptClass.auxiliary === false && previousStructuredTranslationPromptClass.main === true);
    check('model_lightboard_generation_marker_is_allowed', lightboardGenerationClass.auxiliary === false && lightboardGenerationClass.main === true);
    check('model_lightboard_structured_prompt_is_allowed', lightboardStructuredClass.auxiliary === false && lightboardStructuredClass.main === true);
    const restrictedSecret = {
      axis: 'entity',
      category: 'secret',
      visibility: {
        holderEntityIds: ['하루'],
        visibleToEntityIds: ['하루'],
        deniedToEntityIds: ['리아'],
        secrecyLevel: 'secret',
        revealState: 'hidden'
      }
    };
    const allowedOnlySecret = {
      axis: 'entity',
      category: 'secret',
      visibility: {
        holderEntityIds: ['하루'],
        visibleToEntityIds: ['하루'],
        deniedToEntityIds: [],
        secrecyLevel: 'secret',
        revealState: 'hidden'
      }
    };
    const visiblePov = {
      axis: 'entity',
      category: 'pov_memory',
      visibility: {
        ownerEntityId: '리아',
        visibleToEntityIds: ['리아'],
        deniedToEntityIds: [],
        privacy: 'private'
      }
    };
    check('korean_vocative_mentions_canonical', queryMentionedEntities(fixtureStore, '하루야, 잠깐 와 봐').includes('하루'));
    check('latin_alias_mentions_canonical', queryMentionedEntities(fixtureStore, 'Lia enters').includes('리아'));
    check('japanese_alias_mentions_canonical', queryMentionedEntities(fixtureStore, '凛ちゃんは鍵の場所を尋ねる').includes('凛'));
    check('japanese_tokenizer_preserves_kana_kanji', tokenize('鍵は資料室の机の下にある').some(token => token === '鍵は資料室の机の下にある' || token === '資料室' || token === '机の'));
    check('japanese_cross_lingual_tokens', conceptTokensForText('鍵はどこにある？ 秘密を覚えている。').includes('object:key') && conceptTokensForText('鍵はどこにある？ 秘密を覚えている。').includes('info:location') && conceptTokensForText('鍵はどこにある？ 秘密を覚えている。').includes('info:secret'));
    check('universal_canonical_token_bridge', canonicalRecallTokensForText('médaillon / objeto / object:necklace').includes('object:necklace') && conceptTokensForText('목걸이는 어디 있어?').includes('object:necklace') && tokenWeight('object:necklace') > tokenWeight('necklace'));
    check('denied_secret_blocked', isKnowledgeUnavailableForQuery(restrictedSecret, '리아가 묻는다', ['리아']) === true);
    check('holder_secret_allowed', isKnowledgeUnavailableForQuery(restrictedSecret, '하루가 떠올린다', ['하루']) === false);
    check('visible_pov_allowed_by_recent_context', isKnowledgeUnavailableForQuery(visiblePov, '계속 말한다', effectiveMentionedEntities(fixtureStore, '')) === false);
    check('stale_recent_context_expires', effectiveMentionedEntities({ ...fixtureStore, context: { recentEntities: ['리아'], updatedAt: now() - DEFAULT_SETTINGS.recentEntityContextMs - 1 } }, '', DEFAULT_SETTINGS).length === 0);
    const sceneVisibleOnlyStore = {
      ...fixtureStore,
      context: {
        recentEntities: [],
        updatedAt: 0,
        sceneAnchors: { povEntities: [], activeSpeakers: [], visibleParticipants: ['하루', '리아'], sceneVisibility: 'limited', updatedAt: now() },
        sceneAnchorUpdatedAt: now()
      }
    };
    const sceneIdResetStore = {
      ...fixtureStore,
      context: {
        recentEntities: [],
        updatedAt: 0,
        sceneAnchors: { povEntities: ['하루'], activeSpeakers: ['하루'], visibleParticipants: ['하루', '리아'], sceneVisibility: 'limited', sceneId: 'scene-a', updatedAt: now() },
        sceneAnchorUpdatedAt: now()
      }
    };
    const explicitClearStore = {
      ...fixtureStore,
      context: {
        recentEntities: [],
        updatedAt: 0,
        sceneAnchors: { povEntities: ['하루'], activeSpeakers: ['하루'], visibleParticipants: ['하루', '리아'], sceneVisibility: 'limited', sceneId: 'scene-a', updatedAt: now() },
        sceneAnchorUpdatedAt: now()
      }
    };
    const sceneAnchoredStore = {
      ...fixtureStore,
      context: {
        recentEntities: [],
        updatedAt: 0,
        sceneAnchors: { povEntities: ['하루'], activeSpeakers: [], visibleParticipants: ['하루', '리아'], sceneVisibility: 'limited', updatedAt: now() },
        sceneAnchorUpdatedAt: now()
      }
    };
    const sceneDeniedStore = {
      ...fixtureStore,
      context: {
        recentEntities: [],
        updatedAt: 0,
        sceneAnchors: { povEntities: ['리아'], activeSpeakers: [], visibleParticipants: ['하루', '리아'], sceneVisibility: 'limited', updatedAt: now() },
        sceneAnchorUpdatedAt: now()
      }
    };
    const sceneOmniscientStore = {
      ...fixtureStore,
      context: {
        recentEntities: [],
        updatedAt: 0,
        sceneAnchors: { povEntities: ['하루'], activeSpeakers: ['하루'], visibleParticipants: ['하루', '리아'], sceneVisibility: 'omniscient', updatedAt: now() },
        sceneAnchorUpdatedAt: now()
      }
    };
    const sceneLowConfidenceStore = {
      ...fixtureStore,
      context: {
        recentEntities: [],
        updatedAt: 0,
        sceneAnchors: { povEntities: ['하루'], activeSpeakers: ['하루'], visibleParticipants: ['하루', '리아'], sceneVisibility: 'limited', confidence: 0.2, updatedAt: now() },
        sceneAnchorUpdatedAt: now()
      }
    };
    const resetAnchors = storeSceneAnchors(sceneIdResetStore, { scene_id: 'scene-b' }, {});
    const clearedAnchors = storeSceneAnchors(explicitClearStore, { scene_id: 'scene-a', pov_entity: '', active_speaker: '', visible_participants: [] }, {});
    check('scene_id_change_resets_pov_anchors', resetAnchors?.sceneId === 'scene-b' && resetAnchors?.povEntities?.length === 0 && resetAnchors?.activeSpeakers?.length === 0 && resetAnchors?.visibleParticipants?.length === 0);
    check('explicit_empty_anchor_fields_clear_previous_values', clearedAnchors?.povEntities?.length === 0 && clearedAnchors?.activeSpeakers?.length === 0 && clearedAnchors?.visibleParticipants?.length === 0);
    check('scene_visible_participant_does_not_unlock_secret', isKnowledgeUnavailableForQuery(allowedOnlySecret, '그 비밀을 떠올린다', buildKnowledgeContext(sceneVisibleOnlyStore, '그 비밀을 떠올린다')) === true);
    check('scene_pov_holder_allows_pronoun_secret', isKnowledgeUnavailableForQuery(restrictedSecret, '그 비밀을 떠올린다', buildKnowledgeContext(sceneAnchoredStore, '그 비밀을 떠올린다')) === false);
    check('scene_pov_denied_blocks_pronoun_secret', isKnowledgeUnavailableForQuery(restrictedSecret, '그 비밀을 떠올린다', buildKnowledgeContext(sceneDeniedStore, '그 비밀을 떠올린다')) === true);
    check('omniscient_anchor_does_not_unlock_secret', isKnowledgeUnavailableForQuery(allowedOnlySecret, '그 비밀을 떠올린다', buildKnowledgeContext(sceneOmniscientStore, '그 비밀을 떠올린다')) === true);
    check('low_confidence_anchor_does_not_unlock_secret', isKnowledgeUnavailableForQuery(allowedOnlySecret, '그 비밀을 떠올린다', buildKnowledgeContext(sceneLowConfidenceStore, '그 비밀을 떠올린다')) === true);
    check('search_excludes_denied_secret', !searchIndex(fixtureStore, '리아가 숨겨진 정보를 묻는다', DEFAULT_SETTINGS).entity.some(row => row.category === 'secret'));
    const holderSearch = searchIndex(fixtureStore, '하루가 숨겨진 정보를 떠올린다', DEFAULT_SETTINGS);
    check('search_includes_holder_secret', holderSearch.entity.some(row => row.category === 'secret'));
    check('search_uses_packet_ledger_rev2_engine', holderSearch.entity.some(row => row.retrievalEngine === LEDGER_REV2_SCORING_ENGINE && row.scoreBreakdown?.retrievalEngine === LEDGER_REV2_SCORING_ENGINE && row.scoreBreakdown?.packetLedgerV2));
    const holderRows = Object.values(holderSearch).flat();
    check('bm25_channel_defaults_on', DEFAULT_SETTINGS.bm25Channel === true && DEFAULT_SETTINGS.bm25Weight === 0.08);
    check('bm25_channel_breakdown_present',
      holderRows.some(row => row.scoreBreakdown?.bm25Enabled === true && typeof row.scoreBreakdown?.bm25 === 'number' && typeof row.scoreBreakdown?.bm25Signal === 'number'));
    const bm25DisabledSearch = searchIndex(fixtureStore, '하루가 숨겨진 정보를 떠올린다', { ...DEFAULT_SETTINGS, bm25Channel: false });
    const bm25DisabledRows = Object.values(bm25DisabledSearch).flat();
    check('bm25_channel_can_disable',
      bm25DisabledRows.length > 0
      && bm25DisabledRows.every(row => row.scoreBreakdown?.bm25Enabled === false && row.scoreBreakdown?.bm25Signal === 0));
    const bm25WeightedDoc = retrievalBm25Document({
      publicText: 'field_bm25_repeat field_bm25_repeat ordinary filler',
      publicRef: 'world.world_rule.field_bm25_repeat',
      retrieval: {
        tokens: ['field_bm25_repeat'],
        canonicalAnchors: ['object:field_bm25_anchor'],
        subjectTokens: ['subject_field_bm25'],
        priorityTerms: ['priority_field_bm25']
      }
    });
    const bm25DocCount = token => bm25WeightedDoc.filter(item => item === normalizeKey(token)).length;
    check('bm25_document_preserves_term_frequency_and_field_weights',
      bm25DocCount('field_bm25_repeat') >= 4
      && bm25DocCount('field_bm25_anchor') >= 4
      && bm25DocCount('subject_field_bm25') >= 3
      && bm25DocCount('priority_field_bm25') >= 2);
    const jpSummaryStore = {
      ...emptyStore(),
      memory: {
        summaries: [{
          id: 'jp_summary_key_location',
          kind: 'ledger_rev2_summary_memory',
          summary: '鍵は資料室の机の下にある。',
          text: '鍵は資料室の机の下にある。凛だけがその場所を覚えている。',
          recallAnchors: ['鍵', '資料室', '机の下'],
          directEvidenceSnippets: ['凛は鍵を資料室の机の下に隠した。'],
          mentionedEntityNames: ['凛'],
          importance: 0.86,
          salience: 0.82,
          confidence: 0.8,
          status: 'active',
          time_scope: 'current',
          scene_id: 'jp_scene'
        }]
      }
    };
    rebuildIndex(jpSummaryStore);
    const jpSummarySearch = searchIndex(jpSummaryStore, '鍵は今どこにある？', DEFAULT_SETTINGS);
    check('japanese_summary_memory_recall', jpSummarySearch.narrative.some(row => row.category === 'summary_memory'));
    const multilingualAnchorStore = {
      ...emptyStore(),
      memory: {
        summaries: [{
          id: 'en_packet_ko_query_anchor',
          kind: 'ledger_rev2_summary_memory',
          summary: 'The silver locket is hidden inside the wardrobe.',
          text: 'The silver locket is hidden inside the wardrobe. recallAnchors: locket / 목걸이 / ロケット / object:necklace; wardrobe / 옷장 / クローゼット / place:wardrobe; hidden / 숨김 / 隠し / state:hidden',
          recallAnchors: ['locket / 목걸이 / ロケット / object:necklace', 'wardrobe / 옷장 / クローゼット / place:wardrobe', 'hidden / 숨김 / 隠し / state:hidden'],
          directEvidenceSnippets: ['The locket was tucked into the wardrobe.'],
          mentionedEntityNames: ['Rin', '린', '凛'],
          importance: 0.86,
          salience: 0.84,
          confidence: 0.8,
          status: 'active',
          time_scope: 'current',
          scene_id: 'multi_anchor_scene'
        }]
      }
    };
    rebuildIndex(multilingualAnchorStore);
    const koToEnPacketSearch = searchIndex(multilingualAnchorStore, '목걸이는 지금 어디에 있어?', DEFAULT_SETTINGS);
    const jpToEnPacketSearch = searchIndex(multilingualAnchorStore, 'ロケットは今どこにある？', DEFAULT_SETTINGS);
    check('korean_query_recalls_english_packet_with_multilingual_anchor', koToEnPacketSearch.narrative.some(row => row.category === 'summary_memory'));
    check('japanese_query_recalls_english_packet_with_multilingual_anchor', jpToEnPacketSearch.narrative.some(row => row.category === 'summary_memory'));
    check('canonical_recall_token_directly_indexed', crossLingualTokensForText('object:necklace place:wardrobe').includes('object:necklace') && crossLingualTokensForText('object:necklace place:wardrobe').includes('place:wardrobe'));
    check('canonical_recall_token_weight_boosted', tokenWeight('object:key') > tokenWeight('plainword'));
    const prefilterRegressionRow = (id, body, importance = 0.8, category = 'current_state') => ({
      id,
      axis: 'world',
      category,
      publicRef: id,
      publicText: body,
      publicProfile: body,
      locator: { turnId: 1, chatRecency: 0.9, distanceFromLatest: 1, messageIndex: 1, messageCount: 600 },
      retrieval: {
        tokens: tokenize(body, 200),
        subject: 'object',
        subjectTokens: tokenize('object', 48),
        priorityTerms: tokenize(body, 80),
        locatorTokens: tokenize(`${id} ${body}`, 80),
        semanticFrameTokens: tokenize(body, 80),
        crossLingualTokens: [],
        canonicalAnchors: [],
        worldTags: [],
        branchTags: [],
        emotionTags: [],
        relationTags: [],
        narrativeTags: [],
        storyTags: [],
        timeTags: [],
        locatorHintTags: [],
        chatRecency: 0.9,
        distanceFromLatest: 1,
        messageCount: 600,
        salience: 0.8,
        confidence: 0.8,
        importance
      },
      importance,
      updatedAt: now()
    });
    const prefilterFuzzyStore = {
      ...emptyStore(),
      index: [
        prefilterRegressionRow('prefilter_fuzzy_typo', 'current object location has necklac in wardrobe', 0.8),
        ...Array.from({ length: 25 }, (_, index) => prefilterRegressionRow(`prefilter_exact_${index}`, `necklace unrelated filler ${index}`, 0.1)),
        ...Array.from({ length: 280 }, (_, index) => prefilterRegressionRow(`prefilter_noise_${index}`, `random archive candle hallway ${index}`, 0.1))
      ]
    };
    const prefilterFuzzySearch = searchIndex(prefilterFuzzyStore, 'necklace', { ...DEFAULT_SETTINGS, mode: 'fast', maxItemsPerAxis: 12 });
    check('prefilter_preserves_fuzzy_only_candidates', prefilterFuzzySearch.world.some(row => row.id === 'prefilter_fuzzy_typo'));
    const prefilterProtectedStore = {
      ...emptyStore(),
      index: [
        ...Array.from({ length: 300 }, (_, index) => prefilterRegressionRow(`prefilter_protected_${index}`, `necklace protected world rule ${index}`, 0.5, 'world_rule')),
        ...Array.from({ length: 60 }, (_, index) => prefilterRegressionRow(`prefilter_fallback_${index}`, `random archive candle hallway ${index}`, 0.1))
      ]
    };
    const prefilterProtectedSignature = buildRetrievalQuerySignature(prefilterProtectedStore, 'necklace', { ...DEFAULT_SETTINGS, mode: 'fast' });
    const prefilterProtectedRows = prefilterRetrievalRows(prefilterProtectedStore.index, prefilterProtectedSignature, { ...DEFAULT_SETTINGS, mode: 'fast' });
    check('prefilter_preserves_force_rows_before_fallback', prefilterProtectedRows.length === RETRIEVAL_PREFILTER_KEEP_LIMITS.fast && prefilterProtectedRows.every(row => row.category === 'world_rule'));
    check('prefilter_protected_re_matches_index_protected_slots', PROTECTED_INDEX_SLOTS.every(slot => RETRIEVAL_PREFILTER_PROTECTED_RE.test(slot.category)));
    const protectedSlotBudget = PROTECTED_INDEX_SLOTS.reduce((sum, slot) => sum + Number(slot.limit || 0), 0);
    check('protected_index_slot_budget_within_index_limit', protectedSlotBudget <= INDEX_ROW_LIMIT);
    check('protected_index_slots_and_important_floor_fit_index_limit', protectedSlotBudget + DEFAULT_SETTINGS.importantLimit <= INDEX_ROW_LIMIT);
    const importantFloorRows = [
      ...PROTECTED_INDEX_SLOTS.flatMap(slot => Array.from({ length: slot.limit }, (_, index) => ({
        ...prefilterRegressionRow(`slot_${slot.axis}_${slot.category}_${index}`, `slot filler ${slot.category} ${index}`, 0.4, slot.category),
        axis: slot.axis
      }))),
      ...Array.from({ length: DEFAULT_SETTINGS.importantLimit }, (_, index) => ({
        ...prefilterRegressionRow(`important_floor_${index}`, `important floor row ${index}`, 0.99 - index * 0.0001, 'unprotected_important'),
        axis: 'narrative'
      }))
    ];
    const importantSelected = selectProtectedIndexRows(importantFloorRows, INDEX_ROW_LIMIT);
    check('protected_index_honors_important_floor_before_slots', Array.from({ length: DEFAULT_SETTINGS.importantLimit }, (_, index) => `important_floor_${index}`).every(id => importantSelected.some(row => row.id === id)));
    check('protected_index_honors_slots_after_important_floor', PROTECTED_INDEX_SLOTS.every(slot => importantSelected.filter(row => row.axis === slot.axis && row.category === slot.category).length === slot.limit));
    const dynamicSlotKeys = ['planner/next_direction', 'planner/suggested_hook', 'narrative/state'];
    check('protected_index_covers_dynamic_packet_categories', dynamicSlotKeys.every(key => {
      const [axis, category] = key.split('/');
      return PROTECTED_INDEX_SLOTS.some(slot => slot.axis === axis && slot.category === category && Number(slot.limit || 0) > 0);
    }));
    const dynamicCriticalRows = [
      { axis: 'planner', category: 'next_direction', id: 'critical_next_direction_row', body: 'critical next direction token', importance: 0.45 },
      { axis: 'planner', category: 'suggested_hook', id: 'critical_suggested_hook_row', body: 'critical suggested hook token', importance: 0.45 },
      { axis: 'narrative', category: 'state', id: 'critical_narrative_state_row', body: 'critical narrative state token', importance: 0.45 }
    ];
    const dynamicProtectedRows = [
      ...PROTECTED_INDEX_SLOTS.flatMap(slot => {
        const reserveCritical = dynamicCriticalRows.some(row => row.axis === slot.axis && row.category === slot.category);
        const count = Math.max(0, slot.limit - (reserveCritical ? 1 : 0));
        return Array.from({ length: count }, (_, index) => ({
          ...prefilterRegressionRow(`dynamic_slot_${slot.axis}_${slot.category}_${index}`, `dynamic slot filler ${slot.category} ${index}`, 0.4, slot.category),
          axis: slot.axis
        }));
      }),
      ...dynamicCriticalRows.map(row => ({
        ...prefilterRegressionRow(row.id, row.body, row.importance, row.category),
        axis: row.axis
      })),
      ...Array.from({ length: DEFAULT_SETTINGS.importantLimit }, (_, index) => ({
        ...prefilterRegressionRow(`dynamic_important_floor_${index}`, `dynamic important floor row ${index}`, 0.99 - index * 0.0001, 'unprotected_important'),
        axis: 'narrative'
      })),
      ...Array.from({ length: 48 }, (_, index) => ({
        ...prefilterRegressionRow(`dynamic_high_filler_${index}`, `dynamic high filler ${index}`, 0.74, 'unprotected_high'),
        axis: 'planner'
      }))
    ];
    const dynamicSelected = selectProtectedIndexRows(dynamicProtectedRows, INDEX_ROW_LIMIT);
    check('protected_index_keeps_dynamic_packet_rows_under_saturation', dynamicCriticalRows.every(row => dynamicSelected.some(selected => selected.id === row.id)));
    const plannerCrowdingStore = {
      ...emptyStore(),
      index: [
        ...Array.from({ length: 20 }, (_, index) => ({
          ...prefilterRegressionRow(`crowding_lock_${index}`, `unrelated continuity lock filler ${index}`, 0.4, 'continuity_lock'),
          axis: 'planner'
        })),
        {
          ...prefilterRegressionRow('crowding_next_direction', 'crowding_next_direction_token', 0.45, 'next_direction'),
          axis: 'planner'
        }
      ]
    };
    const plannerCrowdingSearch = searchIndex(plannerCrowdingStore, 'crowding_next_direction_token', { ...DEFAULT_SETTINGS, mode: 'deep', maxItemsPerAxis: 12 });
    check('planner_dynamic_exact_query_not_crowded_by_unrelated_locks', plannerCrowdingSearch.planner.some(row => row.id === 'crowding_next_direction'));
    const packetRecallRegression = (packet, hash = `packet_recall_${stableHash64(JSON.stringify(packet))}`, sourceMeta = {}) => {
      const store = emptyStore();
      const result = ingestPacket(store, JSON.stringify(packet), hash, { messageIndex: 1, distanceFromLatest: 0, chatRecency: 1, ...sourceMeta });
      rebuildIndex(store);
      return { store, result };
    };
    const worldSensoryRecall = packetRecallRegression({
      meta: { schema: 'hayaku_packet_v1' },
      entity: {},
      world: { sensory: 'only_sensory_token_celadon' },
      narrative: {},
      planner: {},
      importance: { overall: 0.8 }
    }, 'packet_recall_world_sensory');
    const worldSensorySearch = searchIndex(worldSensoryRecall.store, 'only_sensory_token_celadon', { ...DEFAULT_SETTINGS, mode: 'deep', maxItemsPerAxis: 8 });
    check('packet_recall_indexes_world_sensory_only', worldSensoryRecall.result.ok && worldSensoryRecall.store.index.some(row => row.axis === 'world' && row.category === 'current_state' && /only_sensory_token_celadon/.test(row.publicText)) && worldSensorySearch.world.some(row => row.category === 'current_state'));
    const narrativePacingRecall = packetRecallRegression({
      meta: { schema: 'hayaku_packet_v1' },
      entity: {},
      world: {},
      narrative: { pacing: 'only_pacing_token_damask', time_elapsed: 'only_elapsed_token_egret' },
      planner: {},
      importance: { overall: 0.8 }
    }, 'packet_recall_narrative_pacing');
    const narrativePacingSearch = searchIndex(narrativePacingRecall.store, 'only_pacing_token_damask', { ...DEFAULT_SETTINGS, mode: 'deep', maxItemsPerAxis: 8 });
    check('packet_recall_indexes_narrative_pacing_only', narrativePacingRecall.store.index.some(row => row.axis === 'narrative' && row.category === 'state' && /only_pacing_token_damask/.test(row.publicText)) && narrativePacingSearch.narrative.some(row => row.category === 'state'));
    const packetQualitySourceMeta = {
      sourceEvidence: {
        lines: ['visible source line without exact packet-only structural fields'],
        allLines: ['visible source line without exact packet-only structural fields'],
        allText: 'visible source line without exact packet-only structural fields'
      }
    };
    const worldSensoryQuality = packetRecallRegression({
      meta: { schema: 'hayaku_packet_v1' },
      entity: {},
      world: { sensory: 'only_sensory_quality_token', scent: 'only_scent_quality_token', confidence: 0.9 },
      narrative: {},
      planner: {},
      importance: { overall: 0.8 }
    }, 'packet_quality_world_sensory', packetQualitySourceMeta);
    const worldSensoryQualityItem = ensureArray(worldSensoryQuality.store.world?.items).find(item => item.type === 'current_state');
    check('packet_quality_treats_world_sensory_as_structural_state', worldSensoryQualityItem?._packetQuality?.score >= 0.62 && !ensureArray(worldSensoryQualityItem?.qualityFlags).some(flag => /packet_quality_low|packet_quality_softened/i.test(text(flag))) && Number(worldSensoryQualityItem?.confidence) === 0.9);
    const narrativePacingQuality = packetRecallRegression({
      meta: { schema: 'hayaku_packet_v1' },
      entity: {},
      world: {},
      narrative: { pacing: 'only_pacing_quality_token', time_elapsed: 'only_elapsed_quality_token', confidence: 0.9 },
      planner: {},
      importance: { overall: 0.8 }
    }, 'packet_quality_narrative_pacing', packetQualitySourceMeta);
    const narrativePacingQualityItem = ensureArray(narrativePacingQuality.store.narrative?.items).find(item => item.title === '내러티브 상태');
    check('packet_quality_treats_narrative_pacing_as_structural_state', narrativePacingQualityItem?._packetQuality?.score >= 0.62 && !ensureArray(narrativePacingQualityItem?.qualityFlags).some(flag => /packet_quality_low|packet_quality_softened/i.test(text(flag))) && Number(narrativePacingQualityItem?.confidence) === 0.9);
    const plannerDynamicRecall = packetRecallRegression({
      meta: { schema: 'hayaku_packet_v1' },
      entity: {},
      world: {},
      narrative: {},
      planner: {
        next_direction: [{ label: 'only_next_token_fennel' }],
        suggested_hooks: [{ label: 'only_hook_token_grove' }],
        open_invitations: [{ label: 'only_open_token_harbor' }]
      },
      importance: { overall: 0.8 }
    }, 'packet_recall_planner_dynamic');
    const plannerDynamicCategories = new Set(plannerDynamicRecall.store.index.filter(row => row.axis === 'planner').map(row => row.category));
    const plannerNextSearch = searchIndex(plannerDynamicRecall.store, 'only_next_token_fennel', { ...DEFAULT_SETTINGS, mode: 'deep', maxItemsPerAxis: 8 });
    const plannerHookSearch = searchIndex(plannerDynamicRecall.store, 'only_hook_token_grove', { ...DEFAULT_SETTINGS, mode: 'deep', maxItemsPerAxis: 8 });
    const plannerOpenSearch = searchIndex(plannerDynamicRecall.store, 'only_open_token_harbor', { ...DEFAULT_SETTINGS, mode: 'deep', maxItemsPerAxis: 8 });
    check('packet_recall_preserves_planner_dynamic_categories', ['next_direction', 'suggested_hook', 'open_invitation'].every(category => plannerDynamicCategories.has(category)));
    check('packet_recall_selects_planner_dynamic_items', plannerNextSearch.planner.some(row => row.category === 'next_direction') && plannerHookSearch.planner.some(row => row.category === 'suggested_hook') && plannerOpenSearch.planner.some(row => row.category === 'open_invitation'));
    const previousTurnBridgePacket = {
      meta: {
        schema: 'hayaku_packet_v1',
        packet_type: 'current_snapshot',
        packet_schema_rev: 2,
        scene_id: 'bridge_scene_alpha',
        turn_anchor: 'only_bridge_anchor_token_cobalt',
        active_speaker: '리아',
        visible_participants: ['리아', '하루'],
        summary_memory: {
          summary: '직전 턴에서 only_bridge_summary_token_cobalt 약속이 남아 있음',
          recallAnchors: ['only_bridge_anchor_token_cobalt', 'object:bridge_cobalt'],
          canonicalAnchors: ['object:bridge_cobalt'],
          mentionedEntityNames: ['리아', '하루']
        }
      },
      entity: { characters: [{ name: '리아', current_state: 'only_bridge_character_token_cobalt 상태 유지' }] },
      world: { location: 'bridge_room', active_events: [] },
      narrative: { scene_phase: 'pause', conflict_traces: [{ summary: 'only_bridge_conflict_token_cobalt unresolved' }] },
      planner: { next_direction: [{ label: 'only_bridge_next_token_cobalt' }] },
      importance: { overall: 0.82, reason: ['previous turn bridge regression'] }
    };
    const previousTurnBridgeMessages = [
      { role: 'assistant', content: `visible\n\n<!-- ${PACKET_START}\n${JSON.stringify(previousTurnBridgePacket)}\n${PACKET_END} -->` },
      { role: 'user', content: '<Current Input>\n계속\n</Current Input>' }
    ];
    const previousTurnBridgePackets = extractPackets(previousTurnBridgeMessages, requestScopeForMessages(previousTurnBridgeMessages));
    const previousTurnBridge = buildPreviousTurnRecallBridge(previousTurnBridgeMessages, previousTurnBridgePackets, '계속', DEFAULT_SETTINGS);
    check('previous_turn_recall_bridge_builds_for_continuation_query',
      previousTurnBridge.active === true
      && previousTurnBridge.mode === 'strong'
      && previousTurnBridge.sourceMessageIndex === 0
      && previousTurnBridge.query.includes('only_bridge_next_token_cobalt')
      && previousTurnBridge.query.includes('bridge_scene_alpha'));
    const resetPreviousTurnBridge = buildPreviousTurnRecallBridge(previousTurnBridgeMessages, previousTurnBridgePackets, '다음 날 새 장면으로 넘어간다', DEFAULT_SETTINGS);
    check('previous_turn_recall_bridge_disables_on_scene_shift',
      resetPreviousTurnBridge.active === false
      && resetPreviousTurnBridge.reason === 'scene_shift_query');
    const previousTurnBridgeRecall = packetRecallRegression(previousTurnBridgePacket, 'previous_turn_bridge_packet');
    const previousTurnBridgeSearch = searchIndex(previousTurnBridgeRecall.store, previousTurnBridge.query, { ...DEFAULT_SETTINGS, mode: 'deep', maxItemsPerAxis: 8 });
    check('previous_turn_recall_bridge_selects_prior_packet_continuity',
      previousTurnBridgeSearch.planner.some(row => /only_bridge_next_token_cobalt/.test(row.publicText))
      || previousTurnBridgeSearch.narrative.some(row => /only_bridge_conflict_token_cobalt/.test(row.publicText))
      || previousTurnBridgeSearch.entity.some(row => /only_bridge_character_token_cobalt/.test(row.publicText)));
    const bridgeSelectionOldRaw = JSON.stringify({
      meta: { schema: 'hayaku_packet_v1', packet_type: 'current_snapshot', summary_memory: { summary: 'older packet only_bridge_next_token_cobalt detail' } },
      entity: {},
      world: {},
      narrative: {},
      planner: {},
      importance: { overall: 0.2 }
    });
    const bridgeSelectionFillerRaw = JSON.stringify({
      meta: { schema: 'hayaku_packet_v1', packet_type: 'current_snapshot', summary_memory: { summary: 'filler packet' } },
      entity: {},
      world: {},
      narrative: {},
      planner: {},
      importance: { overall: 0.2 }
    });
    const bridgeSelectionPackets = Array.from({ length: 8 }, (_, index) => {
      const raw = index === 0 ? bridgeSelectionOldRaw : (index === 7 ? JSON.stringify(previousTurnBridgePacket) : bridgeSelectionFillerRaw);
      return { raw, hash: `bridge_selection_${index}_${stableHash64(raw)}`, messageIndex: index, messageCount: 9, distanceFromLatest: 8 - index, chatRecency: index / 8 };
    });
    const bridgeSelectionPlain = selectPacketsForIngest(bridgeSelectionPackets, '계속', { ...DEFAULT_SETTINGS, mode: 'balanced' });
    const bridgeSelectionWithBridge = selectPacketsForIngest(bridgeSelectionPackets, previousTurnBridge.query, { ...DEFAULT_SETTINGS, mode: 'balanced' });
    check('previous_turn_recall_bridge_selects_old_relevant_packet_for_ingest',
      !bridgeSelectionPlain.packets.some(packet => packet.hash === bridgeSelectionPackets[0].hash)
      && bridgeSelectionWithBridge.packets.some(packet => packet.hash === bridgeSelectionPackets[0].hash));
    const pronounBridgePacket = {
      meta: {
        schema: 'hayaku_packet_v1',
        packet_type: 'current_snapshot',
        packet_schema_rev: 2,
        scene_id: 'pronoun_scene_alpha',
        turn_anchor: '리아가 문가에서 멈춰 선 뒤 아직 대답하지 않았다',
        pov_entity: '리아',
        active_speaker: '하루',
        visible_participants: ['리아', '하루'],
        summary_memory: {
          summary: '리아는 feminine_hint_token 여성이며 아직 말하지 않은 약속을 품고 있다',
          mentionedEntityNames: ['리아', '하루'],
          recallAnchors: ['only_pronoun_lia_token'],
          canonicalAnchors: ['person:lia']
        }
      },
      entity: {
        characters: [
          { name: '리아', gender: 'female', current_state: 'only_pronoun_lia_token 말을 꺼내려는 상태' },
          { name: '하루', gender: 'male', current_state: '하루는 기다리는 중' }
        ]
      },
      world: { location: 'pronoun_room' },
      narrative: { scene_phase: 'pause' },
      planner: { next_direction: [{ label: '리아가 대답할 차례' }] },
      importance: { overall: 0.82, reason: ['pronoun bridge regression'] }
    };
    const pronounBridgeMessages = [
      { role: 'assistant', content: `visible\n\n<!-- ${PACKET_START}\n${JSON.stringify(pronounBridgePacket)}\n${PACKET_END} -->` },
      { role: 'user', content: '<Current Input>\n그녀가 말했다\n</Current Input>' }
    ];
    const pronounBridgePackets = extractPackets(pronounBridgeMessages, requestScopeForMessages(pronounBridgeMessages));
    const pronounBridge = buildPreviousTurnRecallBridge(pronounBridgeMessages, pronounBridgePackets, '그녀가 말했다', DEFAULT_SETTINGS);
    check('pronoun_recall_bridge_ranks_feminine_scene_candidate',
      pronounBridge.active === true
      && pronounBridge.pronounBridge?.candidates?.[0]?.name === '리아'
      && pronounBridge.pronounBridge?.candidates?.[0]?.confidence >= pronounBridge.pronounBridge?.candidates?.[1]?.confidence
      && pronounBridge.query.includes('pronoun_candidates')
      && pronounBridge.query.includes('only_pronoun_lia_token'));
    const pronounBridgeRecall = packetRecallRegression(pronounBridgePacket, 'pronoun_bridge_packet');
    const pronounBridgeSearch = searchIndex(pronounBridgeRecall.store, pronounBridge.query, { ...DEFAULT_SETTINGS, mode: 'deep', maxItemsPerAxis: 8 });
    check('pronoun_recall_bridge_recalls_ranked_candidate_row',
      pronounBridgeSearch.entity.some(row => /only_pronoun_lia_token/.test(row.publicText)));
    const pronounStateOnlyPacket = {
      meta: {
        schema: 'hayaku_packet_v1',
        packet_type: 'current_snapshot',
        packet_schema_rev: 2,
        scene_id: 'pronoun_state_only_scene',
        turn_anchor: '그녀가 문 앞에서 숨을 골랐다',
        pov_entity: '현지유',
        active_speaker: '푸딩',
        visible_participants: ['현지유', '푸딩'],
        summary_memory: {
          mentionedEntityNames: ['현지유', '푸딩'],
          recallAnchors: ['only_pronoun_state_field_token']
        }
      },
      entity: {
        characters: [
          { name: '현지유', aliases: ['지유'], state: 'only_pronoun_state_field_token state 필드만 있는 상태', status: 'active' },
          { name: '푸딩', aliases: ['Puding'], state: '기다리는 상태', status: 'active' }
        ]
      },
      world: { location: 'state_only_room' },
      narrative: { scene_phase: 'pause' },
      planner: {},
      importance: { overall: 0.78, reason: ['state field bridge regression'] }
    };
    const pronounStateOnlyMessages = [
      { role: 'assistant', content: `visible\n\n<!-- ${PACKET_START}\n${JSON.stringify(pronounStateOnlyPacket)}\n${PACKET_END} -->` },
      { role: 'user', content: '<Current Input>\n그녀가 말했다\n</Current Input>' }
    ];
    const pronounStateOnlyPackets = extractPackets(pronounStateOnlyMessages, requestScopeForMessages(pronounStateOnlyMessages));
    const pronounStateOnlyBridge = buildPreviousTurnRecallBridge(pronounStateOnlyMessages, pronounStateOnlyPackets, '그녀가 말했다', DEFAULT_SETTINGS);
    check('previous_turn_bridge_reads_character_state_field',
      pronounStateOnlyBridge.query.includes('only_pronoun_state_field_token')
      && pronounStateOnlyBridge.pronounBridge?.candidates?.[0]?.name === '현지유'
      && pronounStateOnlyBridge.pronounBridge?.candidates?.[0]?.confidence >= pronounStateOnlyBridge.pronounBridge?.candidates?.[1]?.confidence);
    const typedCollectionRecall = packetRecallRegression({
      meta: { schema: 'hayaku_packet_v1' },
      entity: {},
      world: {
        world_rules: [{ type: 'magic_rule', rule: 'typed_world_rule_token_dusk' }],
        active_events: [{ type: 'festival', event: 'typed_event_token_ember' }]
      },
      narrative: {},
      planner: {
        next_direction: [{ type: 'choice', label: 'typed_next_token_amber' }],
        suggested_hooks: [{ type: 'hook_seed', label: 'typed_hook_token_birch' }],
        open_invitations: [{ type: 'option', label: 'typed_open_token_cedar' }]
      },
      importance: { overall: 0.8 }
    }, 'packet_recall_typed_collections');
    const typedCategories = new Set(typedCollectionRecall.store.index.map(row => `${row.axis}/${row.category}`));
    check('packet_collection_type_field_does_not_override_category', [
      'world/world_rule',
      'world/active_event',
      'planner/next_direction',
      'planner/suggested_hook',
      'planner/open_invitation'
    ].every(category => typedCategories.has(category)));
    check('packet_collection_preserves_inner_type_as_item_type', [
      ...ensureArray(typedCollectionRecall.store.world?.items),
      ...ensureArray(typedCollectionRecall.store.planner?.items)
    ].some(item => item.item_type === 'magic_rule' && item.type === 'world_rule')
      && ensureArray(typedCollectionRecall.store.planner?.items).some(item => item.item_type === 'choice' && item.type === 'next_direction'));
    check('fast_protected_signal_keeps_planner_dynamic_fields', [
      { planner: { continuityLocks: [{ label: 'camel lock' }] } },
      { planner: { doNotResolveYet: [{ label: 'camel avoid' }] } },
      { meta: { consentMemory: { limits: ['camel limit'] } } },
      { planner: { next_direction: [{ label: 'old next pressure' }] } },
      { planner: { nextResponseDirection: [{ label: 'camel next pressure' }] } },
      { planner: { suggested_hooks: [{ label: 'old hook pressure' }] } },
      { planner: { suggestedHooks: [{ label: 'camel hook pressure' }] } },
      { planner: { open_invitations: [{ label: 'old open choice' }] } },
      { planner: { openInvitations: [{ label: 'camel open choice' }] } },
      { planner: { avoid: [{ label: 'old avoid alias' }] } },
      { entity: { characters: [{ name: '하루', current_state: 'old character state' }] } },
      { entity: { character: [{ name: '리아', current_state: 'old character alias state' }] } },
      { entity: { people: [{ name: '린', current_state: 'old people alias state' }] } },
      { entity: { relations: [{ from: '하루', to: '리아', state: 'trust' }] } },
      { entity: { relationships: [{ from: '하루', to: '리아', state: 'camel trust' }] } },
      { entity: { secrets: [{ title: 'old secret without reveal state', summary: 'hidden boundary' }] } },
      { entity: { secret_boundaries: [{ title: 'old secret alias', summary: 'hidden boundary' }] } },
      { entity: { hiddenKnowledge: [{ summary: 'camel hidden knowledge' }] } },
      { entity: { privateThoughts: [{ summary: 'camel private thought' }] } },
      { entity: { pov_memories: [{ ownerEntityId: '리아', summary: 'owner scoped memory' }] } },
      { entity: { povMemories: [{ ownerEntityId: '리아', summary: 'camel owner scoped memory' }] } },
      { entity: { knowledge: [{ ownerEntityId: '리아', summary: 'legacy owner scoped memory' }] } },
      { world: { active_events: [{ event: 'old active event' }] } },
      { world: { location: 'old archive', time: 'night', sensory: 'dust and candle smoke' } },
      { world: { events: [{ event: 'old event alias' }] } },
      { world: { world_rules: [{ rule: 'old world rule' }] } },
      { world: { worldRules: [{ rule: 'camel world rule' }] } },
      { world: { rules: [{ rule: 'old rule alias' }] } },
      { world: { offscreen_threads: [{ summary: 'old offscreen pressure' }] } },
      { world: { factions: [{ name: 'old faction' }] } },
      { world: { regions: [{ name: 'old region' }] } },
      { narrative: { conflicts: [{ summary: 'old conflict alias' }] } },
      { narrative: { scene_deltas: [{ summary: 'old scene delta' }] } },
      { narrative: { sceneDeltas: [{ summary: 'camel scene delta' }] } },
      { narrative: { deltas: [{ summary: 'old delta alias' }] } },
      { narrative: { theme_motifs: [{ motif: 'old theme motif' }] } },
      { narrative: { themeMotifs: [{ motif: 'camel theme motif' }] } },
      { narrative: { motifs: [{ motif: 'old motif alias' }] } },
      { planner: { consequence_ledger: [{ summary: 'old consequence' }] } },
      { planner: { payoffTracker: [{ label: 'camel payoff' }] } },
      { meta: { summary_memory: { summary: 'old summary memory' } } },
      { meta: { canonicalAnchors: ['object:old_key'] } },
      { meta: { canonical_anchors: ['object:old_key_snake'] } },
      { meta: { canonicalTokens: ['object:old_key_token'] } },
      { meta: { canonical_tokens: ['object:old_key_token_snake'] } },
      { meta: { speaker_boundaries: [{ speaker: '리아', summary: 'voice boundary' }] } },
      { meta: { patternGuard: [{ summary: 'avoid repetition' }] } },
      { meta: { overpromotion_risks: [{ summary: 'do not overpromote' }] } }
    ].every(packet => FAST_PROTECTED_PACKET_SIGNAL_RE.test(JSON.stringify(packet))));
    check('fast_protected_signal_ignores_world_alias_words_in_values', [
      { entity: { notes: [{ text: 'argues about rules at dinner' }] } },
      { entity: { notes: [{ text: 'attends old events downtown' }] } },
      { entity: { notes: [{ text: 'relationship talk follows rules of courtesy' }] } }
    ].every(packet => !FAST_PROTECTED_PACKET_SIGNAL_RE.test(JSON.stringify(packet))));
    const turnAnchorRecall = packetRecallRegression({
      meta: { schema: 'hayaku_packet_v1', scene_id: 'scene-turn-anchor', turn_anchor: 'turn_anchor_token_iris' },
      entity: {},
      world: {},
      narrative: {},
      planner: {},
      importance: { overall: 0.6 }
    }, 'packet_recall_turn_anchor');
    check('packet_meta_turn_anchor_updates_scene_anchor', turnAnchorRecall.store.context?.sceneAnchors?.turnHint === 'turn_anchor_token_iris');
    const topCanonicalRecall = packetRecallRegression({
      meta: { schema: 'hayaku_packet_v1', canonicalAnchors: ['object:topaz_key'] },
      entity: {},
      world: {},
      narrative: {},
      planner: {},
      importance: { overall: 0.6 }
    }, 'packet_recall_top_canonical');
    const topCanonicalSearch = searchIndex(topCanonicalRecall.store, 'object:topaz_key', { ...DEFAULT_SETTINGS, mode: 'deep', maxItemsPerAxis: 8 });
    check('packet_meta_top_canonical_anchor_recalls_summary_memory', topCanonicalRecall.store.index.some(row => row.axis === 'narrative' && row.category === 'summary_memory') && topCanonicalSearch.narrative.some(row => row.category === 'summary_memory'));
    const shapeWarnings = validatePacketShape({
      meta: { schema: 'hayaku_packet_v1' },
      entity: { characters: { character1: { name: '하루' } } },
      world: {},
      narrative: {},
      planner: {},
      extra_axis: {}
    });
    check('packet_shape_warns_unknown_top_key', shapeWarnings.includes('unknown_top_key:extra_axis'));
    check('packet_shape_warns_non_array_collection', shapeWarnings.includes('non_array_collection:entity.characters'));
    const coercedPacket = coercePacketCollections({
      entity: { characters: { character1: { name: '하루' } } },
      planner: { consequence_ledger: { consequence1: '약속의 여파' } }
    });
    check('coerce_packet_collection_object_map_to_array', Array.isArray(coercedPacket.entity.characters) && coercedPacket.entity.characters[0]?.ref === 'character1' && coercedPacket.entity.characters[0]?.name === '하루');
    check('coerce_packet_collection_scalar_map_value', Array.isArray(coercedPacket.planner.consequence_ledger) && coercedPacket.planner.consequence_ledger[0]?.ref === 'consequence1' && coercedPacket.planner.consequence_ledger[0]?.summary === '약속의 여파');
    const scalarCollectionWarnings = validatePacketShape({ planner: { next_direction: '다음 방향' } });
    check('scalar_collection_singleton_does_not_shape_warn', !scalarCollectionWarnings.includes('non_array_collection:planner.next_direction'));
    const singletonCoercedPacket = coercePacketCollections({
      planner: {
        next_direction: '다음 방향',
        suggested_hooks: { label: '복도 끝 발소리', importance: 0.6 }
      }
    });
    check('coerce_packet_collection_scalar_singleton_to_array', Array.isArray(singletonCoercedPacket.planner.next_direction) && singletonCoercedPacket.planner.next_direction[0] === '다음 방향');
    check('coerce_packet_collection_single_object_to_array', Array.isArray(singletonCoercedPacket.planner.suggested_hooks) && singletonCoercedPacket.planner.suggested_hooks[0]?.label === '복도 끝 발소리');
    const payoverCounts = countPacketItems({ planner: { payover_tracker: ['오타 복선'] } });
    check('payover_tracker_legacy_typo_alias_counted', payoverCounts.plannerItems === 1);
    const legacyPovMemory = normalizePovMemory({ owner: '푸딩', type: 'experienced', content: '세연이 걱정했다', salience: 0.8, pressure: 0.3 });
    check('legacy_pov_owner_type_content_salience_preserved', legacyPovMemory.ownerEntityId === '푸딩' && legacyPovMemory.memoryType === 'experienced' && legacyPovMemory.text.includes('세연') && legacyPovMemory.salience === 0.8 && legacyPovMemory.pressure === 0.3);
    const legacyExtraText = itemText({ detail: '가벼운 대화', knowledge_boundary: ['카페 정보 모름'], impression_seyeon: '웃는 얼굴이 의외였다' });
    check('legacy_extra_packet_text_fields_indexed', /가벼운 대화/.test(legacyExtraText) && /카페 정보 모름/.test(legacyExtraText) && /웃는 얼굴/.test(legacyExtraText));
    const knownSimpleHashCollisionA = '{"meta":{"schema":"hayaku_packet_v1"},"narrative":{"scene_phase":"phase_38250","current_arc":"arc_3435948106"},"planner":{"next_direction":[{"label":"next_38250"}]},"importance":{"overall":0.5}}';
    const knownSimpleHashCollisionB = '{"meta":{"schema":"hayaku_packet_v1"},"narrative":{"scene_phase":"phase_70343","current_arc":"arc_1566509719"},"planner":{"next_direction":[{"label":"next_70343"}]},"importance":{"overall":0.5}}';
    const collisionStore = emptyStore();
    const collisionHashA = stableHash64(knownSimpleHashCollisionA);
    const collisionHashB = stableHash64(knownSimpleHashCollisionB);
    const collisionResultA = ingestPacket(collisionStore, knownSimpleHashCollisionA, collisionHashA, { messageIndex: 1, distanceFromLatest: 1, chatRecency: 0.8 });
    const collisionResultB = ingestPacket(collisionStore, knownSimpleHashCollisionB, collisionHashB, { messageIndex: 2, distanceFromLatest: 0, chatRecency: 1 });
    check('packet_hash_uses_64bit_for_known_32bit_collision_pair', simpleHash(knownSimpleHashCollisionA) === simpleHash(knownSimpleHashCollisionB) && collisionHashA !== collisionHashB);
    check('packet_hash_collision_pair_ingests_both_packets', collisionResultA.ok && !collisionResultA.skipped && collisionResultB.ok && !collisionResultB.skipped && collisionStore.ingestedPacketHashes.length === 2);
    const extractedCollisionPackets = extractPackets([
      { role: 'assistant', content: `<!-- ${PACKET_START}\n${knownSimpleHashCollisionA}\n${PACKET_END} -->` },
      { role: 'assistant', content: `<!-- ${PACKET_START}\n${knownSimpleHashCollisionB}\n${PACKET_END} -->` }
    ]);
    const extractedCollisionHashes = extractedCollisionPackets.map(packet => packet.hash);
    check('extract_packets_hashes_known_32bit_collision_pair_as_distinct', extractedCollisionPackets.length === 2 && new Set(extractedCollisionHashes).size === 2 && extractedCollisionHashes.every(hash => /^h64/.test(hash)));
    const minorShapeHealth = computePacketHealth([], {
      context: { packetHealthSignals: [{ packetShapeWarningsRecently: true, packetShapeWarnings: ['unknown_top_key:debug_note'] }] }
    });
    const criticalShapeHealth = computePacketHealth([], {
      context: { packetHealthSignals: [{ packetShapeWarningsRecently: true, packetShapeWarnings: ['non_array_collection:entity.characters'] }] }
    });
    check('minor_shape_warning_does_not_force_full', minorShapeHealth.packetShapeWarningsRecently === true && minorShapeHealth.criticalPacketShapeWarningsRecently === false && minorShapeHealth.forceFullNextTurn === false);
    check('critical_shape_warning_forces_full', criticalShapeHealth.criticalPacketShapeWarningsRecently === true && criticalShapeHealth.forceFullNextTurn === true);
    const budgetFixtureLines = [
      INJECTION_HEADER,
      'budget fixture header',
      'budget fixture metadata',
      'budget fixture mode',
      'x'.repeat(80),
      '[HAYAKU STATE VIEW USAGE RULE]',
      'preserved rule'
    ];
    const budgetFixtureSettings = { promptMode: 'balanced', injectionCapChars: 180, tailReserveChars: 20 };
    const budgetFixtureBlock = finalizeContinuityContext(budgetFixtureLines, budgetFixtureSettings);
    check('mode_cap_limits_total_context_block', budgetFixtureBlock.length <= injectionBlockCapForSettings(budgetFixtureSettings) && budgetFixtureBlock.includes('…\n[HAYAKU STATE VIEW USAGE RULE]'));
    check('mode_cap_variable_budget_uses_fixed_rules', variableStateViewLength(budgetFixtureBlock) <= variableStateViewBudget(budgetFixtureSettings, budgetFixtureBlock) + 2);
    check('default_prompt_mode_uses_auto', DEFAULT_SETTINGS.promptMode === 'auto');
    check('long_memory_injection_caps_are_restored', modeInjectionCap('balanced') === 22000 && modeInjectionCap('full') === 30000);
    check('long_memory_state_view_budgets_are_restored', stateViewCharBudgetForMode('balanced') === 8500 && stateViewCharBudgetForMode('full') === 14000);
    const footerFixtureLines = [
      INJECTION_HEADER,
      'footer fixture header',
      'footer fixture metadata',
      'footer fixture mode',
      'x'.repeat(600),
      '[HAYAKU STATE VIEW USAGE RULE]',
      'r'.repeat(900),
      INJECTION_FOOTER
    ];
    const footerFixtureSettings = { promptMode: 'balanced', injectionCapChars: 520, tailReserveChars: 0 };
    const footerFixtureBlock = finalizeContinuityContext(footerFixtureLines, footerFixtureSettings);
    check('mode_cap_trim_preserves_context_footer', footerFixtureBlock.length <= injectionBlockCapForSettings(footerFixtureSettings) && footerFixtureBlock.endsWith(INJECTION_FOOTER));
    check('default_performance_mode_uses_auto', DEFAULT_SETTINGS.mode === 'auto');
    check('auto_performance_mode_defaults_balanced', resolvePerformanceMode({ ...DEFAULT_SETTINGS, mode: 'auto' }, Array.from({ length: 24 }, () => ({ role: 'user', content: '계속' })), '계속').mode === 'balanced');
    check('explicit_performance_mode_is_not_auto_overridden', resolvePerformanceMode({ ...DEFAULT_SETTINGS, mode: 'fast' }, Array.from({ length: 24 }, () => ({ role: 'user', content: '예전 기록을 확인해줘' })), '예전 기록을 확인해줘').mode === 'fast');
    const previousRun = Memory.lastBeforeRequest;
    const perfMessages = (count, chatId, content = '계속') => Array.from({ length: count }, () => ({ role: 'user', chatId, content }));
    const perfScope = requestScopeForMessages(perfMessages(1, 'perf-scope'));
    Memory.lastBeforeRequest = { scopeKey: perfScope.key, scopeConfident: true, elapsedMs: 5200, budgetMs: 5000, budgetExceeded: true, packetSelection: { total: 80 }, packetScan: { packets: 80 } };
    check('auto_performance_mode_throttles_after_budget_pressure', resolvePerformanceMode({ ...DEFAULT_SETTINGS, mode: 'auto' }, perfMessages(300, 'perf-scope'), '계속').mode === 'fast');
    Memory.lastBeforeRequest = { scopeKey: perfScope.key, scopeConfident: true, elapsedMs: 1800, budgetMs: 5000, budgetExceeded: false, packetSelection: { total: 24 }, packetScan: { packets: 24 } };
    check('auto_performance_mode_uses_deep_for_manageable_past_recall', resolvePerformanceMode({ ...DEFAULT_SETTINGS, mode: 'auto' }, perfMessages(120, 'perf-scope', '기록'), '처음 만났던 기억을 확인해줘').mode === 'deep');
    Memory.lastBeforeRequest = { scopeKey: perfScope.key, scopeConfident: true, elapsedMs: 1800, budgetMs: 5000, budgetExceeded: false, packetSelection: { total: 320 }, packetScan: { packets: 320 } };
    check('auto_performance_mode_keeps_large_recall_at_balanced', resolvePerformanceMode({ ...DEFAULT_SETTINGS, mode: 'auto' }, perfMessages(2200, 'perf-scope', '기록'), '예전 관계 기록을 확인해줘').mode === 'balanced');
    const heavyScope = requestScopeForMessages(perfMessages(1, 'heavy-scope'));
    Memory.lastBeforeRequest = { at: now(), scopeKey: heavyScope.key, scopeConfident: true, elapsedMs: 1800, budgetMs: 5000, budgetExceeded: false, packetSelection: { total: 320 }, packetScan: { packets: 320 } };
    const freshOtherScopeMode = resolvePerformanceMode({ ...DEFAULT_SETTINGS, mode: 'auto' }, perfMessages(2, 'fresh-scope', '기록'), '처음 만났던 기억을 확인해줘');
    check('auto_performance_mode_ignores_previous_pressure_from_other_scope',
      freshOtherScopeMode.mode === 'deep'
      && freshOtherScopeMode.signals?.previousScopeMatched === false
      && freshOtherScopeMode.signals?.previousIgnoredReason === 'scope_mismatch');
    Memory.lastBeforeRequest = previousRun;
    const goldenRecall = runGoldenRecallTests();
    check('golden_recall_harness_passes', goldenRecall.ok, JSON.stringify(goldenRecall.failures.slice(0, 3)));
    return { ok: failures.length === 0, failures };
  };

  const handleBeforeRequest = async (messages = [], requestType = 'model') => {
    const startedAt = now();
    const stages = {};
    await loadSettings();
    const settings = Memory.settings;
    let requestBudgetMs = budgetForSettings(settings);
    const isBudgetExceeded = () => now() - startedAt > requestBudgetMs;
    let budgetExceeded = false;
    Memory.store = emptyStore();
    clearTokenSimilarityCache();
    clearNgramCache();
    const requestScope = requestScopeForMessages(messages, requestType);
    const initialPacketScanScope = syncPacketScanCacheScope(requestScope);
    const stage = (name, fn) => {
      const stageStartedAt = now();
      try {
        return fn();
      } finally {
        stages[name] = now() - stageStartedAt;
      }
    };
    const sanitizeAuxiliaryMessages = (requestClass, extra = {}) => {
      let hayakuPacketCharsRemoved = 0;
      const sanitizedMessages = stage('stripAuxiliaryPackets', () => ensureArray(messages).map(msg => {
        const result = stripHayakuFromMessagePayloads(msg);
        hayakuPacketCharsRemoved += result.removed;
        return result.message;
      }));
      Memory.lastBeforeRequest = {
        at: now(),
        skipped: true,
        sanitized: true,
        reason: requestClass.reason,
        requestType,
        scopeKey: requestScope.key || '',
        scopeConfident: requestScope.confident === true,
        scopeReason: requestScope.reason || '',
        packetScanCacheEnabled: initialPacketScanScope.enabled === true,
        packetScanCacheScopeCleared: initialPacketScanScope.cleared === true,
        stages,
        hayakuPacketCharsRemoved,
        elapsedMs: now() - startedAt,
        ...extra
      };
      debugLog('beforeRequest:skip', Memory.lastBeforeRequest);
      return sanitizedMessages;
    };
    try {
      debugLog('beforeRequest:start', { requestType, messages: ensureArray(messages).length });
      const configuredMainTypes = text(Memory.settings?.mainRequestTypes || '').trim()
        ? text(Memory.settings?.mainRequestTypes || '').split(/[\s,]+/).map(s => s.trim().toLowerCase()).filter(Boolean)
        : null;
      const requestClass = stage('classifyRequest', () => RequestKindCore.classify(requestType, messages, '', configuredMainTypes ? { mainTypes: configuredMainTypes } : {}));
      if (!settings.enabled) {
        if (requestClass.auxiliary) return sanitizeAuxiliaryMessages(requestClass, { disabled: true, reason: `disabled,${requestClass.reason}` });
        Memory.lastBeforeRequest = {
          at: now(),
          skipped: true,
          reason: 'disabled',
          requestType,
          scopeKey: requestScope.key || '',
          scopeConfident: requestScope.confident === true,
          scopeReason: requestScope.reason || '',
          packetScanCacheEnabled: initialPacketScanScope.enabled === true,
          packetScanCacheScopeCleared: initialPacketScanScope.cleared === true,
          stages,
          elapsedMs: now() - startedAt
        };
        return messages;
      }
      if (requestClass.auxiliary) {
        return sanitizeAuxiliaryMessages(requestClass);
      }
      const store = emptyStore();
      const query = stage('latestUserText', () => latestUserText(messages));
      const performanceMode = stage('resolvePerformanceMode', () => resolvePerformanceMode(settings, messages, query, { scope: requestScope }));
      settings.effectiveMode = performanceMode.mode;
      settings.effectiveModeReason = performanceMode.reason;
      settings.effectiveModeSignals = clone(performanceMode.signals || {}, {});
      requestBudgetMs = budgetForSettings(settings);
      const packets = stage('extractPackets', () => extractPackets(messages, requestScope));
      const packetRecovery = stage('packetRecovery', () => {
        const detected = detectPacketRecovery(messages, packets, settings);
        return isDetectedPacketRecoveryRequest(detected) ? detected : null;
      });
      const previousTurnRecallBridge = stage('previousTurnRecallBridge', () => buildPreviousTurnRecallBridge(messages, packets, query, settings));
      const retrievalQuery = previousTurnRecallBridge.active ? previousTurnRecallBridge.query : query;
      const packetSelection = stage('selectPackets', () => selectPacketsForIngest(packets, retrievalQuery, settings));
      const packetsToIngest = packetSelection.packets;
      if (packetSelection.stats?.skipped > 0) {
        debugLog('beforeRequest:packetSelection', packetSelection.stats);
      }
      debugLog('beforeRequest:packets', {
        packets: packets.length,
        ingesting: packetsToIngest.length,
        full: packetSelection.stats?.full || 0,
        light: packetSelection.stats?.light || 0,
        skipped: packetSelection.stats?.skipped || 0,
        recovery: packetRecovery?.active === true ? packetRecovery.reason : '',
        turn: store.turn || 0,
        index: ensureArray(store.index).length
      });
      let ingested = 0;
      let failed = 0;
      const packetResults = [];
      stage('ingestPackets', () => {
        for (const selectedPacket of packetsToIngest) {
          if (isBudgetExceeded()) {
            budgetExceeded = true;
            packetResults.push({ ok: false, reason: 'before_request_budget_exceeded', skipped: true });
            break;
          }
          const packet = materializeExtractedPacket(selectedPacket);
          if (!packet.raw) {
            packetResults.push({ ok: false, reason: 'empty_materialized_packet', messageIndex: packet.messageIndex, lightweightIngest: packet.lightweightIngest === true, selectionReason: packet.selectionReason || '' });
            failed += 1;
            continue;
          }
          const compactFull = packet.lightweightIngest !== true && settings.effectiveMode !== 'deep';
          const deferredEvidence = compactFull
            ? null
            : (packet.sourceEvidence || (packet.sourceEvidenceDeferred ? buildSourceEvidence(messages, packet.messageIndex, packet.raw, { lightweight: true }) : null));
          const ingestRaw = packet.lightweightIngest ? lightweightPacketRaw(packet.raw) : boundedPacketRaw(packet.raw);
          const sourceMeta = {
            ...packet,
            payloadBody: undefined,
            cheapText: undefined,
            raw: ingestRaw,
            sourceEvidence: deferredEvidence,
            originalRawLength: text(packet.raw).length,
            lightweightIngest: packet.lightweightIngest === true,
            compactFullIngest: packet.lightweightIngest !== true && settings.effectiveMode !== 'deep',
            selectionReason: packet.selectionReason || ''
          };
          const result = packet.lightweightIngest
            ? ingestLightPacketToStore(store, ingestRaw, packet.hash, sourceMeta)
            : ingestPacket(store, ingestRaw, packet.hash, sourceMeta);
          packetResults.push({
            ...result,
            hash: packet.hash,
            messageIndex: packet.messageIndex,
            lightweightIngest: packet.lightweightIngest === true,
            compactFullIngest: packet.lightweightIngest !== true && settings.effectiveMode !== 'deep',
            selectionReason: packet.selectionReason || ''
          });
          if (result.ok && !result.skipped) ingested += 1;
          if (!result.ok) failed += 1;
        }
      });
      if (ingested) await saveStore(store);
      stage('rebuildIndex', () => rebuildIndex(store));

      const currentMentionedEntities = stage('queryMentionedEntities', () => queryMentionedEntities(store, query));
      if (currentMentionedEntities.length) {
        store.context = {
          ...(store.context || {}),
          recentEntities: currentMentionedEntities,
          recentQuery: compact(query, 220),
          updatedAt: now()
        };
      }
      const selected = stage('search', () => searchIndex(store, retrievalQuery, settings));
      const selectedWithMetaGuards = stage('metaGuards', () => attachRev2MetaGuards(store, selected, retrievalQuery, settings));
      const visibleRepeatGuards = stage('visibleRepeatGuards', () => buildVisibleRepeatGuards(messages));
      const selectedWithRuntimeGuards = stage('runtimeMetaGuards', () => attachVisibleRepeatGuards(selectedWithMetaGuards, visibleRepeatGuards));
      const packetHealth = stage('packetHealth', () => computePacketHealth(packetResults, store));
      const sceneSignals = stage('sceneSignals', () => computeSceneSignals(query, selectedWithRuntimeGuards, store));
      const promptMode = stage('choosePromptMode', () => choosePromptMode(packetHealth, sceneSignals, settings));
      const tail = stage('buildTail', () => buildSideWriteTailReminder({ ...settings, packetRecoveryRequest: packetRecovery, packetHealth }));
      const tailChars = text(tail).length;
      const injectionCapChars = modeInjectionCap(promptMode);
      const contextSettings = { ...settings, promptMode, injectionCapChars, tailReserveChars: tailChars, packetRecoveryRequest: packetRecovery };
      const block = stage('buildContext', () => buildContinuityContext(selectedWithRuntimeGuards, contextSettings, query, promptMode));
      const totalInjectedChars = block.length + tailChars;
      const variableChars = variableStateViewLength(block);
      const variableBudget = variableStateViewBudget(contextSettings, block);
      const marker = block.indexOf('[HAYAKU RESPONSE QUALITY RULE]');
      const afterIntro = block.indexOf('\n\n');
      const continuityChars = marker >= 0 && afterIntro >= 0 && marker > afterIntro
        ? block.slice(afterIntro + 2, marker).trim().length
        : 0;
      await saveStore(store);
      Memory.store = store;
      Memory.lastBeforeRequest = {
        at: now(),
        scopeKey: requestScope.key || '',
        scopeConfident: requestScope.confident === true,
        scopeReason: requestScope.reason || '',
        elapsedMs: now() - startedAt,
        stages,
        chars: totalInjectedChars,
        totalChars: totalInjectedChars,
        estimatedInjectedTokens: Math.ceil(totalInjectedChars / 3),
        blockChars: block.length,
        tailChars,
        variableStateViewChars: variableChars,
        maxVariableStateViewChars: variableBudget,
        injectionCapMode: promptMode,
        maxInjectedCharsModeCap: injectionCapChars,
        injectionOverModeCap: Math.max(0, totalInjectedChars - injectionCapChars),
        continuityChars,
        fixedChars: Math.max(0, totalInjectedChars - continuityChars),
        maxContinuityChars: injectionCapChars,
        recentEntities: ensureArray(store.context?.recentEntities),
        sceneAnchors: clone(store.context?.sceneAnchors || null, null),
        packetQuality: clone(store.context?.packetQuality || [], []),
        packetHealth: clone(packetHealth, {}),
        packetRecovery: clone(packetRecovery || null, null),
        previousTurnRecallBridge: clone(previousTurnRecallBridge || null, null),
        visibleRepeatGuards: clone(visibleRepeatGuards || [], []),
        sceneSignals: clone(sceneSignals, {}),
        configuredMode: settings.mode,
        effectiveMode: settings.effectiveMode,
        effectiveModeReason: settings.effectiveModeReason,
        effectiveModeSignals: clone(settings.effectiveModeSignals || {}, {}),
        promptMode,
        selected: Object.fromEntries(Object.entries(selectedWithRuntimeGuards).map(([axis, rows]) => [axis, rows.map(row => ({
          id: row.id,
          ref: row.publicRef,
          category: row.category,
          state: compact(row.publicText || '', 180),
          score: Number(row.score.toFixed(4)),
          importance: row.importance,
          breakdown: row.scoreBreakdown || {}
        }))])),
        ingested,
        failed,
        packetSelection: clone(packetSelection.stats || {}, {}),
        packetScan: clone(Memory.packetScanStats || {}, {}),
        packetScanCacheEnabled: initialPacketScanScope.enabled === true,
        packetScanCacheScopeCleared: initialPacketScanScope.cleared === true,
        compat: RisuCompat.snapshot(),
        budgetMs: requestBudgetMs,
        budgetExceeded,
        queryPreview: compact(query, 160),
        retrievalQueryPreview: compact(retrievalQuery, 220)
      };
      debugLog('beforeRequest:done', {
        elapsedMs: Memory.lastBeforeRequest.elapsedMs,
        ingested,
        failed,
        chars: totalInjectedChars,
        configuredMode: settings.mode,
        effectiveMode: settings.effectiveMode,
        effectiveModeReason: settings.effectiveModeReason,
        promptMode,
        packetRecovery: packetRecovery?.active === true ? packetRecovery.reason : '',
        previousTurnRecallBridge: previousTurnRecallBridge?.active === true ? previousTurnRecallBridge.reason : '',
        visibleRepeatGuards: visibleRepeatGuards.length,
        selected: Object.fromEntries(Object.entries(selectedWithRuntimeGuards).map(([axis, rows]) => [axis, rows.length]))
      });
      return injectPrompt(messages, block, tail);
    } catch (error) {
      const detail = debugError('beforeRequest_failed', error, {
        requestType,
        messages: ensureArray(messages).length,
        elapsedMs: now() - startedAt
      });
      Memory.store = emptyStore();
      Memory.lastBeforeRequest = {
        at: now(),
        skipped: true,
        failedOpen: true,
        reason: 'beforeRequest_failed',
        error: detail.message,
        scopeKey: requestScope.key || '',
        scopeConfident: requestScope.confident === true,
        scopeReason: requestScope.reason || '',
        packetScanCacheEnabled: initialPacketScanScope.enabled === true,
        packetScanCacheScopeCleared: initialPacketScanScope.cleared === true,
        stages,
        elapsedMs: now() - startedAt,
        requestType,
        compat: RisuCompat.snapshot(),
        budgetMs: requestBudgetMs,
        budgetExceeded: now() - startedAt > requestBudgetMs
      };
      return messages;
    }
  };

  const exposeApi = () => {
    globalThis.HAYAKU = {
      version: PLUGIN_VERSION,
      settings: () => clone(Memory.settings, {}),
      lastDebug: () => clone({
        compat: RisuCompat.snapshot(),
        replacer: clone(Memory.replacer, {}),
        lastBeforeRequest: Memory.lastBeforeRequest,
        lastWarnings: Memory.lastWarnings,
        ...(Memory.settings?.debug ? { requestStore: Memory.store } : {})
      }, {}),
      compat: () => clone(RisuCompat.snapshot(), {}),
      selfTest: runSelfTests,
      goldenRecallTest: runGoldenRecallTests,
      classifyRequest: RequestKindCore.classify
    };
  };

  const install = async () => {
    try {
      await RisuCompat.refreshInfo();
      await loadSettings();
      await purgePersistentStore();
      debugLog('install:settings', Memory.settings);
      exposeApi();
      const registered = await RisuCompat.addBeforeRequest(handleBeforeRequest);
      if (!registered) {
        console.warn(`[HAYAKU] beforeRequest participation disabled: ${Memory.replacer.registerError || 'registration_failed'}`);
      }
      await RisuCompat.onUnload(async () => {
        await RisuCompat.removeBeforeRequest();
        try { delete globalThis.HAYAKU; } catch (_) {}
      });
      debugLog('ready', { version: PLUGIN_VERSION, compat: RisuCompat.snapshot() });
    } catch (error) {
      const detail = debugError('install_failed', error, { version: PLUGIN_VERSION });
      Memory.replacer.registered = false;
      Memory.replacer.registerError = detail.message;
      exposeApi();
      console.warn(`[HAYAKU] install failed: ${detail.message}`);
    }
  };

  await install();
})();
