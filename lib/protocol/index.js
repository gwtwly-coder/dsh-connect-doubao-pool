/**
 * 豆包协议层：把我们 vendored 的 `lib/doubao-core.js`（源自 dsh-connect-doubao，
 * MIT 许可，见 lib/NOTICE.md）里的压缩导出名，重新导出成可读的名字。
 *
 * 这一层存在的唯一目的：`index.js` / `lib/provider/adapter.js` 只跟可读名字打交道，
 * 将来换掉 core 的版本时只要改这个文件。
 *
 * 这个文件没有任何宿主（@deepseek-ai/*）import —— 这是我们能在 `link:` 安装下
 * 跑起来的前提（宿主平台包在 workspace 目录里不可解析）。
 */
export {
  // —— 凭据（DPAPI 密封在 ~/.dsh/doubao-credentials-browser.dpapi）——
  vt as saveBrowserCredentials,
  gt as loadBrowserCredentials,
  mt as hasBrowserCredentials,
  ft as clearBrowserCredentials,
  _t as loadDoubaoCredentials,
  ht as invalidateCredentialCache,
  pt as clearCredentialCache,
  ut as CREDENTIAL_TTL_MS,
  lt as CORE_AUTH_COOKIE_NAMES,
  dt as REQUIRED_COOKIE_NAMES,

  // —— 登录（拉起 Chromium + CDP 抓 cookie）——
  at as browserLogin,
  Ct as listDoubaoProfiles,
  St as findDoubaoUserDataDir,
  bt as describeProfileLocation,
  Et as setProfileOverride,

  // —— 额度 / 账号探活 ——
  r as fetchQuota,
  U as probeAccount,
  o as invalidateQuotaCache,
  t as QUOTA_TTL_MS,
  i as findWindow,
  s as millisUntilReset,
  a as formatDuration,

  // —— 模型目录 ——
  Lt as DOUBAO_MODELS,
  Xt as doubaoCatalogEntries,
  Zt as enabledModelsOf,
  Qt as findDoubaoModel,
  Pt as DOUBAO_IMAGE_MODEL_ID,
  Ft as DOUBAO_IMAGE_MODEL_NAME,
  Nt as DOUBAO_DEFAULT_MODEL_ID,
  Mt as DOUBAO_CONTEXT_WINDOW,
  It as DOUBAO_MAX_TOKENS,
  Bt as DOUBAO_REASONING_LEVELS,
  $t as findReasoningLevel,
  an as reasoningLevelOf,
  rn as levelIdOf,
  nn as isTaskModel,
  on as supportsReasoning,
  Yt as discoverDoubaoModels,

  // —— 对话 ——
  G as streamChat,
  k as chat,
  T as buildChatBody,
  H as parseFrames,
  d as CHAT_ENDPOINT,
  D as buildHeaders,
  O as buildQueryUrl,
  X as TOOL_FENCE_LANGUAGE,
  Z as buildToolContract,
  $ as parseToolCalls,
  tt as toolResultAsText,

  // —— 失败分类 ——
  A as classifyDoubaoFailure,
  z as isRetryableFailure,
  R as isInvalidParamFailure,
  P as describeDoubaoFailure,
  g as DoubaoUpstreamError,
  m as DOUBAO_ERROR_HINTS,

  // —— 模型菜单（除了静态 5 个，还有工作任务那套第三方模型）——
  u as ACTION_BAR_BRIEF_LIST_ENDPOINT,
  p as DEFAULT_BOT_ID,

  // —— 标识 ——
  Rt as DOUBAO_PROVIDER,
  zt as DOUBAO_PROVIDER_DISPLAY_NAME,
} from "../doubao-core.js";
