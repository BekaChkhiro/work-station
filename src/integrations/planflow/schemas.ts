import { z } from "zod";

export const taskStatusSchema = z.enum(["TODO", "IN_PROGRESS", "BLOCKED", "DONE", "DROPPED"]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const taskComplexitySchema = z.enum(["S", "M", "L", "XL"]);
export type TaskComplexity = z.infer<typeof taskComplexitySchema>;

export const userSummarySchema = z.looseObject({
  id: z.string(),
  email: z.string().optional(),
  name: z.string().optional(),
  avatarUrl: z.string().optional(),
});
export type UserSummary = z.infer<typeof userSummarySchema>;

export const meSchema = z.looseObject({
  id: z.string(),
  email: z.string(),
  name: z.string().optional(),
});
export type Me = z.infer<typeof meSchema>;

export const projectSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type Project = z.infer<typeof projectSchema>;

export const projectListSchema = z.array(projectSchema);

export const taskSchema = z.looseObject({
  id: z.string(),
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
  estimateHours: z.number().nullable().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type Task = z.infer<typeof taskSchema>;

export const taskListSchema = z.array(taskSchema);

export const commentSchema = z.looseObject({
  id: z.string(),
  taskId: z.string().optional(),
  body: z.string(),
  author: userSummarySchema.optional(),
  createdAt: z.string().optional(),
});
export type Comment = z.infer<typeof commentSchema>;

export const commentListSchema = z.array(commentSchema);

export const activeWorkEntrySchema = z.looseObject({
  user: userSummarySchema,
  taskId: z.string(),
  startedAt: z.string(),
});
export type ActiveWorkEntry = z.infer<typeof activeWorkEntrySchema>;

export const activeWorkListSchema = z.array(activeWorkEntrySchema);

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

export const knowledgeListSchema = z.array(knowledgeEntrySchema);

export const notificationSchema = z.looseObject({
  id: z.string(),
  kind: z.string(),
  message: z.string(),
  read: z.boolean().optional(),
  createdAt: z.string().optional(),
  projectId: z.string().optional(),
  taskId: z.string().optional(),
});
export type Notification = z.infer<typeof notificationSchema>;

export const notificationListSchema = z.array(notificationSchema);

export const changeSchema = z.looseObject({
  id: z.string(),
  kind: z.string(),
  resourceType: z.string().optional(),
  resourceId: z.string().optional(),
  occurredAt: z.string(),
  actor: userSummarySchema.optional(),
});
export type Change = z.infer<typeof changeSchema>;

export const changesResponseSchema = z.looseObject({
  changes: z.array(changeSchema),
  cursor: z.string().nullable().optional(),
});
export type ChangesResponse = z.infer<typeof changesResponseSchema>;

export const branchNameResponseSchema = z.looseObject({
  branchName: z.string(),
});
export type BranchNameResponse = z.infer<typeof branchNameResponseSchema>;
