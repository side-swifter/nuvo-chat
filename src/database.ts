
export interface ChatMessage {
  chatId: number;
  userId: number;
  messageId: number;
  text: string;
  timestamp: number;
  replyToUserId?: number | null;
  entities?: unknown[];
}

export interface GroupMember {
  user_id: number;
  username: string | null;
  first_name: string;
}

export interface ConversationMessage {
  user_id: number;
  username: string | null;
  first_name: string | null;
  content: string;
  reply_to_user_id: number | null;
  entities_json: string | null;
}

export interface ActiveChallenge {
  id: number;
  chat_id: number;
  target_user_id: number;
  rule: string;
  photo_check: string | null;
  photo_can_complete: number;
  status: string;
}

export interface LeaderboardEntry {
  user_id: number;
  username: string | null;
  first_name: string | null;
  points: number;
}

// How our app registers/updates a telegram user
export async function saveUser(
  db: D1Database,
  userId: number,
  username: string | null
): Promise<void> {
  await db.prepare(
    `INSERT INTO users (user_id, username)
     VALUES (?, ?)
     ON CONFLICT(user_id)
     DO UPDATE SET username = excluded.username`
  ).bind(userId, username).run();
}

// How the app manages who consented to the chat and 
export async function setUserConsent(
  db: D1Database,
  userId: number,
  enabled: boolean
): Promise<void> {
  await db.prepare(
    `UPDATE users SET opted_in = ? WHERE user_id = ?`
  ).bind(enabled ? 1 : 0, userId).run();

  if (!enabled) {
    await db.batch([
      db.prepare(
        `DELETE FROM message_context WHERE user_id = ?`
      ).bind(userId),

      db.prepare(
        `DELETE FROM messages WHERE user_id = ?`
      ).bind(userId),

      db.prepare(
        `DELETE FROM group_members WHERE user_id = ?`
      ).bind(userId),

      db.prepare(
        `UPDATE challenge_runs SET status = 'cancelled'
         WHERE target_user_id = ? AND status = 'active'`
      ).bind(userId),

      db.prepare(
        `DELETE FROM photo_proofs WHERE user_id = ?`
      ).bind(userId),

      db.prepare(
        `DELETE FROM scores WHERE user_id = ?`
      ).bind(userId),
    ]);
  }
}

export async function hasConsent(
  db: D1Database,
  userId: number
): Promise<boolean> {
  const user = await db.prepare(
    `SELECT opted_in FROM users WHERE user_id = ?`
  ).bind(userId).first<{ opted_in: number }>();

  return user?.opted_in === 1;
}

// Remember participating members of each Telegram group
export async function upsertGroupMember(
  db: D1Database,
  chatId: number,
  userId: number,
  username: string | null,
  firstName: string
): Promise<void> {
  await db.prepare(
    `INSERT INTO group_members
     (chat_id, user_id, username, first_name)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(chat_id, user_id)
     DO UPDATE SET
       username = excluded.username,
       first_name = excluded.first_name`
  ).bind(chatId, userId, username, firstName).run();
}

export async function getGroupMembers(
  db: D1Database,
  chatId: number
): Promise<GroupMember[]> {
  const result = await db.prepare(
    `SELECT gm.user_id, gm.username, gm.first_name
     FROM group_members gm
     JOIN users u ON u.user_id = gm.user_id
     WHERE gm.chat_id = ? AND u.opted_in = 1`
  ).bind(chatId).all<GroupMember>();

  return result.results;
}

// Save opted-in chat messages and mention/reply context
export async function saveMessage(
  db: D1Database,
  message: ChatMessage
): Promise<void> {
  await db.batch([
    db.prepare(
      `INSERT OR IGNORE INTO messages
       (chat_id, user_id, message_id, content, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(
      message.chatId,
      message.userId,
      message.messageId,
      message.text,
      message.timestamp
    ),

    db.prepare(
      `INSERT OR IGNORE INTO message_context
       (chat_id, message_id, user_id,
        reply_to_user_id, entities_json)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(
      message.chatId,
      message.messageId,
      message.userId,
      message.replyToUserId ?? null,
      JSON.stringify(message.entities ?? [])
    ),
  ]);
}

// Retrieve chronological context for Gemini
export async function getRecentMessages(
  db: D1Database,
  chatId: number,
  limit = 70
): Promise<ConversationMessage[]> {
  const result = await db.prepare(
    `SELECT m.user_id, gm.username, gm.first_name,
            m.content, mc.reply_to_user_id, mc.entities_json
     FROM messages m
     JOIN users u ON u.user_id = m.user_id
     LEFT JOIN group_members gm
       ON gm.chat_id = m.chat_id AND gm.user_id = m.user_id
     LEFT JOIN message_context mc
       ON mc.chat_id = m.chat_id
       AND mc.message_id = m.message_id
     WHERE m.chat_id = ? AND u.opted_in = 1
     ORDER BY m.created_at DESC, m.id DESC
     LIMIT ?`
  ).bind(
    chatId,
    Math.max(1, Math.min(limit, 100))
  ).all<ConversationMessage>();

  return result.results.reverse();
}

// Launch a challenge; one active challenge per target/group
export async function createChallenge(
  db: D1Database,
  args: {
    chatId: number;
    targetUserId: number;
    rule: string;
    photoCheck: string | null;
    photoCanComplete: boolean;
    source: string;
  }
): Promise<number> {
  const result = await db.batch([
    db.prepare(
      `UPDATE challenge_runs
       SET status = 'replaced'
       WHERE chat_id = ? AND target_user_id = ?
       AND status = 'active'`
    ).bind(args.chatId, args.targetUserId),

    db.prepare(
      `INSERT INTO challenge_runs
       (chat_id, target_user_id, rule, photo_check,
        photo_can_complete, source, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`
    ).bind(
      args.chatId,
      args.targetUserId,
      args.rule,
      args.photoCheck,
      args.photoCanComplete ? 1 : 0,
      args.source,
      Math.floor(Date.now() / 1000)
    ),
  ]);

  return Number(result[1].meta.last_row_id);
}

export async function getActiveChallenge(
  db: D1Database,
  chatId: number,
  userId: number
): Promise<ActiveChallenge | null> {
  return db.prepare(
    `SELECT id, chat_id, target_user_id,
            rule, photo_check, photo_can_complete, status
     FROM challenge_runs
     WHERE chat_id = ? AND target_user_id = ?
     AND status = 'active'
     ORDER BY id DESC LIMIT 1`
  ).bind(chatId, userId).first<ActiveChallenge>();
}

export async function proofAlreadyProcessed(
  db: D1Database,
  chatId: number,
  messageId: number
): Promise<boolean> {
  const row = await db.prepare(
    `SELECT id FROM photo_proofs
     WHERE chat_id = ? AND message_id = ?`
  ).bind(chatId, messageId).first<{ id: number }>();

  return row !== null;
}

// Record a photo result and award one point for completion
export async function recordProof(
  db: D1Database,
  args: {
    challengeId: number;
    chatId: number;
    userId: number;
    messageId: number;
    outcome: "verified" | "not_verified" | "uncertain";
    explanation: string;
  }
): Promise<{ credited: boolean; duplicate: boolean }> {
  const inserted = await db.prepare(
    `INSERT OR IGNORE INTO photo_proofs
     (challenge_id, chat_id, user_id, message_id,
      outcome, explanation, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    args.challengeId,
    args.chatId,
    args.userId,
    args.messageId,
    args.outcome,
    args.explanation,
    Math.floor(Date.now() / 1000)
  ).run();

  if (!inserted.meta.changes) {
    return { credited: false, duplicate: true };
  }

  if (args.outcome !== "verified") {
    return { credited: false, duplicate: false };
  }

  // Conditional transition prevents double completion
  const finished = await db.prepare(
    `UPDATE challenge_runs SET status = 'completed'
     WHERE id = ? AND chat_id = ? AND target_user_id = ?
     AND status = 'active'`
  ).bind(
    args.challengeId,
    args.chatId,
    args.userId
  ).run();

  if (!finished.meta.changes) {
    return { credited: false, duplicate: false };
  }

  await db.prepare(
    `INSERT INTO scores (chat_id, user_id, points)
     VALUES (?, ?, 1)
     ON CONFLICT(chat_id, user_id)
     DO UPDATE SET points = points + 1`
  ).bind(args.chatId, args.userId).run();

  return { credited: true, duplicate: false };
}

// Get a group's competition rankings
export async function getLeaderboard(
  db: D1Database,
  chatId: number
): Promise<LeaderboardEntry[]> {
  const result = await db.prepare(
    `SELECT s.user_id, s.points,
            gm.username, gm.first_name
     FROM scores s
     LEFT JOIN group_members gm
       ON gm.chat_id = s.chat_id
       AND gm.user_id = s.user_id
     WHERE s.chat_id = ?
     ORDER BY s.points DESC, s.user_id
     LIMIT 10`
  ).bind(chatId).all<LeaderboardEntry>();

  return result.results;
}
