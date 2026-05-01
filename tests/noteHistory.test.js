import test from 'node:test';
import assert from 'node:assert/strict';
import { createContentDb } from '../src/contentDb.js';

test('notes can be edited while preserving immutable history snapshots', () => {
  const db = createContentDb();
  try {
    const created = db.createNote({ title: '初稿', content: '第一版内容', visibility: 'private', tags: ['v1'] });
    const updated = db.updateNote(created.id, { title: '修改后', content: '第二版内容', visibility: 'public', tags: ['v2'] });
    assert.equal(updated.title, '修改后');
    assert.equal(updated.content, '第二版内容');
    assert.equal(updated.visibility, 'public');

    const history = db.listNoteHistory(created.id).history;
    assert.equal(history.length, 2);
    assert.deepEqual(history.map(item => item.action), ['created', 'updated']);
    assert.equal(history[0].title, '初稿');
    assert.equal(history[1].title, '修改后');
    assert.equal(history[0].revision, 1);
    assert.equal(history[1].revision, 2);
  } finally {
    db.close();
  }
});

test('deleting notes is soft delete and appends a deletion history entry', () => {
  const db = createContentDb();
  try {
    const note = db.createNote({ title: '可删除', content: '会被删除', visibility: 'public' });
    assert.equal(db.deleteNote(note.id), true);
    assert.equal(db.getNote(note.id), null);

    const active = db.listNotes({ includePrivate: true }).notes;
    assert.equal(active.some(item => item.id === note.id), false);

    const history = db.listNoteHistory(note.id, { includeDeleted: true }).history;
    assert.equal(history.length, 2);
    assert.deepEqual(history.map(item => item.action), ['created', 'deleted']);
    assert.equal(history[1].deletedAt.length > 0, true);
  } finally {
    db.close();
  }
});
