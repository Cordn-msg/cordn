import { z } from "zod";

export const CONTEXTVM_COORDINATOR_TOOLS = {
  publishKeyPackage: "publish_key_package",
  listAvailableKeyPackages: "list_available_key_packages",
  consumeKeyPackage: "consume_key_package",
  fetchPendingWelcomes: "fetch_pending_welcomes",
  storeWelcome: "store_welcome",
  postGroupMessage: "post_group_message",
  fetchGroupMessages: "fetch_group_messages",
} as const;

export const emptyInputSchema = z.object({});

export const publishKeyPackageInputSchema = z.object({
  keyPackageRef: z.string().min(1),
  keyPackageBase64: z.string().min(1),
});

export const publishKeyPackageOutputSchema = z.object({
  keyPackageRef: z.string(),
  publishedAt: z.number(),
});

export const consumeKeyPackageInputSchema = z.object({
  identifier: z.string().min(1),
});

export const consumedKeyPackageSchema = z.object({
  stablePubkey: z.string(),
  keyPackageRef: z.string(),
  keyPackageBase64: z.string(),
  publishedAt: z.number(),
});

export const consumeKeyPackageOutputSchema = z.object({
  keyPackage: consumedKeyPackageSchema.nullable(),
});

export const availableKeyPackageSchema = z.object({
  stablePubkey: z.string(),
  keyPackageRef: z.string(),
  publishedAt: z.number(),
});

export const listAvailableKeyPackagesInputSchema = emptyInputSchema;

export const listAvailableKeyPackagesOutputSchema = z.object({
  keyPackages: z.array(availableKeyPackageSchema),
});

export const pendingWelcomeSchema = z.object({
  keyPackageReference: z.string(),
  welcomeBase64: z.string(),
  createdAt: z.number(),
});

export const fetchPendingWelcomesInputSchema = emptyInputSchema;

export const fetchPendingWelcomesOutputSchema = z.object({
  welcomes: z.array(pendingWelcomeSchema),
});

export const storeWelcomeInputSchema = z.object({
  targetStablePubkey: z.string().min(1),
  keyPackageReference: z.string().min(1),
  welcomeBase64: z.string().min(1),
});

export const storeWelcomeOutputSchema = z.object({
  createdAt: z.number(),
});

export const postGroupMessageInputSchema = z.object({
  opaqueMessageBase64: z.string().min(1),
});

export const postGroupMessageOutputSchema = z.object({
  cursor: z.number(),
  groupId: z.string(),
  createdAt: z.number(),
});

export const fetchGroupMessagesInputSchema = z.object({
  groupId: z.string().min(1),
  afterCursor: z.number().int().positive().optional(),
});

export const groupMessageSchema = z.object({
  cursor: z.number(),
  groupId: z.string(),
  opaqueMessageBase64: z.string(),
  createdAt: z.number(),
});

export const fetchGroupMessagesOutputSchema = z.object({
  messages: z.array(groupMessageSchema),
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
export type FetchPendingWelcomesInput = z.infer<
  typeof fetchPendingWelcomesInputSchema
>;
export type FetchPendingWelcomesOutput = z.infer<
  typeof fetchPendingWelcomesOutputSchema
>;
export type StoreWelcomeInput = z.infer<typeof storeWelcomeInputSchema>;
export type StoreWelcomeOutput = z.infer<typeof storeWelcomeOutputSchema>;
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
export type AvailableKeyPackage = z.infer<typeof availableKeyPackageSchema>;
export type PendingWelcome = z.infer<typeof pendingWelcomeSchema>;
export type GroupMessage = z.infer<typeof groupMessageSchema>;
