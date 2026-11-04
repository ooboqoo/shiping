import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { ChatHistory } from './ai-client'
export const CHAT_SCHEMA = `
CREATE TABLE IF NOT EXISTS chat_sessions(id TEXT PRIMARY KEY,project TEXT NOT NULL,title TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL,FOREIGN KEY(project) REFERENCES projects(id));
CREATE TABLE IF NOT EXISTS chat_turns(id TEXT PRIMARY KEY,session TEXT NOT NULL,request_id TEXT NOT NULL,question TEXT NOT NULL,answer TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL,error TEXT,created INTEGER NOT NULL,updated INTEGER NOT NULL,UNIQUE(session,request_id),FOREIGN KEY(session) REFERENCES chat_sessions(id) ON DELETE CASCADE);
CREATE UNIQUE INDEX IF NOT EXISTS chat_single_running ON chat_turns(session) WHERE status='running';
CREATE INDEX IF NOT EXISTS chat_project_updated ON chat_sessions(project,updated);
`
export class ChatCatalog {
  constructor(
    private db: DatabaseSync,
    private guard: (project: string) => unknown,
    private atomic: <T>(fn: () => T) => T
  ) {}
  recover() {
    this.db
      .prepare(
        "UPDATE chat_turns SET status='interrupted',error='后台重启，回答已中断',updated=? WHERE status='running'"
      )
      .run(Date.now())
  }
  list(project: string) {
    this.guard(project)
    return this.db
      .prepare('SELECT * FROM chat_sessions WHERE project=? ORDER BY updated DESC LIMIT 200')
      .all(project)
  }
  create(project: string) {
    this.guard(project)
    const now = Date.now(),
      id = randomUUID()
    this.db
      .prepare('INSERT INTO chat_sessions VALUES(?,?,?,?,?)')
      .run(id, project, '新对话', now, now)
    return { id, project, title: '新对话', created: now, updated: now }
  }
  private session(project: string, id: string): any {
    this.guard(project)
    const s = this.db
      .prepare('SELECT * FROM chat_sessions WHERE id=? AND project=?')
      .get(id, project)
    if (!s) throw Error('对话不存在')
    return s
  }
  get(project: string, id: string) {
    const s = this.session(project, id)
    return {
      ...s,
      turns: this.db
        .prepare(
          'SELECT * FROM (SELECT *,rowid AS position FROM chat_turns WHERE session=? ORDER BY created DESC,rowid DESC LIMIT 100) ORDER BY created,position'
        )
        .all(id)
        .map((t: any) => this.decode(t))
    }
  }
  private decode(t: any) {
    const payload = JSON.parse(t.payload)
    return { ...t, requestId: t.request_id, ...payload, payload: undefined }
  }
  turn(project: string, session: string, id: string) {
    this.session(project, session)
    const t = this.db.prepare('SELECT * FROM chat_turns WHERE session=? AND id=?').get(session, id)
    if (!t) throw Error('消息不存在')
    return this.decode(t)
  }
  begin(project: string, session: string, requestId: string, question: string) {
    return this.atomic(() => {
      this.session(project, session)
      if (
        typeof requestId !== 'string' ||
        !/^[-\w]{1,80}$/.test(requestId) ||
        typeof question !== 'string' ||
        !question.trim() ||
        question.length > 3000
      )
        throw Error('问题或提交编号无效')
      const old = this.db
        .prepare('SELECT * FROM chat_turns WHERE session=? AND request_id=?')
        .get(session, requestId) as any
      if (old) {
        if (old.question !== question) throw Error('提交编号已用于另一问题')
        return { ...this.decode(old), replay: true }
      }
      if (
        this.db
          .prepare("SELECT id FROM chat_turns WHERE session=? AND status='running'")
          .get(session)
      )
        throw Error('当前对话仍在回答，请先停止或等待')
      if (
        (
          this.db
            .prepare('SELECT count(*) AS n FROM chat_turns WHERE session=?')
            .get(session) as any
        ).n >= 200
      )
        throw Error('当前对话已满，请新建对话')
      const id = randomUUID(),
        now = Date.now()
      this.db
        .prepare('INSERT INTO chat_turns VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(id, session, requestId, question, '', 'running', '{}', null, now, now)
      this.db
        .prepare(
          "UPDATE chat_sessions SET title=CASE WHEN title='新对话' THEN ? ELSE title END,updated=? WHERE id=?"
        )
        .run(question.trim().slice(0, 40), now, session)
      return this.turn(project, session, id)
    })
  }
  update(id: string, answer: string, payload: any) {
    this.db
      .prepare("UPDATE chat_turns SET answer=?,payload=?,updated=? WHERE id=? AND status='running'")
      .run(answer, JSON.stringify(payload), Date.now(), id)
  }
  finish(
    id: string,
    status: 'completed' | 'failed' | 'interrupted',
    answer: string,
    payload: any,
    error?: string
  ) {
    this.db
      .prepare(
        "UPDATE chat_turns SET status=?,answer=?,payload=?,error=?,updated=? WHERE id=? AND status='running'"
      )
      .run(status, answer, JSON.stringify(payload), error || null, Date.now(), id)
  }
  history(project: string, session: string): ChatHistory {
    this.session(project, session)
    const rows = this.db
      .prepare(
        "SELECT question,answer FROM (SELECT question,answer,created,rowid AS position FROM chat_turns WHERE session=? AND status='completed' ORDER BY created DESC,rowid DESC LIMIT 3) ORDER BY created,position"
      )
      .all(session) as any[]
    return rows.flatMap((t) => [
      { role: 'user' as const, content: t.question.slice(-1500) },
      { role: 'assistant' as const, content: t.answer.slice(-1500) }
    ])
  }
  remove(project: string, session: string) {
    this.session(project, session)
    if (
      this.db.prepare("SELECT id FROM chat_turns WHERE session=? AND status='running'").get(session)
    )
      throw Error('请先停止正在生成的回答')
    this.db.prepare('DELETE FROM chat_sessions WHERE id=?').run(session)
  }
}
