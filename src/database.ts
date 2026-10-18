
export interface ChatMessage {
  chatId: number;
  userId: number;
  messageId: number;
  text: string;
  timestamp: number;
  replyToUserId?: number;
}

export interface ConversationMessage {
  user_id: number;
  username: string | null;
  first_name: string | null;
  content: string;
  created_at: number;
  reply_to_user_id: number | null;
}

export interface GroupMember {
  user_id: number;
  username: string | null;
  first_name: string | null;
}

// Save the identity of someone interacting with NUVO Chat
export async function saveUser(
  db: D1Database,
  userId: number,
  username: string | null,
  firstName: string
): Promise<void> {
  await db.prepare(
    `INSERT INTO users (user_id, username, first_name)
     VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       username = excluded.username,
       first_name = excluded.first_name`
  )
    .bind(userId, username, firstName)
    .run();
}

// Enable or disable message storage
export async function setUserConsent(
  db: D1Database,
  userId: number,
  optedIn: boolean
): Promise<void> {
  await db.prepare(
    `UPDATE users SET opted_in = ? WHERE user_id = ?`
  )
    .bind(optedIn ? 1 : 0, userId)
    .run();

  if (!optedIn) {
    await db.prepare(
      `DELETE FROM messages WHERE user_id = ?`
    )
      .bind(userId)
      .run();
  }
}

export async function hasConsent(
  db: D1Database,
  userId: number
): Promise<boolean> {
  const user = await db.prepare(
    `SELECT opted_in FROM users WHERE user_id = ?`
  )
    .bind(userId)
    .first<{ opted_in: number }>();

  return user?.opted_in === 1;
}

// Persist an opted-in group message
export async function saveMessage(
  db: D1Database,
  message: ChatMessage
): Promise<void> {
  await db.prepare(
    `INSERT OR IGNORE INTO messages
     (chat_id, user_id, message_id, content,
      created_at, reply_to_user_id)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(
      message.chatId,
      message.userId,
      message.messageId,
      message.text,
      message.timestamp,
      message.replyToUserId ?? null
    )
    .run();
}

// Retrieve messages with the sender's identity
export async function getRecentMessages(
  db: D1Database,
  chatId: number,
  limit = 50
): Promise<ConversationMessage[]> {
  const result = await db.prepare(
    `SELECT
       m.user_id,
       u.username,
       u.first_name,
       m.content,
       m.created_at,
       m.reply_to_user_id
     FROM messages m
     LEFT JOIN users u ON m.user_id = u.user_id
     WHERE m.chat_id = ?
     ORDER BY m.created_at DESC, m.id DESC
     LIMIT ?`
  )
    .bind(chatId, Math.max(1, Math.min(limit, 100)))
    .all<ConversationMessage>();

  return result.results.reverse();
}

// Get participants whose opted-in messages exist in this group
export async function getGroupMembers(
  db: D1Database,
  chatId: number
): Promise<GroupMember[]> {
  const result = await db.prepare(
    `SELECT DISTINCT
       u.user_id,
       u.username,
       u.first_name
     FROM users u
     INNER JOIN messages m ON m.user_id = u.user_id
     WHERE m.chat_id = ?
       AND u.opted_in = 1`
  )
    .bind(chatId)
    .all<GroupMember>();

  return result.results;
}

export async function getUser(
  db: D1Database,
  userId: number
): Promise<GroupMember | null> {
  return await db.prepare(
    `SELECT user_id, username, first_name
     FROM users
     WHERE user_id = ?`
  )
    .bind(userId)
    .first<GroupMember>();
}
