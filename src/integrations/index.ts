export {
  createIntegrationHttpClient,
  IntegrationHttpClient,
  IntegrationHttpError,
  IntegrationNetworkError,
  IntegrationRateLimitError,
  IntegrationTimeoutError,
  LayeredCacheStore,
  LocalStorageCacheStore,
  MemoryCacheStore,
} from "./httpClient";
export type {
  CacheEntry,
  HttpMethod,
  IntegrationCacheStore,
  IntegrationFetchResult,
  IntegrationFetchSource,
  IntegrationHttpClientOptions,
  IntegrationRequestOptions,
  OfflineHooks,
  RateLimitDetails,
  ResponseType,
  RetryOptions,
} from "./httpClient";

export { createOfflineAwareIntegrationClient } from "./createOfflineAwareClient";

export {
  CredentialsError,
  DEFAULT_ACCOUNT,
  Integration,
  credentialsErrorSchema,
  deleteCredential,
  getCredential,
  invalidateCredentialCache,
  hasCredential,
  setCredential,
} from "./credentials";

export {
  clearIntegrationNeedsReauthFlag,
  clearIntegrationStatus,
  getIntegrationStatus,
  getIntegrationStatusMap,
  markIntegrationNeedsReauth,
  setIntegrationStatus,
} from "./status";
export type { IntegrationStatusEntry, IntegrationStatusMap } from "./status";

export {
  cancelQueuedForReauth,
  clearNeedsReauthAndReplay,
  hydrateReauthState,
  isNeedsReauth,
  markNeedsReauth,
  reauthSnapshot,
  ReauthCancelledError,
  runWithReauthGuard,
} from "./reauth";

export type {
  CredentialsErrorKind,
  CredentialsErrorPayload,
  CredentialsRecovery,
  IntegrationId,
} from "./credentials";

export {
  commitScopeFromTaskId,
  createPlanFlowClient,
  createRendererPlanFlowClient,
  finishTask,
  formatCheckoutCommand,
  formatCommitCommand,
  formatCommitMessage,
  markProgress,
  MissingPlanFlowTokenError,
  PlanFlowApiError,
  PlanFlowAuthError,
  PlanFlowClient,
  PlanFlowConflictError,
  PlanFlowParseError,
  PLANFLOW_DEFAULT_BASE_URL,
  startTask,
} from "./planflow";

export {
  installOfflineListeners,
  isOffline,
  offlineSnapshot,
  onReconnect,
  reportNetworkError,
  reportNetworkSuccess,
} from "./offline";
export type { OfflineSnapshot, ServiceState } from "./offline";

export {
  clearServiceQueue,
  enqueueWrite,
  installAutoReplay,
  listQueue,
  registerReplayHandler,
  replayQueue,
} from "./writeQueue";
export type { QueuedWrite, QueueEntry, ReplayContext } from "./writeQueue";

export {
  clearProjectLinkCache,
  invalidateProjectLinks,
  loadProjectLinks,
  readCachedLinks,
  usePlanFlowExternalId,
  usePlanFlowLink,
  useProjectServiceLink,
} from "./projectLinks";

export { IntegrationVerifyError, verifyIntegration } from "./verifiers";
export type { VerifyFailureReason, VerifyOptions, VerifyResult } from "./verifiers";

export {
  createGitHubClient,
  createRendererGitHubClient,
  GITHUB_DEFAULT_BASE_URL,
  GitHubApiError,
  GitHubAuthError,
  GitHubClient,
  GitHubNotFoundError,
  GitHubParseError,
  MissingGitHubTokenError,
} from "./github";
export type {
  GitHubBranch,
  GitHubClientOptions,
  GitHubCommit,
  GitHubPullRequest,
  GitHubPullRequestState,
  GitHubRepo,
  GitHubUser,
  GitHubWorkflowRun,
  ListBranchesOptions,
  ListCommitsOptions,
  ListPullRequestsOptions,
  ListWorkflowRunsOptions,
  RendererGitHubClientOptions,
  RepoRef,
} from "./github";

export {
  WsBridgeClient,
  WsBridgeClosedError,
  WsBridgeServerError,
  decodeBase64 as decodeWsBridgeBase64,
  encodeBase64 as encodeWsBridgeBase64,
} from "./wsBridge";
export type {
  ConnectionState as WsBridgeConnectionState,
  ExitHandler as WsBridgeExitHandler,
  MessageHandler as WsBridgeMessageHandler,
  OutputHandler as WsBridgeOutputHandler,
  PtyScrollbackChunk as WsBridgePtyScrollbackChunk,
  PtySpawnPayload as WsBridgePtySpawnPayload,
  ReconnectOptions as WsBridgeReconnectOptions,
  ServerMessage as WsBridgeServerMessage,
  WsBridgeClientOptions,
} from "./wsBridge";
export type {
  ActiveWorkEntry,
  ActiveWorkUser,
  BranchNameResponse,
  Change,
  Comment,
  CreateCommentPayload,
  CreateKnowledgePayload,
  KnowledgeEntry,
  KnowledgeType,
  ListChangesOptions,
  ListTasksOptions,
  Me,
  Notification,
  Organization,
  PlanFlowClientOptions,
  Project,
  RendererPlanFlowClientOptions,
  FinishTaskInput,
  FinishTaskResult,
  MarkProgressInput,
  MarkProgressResult,
  StartTaskInput,
  StartTaskResult,
  Task,
  TaskComplexity,
  TaskStatus,
  UpdateTaskStatusPayload,
  UserSummary,
} from "./planflow";
