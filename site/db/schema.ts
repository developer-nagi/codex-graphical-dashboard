import {sqliteTable,text} from 'drizzle-orm/sqlite-core';
export const remoteState=sqliteTable('remote_state',{
  slot:text('slot').primaryKey(),
  payload:text('payload').notNull(),
  digest:text('digest').notNull(),
  generatedAt:text('generated_at').notNull(),
  receivedAt:text('received_at').notNull()
});
