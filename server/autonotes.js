// Background "live notes" job: watches the transcript and periodically asks
// Ollama for the NEW points to append to the auto-notes summary. Each note
// (recording session) owns one instance; its bullets are SERVER-OWNED and
// live in their own file (data/sessions/<slug>/autonotes.md) — never
// inside the user's notes document. The UI renders the two side by side, but
// they cannot contaminate each other, so the accumulated bullets can never
// pick up client-generated headings or manual edits. The section grows as
// the session progresses; the only rewrite is an explicit "Rebuild all",
// which runs underneath the live tick instead of pausing it (see doRebuild).
// All Ollama work is funneled through `enqueue` so on-demand commands and
// this job never run concurrently (the local model is single-tenant anyway).
import {
  chatStream,
  autoNotesMessages,
  rebuildAutoNotesMessages,
  mapAutoNotesMessages,
  mergeAutoNotesMessages,
} from './ollama.js';

const TICK_MS = 20000;
const MIN_NEW_CHARS = 250; // new transcript material required between runs
const MAX_NEW_MATERIAL = 6000; // cap on the transcript chunk sent per update
const MAP_CHUNK_CHARS = 12000; // transcript per prompt in a rebuild; longer sessions are rebuilt map-reduce
const MERGE_INPUT_CHARS = 12000; // max chars of partial bullet lists per merge prompt
// Ollama silently truncates the head of any prompt that exceeds the model's
// context window. The largest auto-notes prompt (~20k chars ≈ 5–6k tokens)
// overflows the ~4096 default, so raise the window; 8192 leaves room for the
// reply too. Override with OLLAMA_NUM_CTX if a model can't hold it.
const NUM_CTX = Number(process.env.OLLAMA_NUM_CTX) || 8192;

/** Split the transcript into map-sized chunks, breaking between utterances. */
function chunkTranscript(text, cap = MAP_CHUNK_CHARS) {
  if (text.length <= cap) return [text];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + cap, text.length);
    if (end < text.length) {
      const nl = text.lastIndexOf('\n', end);
      if (nl > start) end = nl + 1; // break between utterances, not mid-line
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

/** Group items into batches whose total size stays under cap (merge rounds). */
function batchByChars(items, cap) {
  const batches = [];
  let cur = [];
  let size = 0;
  for (const item of items) {
    if (cur.length && size + item.length > cap) {
      batches.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(item);
    size += item.length + 2; // the blank line joined between lists
  }
  if (cur.length) batches.push(cur);
  return batches;
}

export function createAutoNotes({
  getTranscriptText,
  getNotesDoc,
  getConfig,
  getProfileContext,
  enqueue,
  broadcast,
  interactivePending,
  loadAutoNotes,
  saveAutoNotes,
}) {
  let timer = null;
  let ticking = false; // an incremental tick's Ollama call is in flight
  let rebuilding = false; // a rebuild is in progress — ticks keep running under it
  let tickQueued = false; // a scheduled tick is already waiting in the chain
  let rebuildQueued = false; // a rebuild request is already queued or running
  const boot = loadAutoNotes();
  let content = boot.content; // the accumulated bullets so far
  let updatedAt = boot.updated; // HH:MM of the last change — the only timestamp shown
  // Boot state: the persisted bullets already reflect the persisted
  // transcript, so mark the transcript as consumed — a restart must never
  // re-derive the previous session's bullets. Only genuinely new speech
  // generates new bullets.
  let lastDigestLen = getTranscriptText().length; // transcript chars already incorporated

  // Rebuild bookkeeping, meaningful only while `rebuilding`. The panel shows
  // the rebuild's output streaming in as its top part, with the live tail —
  // the bullets ticks appended since the snapshot — growing below it. That
  // composite is exactly what the finished rebuild will leave behind, and
  // every broadcast goes through viewNow(), so the tick and the rebuild
  // never fight over the panel.
  let rebuildBase = 0; // content.length when the rebuild snapshotted; tail = content after it
  let rebuildStream = ''; // rebuild output so far, including the in-flight stage
  let rebuildAbort = false; // set by reset() — the transcript is gone, commit nothing

  let busyCount = 0; // tick + rebuild can overlap, so the busy flag counts owners
  const setBusy = (delta) => {
    busyCount = Math.max(0, busyCount + delta);
    broadcast({ t: 'autonotes-busy', busy: busyCount > 0 });
  };

  /** The panel view: while rebuilding, rebuilt-so-far above the live tail. */
  const viewNow = () => {
    if (!rebuilding || rebuildAbort) return content; // aborted output is void
    const top = rebuildStream.trim();
    if (!top) return content; // before the first token, keep showing the current view
    const tail = content.slice(rebuildBase).trim();
    return tail ? `${top}\n${tail}` : top;
  };

  async function tick({ force = false } = {}) {
    const cfg = getConfig();
    if (ticking || !cfg.autoNotes || !cfg.ollamaModel) return;
    // Scheduled runs get out of the way while toolbar commands (summarize,
    // polish, re-read, …) are waiting in the chain — a background refresh
    // must never starve what the user explicitly asked for. Explicit
    // "Update now" clicks keep their place in line.
    if (!force && interactivePending && interactivePending()) return;
    const transcript = getTranscriptText();
    if (!transcript.trim()) return;
    const newMaterial = transcript.slice(lastDigestLen).trim();
    if (!newMaterial) return;
    if (!force && newMaterial.length < MIN_NEW_CHARS) return;

    ticking = true;
    console.log(`[autonotes] job started (${newMaterial.length} new transcript chars)`);
    setBusy(1);
    try {
      let acc = '';
      let lastSent = 0;
      // While a rebuild is running the rebuild owns the panel (its stream
      // composes with the live tail), so this tick stays quiet until its
      // delta is committed — the composite view picks it up from there.
      const streaming = !rebuilding;
      await chatStream({
        model: cfg.ollamaModel,
        numCtx: NUM_CTX,
        messages: autoNotesMessages({
          existing: content,
          // the user's manual notes as context — new bullets must not
          // duplicate what is already written there
          manualNotes: getNotesDoc(),
          newMaterial: newMaterial.slice(-MAX_NEW_MATERIAL),
          profileCtx: getProfileContext(),
        }),
        onToken: (tok) => {
          acc += tok;
          updatedAt = new Date().toTimeString().slice(0, 5);
          const now = Date.now();
          if (streaming && now - lastSent > 300) {
            lastSent = now;
            broadcast({ t: 'autonotes', content: (content ? content + '\n' : '') + acc, updated: updatedAt });
          }
        },
      });
      const delta = acc.trim();
      // notes only ever grow: append, never rewrite
      if (delta) {
        content = content ? content + '\n' + delta : delta;
        updatedAt = new Date().toTimeString().slice(0, 5);
        saveAutoNotes(content);
        console.log(`[autonotes] +${delta.length} chars -> ${content.length} total`);
      }
      lastDigestLen = transcript.length; // material consumed either way
      broadcast({ t: 'autonotes', content: viewNow(), updated: updatedAt });
    } catch (e) {
      broadcast({ t: 'error', scope: 'autonotes', message: String(e.message || e) });
    } finally {
      ticking = false;
      setBusy(-1);
    }
  }

  /**
   * Full rebuild: the transcript as of right now is re-summarized from
   * scratch and the accumulated bullets are replaced. A transcript longer
   * than one map chunk goes through map-reduce: each chunk is distilled to
   * bullets ("map"), then the per-part lists are merged in rounds until one
   * set remains ("reduce").
   *
   * The rebuild does not pause the live tick. Each map/merge stage is its
   * own unit in the Ollama chain, so ticks keep turning incoming speech into
   * bullets in the gaps between stages. Those bullets pile up below the
   * rebuild's output and are re-attached when it commits, so speech that
   * arrives during a long rebuild is neither dropped nor overwritten. The
   * old content stays until the new set is ready — a failed rebuild never
   * blanks the panel.
   */
  async function doRebuild() {
    // Let everything already waiting in the chain finish first (an in-flight
    // tick, a queued command) before snapshotting: otherwise the snapshot
    // boundary could straddle material a just-finished tick is turning into
    // bullets, and that range would end up both in the rebuilt set and in
    // the tick's appended tail.
    await enqueue(() => {});
    const cfg = getConfig();
    if (rebuilding || !cfg.autoNotes || !cfg.ollamaModel) return;
    const snapshot = getTranscriptText();
    if (!snapshot.trim()) return;
    const digestAtStart = lastDigestLen; // restore point if the rebuild fails
    rebuilding = true;
    rebuildAbort = false;
    rebuildBase = content.length;
    rebuildStream = '';
    // The snapshot is now the rebuild's to cover — ticks own only the speech
    // that arrives after it, so advance past it (otherwise the seam range
    // would end up summarized both in the rebuilt set and in the tail).
    lastDigestLen = snapshot.length;
    const prevLen = content.length;
    const chunks = chunkTranscript(snapshot);
    console.log(
      `[autonotes] rebuild started (${snapshot.length} transcript chars, ${chunks.length} part${chunks.length === 1 ? '' : 's'})`
    );
    setBusy(1);
    let failed = null;
    try {
      let lastSent = 0;
      const streamView = () => {
        if (rebuildAbort) return; // cleared mid-rebuild — don't paint stale output
        updatedAt = new Date().toTimeString().slice(0, 5);
        broadcast({ t: 'autonotes', content: viewNow(), updated: updatedAt });
      };
      const onToken = (prefix) => (tok) => {
        rebuildStream = prefix + tok;
        updatedAt = new Date().toTimeString().slice(0, 5);
        const now = Date.now();
        if (now - lastSent > 300) {
          lastSent = now;
          streamView();
        }
      };
      // Each stage is enqueued as its own chain unit rather than holding the
      // chain for the whole rebuild — that is what lets the tick (and user
      // commands) interleave between stages.
      const call = (messages, prefix) =>
        enqueue(() =>
          chatStream({
            model: cfg.ollamaModel,
            numCtx: NUM_CTX,
            messages,
            onToken: onToken(prefix),
          })
        );

      let parts = [];
      if (chunks.length === 1) {
        // Short session: one prompt, as before — the single-shot prompt
        // produces a better-shaped set than extract-then-merge.
        parts.push(
          await call(
            rebuildAutoNotesMessages({
              transcript: chunks[0],
              manualNotes: getNotesDoc(),
              profileCtx: getProfileContext(),
            }),
            ''
          )
        );
      } else {
        // Map: distill each chunk to bullets. Chunk-scoped prompts keep the
        // model's effective context small regardless of session length.
        for (let i = 0; i < chunks.length && !rebuildAbort; i++) {
          const part = (
            await call(
              mapAutoNotesMessages({
                chunk: chunks[i],
                index: i + 1,
                total: chunks.length,
                profileCtx: getProfileContext(),
              }),
              parts.join('\n')
            )
          ).trim();
          if (part) parts.push(part);
          console.log(`[autonotes] rebuild: part ${i + 1}/${chunks.length} -> ${part.length} chars of bullets`);
          streamView();
        }
        // Reduce: merge rounds over batches, each batch bounded by chars so
        // the merge prompt itself can never overflow. A merge that comes
        // back empty keeps its inputs rather than losing them.
        while (parts.length > 1 && !rebuildAbort) {
          const before = parts.length;
          const next = [];
          for (const batch of batchByChars(parts, MERGE_INPUT_CHARS)) {
            if (batch.length === 1) {
              next.push(batch[0]);
              continue;
            }
            const merged = (
              await call(
                mergeAutoNotesMessages({
                  partials: batch,
                  manualNotes: getNotesDoc(),
                  profileCtx: getProfileContext(),
                }),
                next.join('\n')
              )
            ).trim();
            next.push(merged || batch.join('\n'));
          }
          // every batch was a singleton (or every merge came back empty) —
          // nothing more to merge, so don't spin forever
          if (next.length === before) break;
          parts = next;
          streamView();
          console.log(`[autonotes] rebuild: merged down to ${parts.length} set(s)`);
        }
      }
      const fresh = parts.join('\n').trim();
      if (rebuildAbort) {
        console.log('[autonotes] rebuild discarded — the transcript was cleared mid-rebuild');
      } else if (fresh) {
        // Re-attach the bullets ticks appended while the rebuild ran: the
        // rebuilt set covers the snapshot, the tail covers everything after.
        const tail = content.slice(rebuildBase).trim();
        content = tail ? `${fresh}\n${tail}` : fresh;
        updatedAt = new Date().toTimeString().slice(0, 5);
        saveAutoNotes(content);
        console.log(`[autonotes] rebuilt: ${content.length} chars (was ${prevLen})`);
      } else {
        console.log('[autonotes] rebuild produced nothing — keeping the previous bullets');
      }
    } catch (e) {
      failed = e;
    } finally {
      const err = failed;
      if (err) {
        // A failed rebuild incorporated nothing, so give the seam range back
        // to the tick — it re-summarizes from the old marker (deduping
        // against the tail bullets through the prompt's existing context).
        lastDigestLen = Math.min(lastDigestLen, digestAtStart);
      }
      rebuilding = false;
      rebuildStream = '';
      rebuildAbort = false;
      setBusy(-1);
      broadcast({ t: 'autonotes', content, updated: updatedAt });
      if (err) broadcast({ t: 'error', scope: 'autonotes', message: `Rebuild failed: ${err.message || err}` });
    }
  }

  return {
    start() {
      // Never let scheduled ticks pile up behind a slow or hung job — if one
      // is already queued, skip this beat. The next interval fires 20 s later,
      // so nothing is lost; only the backlog spam disappears. Also idempotent:
      // every client join calls this, only the first sets the timer.
      if (!timer)
        timer = setInterval(() => {
          if (tickQueued) return;
          tickQueued = true;
          enqueue(() => tick()).finally(() => {
            tickQueued = false;
          });
        }, TICK_MS);
    },
    /**
     * Stop the ticking interval — called when a note's last viewer leaves.
     * In-flight jobs finish and persist; the instance keeps its consumption
     * state so the next viewer's start() resumes without re-deriving bullets.
     */
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    triggerNow() {
      enqueue(() => tick({ force: true }));
    },
    rebuild() {
      // Collapse duplicates: while a rebuild is queued or running, further
      // clicks are no-ops — the in-flight one already covers the snapshot and
      // the live tick keeps it current underneath. The button therefore never
      // needs to disable itself on job activity; it only grays out when there
      // is nothing to rebuild.
      if (rebuildQueued) return;
      rebuildQueued = true;
      Promise.resolve()
        .then(() => doRebuild())
        .catch((e) => console.error('[autonotes] rebuild crashed:', e))
        .finally(() => {
          rebuildQueued = false;
        });
    },
    reset() {
      // If a rebuild is running, stop it from committing — its snapshot is
      // the transcript that was just cleared, and resurrecting bullets for
      // cleared speech is the one outcome we must never allow.
      rebuildAbort = rebuilding;
      lastDigestLen = 0;
      content = '';
      updatedAt = null;
      saveAutoNotes('');
    },
    /** Current state, sent to new clients in their init message. */
    snapshot() {
      return { content: viewNow(), updated: updatedAt, busy: busyCount > 0 };
    },
  };
}