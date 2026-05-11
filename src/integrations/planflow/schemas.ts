import { z } from "zod";

/** Every PlanFlow REST endpoint responds with this envelope on success.
 *  On error the API returns 4xx/5xx with `{success: false, error}` — those
 *  are surfaced by `httpClient` as `IntegrationHttpError` before parsing,
 *  so the schema only needs to model the success shape. */
export const envelopeSchema = <T extends z.ZodType>(data: T) =>
  z.looseObject({
    success: z.literal(true).optional(),
    data,
  });

export const taskStatusSchema = z.enum(["TODO", "IN_PROGRESS", "BLOCKED", "DONE", "DROPPED"]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const taskComplexitySchema = z.string();
export type TaskComplexity = z.infer<typeof taskComplexitySchema>;

export const userSummarySchema = z.looseObject({
  id: z.string(),
  email: z.string().optional(),
  name: z.string().nullable().optional(),
  avatarUrl: z.string().nullable().optional(),
});
export type UserSummary = z.infer<typeof userSummarySchema>;

/** `/auth/me` wraps the user in `{user, subscription, limits}` inside `data`.
 *  We only need the user fields downstream; the helper schemas tolerate extra
 *  keys (looseObject) so a future server addition doesn't trip parse. */
export const meSchema = z.looseObject({
  user: z.looseObject({
    id: z.string(),
    email: z.string(),
    name: z.string().nullable().optional(),
  }),
});
export type Me = z.infer<typeof meSchema>;

export const organizationSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  role: z.string().optional(),
});
export type Organization = z.infer<typeof organizationSchema>;

export const organizationListSchema = z.looseObject({
  organizations: z.array(organizationSchema),
});

export const projectSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  organizationId: z.string().nullable().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type Project = z.infer<typeof projectSchema>;

export const projectListSchema = z.looseObject({
  projects: z.array(projectSchema),
});

export const projectDetailSchema = z.looseObject({
  project: projectSchema,
});

/** PlanFlow tasks carry both a UUID (`id`) and a human-readable taskId
 *  ("T1.1"). Lock/work routes use the human-readable form, but bulk update
 *  routes need the UUID — keep both fields visible to consumers. */
export const taskSchema = z.looseObject({
  id: z.string(),
  taskId: z.string(),
  projectId: z.string().optional(),
  name: z.string(),
  description: z.string().nullable().optional(),
  status: taskStatusSchema,
  complexity: taskComplexitySchema.nullable().optional(),
  phase: z.union([z.string(), z.number()]).nullable().optional(),
  dependencies: z.array(z.string()).optional(),
  blocks: z.array(z.string()).optional(),
  lockedBy: userSummarySchema.nullable().optional(),
  assignee: userSummarySchema.nullable().optional(),
  acceptance: z.string().nullable().optional(),
  estimatedHours: z.number().nullable().optional(),
  estimateHours: z.number().nullable().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type Task = z.infer<typeof taskSchema>;

export const taskListSchema = z.looseObject({
  tasks: z.array(taskSchema),
});

/** PlanFlow currently emits comment bodies as `content`; older callers in
 *  this app read `body`. Accept either at the schema layer and let the
 *  client adapter normalise both fields so consumers can keep using
 *  `body` without further changes. */
export const commentSchema = z
  .looseObject({
    id: z.string(),
    taskId: z.string().optional(),
    body: z.string().optional(),
    content: z.string().optional(),
    parentId: z.string().nullable().optional(),
    mentions: z.array(z.string()).optional(),
    author: userSummarySchema.optional(),
    user: userSummarySchema.optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .transform((c) => ({
    ...c,
    body: c.body ?? c.content ?? "",
  }));
export type Comment = z.infer<typeof commentSchema>;

export const commentListSchema = z.looseObject({
  comments: z.array(commentSchema),
  taskId: z.string().optional(),
  totalCount: z.number().int().nonnegative().optional(),
});

export const commentDetailSchema = z.looseObject({
  comment: commentSchema,
});

export const activeWorkEntrySchema = z.looseObject({
  taskId: z.string(),
  taskUuid: z.string().optional(),
  taskName: z.string().optional(),
  userId: z.string(),
  userEmail: z.string().optional(),
  userName: z.string().nullable().optional(),
  startedAt: z.string(),
  lastHeartbeat: z.string().nullable().optional(),
});
export type ActiveWorkEntry = z.infer<typeof activeWorkEntrySchema>;

export const activeWorkResponseSchema = z.looseObject({
  projectId: z.string(),
  activeWork: z.array(activeWorkEntrySchema),
  count: z.number().int().nonnegative().optional(),
});

export const knowledgeTypeSchema = z.enum([
  "architecture",
  "pattern",
  "convention",
  "decision",
  "dependency",
  "environment",
  "other",
]);
export type KnowledgeType = z.infer<typeof knowledgeTypeSchema>;

export const knowledgeEntrySchema = z.looseObject({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  type: knowledgeTypeSchema.optional(),
  createdAt: z.string().optional(),
});
export type KnowledgeEntry = z.infer<typeof knowledgeEntrySchema>;

export const knowledgeListSchema = z.looseObject({
  knowledge: z.array(knowledgeEntrySchema).optional(),
  entries: z.array(knowledgeEntrySchema).optional(),
});

export const notificationSchema = z.looseObject({
  id: z.string(),
  type: z.string(),
  title: z.string().optional(),
  body: z.string().nullable().optional(),
  link: z.string().nullable().optional(),
  projectId: z.string().nullable().optional(),
  organizationId: z.string().nullable().optional(),
  taskId: z.string().nullable().optional(),
  readAt: z.string().nullable().optional(),
  createdAt: z.string().optional(),
  actor: userSummarySchema.nullable().optional(),
});
export type Notification = z.infer<typeof notificationSchema>;

export const notificationListSchema = z.looseObject({
  notifications: z.array(notificationSchema),
  unreadCount: z.number().int().nonnegative().optional(),
  pagination: z
    .looseObject({
      total: z.number().int().nonnegative(),
      limit: z.number().int().nonnegative(),
      offset: z.number().int().nonnegative(),
      hasMore: z.boolean(),
    })
    .optional(),
});

export const unreadNotificationCountSchema = z.looseObject({
  unreadCount: z.number().int().nonnegative(),
});
export type UnreadNotificationCount = z.infer<typeof unreadNotificationCountSchema>;

export const changeSchema = z.looseObject({
  id: z.string(),
  entityType: z.string().optional(),
  action: z.string().optional(),
  entityId: z.string().optional(),
  projectId: z.string().optional(),
  userId: z.string().optional(),
  userEmail: z.string().optional(),
  userName: z.string().nullable().optional(),
  summary: z.string().optional(),
  /** PlanFlow names this field `timestamp`; older callers in this app
   *  used `occurredAt`. Both are exposed (with `occurredAt` derived from
   *  `timestamp` in the client) so we don't have to touch every consumer
   *  at once. */
  timestamp: z.string().optional(),
  occurredAt: z.string().optional(),
  createdAt: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type Change = z.infer<typeof changeSchema>;

export const changesResponseSchema = z.looseObject({
  changes: z.array(changeSchema),
  total: z.number().int().nonnegative().optional(),
  limit: z.number().int().nonnegative().optional(),
  offset: z.number().int().nonnegative().optional(),
});
export type ChangesResponse = z.infer<typeof changesResponseSchema>;
