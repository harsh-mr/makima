import { db } from "../db";
import { asc, desc, eq } from "drizzle-orm";
import {
  messagesTable,
  contextsTable,
  agentsTable,
  summariesTable,
} from "./schema";
import type {
  Agent,
  AiMessage,
  BlockScalingConfig,
  Context,
  DbMessage,
  Message,
  ScalingConfig,
  ThresholdScalingConfig,
  ToolCalls,
  ToolResponse,
  UserMessage,
  WindowScalingConfig,
} from "../lib/inference/types";
import { generateSummary } from "../lib/thread/summarize";

export async function getScaledMessages(
  contextId: string,
  agent: Agent,
): Promise<Message[]> {
  const context = await getThreadDetailsById(contextId);
  if (!context) {
    throw new Error("Context not found");
  }

  const allMessages = await getMessagesByThreadId(contextId);

  if (!context.scaling_algorithm || !context.scaling_config) {
    console.log("No scaling algorithm or config");
    return allMessages;
  }

  switch (context.scaling_algorithm) {
    case "window": {
      const config = context.scaling_config as WindowScalingConfig;
      return allMessages.slice(-config.windowSize);
    }

    case "threshold": {
      const config = context.scaling_config as ThresholdScalingConfig;
      if (allMessages.length <= config.totalWindow) {
        return allMessages;
      }

      const existingSummary = await db
        .select()
        .from(summariesTable)
        .where(eq(summariesTable.context_id, contextId))
        .orderBy(desc(summariesTable.created_at))
        .limit(1)
        .execute();

      let summaryMessage: Message;
      if (existingSummary.length === 0) {
        const messagesToSummarize = allMessages.slice(
          0,
          -config.summarizationThreshold,
        );
        const summary = await generateSummary(
          messagesToSummarize,
          agent.primaryModel,
        );

        const [newSummary] = await db
          .insert(summariesTable)
          .values({
            context_id: contextId,
            start_message_id: messagesToSummarize[0].db_id,
            end_message_id:
              messagesToSummarize[messagesToSummarize.length - 1].db_id,
            summary_content: summary.content,
          })
          .returning()
          .execute();

        summaryMessage = {
          ...summary,
          db_id: newSummary.id,
          context_id: contextId,
        };
      } else {
        summaryMessage = {
          role: "system",
          content: existingSummary[0].summary_content || "",
          db_id: existingSummary[0].id,
          context_id: contextId,
        };
      }

      return [
        summaryMessage,
        ...allMessages.slice(-config.summarizationThreshold),
      ];
    }

    case "block": {
      const config = context.scaling_config as BlockScalingConfig;
      const totalBlocks = Math.ceil(allMessages.length / config.blockSize);
      console.log("totalBlocks", totalBlocks);
      if (totalBlocks <= 1) {
        console.log("totalBlocks <= 1");
        return allMessages;
      }


      const existingBlockSummaries = await db
        .select()
        .from(summariesTable)
        .where(eq(summariesTable.context_id, contextId))
        .orderBy(asc(summariesTable.block_number))
        .execute();

      const summaries: Message[] = [];
      console.log("existingBlockSummaries", existingBlockSummaries);
      let currentBlock = 0;

      while (currentBlock < totalBlocks - 1) {
        const blockStart = currentBlock * config.blockSize;
        const blockEnd = Math.min(
          (currentBlock + 1) * config.blockSize,
          allMessages.length,
        );
        const blockMessages = allMessages.slice(blockStart, blockEnd);

        const existingSummary = existingBlockSummaries.find(
          (s) => s.block_number === currentBlock,
        );

        if (existingSummary) {
          summaries.push({
            role: "system",
            content: existingSummary.summary_content || "",
            db_id: existingSummary.id,
            context_id: contextId,
          });
        } else {
          const summary = await generateSummary(
            blockMessages,
            agent.primaryModel,
          );
          const [newSummary] = await db
            .insert(summariesTable)
            .values({
              context_id: contextId,
              start_message_id: blockMessages[0].db_id,
              end_message_id: blockMessages[blockMessages.length - 1].db_id,
              summary_content: summary.content,
              block_number: currentBlock,
            })
            .returning()
            .execute();

          summaries.push({
            ...summary,
            db_id: newSummary.id,
            context_id: contextId,
          });
        }

        currentBlock++;
      }

      // Add the most recent block's messages as-is
      const lastBlockMessages = allMessages.slice(
        (totalBlocks - 1) * config.blockSize,
      );
      return [...summaries, ...lastBlockMessages];
    }

    default:
      console.error("Unknown scaling algorithm:", context.scaling_algorithm);
      return allMessages;
  }
}

// Helper function to convert DbMessage to Message
function dbMessageToMessage(dbMessage: DbMessage): Message {
  const baseMessage = {
    db_id: dbMessage.id,
    context_id: dbMessage.context_id || undefined,
    author_id: dbMessage.author_id,
    createdAt: dbMessage.createdAt,
    calls: dbMessage.calls,
  };

  switch (dbMessage.role) {
    case "human":
      return {
        ...baseMessage,
        role: "human",
        name: dbMessage.name as string,
        content: dbMessage.content as string,
      };
    case "ai":
      return {
        ...baseMessage,
        role: "ai",
        name: dbMessage.name as string,
        content: dbMessage.content as string,
      };
    case "tool_calls":
      return {
        ...baseMessage,
        role: "tool_calls",
        content: dbMessage.content as string | undefined,
        calls: dbMessage.calls as {
          tool_name: string;
          params: object;
          id: string;
        }[],
      };
    case "tool_response":
      return {
        ...baseMessage,
        role: "tool_response",
        content: dbMessage.content as string,
        id: dbMessage.callId as string,
      };
    default:
      throw new Error(`Unknown message role: ${dbMessage.role}`);
  }
}

function messageToDbMessage(
  threadId: string,
  message: Message,
): typeof messagesTable.$inferInsert {
  const baseMessage = {
    id: crypto.randomUUID(),
    context_id: threadId,
    role: message.role,
    createdAt: new Date(),
  };

  switch (message.role) {
    case "human": {
      const humanMessage = message as UserMessage;
      return {
        ...baseMessage,
        name: humanMessage.name,
        content:
          typeof humanMessage.content === "string"
            ? humanMessage.content
            : JSON.stringify(humanMessage.content),
        author_id: humanMessage.name,
        calls: null,
        callId: null,
      };
    }
    case "ai": {
      const aiMessage = message as AiMessage;
      return {
        ...baseMessage,
        name: aiMessage.name,
        content: aiMessage.content,
        author_id: null,
        calls: null,
        callId: null,
      };
    }
    case "tool_calls": {
      const toolMessage = message as ToolCalls;
      return {
        ...baseMessage,
        name: null,
        content: toolMessage.content || null,
        author_id: null,
        calls: toolMessage.calls,
        callId: null,
      };
    }
    case "tool_response": {
      const responseMessage = message as ToolResponse;
      return {
        ...baseMessage,
        name: null,
        content: responseMessage.content,
        author_id: null,
        calls: null,
        callId: responseMessage.id,
      };
    }
    default:
      throw new Error(`Unknown message role: ${(message as any).role}`);
  }
}

// 1. Get messages of a thread/context by thread ID
export async function getMessagesByThreadId(
  threadId: string,
): Promise<Message[]> {
  const dbMessages = await db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.context_id, threadId))
    .execute();
  return dbMessages.map(dbMessageToMessage);
}

// 2. Get thread details by thread ID
export async function getThreadDetailsById(
  threadId: string,
): Promise<Context | null> {
  const contexts = await db
    .select({
      context: contextsTable,
      agent: {
        id: agentsTable.id,
        name: agentsTable.name,
      },
    })
    .from(contextsTable)
    .leftJoin(agentsTable, eq(contextsTable.default_agent_id, agentsTable.id))
    .where(eq(contextsTable.id, threadId))
    .execute();

  if (contexts.length === 0) return null;

  const { context, agent } = contexts[0];
  return {
    id: context.id,
    platform: context.platform,
    description: context.description,
    authors: context.authors as string[],
    default_agent_id: context.default_agent_id,
    default_agent: agent ? { id: agent.id, name: agent.name } : null,
    scaling_algorithm: context.scaling_algorithm ?? undefined,
    scaling_config: context.scaling_config ?? undefined,
  };
}

// 3. Create a new thread/context
export async function createThread({
  platform,
  description,
  authors,
  id,
  agentName,
  scalingAlgorithm = "window", // default to window scaling
  scalingConfig = { type: "window", windowSize: 10 }, // default config
}: {
  id: string;
  platform: string;
  authors?: string[];
  description?: string;
  agentName: string;
  scalingAlgorithm?: "window" | "threshold" | "block";
  scalingConfig?: ScalingConfig;
}): Promise<{ id: string }> {
  // Look up the agent ID based on the provided name
  const agent = await db
    .select({ id: agentsTable.id })
    .from(agentsTable)
    .where(eq(agentsTable.name, agentName))
    .execute();

  if (agent.length === 0) {
    throw new Error(`Agent with name "${agentName}" not found`);
  }

  const defaultAgentId = agent[0].id;

  // Validate scaling config matches algorithm
  if (scalingConfig && scalingConfig.type !== scalingAlgorithm) {
    throw new Error(
      `Scaling config type doesn't match algorithm: ${scalingAlgorithm}`,
    );
  }

  // Use provided config or create default based on algorithm
  const finalScalingConfig = scalingConfig || {
    type: scalingAlgorithm,
    ...(scalingAlgorithm === "window" && { windowSize: 10 }),
    ...(scalingAlgorithm === "threshold" && {
      totalWindow: 50,
      summarizationThreshold: 20,
    }),
    ...(scalingAlgorithm === "block" && {
      blockSize: 20,
      maxBlocks: 5,
    }),
  };

  const result = await db
    .insert(contextsTable)
    .values({
      id: id,
      platform,
      description,
      authors,
      default_agent_id: defaultAgentId,
      scaling_algorithm: scalingAlgorithm,
      scaling_config: finalScalingConfig,
    })
    .returning({ id: contextsTable.id })
    .execute();
  return result[0];
}

// 4. Add a message to a thread and update the context's author list if necessary
export async function addMessageToThread(
  threadId: string,
  message: Message,
): Promise<Message> {
  const dbMessage = messageToDbMessage(threadId, message);

  const [insertedMessage] = await db
    .insert(messagesTable)
    .values(dbMessage)
    .returning()
    .execute();

  if (message.role === "human") {
    await updateContextAuthors(threadId, message.name);
  }

  return dbMessageToMessage(insertedMessage);
}

export async function addMessagesToThread(
  threadId: string,
  messages: Message[],
): Promise<Message[]> {
  const insertedMessages = await db.transaction(async (tx) => {
    const dbMessages = messages.map((message) =>
      messageToDbMessage(threadId, message),
    );
    const inserted = await tx
      .insert(messagesTable)
      .values(dbMessages)
      .returning()
      .execute();
    return inserted;
  });

  // Update context authors for all human messages
  await Promise.all(
    messages
      .filter((m): m is UserMessage => m.role === "human")
      .map((message) => updateContextAuthors(threadId, message.name)),
  );

  return insertedMessages.map(dbMessageToMessage);
}

// Helper function to update context authors
async function updateContextAuthors(threadId: string, authorId: string) {
  const context = await db
    .select()
    .from(contextsTable)
    .where(eq(contextsTable.id, threadId))
    .execute();

  if (context.length > 0) {
    let currentAuthors: string[] | null = context[0].authors as string[];

    if (!currentAuthors?.includes(authorId)) {
      currentAuthors = [...(currentAuthors || []), authorId];
      await db
        .update(contextsTable)
        .set({
          authors: currentAuthors,
        })
        .where(eq(contextsTable.id, threadId))
        .execute();
    }
  }
}

export const deleteThread = async (
  threadId: string,
): Promise<{ success: boolean; deletedMessages: number | null }> => {
  try {
    // First, delete all messages associated with the thread and delete the thread itself in parallel
    const [deletedMessagesResult, deletedThreadsResult] = await Promise.all([
      db
        .delete(messagesTable)
        .where(eq(messagesTable.context_id, threadId))
        .execute(),
      db.delete(contextsTable).where(eq(contextsTable.id, threadId)).execute(),
    ]);

    const deletedMessages = deletedMessagesResult.rowCount;
    const deletedThreads = deletedThreadsResult.rowCount;

    return {
      success: deletedThreads === 1,
      deletedMessages,
    };
  } catch (error) {
    console.error("Error deleting thread:", error);
    return { success: false, deletedMessages: 0 };
  }
};

// 6. Delete a single message
export const deleteMessage = async (messageId: string): Promise<boolean> => {
  try {
    const { rowCount } = await db
      .delete(messagesTable)
      .where(eq(messagesTable.id, messageId))
      .execute();

    return rowCount === 1;
  } catch (error) {
    console.error("Error deleting message:", error);
    return false;
  }
};

// 7. Update thread's default agent
export const updateThreadAgent = async (
  threadId: string,
  agentName: string,
): Promise<Context | null> => {
  // Look up the agent ID based on the provided name
  const agent = await db
    .select({ id: agentsTable.id })
    .from(agentsTable)
    .where(eq(agentsTable.name, agentName))
    .execute();

  if (agent.length === 0) {
    throw new Error(`Agent with name "${agentName}" not found`);
  }

  const defaultAgentId = agent[0].id;

  await db
    .update(contextsTable)
    .set({ default_agent_id: defaultAgentId })
    .where(eq(contextsTable.id, threadId))
    .execute();

  return getThreadDetailsById(threadId);
};

export async function updateThreadScaling(
  threadId: string,
  scalingAlgorithm: "window" | "threshold" | "block" | null,
  scalingConfig: ScalingConfig | null,
): Promise<Context | null> {
  // Validate scaling config matches algorithm if both are provided
  if (scalingAlgorithm && scalingConfig) {
    if (scalingConfig.type !== scalingAlgorithm) {
      throw new Error(
        `Scaling config type doesn't match algorithm: ${scalingAlgorithm}`,
      );
    }
  }

  await db
    .update(contextsTable)
    .set({
      scaling_algorithm: scalingAlgorithm,
      scaling_config: scalingConfig,
    })
    .where(eq(contextsTable.id, threadId))
    .execute();

  return getThreadDetailsById(threadId);
}

export async function listAllThreads(): Promise<Context[]> {
  const contexts = await db
    .select({
      context: contextsTable,
      agent: {
        id: agentsTable.id,
        name: agentsTable.name,
      },
    })
    .from(contextsTable)
    .leftJoin(agentsTable, eq(contextsTable.default_agent_id, agentsTable.id))
    .execute();

  return contexts.map(({ context, agent }) => ({
    id: context.id,
    platform: context.platform,
    description: context.description,
    authors: context.authors as string[],
    default_agent_id: context.default_agent_id,
    default_agent: agent ? { id: agent.id, name: agent.name } : null,
  }));
}
