
import {
  saveUser,
  setUserConsent,
  hasConsent,
  saveMessage,
  getRecentMessages,
  getGroupMembers,
  getUser,
} from "./database";

import { analyzeHabits } from "./gemini";

interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  GEMINI_API_KEY: string;
  nuvo_chat_db: D1Database;
}

interface TelegramUser {
  id: number;
  username?: string;
  first_name: string;
}

interface TelegramUpdate {
  message?: {
    message_id: number;
    date: number;
    from?: TelegramUser;
    chat: {
      id: number;
      type: string;
    };
    text?: string;
    reply_to_message?: {
      from?: TelegramUser;
    };
  };
}

// Prevent dynamic text from breaking Telegram HTML
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Reusable Telegram message sender
async function sendMessage(
  env: Env,
  chatId: number,
  text: string,
  parseMode?: "HTML"
): Promise<void> {
  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        ...(parseMode ? { parse_mode: parseMode } : {}),
      }),
    }
  );

  if (!response.ok) {
    throw new Error(
      `Telegram API error ${response.status}: ${await response.text()}`
    );
  }
}

// Main Cloudflare Worker
export default {
  async fetch(
    request: Request,
    env: Env
  ): Promise<Response> {

    // Health check
    if (request.method === "GET") {
      return new Response("NUVO Chat online");
    }

    // Telegram updates must arrive through POST
    if (request.method !== "POST") {
      return new Response("Method not allowed", {
        status: 405,
      });
    }

    // Authenticate incoming Telegram webhook
    const secret = request.headers.get(
      "X-Telegram-Bot-Api-Secret-Token"
    );

    if (
      !env.TELEGRAM_WEBHOOK_SECRET ||
      secret !== env.TELEGRAM_WEBHOOK_SECRET
    ) {
      return new Response("Unauthorized", {
        status: 401,
      });
    }

    // Decode the Telegram message
    let update: TelegramUpdate;

    try {
      update = (await request.json()) as TelegramUpdate;
    } catch {
      return new Response("Invalid JSON", {
        status: 400,
      });
    }

    const message = update.message;

    if (!message?.from || !message.text) {
      return new Response("OK");
    }

    const db = env.nuvo_chat_db;
    const userId = message.from.id;
    const chatId = message.chat.id;
    const text = message.text;

    const isGroup =
      message.chat.type === "group" ||
      message.chat.type === "supergroup";

    try {
      // Keep sender identity updated
      await saveUser(
        db,
        userId,
        message.from.username ?? null,
        message.from.first_name
      );

      if (text === "/start") {
        await sendMessage(
          env,
          chatId,
          "🚀 NUVO Chat is online!\n\n" +
          "turn group chat moments into actual challenges.\n\n" +
          "/optin - Join NUVO Chat\n" +
          "/optout - Leave NUVO Chat\n" +
          "/analyze - Find the next challenge"
        );
      }

      else if (text === "/optin") {
        await setUserConsent(db, userId, true);

        await sendMessage(
          env,
          chatId,
          "✅ you're in.\n" +
          "NUVO Chat can now remember your new group messages."
        );
      }

      else if (text === "/optout") {
        await setUserConsent(db, userId, false);

        await sendMessage(
          env,
          chatId,
          "✅ opted out. your stored messages are deleted."
        );
      }

      // Analyze conversations and propose one targeted challenge
      else if (text === "/analyze") {
        if (!isGroup) {
          await sendMessage(
            env,
            chatId,
            "use /analyze inside your group chat 💀"
          );
        }

        else {
          const rows = await getRecentMessages(
            db,
            chatId,
            50
          );

          const members = await getGroupMembers(
            db,
            chatId
          );

          if (rows.length === 0) {
            await sendMessage(
              env,
              chatId,
              "nothing to work with yet 💀"
            );
          }

          else {
            // Gemini now knows the people and their replies
            const suggestions = await analyzeHabits(
              rows,
              members,
              env.GEMINI_API_KEY
            );

            if (suggestions.length === 0) {
              await sendMessage(
                env,
                chatId,
                "no clear challenge yet. y'all gotta give me something 😭"
              );
            }

            else {
              const suggestion = suggestions[0];

              const target = await getUser(
                db,
                suggestion.target_user_id
              );

              const allowed = await hasConsent(
                db,
                suggestion.target_user_id
              );

              if (!target || !allowed) {
                await sendMessage(
                  env,
                  chatId,
                  "couldn't confirm who that challenge was for."
                );
              }

              else {
                const displayName = target.username
                  ? `@${target.username}`
                  : target.first_name || "friend";

                const mention =
                  `<a href="tg://user?id=${suggestion.target_user_id}">` +
                  `${escapeHtml(displayName)}</a>`;

                const challenge = escapeHtml(
                  suggestion.challenge
                );

                const proof = escapeHtml(
                  suggestion.proof_instruction
                );

                const output =
                  `yo ${mention} 💀\n\n` +
                  `the gc has a challenge for you.\n\n` +
                  `🚫 <b>${challenge}</b>\n\n` +
                  `📸 ${proof}\n\n` +
                  `you taking this one or nah?`;

                await sendMessage(
                  env,
                  chatId,
                  output,
                  "HTML"
                );
              }
            }
          }
        }
      }

      // Capture ordinary group conversations
      else if (isGroup && !text.startsWith("/")) {
        const consented = await hasConsent(
          db,
          userId
        );

        if (consented) {
          // A reply tells us who the message is directed at
          const replyToUserId =
            message.reply_to_message?.from?.id;

          await saveMessage(db, {
            chatId,
            userId,
            messageId: message.message_id,
            text,
            timestamp: message.date,
            replyToUserId,
          });
        }
      }

      return new Response("OK");

    } catch (error) {
      console.error("NUVO Chat error:", error);

      return new Response(
        "Internal Server Error",
        { status: 500 }
      );
    }
  },
};
