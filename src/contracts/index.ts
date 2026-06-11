import { z } from "zod";

export const nostrEventSchema = z.object({
  id: z.string().min(1),
  pubkey: z.string().min(1),
  created_at: z.number(),
  kind: z.number(),
  tags: z.array(z.array(z.string())),
  content: z.string(),
  sig: z.string().min(1),
});

export const COORDINATOR_METHODS = {
  publishKeyPackage: "kp_publish",
  listAvailableKeyPackages: "kp_list",
  consumeKeyPackage: "kp_take",
  removeKeyPackages: "kp_remove",
  fetchPendingWelcomes: "welcome_take",
  storeWelcome: "welcome_store",
  storeJoinRequest: "join_request_store",
  fetchPendingJoinRequests: "join_request_take",
  fetchManyPendingJoinRequests: "join_request_take_many",
  postGroupMessage: "msg_post",
  fetchGroupMessages: "msg_fetch",
  fetchManyGroupMessages: "msg_fetch_many",
  subscribeGroupMessages: "msg_sub",
  subscribeManyGroupMessages: "msg_sub_many",
} as const;

export const emptyInputSchema = z.object({});

export const publishKeyPackageInputSchema = z.object({
  kp_ref: z.string().min(1),
  kp_64: z.string().min(1),
});

export const publishKeyPackageOutputSchema = z.object({
  kp_ref: z.string(),
  last_resort: z.boolean(),
  at: z.number(),
});

export const consumeKeyPackageInputSchema = z.object({
  id: z.string().min(1),
});

export const consumedKeyPackageSchema = z.object({
  pk: z.string(),
  kp_ref: z.string(),
  last_resort: z.boolean(),
  at: z.number(),
  event: nostrEventSchema,
});

export const consumeKeyPackageOutputSchema = z.object({
  keyPackage: consumedKeyPackageSchema.nullable(),
});

export const availableKeyPackageSchema = z.object({
  pk: z.string(),
  kp_ref: z.string(),
  last_resort: z.boolean(),
  at: z.number(),
});

export const removeKeyPackagesInputSchema = z.object({
  kp_refs: z.array(z.string().min(1)).min(1),
});

export const removeKeyPackagesOutputSchema = z.object({
  kp_refs: z.array(z.string()),
});

export const listAvailableKeyPackagesInputSchema = emptyInputSchema;

export const listAvailableKeyPackagesOutputSchema = z.object({
  keyPackages: z.array(availableKeyPackageSchema),
});

export const pendingWelcomeSchema = z.object({
  kp_ref: z.string(),
  welcome_64: z.string(),
  at: z.number(),
});

export const fetchPendingWelcomesInputSchema = emptyInputSchema;

export const fetchPendingWelcomesOutputSchema = z.object({
  welcomes: z.array(pendingWelcomeSchema),
});

export const storeWelcomeInputSchema = z.object({
  target_pk: z.string().min(1),
  kp_ref: z.string().min(1),
  welcome_64: z.string().min(1),
});

export const storeWelcomeOutputSchema = z.object({
  at: z.number(),
});

export const storeJoinRequestInputSchema = z.object({
  gid: z.string().min(1),
  kp_ref: z.string().min(1),
});

export const storeJoinRequestOutputSchema = z.object({
  at: z.number(),
});

export const joinRequestSchema = z.object({
  pk: z.string(),
  kp_ref: z.string(),
  at: z.number(),
});

export const fetchPendingJoinRequestsInputSchema = z.object({
  gid: z.string().min(1),
});

export const fetchPendingJoinRequestsOutputSchema = z.object({
  requests: z.array(joinRequestSchema),
});

export const fetchManyPendingJoinRequestsGroupInputSchema = z.object({
  gid: z.string().min(1),
});

export const fetchManyPendingJoinRequestsInputSchema = z.object({
  groups: z.array(fetchManyPendingJoinRequestsGroupInputSchema).min(1),
});

export const joinRequestWithGroupSchema = joinRequestSchema.extend({
  gid: z.string(),
});

export const fetchManyPendingJoinRequestsOutputSchema = z.object({
  requests: z.array(joinRequestWithGroupSchema),
});

export const postGroupMessageInputSchema = z.object({
  msg_64: z.string().min(1),
});

export const postGroupMessageOutputSchema = z.object({
  cursor: z.number(),
  gid: z.string(),
  at: z.number(),
});

export const fetchGroupMessagesInputSchema = z.object({
  gid: z.string().min(1),
  after: z.number().int().positive().optional(),
  since_epoch: z
    .string()
    .regex(/^\d+$/, "since_epoch must be a non-negative integer string")
    .optional(),
});

export const groupMessageSchema = z.object({
  cursor: z.number(),
  gid: z.string(),
  msg_64: z.string(),
  at: z.number(),
});

export const fetchGroupMessagesOutputSchema = z.object({
  messages: z.array(groupMessageSchema),
});

export const fetchManyGroupMessagesInputSchema = z.object({
  groups: z.array(fetchGroupMessagesInputSchema).min(1),
});

export const fetchManyGroupMessagesOutputSchema =
  fetchGroupMessagesOutputSchema;

export const subscribeGroupMessagesInputSchema = fetchGroupMessagesInputSchema;

export const subscribeGroupMessagesOutputSchema = z.object({
  subscribed: z.literal(true),
});

export const subscribeManyGroupMessagesInputSchema = z.object({
  groups: z.array(fetchGroupMessagesInputSchema).min(1),
});

export const subscribeManyGroupMessagesOutputSchema = z.object({
  subscribed: z.literal(true),
  groups: z.array(z.string()),
});

export type PublishKeyPackageInput = z.infer<
  typeof publishKeyPackageInputSchema
>;
export type PublishKeyPackageOutput = z.infer<
  typeof publishKeyPackageOutputSchema
>;
export type ConsumeKeyPackageInput = z.infer<
  typeof consumeKeyPackageInputSchema
>;
export type ConsumeKeyPackageOutput = z.infer<
  typeof consumeKeyPackageOutputSchema
>;
export type ListAvailableKeyPackagesInput = z.infer<
  typeof listAvailableKeyPackagesInputSchema
>;
export type ListAvailableKeyPackagesOutput = z.infer<
  typeof listAvailableKeyPackagesOutputSchema
>;
export type RemoveKeyPackagesInput = z.infer<
  typeof removeKeyPackagesInputSchema
>;
export type RemoveKeyPackagesOutput = z.infer<
  typeof removeKeyPackagesOutputSchema
>;
export type FetchPendingWelcomesInput = z.infer<
  typeof fetchPendingWelcomesInputSchema
>;
export type FetchPendingWelcomesOutput = z.infer<
  typeof fetchPendingWelcomesOutputSchema
>;
export type StoreWelcomeInput = z.infer<typeof storeWelcomeInputSchema>;
export type StoreWelcomeOutput = z.infer<typeof storeWelcomeOutputSchema>;
export type StoreJoinRequestInput = z.infer<typeof storeJoinRequestInputSchema>;
export type StoreJoinRequestOutput = z.infer<
  typeof storeJoinRequestOutputSchema
>;
export type JoinRequest = z.infer<typeof joinRequestSchema>;
export type JoinRequestWithGroup = z.infer<typeof joinRequestWithGroupSchema>;
export type FetchPendingJoinRequestsInput = z.infer<
  typeof fetchPendingJoinRequestsInputSchema
>;
export type FetchPendingJoinRequestsOutput = z.infer<
  typeof fetchPendingJoinRequestsOutputSchema
>;
export type FetchManyPendingJoinRequestsInput = z.infer<
  typeof fetchManyPendingJoinRequestsInputSchema
>;
export type FetchManyPendingJoinRequestsOutput = z.infer<
  typeof fetchManyPendingJoinRequestsOutputSchema
>;
export type PostGroupMessageInput = z.infer<typeof postGroupMessageInputSchema>;
export type PostGroupMessageOutput = z.infer<
  typeof postGroupMessageOutputSchema
>;
export type FetchGroupMessagesInput = z.infer<
  typeof fetchGroupMessagesInputSchema
>;
export type FetchGroupMessagesOutput = z.infer<
  typeof fetchGroupMessagesOutputSchema
>;
export type FetchManyGroupMessagesInput = z.infer<
  typeof fetchManyGroupMessagesInputSchema
>;
export type FetchManyGroupMessagesOutput = z.infer<
  typeof fetchManyGroupMessagesOutputSchema
>;
export type SubscribeGroupMessagesInput = z.infer<
  typeof subscribeGroupMessagesInputSchema
>;
export type SubscribeGroupMessagesOutput = z.infer<
  typeof subscribeGroupMessagesOutputSchema
>;
export type SubscribeManyGroupMessagesInput = z.infer<
  typeof subscribeManyGroupMessagesInputSchema
>;
export type SubscribeManyGroupMessagesOutput = z.infer<
  typeof subscribeManyGroupMessagesOutputSchema
>;
export type AvailableKeyPackage = z.infer<typeof availableKeyPackageSchema>;
export type PendingWelcome = z.infer<typeof pendingWelcomeSchema>;
export type GroupMessage = z.infer<typeof groupMessageSchema>;
