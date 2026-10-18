
import {
  saveUser,
  setUserConsent,
  hasConsent,
  upsertGroupMember,
  getGroupMembers,
  saveMessage,
  getRecentMessages,
  createChallenge,
  getActiveChallenge,
  proofAlreadyProcessed,
  recordProof,
  getLeaderboard,
} from "./database";

import {
  analyzeHabits,
  verifyPhoto,
  GeminiError,
} from "./gemini";

interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  GEMINI_API_KEY: string;
  nuvo_chat_db: D1Database;
}

interface TelegramUser {
  id: number;
  first_name: string;
  username?: string;
}

interface TelegramEntity {
  type: string;
  offset: number;
  length: number;
  user?: TelegramUser;
}

interface TelegramMessage {
  message_id: number;
  date: number;
  from?: TelegramUser;
  chat: {
    id: number;
    type: string;
  };
  text?: string;
  entities?: TelegramEntity[];
  reply_to_message?: {
    from?: TelegramUser;
  };
  photo?: Array<{
    file_id: string;
    width: number;
    height: number;
    file_size?: number;
  }>;
}

interface TelegramUpdate {
  update_id?: number;
  message?: TelegramMessage;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function userName(user: TelegramUser): string {
  return user.username
    ? `@${user.username}`
    : user.first_name;
}

function mention(
  userId: number,
  name: string
): string {
  return (
    `<a href="tg://user?id=${userId}">` +
    `${escapeHtml(name)}</a>`
  );
}

// General Telegram API client
async function telegramApi<T>(
  env: Env,
  method: string,
  body: object
): Promise<T> {
  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );

  const result = await response.json() as {
    ok: boolean;
    result?: T;
    description?: string;
  };

  if (
    !response.ok ||
    !result.ok ||
    result.result === undefined
  ) {
    throw new Error(
      `Telegram ${method}: ` +
      `${result.description ?? response.status}`
    );
  }

  return result.result;
}

// Send a message, optionally replying to a photo
async function sendMessage(
  env: Env,
  chatId: number,
  text: string,
  replyToMessageId?: number
): Promise<void> {
  await telegramApi(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    ...(replyToMessageId
      ? {
          reply_parameters: {
            message_id: replyToMessageId,
            allow_sending_without_reply: true,
          },
        }
      : {}),
  });
}

// Create and announce the next challenge
async function analyzeGroup(
  env: Env,
  chatId: number
): Promise<void> {
  const db = env.nuvo_chat_db;

  const [messages, members] = await Promise.all([
    getRecentMessages(db, chatId, 70),
    getGroupMembers(db, chatId),
  ]);

  if (!messages.length || !members.length) {
    await sendMessage(
      env,
      chatId,
      "nothing saved yet 💀\n" +
      "run /optin, then talk in the group first."
    );
    return;
  }

  let suggestion;

  try {
    suggestion = await analyzeHabits(
      messages,
      members,
      env.GEMINI_API_KEY
    );
  } catch (error) {
    await sendMessage(
      env,
      chatId,
      describeGeminiError(error)
    );
    return;
  }

  if (!suggestion) {
    await sendMessage(
      env,
      chatId,
      "couldn't find a clear challenge 😭\n" +
      "try tagging a friend with a specific dare."
    );
    return;
  }

  const target = members.find(
    m => m.user_id === suggestion.target_user_id
  );

  if (
    !target ||
    !(await hasConsent(db, target.user_id))
  ) {
    await sendMessage(
      env,
      chatId,
      "couldn't identify an opted-in target."
    );
    return;
  }

  // Save challenge before announcing it
  const challengeId = await createChallenge(db, {
    chatId,
    targetUserId: target.user_id,
    rule: suggestion.rule,
    photoCheck: suggestion.photo_check,
    photoCanComplete: suggestion.photo_can_complete,
    source: suggestion.source,
  });

  const name = target.username
    ? `@${target.username}`
    : target.first_name;

  const photoInstructions = suggestion.photo_check
    ? `📸 send a photo here.\n` +
      `i'll check: ${escapeHtml(suggestion.photo_check)}`
    : "this one can't be checked with a photo.";

  const limitation =
    suggestion.photo_check &&
    !suggestion.photo_can_complete
      ? "\n\none picture can show progress, " +
        "not necessarily full completion."
      : "";

  await sendMessage(
    env,
    chatId,
    `yo ${mention(target.user_id, name)} 💀\n\n` +
    `🎯 <b>${escapeHtml(suggestion.rule)}</b>\n\n` +
    photoInstructions +
    limitation +
    `\n\nchallenge #${challengeId} is live.`
  );
}

// Explain Gemini failures in normal Telegram language
function describeGeminiError(error: unknown): string {
  if (error instanceof GeminiError) {
    if (error.statusCode === 429) {
      return (
        "⚠️ Gemini hit its API quota.\n" +
        "can't verify challenges until capacity is available."
      );
    }

    if ([500, 502, 503].includes(error.statusCode)) {
      return (
        "⚠️ Gemini is overloaded right now 😭\n" +
        "your challenge is still saved. try again."
      );
    }
  }

  console.error("Gemini error:", error);

  return (
    "⚠️ AI verification failed.\n" +
    "try again or check the Worker logs."
  );
}

// Download an image from Telegram
async function downloadPhoto(
  env: Env,
  fileId: string
): Promise<{
  bytes: ArrayBuffer;
  mimeType: string;
}> {
  const file = await telegramApi<{
    file_path?: string;
    file_size?: number;
  }>(env, "getFile", {
    file_id: fileId,
  });

  if (!file.file_path) {
    throw new Error("No Telegram photo path returned.");
  }

  if (
    file.file_size !== undefined &&
    file.file_size > 7_000_000
  ) {
    throw new Error("Photo is too large (max 7 MB).");
  }

  const response = await fetch(
    `https://api.telegram.org/file/bot` +
    `${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`
  );

  if (!response.ok) {
    throw new Error(
      `Photo download error: ${response.status}`
    );
  }

  const bytes = await response.arrayBuffer();

  if (bytes.byteLength > 7_000_000) {
    throw new Error("Photo is too large.");
  }

  const path = file.file_path.toLowerCase();

  const mimeType = path.endsWith(".png")
    ? "image/png"
    : path.endsWith(".webp")
      ? "image/webp"
      : "image/jpeg";

  return { bytes, mimeType };
}

// Check the photo against the target's active challenge
async function processPhoto(
  env: Env,
  message: TelegramMessage
): Promise<void> {
  if (!message.from || !message.photo?.length) {
    return;
  }

  const db = env.nuvo_chat_db;
  const chatId = message.chat.id;
  const userId = message.from.id;
  const messageId = message.message_id;

  if (!(await hasConsent(db, userId))) {
    await sendMessage(
      env,
      chatId,
      "run /optin before sending challenge proof.",
      messageId
    );
    return;
  }

  const challenge = await getActiveChallenge(
    db,
    chatId,
    userId
  );

  if (!challenge) {
    await sendMessage(
      env,
      chatId,
      "📸 got the photo, but you don't have an active challenge.\n" +
      "run /challenge first.",
      messageId
    );
    return;
  }

  if (
    await proofAlreadyProcessed(db, chatId, messageId)
  ) {
    return;
  }

  if (!challenge.photo_check) {
    await sendMessage(
      env,
      chatId,
      "this challenge doesn't have a photo-verifiable condition.",
      messageId
    );
    return;
  }

  // Acknowledge the image before calling Gemini
  await sendMessage(
    env,
    chatId,
    "📸 got it! checking your challenge...",
    messageId
  );

  try {
    const photo = message.photo[
      message.photo.length - 1
    ];

    const { bytes, mimeType } = await downloadPhoto(
      env,
      photo.file_id
    );

    const judgment = await verifyPhoto(
      bytes,
      mimeType,
      challenge.rule,
      challenge.photo_check,
      env.GEMINI_API_KEY
    );

    // A successfully checked pose is not proof of
    // a long workout or other multi-step challenge.
    const outcome =
      judgment.verdict === "verified" &&
      challenge.photo_can_complete !== 1
        ? "uncertain"
        : judgment.verdict;

    const recorded = await recordProof(db, {
      challengeId: challenge.id,
      chatId,
      userId,
      messageId,
      outcome,
      explanation: judgment.explanation,
    });

    if (recorded.duplicate) return;

    const person = mention(
      userId,
      userName(message.from)
    );

    let heading: string;

    if (recorded.credited) {
      heading = "✅ <b>challenge complete! +1 point</b>";
    } else if (judgment.verdict === "verified") {
      heading =
        "📸 <b>photo checkpoint passed</b>\n" +
        "full challenge completion isn't proven yet.";
    } else if (judgment.verdict === "not_verified") {
      heading = "❌ <b>photo didn't pass</b>";
    } else {
      heading = "🤔 <b>not enough evidence</b>";
    }

    await sendMessage(
      env,
      chatId,
      `${person}\n\n${heading}\n\n` +
      escapeHtml(judgment.explanation),
      messageId
    );

  } catch (error) {
    console.error("Photo verification error:", error);

    await sendMessage(
      env,
      chatId,
      describeGeminiError(error),
      messageId
    );
  }
}

// Handle all commands and group messages
async function handleUpdate(
  env: Env,
  update: TelegramUpdate
): Promise<void> {
  const message = update.message;

  if (!message?.from) return;

  const db = env.nuvo_chat_db;
  const chatId = message.chat.id;
  const user = message.from;
  const userId = user.id;

  const isGroup =
    message.chat.type === "group" ||
    message.chat.type === "supergroup";

  const command = (message.text ?? "")
    .split(/\s+/)[0]
    .split("@")[0]
    .toLowerCase();

  await saveUser(
    db,
    userId,
    user.username ?? null
  );

  if (command === "/start") {
    await sendMessage(
      env,
      chatId,
      "🚀 <b>NUVO Chat</b>\n\n" +
      "group chats become real challenges.\n\n" +
      "/optin — join\n" +
      "/optout — leave\n" +
      "/challenge — generate challenge\n" +
      "/leaderboard — see rankings\n\n" +
      "send a photo to attempt your challenge."
    );
    return;
  }

  if (command === "/optin") {
    await setUserConsent(db, userId, true);

    if (isGroup) {
      await upsertGroupMember(
        db,
        chatId,
        userId,
        user.username ?? null,
        user.first_name
      );
    }

    await sendMessage(
      env,
      chatId,
      "✅ you're opted in. let the challenges begin."
    );
    return;
  }

  if (command === "/optout") {
    await setUserConsent(db, userId, false);

    await sendMessage(
      env,
      chatId,
      "✅ opted out. saved messages, active challenges " +
      "and scores for your account have been cleared."
    );
    return;
  }

  if (command === "/challenge") {
    if (!isGroup) {
      await sendMessage(
        env,
        chatId,
        "use /challenge in your Telegram group."
      );
    } else {
      await analyzeGroup(env, chatId);
    }
    return;
  }

  if (command === "/leaderboard") {
    if (!isGroup) {
      await sendMessage(
        env,
        chatId,
        "use /leaderboard in a group."
      );
      return;
    }

    const scores = await getLeaderboard(db, chatId);

    if (!scores.length) {
      await sendMessage(
        env,
        chatId,
        "🏆 no verified completions yet."
      );
      return;
    }

    const rankings = scores.map((entry, index) => {
      const name = entry.username
        ? `@${entry.username}`
        : entry.first_name ?? `User ${entry.user_id}`;

      const marker =
        index === 0 ? "🥇" :
        index === 1 ? "🥈" :
        index === 2 ? "🥉" :
        `${index + 1}.`;

      return (
        `${marker} ${escapeHtml(name)} — ` +
        `${entry.points} pts`
      );
    }).join("\n");

    await sendMessage(
      env,
      chatId,
      "🏆 <b>NUVO Leaderboard</b>\n\n" +
      rankings
    );
    return;
  }

  if (!isGroup) return;

  // Photos can arrive without any text
  if (message.photo?.length) {
    await processPhoto(env, message);
    return;
  }

  if (!(await hasConsent(db, userId))) {
    return;
  }

  await upsertGroupMember(
    db,
    chatId,
    userId,
    user.username ?? null,
    user.first_name
  );

  if (
    !message.text ||
    message.text.startsWith("/")
  ) {
    return;
  }

  await saveMessage(db, {
    chatId,
    userId,
    messageId: message.message_id,
    text: message.text,
    timestamp: message.date,
    replyToUserId:
      message.reply_to_message?.from?.id ?? null,

    entities: (message.entities ?? []).map(entity => ({
      type: entity.type,
      text: message.text!.slice(
        entity.offset,
        entity.offset + entity.length
      ),
      user_id: entity.user?.id ?? null,
    })),
  });
}

// Cloudflare Worker entry point
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    if (request.method === "GET") {
      return new Response("NUVO Chat online!");
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", {
        status: 405,
      });
    }

    if (
      !env.TELEGRAM_WEBHOOK_SECRET ||
      request.headers.get(
        "X-Telegram-Bot-Api-Secret-Token"
      ) !== env.TELEGRAM_WEBHOOK_SECRET
    ) {
      return new Response("Unauthorized", {
        status: 401,
      });
    }

    let update: TelegramUpdate;

    try {
      update = (await request.json()) as TelegramUpdate;
    } catch {
      return new Response("Invalid JSON", {
        status: 400,
      });
    }

    // Acknowledge Telegram without waiting for Gemini
    ctx.waitUntil(
      handleUpdate(env, update).catch(async error => {
        console.error("NUVO Worker error:", error);

        if (update.message?.chat.id) {
          try {
            await sendMessage(
              env,
              update.message.chat.id,
              "⚠️ couldn't process that. try again."
            );
          } catch (sendError) {
            console.error(
              "Failed to send Telegram error:",
              sendError
            );
          }
        }
      })
    );

    return new Response("OK");
  },
};
