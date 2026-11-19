'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import SiteNavbar from '../components/site-navbar';
import { markdownHtml } from '../../lib/markdown.js';
import ThemeToggle from '../components/theme-toggle';
import { loadVaultSearchPages } from '../../lib/oge-vault-search-pages.js';
import { noteEditorFeedback, noteBodyMetrics } from '../../lib/oge-notes-editor-feedback.js';
import { vaultSaveFailureMessage } from '../../lib/oge-vault-save-feedback.js';
import { stageVaultFollowupSave, retireSubmittedVaultDraft } from '../../lib/oge-vault-followup-save.js';
import {
  isVaultNoteId, recentVaultNotesKey, readRecentVaultNoteIds,
  rememberRecentVaultNote, mergeRecentVaultNotes, findLinkedVaultNote,
} from '../../lib/oge-vault-recent-notes.js';

async function responseJson(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'The request could not be completed.');
  return data;
}

function savedLabel(value) {
  if (!value) return 'Just created';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Recently edited';
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function NotesPage({
  notesApi = '/api/notes', vaultMode = false, hybridDrafts = false,
  vaultOwnerId = '', vaultRepoId = null,
}) {
  const [subjects, setSubjects] = useState([]);
  const [notes, setNotes] = useState([]);
  const [nextNotesCursor, setNextNotesCursor] = useState(null);
  const [totalVaultNotes, setTotalVaultNotes] = useState(null);
  const [loadingMoreNotes, setLoadingMoreNotes] = useState(false);
  const [searchScanBusy, setSearchScanBusy] = useState(false);
  const [searchScanStatus, setSearchScanStatus] = useState('');
  const searchScanRef = useRef(null);
  const [activeSubject, setActiveSubject] = useState('');
  const [query, setQuery] = useState('');
  const [globalSearch, setGlobalSearch] = useState(false);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [selectedTag, setSelectedTag] = useState('');
  const [sortOrder, setSortOrder] = useState('latest');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [noteDialog, setNoteDialog] = useState(false);
  const [editingId, setEditingId] = useState('');
  const [readerNote, setReaderNote] = useState(null);
  // An extension link opens the reader once per page visit. Re-loading the
  // Note list after editing must not reopen it unexpectedly.
  const openedDeepLinkRef = useRef(null);
  const [heading, setHeading] = useState('');
  const [answer, setAnswer] = useState('');
  const [tagsText, setTagsText] = useState('');
  const [subjectName, setSubjectName] = useState('');
  const [showSubjectForm, setShowSubjectForm] = useState(false);
  const subjectInputRef = useRef(null);
  const createNoteAfterSubjectRef = useRef(false);
  const [subjectSaving, setSubjectSaving] = useState(false);
  const [shareMenuOpen, setShareMenuOpen] = useState(false);
  const [preview, setPreview] = useState(false);
  const [answerFullscreen, setAnswerFullscreen] = useState(false);
  const [draftStatus, setDraftStatus] = useState('');
  const [aiCleanupBusy, setAiCleanupBusy] = useState(false);
  const answerRef = useRef(null);
  const headingRef = useRef(null);
  const editorInitialRef = useRef(null);
  const [editorBaseline, setEditorBaseline] = useState(null);
  const hybridRevisionRef = useRef(0);
  const hybridPendingRef = useRef(Promise.resolve());
  const hybridGenerationRef = useRef(0);
  const [hybridReady, setHybridReady] = useState(false);
  const [newDraftId, setNewDraftId] = useState('');
  const [hybridError, setHybridError] = useState('');
  const [hybridRetryToken, setHybridRetryToken] = useState(0);
  const hybridConflictRef = useRef(false);
  // Track the latest rendered editor content, not a stale async Save closure.
  // Edits made while a GitHub request is in flight must never be discarded.
  const liveEditorRef = useRef(null);
  useEffect(() => {
    liveEditorRef.current = { heading, answer, tagsText, activeSubject, editingId, newDraftId };
  }, [heading, answer, tagsText, activeSubject, editingId, newDraftId]);

  // Browser connection events are hints, not proof that the server is up.
  // Retry only the latest editor snapshot; conflict errors require explicit
  // recovery rather than auto-overwriting a different device's draft.
  useEffect(() => {
    if (!hybridDrafts) return undefined;
    const resume = () => {
      if (hybridConflictRef.current) return;
      setHybridError('');
      setHybridRetryToken((token) => token + 1);
    };
    window.addEventListener('online', resume);
    return () => window.removeEventListener('online', resume);
  }, [hybridDrafts]);

  const hybridKey = (id) => 'oge-hybrid-draft:v1:' + encodeURIComponent(vaultOwnerId) +
    ':' + vaultRepoId + ':' + id;

  const newDraftPointerKey = (subjectId) => 'oge-hybrid-new:v1:' +
    encodeURIComponent(vaultOwnerId) + ':' + vaultRepoId + ':' + subjectId;

  async function recoverNewHybridDraft(subjectId, generation) {
    try {
      const response = await responseJson(await fetch(
        '/api/vault/drafts?new=true&subject=' + encodeURIComponent(subjectId),
        { cache: 'no-store' },
      ));
      if (generation !== hybridGenerationRef.current) return;
      const items = response.items || [];
      if (!Array.isArray(items)) throw new Error('Invalid draft recovery response.');
      // A browser-only draft may not have reached MongoDB before a reload.
      let localId = null;
      try { localId = window.sessionStorage.getItem(newDraftPointerKey(subjectId)); }
      catch { /* Storage can be disabled. */ }
      if (localId && !items.some((item) => item.id === localId)) {
        try {
          const local = JSON.parse(window.sessionStorage.getItem(hybridKey(localId)) || 'null')?.draft;
          if (local?.subjectId === subjectId && local?.baseSha === null)
            items.unshift({ id: localId, revision: 0, draft: local });
        } catch { /* Corrupt local data is never trusted. */ }
      }
      if (items.length > 0) {
        // Multiple uncommitted notes may coexist. Never discard or silently
        // overwrite one: ask which draft the user wants to resume.
        const selection = items.length === 1 ? '1' : window.prompt(
          'Found ' + items.length + ' unfinished notes. Enter a number (1–' +
          items.length + ') to recover, or Cancel for a new note.',
          '1',
        );
        const index = Number(selection) - 1;
        if (selection !== null && Number.isInteger(index) && index >= 0 && index < items.length) {
          const item = items[index];
          if (item.draft.baseSha === null && item.draft.subjectId === subjectId &&
              window.confirm('Restore this unfinished note?')) {
            setNewDraftId(item.id);
            hybridRevisionRef.current = item.revision;
            setHeading(item.draft.heading);
            setAnswer(item.draft.answer);
            setTagsText(item.draft.tags.join(', '));
            setDraftStatus('Recovered draft — press Save to commit');
          }
        }
      }
      if (response.limited) setHybridError(
        'More unfinished drafts may exist. Contact support before assuming older drafts are gone.');
    } catch (err) {
      if (generation !== hybridGenerationRef.current) return;
      // Recover the browser-only draft even when GitHub/MongoDB cannot be
      // reached. Never overwrite its data with a newly generated empty note.
      try {
        const localId = window.sessionStorage.getItem(newDraftPointerKey(subjectId));
        const local = localId &&
          JSON.parse(window.sessionStorage.getItem(hybridKey(localId)) || 'null')?.draft;
        if (local?.subjectId === subjectId && local.baseSha === null &&
            window.confirm('Server recovery unavailable. Restore the browser draft?')) {
          setNewDraftId(localId);
          hybridRevisionRef.current = 0;
          setHeading(local.heading);
          setAnswer(local.answer);
          setTagsText(local.tags.join(', '));
          setDraftStatus('Local draft recovered — Save when online');
        }
      } catch { /* Keep the editor available for a manual final Save. */ }
      setHybridError('Server draft recovery unavailable. Browser drafts may be incomplete; Save to GitHub when possible.');
    } finally {
      if (generation === hybridGenerationRef.current) setHybridReady(true);
    }
  }

  async function recoverHybridDraft(note, generation) {
    setHybridReady(false);
    setHybridError('');
    hybridRevisionRef.current = 0;
    try {
      const response = await responseJson(await fetch(
        '/api/vault/drafts?id=' + encodeURIComponent(note.id), { cache: 'no-store' },
      ));
      if (generation !== hybridGenerationRef.current) return;
      hybridRevisionRef.current = response.item?.revision || 0;
      let local = null;
      try { local = JSON.parse(window.sessionStorage.getItem(hybridKey(note.id)) || 'null')?.draft; }
      catch { /* The browser copy is best-effort. */ }
      const remote = response.item?.draft || null;
      // Never silently discard a newer local edit when the server has an
      // older autosave. The browser copy takes priority only after the user
      // explicitly approves it.
      const differentCopies = local && remote &&
        JSON.stringify(local) !== JSON.stringify(remote);
      const recovered = differentCopies &&
        window.confirm('Browser and server drafts differ. Review the browser copy first?')
        ? local : (remote || local);
      if (recovered && recovered.subjectId === note.subjectSlug &&
          recovered.baseSha === note.sha &&
          window.confirm('An unsynced draft exists. Restore these changes?')) {
        setHeading(recovered.heading);
        setAnswer(recovered.answer);
        setTagsText(recovered.tags.join(', '));
        setDraftStatus('Recovered draft — press Save to commit');
      } else if (recovered && recovered.baseSha !== note.sha) {
        setHybridError('Unsynced draft has a different GitHub revision. Preserve and review it before editing.');
      }
    } catch (err) {
      if (generation !== hybridGenerationRef.current) return;
      // A server outage must not hide a browser copy of this existing note.
      try {
        const local = JSON.parse(window.sessionStorage.getItem(hybridKey(note.id)) || 'null')?.draft;
        if (local && local.subjectId === note.subjectSlug && local.baseSha === note.sha &&
            window.confirm('Draft server unavailable. Restore this browser copy?')) {
          setHeading(local.heading);
          setAnswer(local.answer);
          setTagsText(local.tags.join(', '));
          setDraftStatus('Browser draft recovered — Save when online');
        }
      } catch { /* Keep local storage untouched on malformed data. */ }
      setHybridError(err.message || 'Draft recovery unavailable. Browser copy may still exist.');
    } finally {
      if (generation === hybridGenerationRef.current) setHybridReady(true);
    }
  }


  const rememberSavedNote = (id) => {
    if (!vaultMode || !isVaultNoteId(id)) return;
    try {
      rememberRecentVaultNote(window.localStorage,
        recentVaultNotesKey(vaultOwnerId, vaultRepoId), id);
    } catch { /* Browser storage is optional; GitHub Save already succeeded. */ }
  };

  const load = useCallback(async (preferredSubject = '') => {
    // A saved change or Refresh invalidates previous GitHub page cursors.
    // Abort in-progress read-only searches before replacing the list.
    searchScanRef.current?.abort();
    searchScanRef.current = null;
    setSearchScanBusy(false);
    setSearchScanStatus('');
    setLoading(true);
    setError('');
    try {
      let recentIds = [];
      if (vaultMode) {
        // GitHub's file tree is UUID-sorted, not chronological. A newly
        // saved Note might not be within the first 20 on the next reload.
        // Fetch a tiny list of UUIDs from THIS owner's browser, never
        // cached bodies, and always re-read the Notes from GitHub.
        try {
          const key = recentVaultNotesKey(vaultOwnerId, vaultRepoId);
          recentIds = readRecentVaultNoteIds(window.localStorage, key);
        } catch { /* private storage disabled: normal pagination still works */ }
        // Extension Save opens /vault/notes?note=<UUID> on demand.
        const directId = new URLSearchParams(window.location.search).get('note');
        if (isVaultNoteId(directId)) {
          recentIds = [directId.toLowerCase(), ...recentIds.filter((id) => id !== directId.toLowerCase())]
            .slice(0, 5);
        }
      }
      const [subjectList, response, recentResults] = await Promise.all([
        responseJson(await fetch('/api/subjects', { cache: 'no-store' })),
        responseJson(await fetch(vaultMode ? notesApi + '?paged=true&limit=20' : notesApi, { cache: 'no-store' })),
        Promise.allSettled(recentIds.map(async (id) =>
          responseJson(await fetch(notesApi + '?id=' + encodeURIComponent(id),
            { cache: 'no-store' })))),
      ]);
      const noteList = vaultMode ? response.notes : response;
      if (!Array.isArray(noteList)) throw new Error('Invalid GitHub notes response.');
      const recentNotes = recentResults.filter((result) => result.status === 'fulfilled')
        .map((result) => result.value);
      const loadedNotes = vaultMode
        ? mergeRecentVaultNotes(noteList, recentNotes) : noteList;
      const defaultSubject = subjectList[0]?.slug || '';
      setSubjects(subjectList);
      setNotes(loadedNotes);
      setNextNotesCursor(vaultMode ? response.nextCursor || null : null);
      setTotalVaultNotes(vaultMode ? response.total : null);
      const linkId = vaultMode
        ? new URLSearchParams(window.location.search).get('note') : null;
      const direct = findLinkedVaultNote(linkId, loadedNotes);
      setActiveSubject((current) => preferredSubject || direct?.subjectSlug || current || defaultSubject);
      if (direct && openedDeepLinkRef.current !== direct.id) {
        // The link must open the Note itself, not just switch to its
        // subject or show its card in the library.
        openedDeepLinkRef.current = direct.id;
        setShareMenuOpen(false);
        setReaderNote(direct);
      } else if (isVaultNoteId(linkId) && !direct &&
          openedDeepLinkRef.current !== linkId.toLowerCase()) {
        // Could be a deleted Note, a revoked GitHub connection, or a
        // temporary provider read error; do not falsely claim deletion.
        setError('Could not open the linked GitHub Note. Refresh or check your Vault connection.');
      }
    } catch (err) {
      setError(err.message || 'Could not load your notes.');
    } finally {
      setLoading(false);
    }
  }, [notesApi, vaultMode, vaultOwnerId, vaultRepoId]);

  async function loadMoreVaultNotes() {
    if (!vaultMode || !nextNotesCursor || loadingMoreNotes || loading || searchScanBusy) return;
    setLoadingMoreNotes(true);
    setError('');
    try {
      const page = await responseJson(await fetch(
        notesApi + '?paged=true&limit=20&cursor=' + encodeURIComponent(nextNotesCursor),
        { cache: 'no-store' },
      ));
      if (!Array.isArray(page.notes)) throw new Error('Invalid GitHub notes page.');
      setNotes((existing) => {
        const seen = new Set(existing.map((note) => note.id));
        return [...existing, ...page.notes.filter((note) => !seen.has(note.id))];
      });
      setNextNotesCursor(page.nextCursor || null);
      setTotalVaultNotes(page.total);
    } catch (err) {
      setError(err.message === 'vault-page-stale'
        ? 'GitHub notes changed while loading. Refresh the list after saving your draft.'
        : err.message || 'Could not load more GitHub notes.');
    } finally {
      setLoadingMoreNotes(false);
    }
  }

  async function scanRemainingVaultNotes({ subjectOnly = false } = {}) {
    // On a UUID-sorted first page, a subject may look empty even though
    // its Notes exist on later GitHub pages. Let users discover them
    // without having to guess a heading to search for.
    if (!vaultMode || (!subjectOnly && !query.trim()) ||
        (subjectOnly && !activeSubject) || !nextNotesCursor || loading ||
        loadingMoreNotes || searchScanBusy || saving || noteDialog) return;
    const targetSubject = subjectOnly ? activeSubject : null;
    let foundSubjectNote = false;
    const controller = new AbortController();
    searchScanRef.current = controller;
    setSearchScanBusy(true);
    setSearchScanStatus(subjectOnly
      ? 'Finding older GitHub Notes for this subject…'
      : 'Searching additional GitHub Notes…');
    setError('');
    try {
      const result = await loadVaultSearchPages({
        cursor: nextNotesCursor,
        shouldStop: () => controller.signal.aborted || foundSubjectNote,
        fetchPage: async (cursor) => responseJson(await fetch(
          notesApi + '?paged=true&limit=25&cursor=' + encodeURIComponent(cursor),
          { cache: 'no-store', signal: controller.signal },
        )),
        onPage: (incoming, page) => {
          if (controller.signal.aborted) return;
          if (targetSubject)
            foundSubjectNote = incoming.some((note) => note.subjectSlug === targetSubject);
          setNotes((existing) => {
            const seen = new Set(existing.map((note) => note.id));
            return [...existing, ...incoming.filter((note) => !seen.has(note.id))];
          });
          setNextNotesCursor(page.nextCursor);
          setTotalVaultNotes(page.total);
        },
      });
      if (searchScanRef.current !== controller) return;
      setSearchScanStatus(foundSubjectNote
        ? 'Found older Notes for this subject. Load more if you need the rest.'
        : result.stopped
          ? 'Search paused. You can continue from the next page.'
          : result.complete
            ? subjectOnly
              ? 'All GitHub Notes checked. There are no older Notes for this subject.'
              : 'All GitHub Notes loaded. Search now covers your full Vault.'
            : subjectOnly
              ? 'Checked ' + result.loaded + ' more Notes. Select Find older Notes again to continue.'
              : 'Loaded ' + result.loaded + ' more notes. Select Continue search to scan the rest.');
    } catch (err) {
      if (searchScanRef.current !== controller || controller.signal.aborted) return;
      setSearchScanStatus('Search stopped at the last loaded page.');
      setError(err.message === 'vault-page-stale'
        ? 'Your GitHub Notes changed while searching. Refresh your library to restart.'
        : err.message || 'Could not load the remaining GitHub Notes.');
    } finally {
      if (searchScanRef.current === controller) {
        searchScanRef.current = null;
        setSearchScanBusy(false);
      }
    }
  }

  useEffect(() => {
    let active = true;
    Promise.resolve().then(() => { if (active) void load(); });
    return () => { active = false; };
  }, [load]);

  const availableTags = useMemo(
    () => [...new Set(notes.flatMap((note) => Array.isArray(note.tags) ? note.tags : []))].sort(),
    [notes],
  );

  const visibleNotes = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return notes
      .filter((note) => globalSearch || !activeSubject || note.subjectSlug === activeSubject)
      .filter((note) => !needle || (note.heading + ' ' + note.answer + ' ' + (note.tags || []).join(' ')).toLocaleLowerCase().includes(needle))
      .filter((note) => !favoritesOnly || note.favorite)
      .filter((note) => !selectedTag || (note.tags || []).includes(selectedTag))
      .sort((a, b) => {
        if (sortOrder === 'oldest') return new Date(a.createdAt || 0) - new Date(b.createdAt || 0);
        if (sortOrder === 'title-asc') return a.heading.localeCompare(b.heading);
        if (sortOrder === 'title-desc') return b.heading.localeCompare(a.heading);
        return new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0);
      });
  }, [notes, activeSubject, query, globalSearch, favoritesOnly, selectedTag, sortOrder]);

  const active = subjects.find((subject) => subject.slug === activeSubject);
  const editorMetrics = noteBodyMetrics(answer);
  const editorFeedback = noteEditorFeedback({
    vaultMode, hybridDrafts, saving, hybridReady, editingId,
    changed: Boolean(editorBaseline && (heading !== editorBaseline.heading ||
      answer !== editorBaseline.answer || tagsText !== editorBaseline.tags)),
    draftStatus, hybridError, error, message,
  });

  function openNewNote(subjectId = activeSubject) {
    if (!subjectId) {
      // The Notes editor requires a subject, but the action must remain
      // clickable and explain what is missing instead of silently disabling.
      createNoteAfterSubjectRef.current = true;
      setShowSubjectForm(true);
      setError('');
      setMessage('Create a subject below. Your new Note will open automatically.');
      return;
    }
    const generation = ++hybridGenerationRef.current;
    setNewDraftId('');
    setHybridReady(!hybridDrafts);
    hybridRevisionRef.current = 0;
    const freshId = hybridDrafts ? crypto.randomUUID() : '';
    setNewDraftId(freshId);
    setHybridError('');
    hybridConflictRef.current = false;
    editorInitialRef.current = { heading: '', answer: '', tags: '' };
    setEditorBaseline({ heading: '', answer: '', tags: '' });
    setEditingId('');
    setHeading('');
    setAnswer('');
    setTagsText('');
    setError('');
    setMessage('');
    setPreview(false);
    setAnswerFullscreen(false);
    setDraftStatus('');
    setNoteDialog(true);
    if (hybridDrafts) void recoverNewHybridDraft(subjectId, generation);
  }

  function editNote(note) {
    const generation = ++hybridGenerationRef.current;
    setHybridReady(!hybridDrafts);
    setHybridError('');
    hybridConflictRef.current = false;
    editorInitialRef.current = {
      heading: note.heading, answer: note.answer, tags: (note.tags || []).join(', '),
    };
    setEditorBaseline({
      heading: note.heading, answer: note.answer, tags: (note.tags || []).join(', '),
    });
    setEditingId(note.id);
    setHeading(note.heading);
    setAnswer(note.answer);
    setTagsText((note.tags || []).join(', '));
    setReaderNote(null);
    setError('');
    setMessage('');
    setPreview(false);
    setAnswerFullscreen(false);
    setDraftStatus('');
    setNoteDialog(true);
    if (hybridDrafts) void recoverHybridDraft(note, generation);
  }

  // Focus the title when the editor opens and when draft recovery finishes.
  // An editor in recovery has disabled inputs, so wait until it becomes ready.
  useEffect(() => {
    if (!noteDialog || (hybridDrafts && !hybridReady)) return undefined;
    const frame = window.requestAnimationFrame(() => headingRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [noteDialog, hybridDrafts, hybridReady]);

  const hasUnsavedEditorChanges = useCallback(() => {
    if (!vaultMode || !noteDialog || !editorInitialRef.current) return false;
    const baseline = editorInitialRef.current;
    return heading !== baseline.heading || answer !== baseline.answer ||
      tagsText !== baseline.tags;
  }, [vaultMode, noteDialog, heading, answer, tagsText]);

  function closeNoteEditor() {
    if (saving || (hybridDrafts && !hybridReady)) return;
    if (hasUnsavedEditorChanges() &&
        !window.confirm('Discard unsaved GitHub note edits? These changes have not been committed to your vault.')) return;
    hybridGenerationRef.current += 1;
    setNoteDialog(false);
    setPreview(false);
  }

  // Temporary draft writes are serialized. Browser storage is updated before
  // the request, so fast typing never creates parallel out-of-order revisions.
  useEffect(() => {
    if (!hybridDrafts || !hybridReady || !noteDialog || (!editingId && !newDraftId) ||
        !hasUnsavedEditorChanges()) return undefined;
    const current = notes.find((note) => note.id === editingId);
    if (editingId && !current?.sha) return undefined;
    const noteId = editingId || newDraftId;
    const key = hybridKey(noteId);
    const draft = { subjectId: current?.subjectSlug || activeSubject, heading, answer,
      tags: [...new Set(tagsText.split(',').map((tag) => tag.trim().toLowerCase()).filter(Boolean))].slice(0, 10),
      favorite: Boolean(current?.favorite), baseSha: current?.sha || null };
    try {
      window.sessionStorage.setItem(key, JSON.stringify({ draft }));
      if (!editingId) window.sessionStorage.setItem(newDraftPointerKey(activeSubject), noteId);
    } catch { /* Server copy still available if the next request succeeds. */ }
    // Even while Save is running, preserve newer keystrokes in sessionStorage.
    // Server autosave remains paused until Save returns.
    if (saving) return undefined;
    // A conflicting edit is not a transient outage; keep the user's local
    // copy, but never overwrite the other device automatically.
    if (hybridConflictRef.current) return undefined;
    const generation = hybridGenerationRef.current;
    const timer = setTimeout(() => {
      if (generation !== hybridGenerationRef.current) return;
      if (!navigator.onLine) {
        setDraftStatus('Draft pending — offline');
        return;
      }
      setDraftStatus('Draft saving…');
      hybridPendingRef.current = hybridPendingRef.current.catch(() => {}).then(async () => {
        if (generation !== hybridGenerationRef.current) return;
        const revision = hybridRevisionRef.current + 1;
        const response = await responseJson(await fetch('/api/vault/drafts', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          cache: 'no-store', body: JSON.stringify({ id: noteId, revision, draft }),
        }));
        if (generation !== hybridGenerationRef.current) return;
        hybridRevisionRef.current = response.revision;
        setHybridError('');
        if (generation === hybridGenerationRef.current) {
          let stillLatest = false;
          try {
            stillLatest = window.sessionStorage.getItem(key) === JSON.stringify({ draft });
          } catch { /* A browser-disabled store cannot prove freshness. */ }
          setDraftStatus(stillLatest ? 'Draft saved' : 'Draft pending');
        }
      }).catch(async (err) => {
        if (generation !== hybridGenerationRef.current) return;
        // A lost response does not mean the MongoDB write failed. Read the
        // scoped draft back before declaring a conflict or retrying.
        try {
          const received = await responseJson(await fetch(
            '/api/vault/drafts?id=' + encodeURIComponent(noteId), { cache: 'no-store' },
          ));
          if (generation !== hybridGenerationRef.current) return;
          if (received.item && JSON.stringify(received.item.draft) === JSON.stringify(draft)) {
            hybridRevisionRef.current = received.item.revision;
            setHybridError('');
            const latest = window.sessionStorage.getItem(key) === JSON.stringify({ draft });
            setDraftStatus(latest ? 'Draft saved' : 'Draft pending');
            return;
          }
          if (received.item && received.item.revision >= hybridRevisionRef.current + 1)
            err = new Error('vault-draft-revision-conflict');
        } catch { /* Network failures remain pending; never overwrite remote. */ }
        if (generation !== hybridGenerationRef.current) return;
        if (err.message === 'vault-draft-revision-conflict') {
          hybridConflictRef.current = true;
          setHybridError('Draft conflict: another device changed this note. Your browser copy is preserved. Close and reopen the note to review both copies.');
        } else {
          setHybridError(err.message || 'Draft server unavailable. Retry when online.');
        }
        setDraftStatus('Draft pending');
      });
    }, 700);
    return () => clearTimeout(timer);
  }, [hybridDrafts, hybridReady, noteDialog, editingId, newDraftId, activeSubject, heading, answer, tagsText,
    notes, saving, hybridError, hybridRetryToken, hasUnsavedEditorChanges]);

  async function saveNote(event) {
    event.preventDefault();
    if (saving || !activeSubject || (hybridDrafts && !hybridReady)) return;
    setSaving(true);
    const submittedEditor = JSON.stringify({
      heading, answer, tagsText, activeSubject, editingId, newDraftId,
    });
    if (hybridDrafts) await hybridPendingRef.current.catch(() => {});
    setError('');
    setMessage('');
    let attemptedGitHubSave = null;
    try {
      const tags = [...new Set(tagsText.split(',').map((tag) => tag.trim().toLowerCase()).filter(Boolean))].slice(0, 10);
      const payload = { subjectSlug: activeSubject, heading: heading.trim(), answer: answer.trim(), tags };
      const current = notes.find((item) => item.id === editingId);
      const draftNoteId = editingId || newDraftId;
      if (hybridDrafts && draftNoteId && hasUnsavedEditorChanges()) {
        // Flush the exact editor snapshot before final GitHub Save. A 700 ms
        // debounce may otherwise leave the last characters only in the tab.
        // GitHub confirmation still decides whether the user sees Saved.
        const latest = { subjectId: current?.subjectSlug || activeSubject, heading, answer,
          tags, favorite: Boolean(current?.favorite), baseSha: current?.sha || null };
        const revision = hybridRevisionRef.current + 1;
        try {
          const temporary = await responseJson(await fetch('/api/vault/drafts', {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            cache: 'no-store',
            body: JSON.stringify({ id: draftNoteId, revision, draft: latest }),
          }));
          hybridRevisionRef.current = temporary.revision;
          setDraftStatus('Draft saved');
        } catch {
          // Do not block final GitHub Save if the temporary-draft service is
          // down; preserve the local copy until the remote commit is verified.
          setDraftStatus('Draft pending');
        }
      }
      if (vaultMode && editingId && !current?.sha) throw new Error('GitHub revision is missing. Refresh notes and try again.');
      // Only this submitted, immutable draft revision may be confirmed after a
      // lost Save response. Never use the potentially newer revision later.
      if (hybridDrafts && vaultMode && draftNoteId && hybridRevisionRef.current >= 1)
        attemptedGitHubSave = {
          noteId: draftNoteId, revision: hybridRevisionRef.current,
          submittedDraft: { subjectId: current?.subjectSlug || activeSubject,
            heading, answer, tags, favorite: Boolean(current?.favorite),
            baseSha: current?.sha || null },
        };
      const note = await responseJson(await fetch(notesApi, {
        method: editingId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editingId ? { ...payload, id: editingId,
          ...(vaultMode ? { sha: current.sha } : {}) } :
          (hybridDrafts ? { ...payload, id: newDraftId } : payload)),
      }));
      if (vaultMode) rememberSavedNote(note.id);
      // The submitted revision really was committed, but newer keystrokes
      // remain unsaved. Switch from "create this UUID" to "edit this UUID"
      // and advance the GitHub SHA so the NEXT Save is PUT, never a second
      // POST that conflicts with the already-created file.
      if (hybridDrafts && vaultMode &&
          JSON.stringify(liveEditorRef.current) !== submittedEditor) {
        const followup = stageVaultFollowupSave(notes, note, liveEditorRef.current);
        setNotes((existing) => mergeRecentVaultNotes(existing, [note]));
        // A fast reload before the next 700 ms autosave still needs the
        // browser-only newer text, now tied to this committed GitHub SHA.
        // Never erase it if sessionStorage is disabled.
        try {
          window.sessionStorage.setItem(hybridKey(note.id),
            JSON.stringify({ draft: followup.pendingDraft }));
        } catch { /* Keep the active editor and retry draft autosave. */ }
        setEditingId(followup.editingId);
        setNewDraftId(followup.newDraftId);
        editorInitialRef.current = followup.baseline;
        setEditorBaseline(followup.baseline);
        // The submitted temporary MongoDB draft still looks like a new,
        // unfinished Note unless it is retired after GitHub confirmation.
        // Retire only THAT revision; never remove the newer browser text.
        const submittedRevision = hybridRevisionRef.current;
        const cleanup = await retireSubmittedVaultDraft({
          id: note.id, revision: submittedRevision, sha: note.sha,
          reconcile: async (body) => responseJson(await fetch('/api/vault/drafts', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            cache: 'no-store', body: JSON.stringify(body),
          })),
        });
        if (cleanup.cleared) {
          // A later autosave starts a new draft revision with this Note's
          // newly committed GitHub SHA as its base, not the old create SHA.
          hybridRevisionRef.current = 0;
          if (!editingId) {
            try {
              if (window.sessionStorage.getItem(newDraftPointerKey(activeSubject)) === draftNoteId)
                window.sessionStorage.removeItem(newDraftPointerKey(activeSubject));
            } catch { /* A blocked browser store must not block saving. */ }
          }
        }
        // The editor's visible heading/body/tags are deliberately untouched.
        // On the next autosave the draft's baseSha corresponds to this
        // confirmed GitHub Note rather than the old create intent.
        setDraftStatus(cleanup.cleared
          ? 'Newer edits pending — earlier revision saved to GitHub'
          : 'GitHub saved — previous draft cleanup pending; newer edits retained');
        setMessage(cleanup.cleared
          ? 'The earlier version was saved to GitHub. Your newer text is still here; press Save again to update the same Note.'
          : 'The earlier version was saved to GitHub. Your newer text is intact; draft cleanup could not be confirmed.');
        return;
      }
      if (hybridDrafts && draftNoteId) {
        // Normal Save and recovered Save share the same GitHub-verified,
        // transactional, revision-CAS draft cleanup and metadata receipt.
        // A GitHub-confirmed note is NOT permission to discard an uncertain
        // or newer temporary draft.
        let cleaned;
        try {
          cleaned = await responseJson(await fetch('/api/vault/drafts', {
            method: 'DELETE', headers: { 'Content-Type': 'application/json' },
            cache: 'no-store', body: JSON.stringify({
              id: draftNoteId, revision: hybridRevisionRef.current, sha: note.sha,
            }),
          }));
        } catch {
          // DELETE might have committed its MongoDB transaction even if its
          // HTTP acknowledgment was lost. Retry only the confirmed-cleanup
          // coordinator, NOT the GitHub note Save.
          try {
            cleaned = await responseJson(await fetch('/api/vault/drafts', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              cache: 'no-store', body: JSON.stringify({
                id: draftNoteId, revision: hybridRevisionRef.current, sha: note.sha,
              }),
            }));
          } catch {
            setDraftStatus('GitHub saved — draft cleanup pending');
            setMessage('GitHub saved this version. Draft cleanup could not be confirmed. Your editor remains open so you can review it.');
            return;
          }
        }
        if (cleaned?.confirmed !== true || cleaned.cleared !== true) {
          setDraftStatus('GitHub saved — newer draft retained');
          setMessage('GitHub saved the submitted version, but a temporary draft remains. Review it before closing.');
          return;
        }
        // Do not clear a browser recovery copy that differs from the
        // submitted version, even if the server CAS cleanup succeeded.
        const draftKeyName = hybridKey(draftNoteId);
        const confirmedDraft = {
          subjectId: current?.subjectSlug || activeSubject, heading, answer,
          tags, favorite: Boolean(current?.favorite), baseSha: current?.sha || null,
        };
        let safeLocalCopy = true;
        let hasLocalCopy = false;
        try {
          const raw = window.sessionStorage.getItem(draftKeyName);
          if (raw) {
            hasLocalCopy = true;
            const local = JSON.parse(raw)?.draft;
            safeLocalCopy = Boolean(local) &&
              JSON.stringify(local) === JSON.stringify(confirmedDraft);
          }
        } catch { safeLocalCopy = false; }
        if (!safeLocalCopy ||
            JSON.stringify(liveEditorRef.current) !== submittedEditor) {
          setDraftStatus('GitHub saved — newer browser draft retained');
          setMessage('GitHub saved the submitted version. The browser draft differs; review it before closing.');
          return;
        }
        if (hasLocalCopy) window.sessionStorage.removeItem(draftKeyName);
        if (!editingId &&
            window.sessionStorage.getItem(newDraftPointerKey(activeSubject)) === draftNoteId)
          window.sessionStorage.removeItem(newDraftPointerKey(activeSubject));
      }
      // An edit that raced with confirmed cleanup must remain in the open
      // editor. Never close over new text just because an older Save worked.
      if (hybridDrafts && JSON.stringify(liveEditorRef.current) !== submittedEditor) {
        setDraftStatus('Newer edits pending — earlier revision saved to GitHub');
        setMessage('GitHub saved the submitted version. New edits remain in the editor.');
        return;
      }
      hybridGenerationRef.current += 1;
      setNewDraftId('');
      editorInitialRef.current = null;
      setEditorBaseline(null);
      setNoteDialog(false);
      setAnswerFullscreen(false);
      setPreview(false);
      setEditingId(note.id);
      setMessage(vaultMode ? 'Note saved to GitHub successfully.' : 'Note saved successfully.');
      await load(activeSubject);
    } catch (err) {
      if (attemptedGitHubSave && hybridDrafts && vaultMode) {
        // An HTTP error does NOT prove GitHub rejected the commit. Verify
        // immutable GitHub content, then independently CAS-clear ONLY that
        // saved draft revision. Neither operation issues a second Git commit.
        try {
          const checked = await responseJson(await fetch(
            '/api/vault/drafts?id=' + encodeURIComponent(attemptedGitHubSave.noteId) +
            '&confirm=true&revision=' + attemptedGitHubSave.revision,
            { cache: 'no-store' },
          ));
          if (checked.confirmed === true) {
            let reconciled = null;
            try {
              reconciled = await responseJson(await fetch('/api/vault/drafts', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                cache: 'no-store',
                body: JSON.stringify({
                  id: attemptedGitHubSave.noteId,
                  revision: attemptedGitHubSave.revision, sha: checked.sha,
                }),
              }));
            } catch { /* A second network failure must retain every draft. */ }
            if (reconciled?.confirmed && reconciled.cleared) {
              if (vaultMode && reconciled.note?.id) rememberSavedNote(reconciled.note.id);
              let safeLocalCopy = true;
              try {
                const key = hybridKey(attemptedGitHubSave.noteId);
                const raw = window.sessionStorage.getItem(key);
                if (raw) {
                  const browser = JSON.parse(raw)?.draft;
                  safeLocalCopy = JSON.stringify(browser) ===
                    JSON.stringify(attemptedGitHubSave.submittedDraft);
                  if (safeLocalCopy &&
                      JSON.stringify(liveEditorRef.current) === submittedEditor) {
                    window.sessionStorage.removeItem(key);
                    if (!editingId && window.sessionStorage.getItem(
                      newDraftPointerKey(activeSubject)) === attemptedGitHubSave.noteId)
                      window.sessionStorage.removeItem(newDraftPointerKey(activeSubject));
                  }
                }
              } catch { safeLocalCopy = false; }
              if (safeLocalCopy &&
                  JSON.stringify(liveEditorRef.current) === submittedEditor) {
                hybridGenerationRef.current += 1;
                setNewDraftId('');
                editorInitialRef.current = null;
                setEditorBaseline(null);
                setNoteDialog(false);
                setAnswerFullscreen(false);
                setPreview(false);
                setEditingId(reconciled.note.id);
                setMessage('Note saved to GitHub successfully — commit recovered.');
                await load(activeSubject);
                return;
              }
            }
            // A saved revision is not proof that a newer concurrent draft was
            // saved. Leave the editor and local recovery copy available.
            setDraftStatus('GitHub Save confirmed — newer or unchecked draft retained');
            setMessage('GitHub confirmed the submitted version. Another draft may remain; close and reopen to review it before saving again.');
            return;
          }
        } catch { /* GitHub/offline failures never become a Saved state. */ }
        setDraftStatus('Draft pending — GitHub confirmation needed');
      }
      setError(vaultMode ? vaultSaveFailureMessage(err) : (err.message || 'Could not save this Note.'));
      if (vaultMode) setDraftStatus('GitHub Save not confirmed — keep your draft');
    } finally {
      setSaving(false);
    }
  }


  async function cleanupWithGemini() {
    if (aiCleanupBusy || !editingId || vaultMode) return;
    if (!heading.trim() || !answer.trim()) {
      setError('Add a heading and note content before using Gemini.');
      return;
    }
    setAiCleanupBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await responseJson(await fetch('/api/notes/cleanup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({
          id: editingId,
          heading: heading.trim(),
          answer: answer.trim(),
          tags: tagsText.split(',').map((tag) => tag.trim()).filter(Boolean),
        }),
      }));
      setHeading(result.heading);
      setAnswer(result.answer);
      setTagsText((result.tags || []).join(', '));
      setPreview(false);
      setDraftStatus('Gemini suggestion — review before saving');
      setMessage('');
    } catch (err) {
      setError(err.message || 'Gemini could not clean up this note.');
    } finally {
      setAiCleanupBusy(false);
    }
  }

  async function toggleFavorite(note) {
    setError('');
    try {
      await responseJson(await fetch(notesApi, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: note.id, favorite: !note.favorite,
          ...(vaultMode ? { sha: note.sha } : {}) }),
      }));
      await load(activeSubject);
    } catch (err) {
      setError(err.message || 'Could not update favorite.');
    }
  }

  async function deleteNote(note) {
    if (!window.confirm(`Delete “${note.heading}” permanently? This cannot be undone.`)) return;
    setError('');
    try {
      await responseJson(await fetch(notesApi + '?id=' + encodeURIComponent(note.id) +
        (vaultMode ? '&sha=' + encodeURIComponent(note.sha || '') : ''), { method: 'DELETE' }));
      setReaderNote(null);
      setNoteDialog(false);
      setMessage('Note deleted.');
      await load(activeSubject);
    } catch (err) {
      setError(err.message || 'Could not delete this note.');
    }
  }

  useEffect(() => {
    if (!showSubjectForm) return undefined;
    const frame = window.requestAnimationFrame(() => subjectInputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [showSubjectForm]);

  async function createSubject(event) {
    event.preventDefault();
    if (subjectSaving) return;
    setSubjectSaving(true);
    setError('');
    try {
      const subject = await responseJson(await fetch('/api/subjects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: subjectName }),
      }));
      setSubjectName('');
      setShowSubjectForm(false);
      await load(subject.slug);
      if (createNoteAfterSubjectRef.current) {
        createNoteAfterSubjectRef.current = false;
        openNewNote(subject.slug);
      } else {
        setMessage('Subject created.');
      }
    } catch (err) {
      setError(err.message || 'Could not create the subject.');
    } finally {
      setSubjectSaving(false);
    }
  }

  async function shareReaderNote() {
    if (!readerNote) return;
    const subject = subjects.find((item) => item.slug === readerNote.subjectSlug) || active;
    const text = `${readerNote.heading || 'Untitled note'}\n\n${readerNote.answer || ''}\n\n${subject?.name || 'OgeNotes'} · OgeNotes`;
    try {
      if (navigator.share) {
        await navigator.share({ title: readerNote.heading || 'OgeNotes note', text });
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        setMessage('Note text copied. Paste it into WhatsApp or another app.');
      } else {
        window.prompt('Copy your note text:', text);
      }
    } catch (err) {
      if (err?.name !== 'AbortError') setError('Sharing failed. You can try Print / Save PDF instead.');
    }
    setShareMenuOpen(false);
  }

  function printReaderNote() {
    if (!readerNote) return;
    setShareMenuOpen(false);
    const printWindow = window.open('', '_blank', 'width=900,height=700');
    if (!printWindow) {
      setError('Allow pop-ups to print or save this note as a PDF.');
      return;
    }
    const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[char]);
    const subject = subjects.find((item) => item.slug === readerNote.subjectSlug) || active;
    printWindow.document.open();
    printWindow.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(readerNote.heading || 'OgeNotes note')}</title><style>
      @page{margin:16mm}body{font:11pt/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#17231b;max-width:850px;margin:32px auto;padding:0 20px;overflow-wrap:anywhere}
      header{border-bottom:1px solid #d8e0da;padding-bottom:18px;margin-bottom:24px}small{color:#66736a;text-transform:uppercase;letter-spacing:.08em}h1{font-size:26pt;line-height:1.2;margin:10px 0}p{margin:0 0 14px}pre{white-space:pre-wrap;background:#f3f5f3;padding:12px;border-radius:6px}code{font-family:ui-monospace,SFMono-Regular,monospace;background:#f0f3f0;padding:2px 4px}blockquote{border-left:3px solid #71947a;margin-left:0;padding-left:14px;color:#46564a}a{color:#2f6b42}
      @media print{body{margin:0;padding:0}.print-help{display:none}}
      </style></head><body><header><small>${escapeHtml(subject?.name || 'YOUR LIBRARY')} · OGENOTES</small><h1>${escapeHtml(readerNote.heading || 'Untitled note')}</h1></header><main>${markdownHtml(readerNote.answer || '')}</main><p class="print-help">Use your browser’s Print command to print or save this note as a PDF.</p><script>window.onload=()=>window.print()<\/script></body></html>`);
    printWindow.document.close();
  }

  function insertFormatting(format) {
    if (hybridDrafts && saving) return;
    const field = answerRef.current;
    if (!field) return;
    const start = field.selectionStart;
    const end = field.selectionEnd;
    const selected = answer.slice(start, end);
    let before = '';
    let value = selected || 'text';
    let after = '';
    if (format === 'bold') { before = '**'; after = '**'; }
    if (format === 'code') { before = '`'; after = '`'; }
    if (format === 'codeblock') { before = '```bash\n'; after = '\n```'; value = selected || 'command'; }
    if (format === 'list') {
      const lineStart = answer.lastIndexOf('\n', start - 1) + 1;
      const lineEnd = answer.indexOf('\n', end);
      const actualEnd = lineEnd < 0 ? answer.length : lineEnd;
      const list = answer.slice(lineStart, actualEnd).split('\n').map((line) => `- ${line}`).join('\n');
      setAnswer(`${answer.slice(0, lineStart)}${list}${answer.slice(actualEnd)}`);
      return;
    }
    setAnswer(`${answer.slice(0, start)}${before}${value}${after}${answer.slice(end)}`);
  }

  useEffect(() => {
    if (!noteDialog) return undefined;
    const saveShortcut = (event) => {
      if (!(event.metaKey || event.ctrlKey) || event.key !== 'Enter' ||
          event.repeat || saving || (hybridDrafts && !hybridReady)) return;
      event.preventDefault();
      document.getElementById('noteForm')?.requestSubmit();
    };
    window.addEventListener('keydown', saveShortcut);
    return () => window.removeEventListener('keydown', saveShortcut);
  }, [noteDialog, saving, hybridDrafts, hybridReady]);

  useEffect(() => {
    if (!vaultMode || !noteDialog || !hasUnsavedEditorChanges()) return undefined;
    const guard = (event) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [vaultMode, noteDialog, hasUnsavedEditorChanges]);

  useEffect(() => {
    if (!noteDialog && !readerNote) return undefined;
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      if (answerFullscreen) { setAnswerFullscreen(false); return; }
      if (noteDialog && !saving && (!hybridDrafts || hybridReady)) {
        closeNoteEditor();
        return;
      }
      setReaderNote(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [noteDialog, readerNote, answerFullscreen, saving, hybridDrafts, hybridReady, hasUnsavedEditorChanges]);

  return (
    <main className="shell">
      {vaultMode && <div role="status" className="oge-vault-editor-notice">✳ GITHUB VAULT PREVIEW · {hybridDrafts
        ? 'Temporary encrypted drafts autosave to MongoDB. Press Save to commit to your private GitHub repository.'
        : 'Notes are written to your private GitHub repository. You must manually save changes.'}</div>}
      <SiteNavbar notesHref={vaultMode ? '/vault/notes' : '/notes'} actions={<ThemeToggle />} />

      <nav className="subject-nav" aria-label="Subjects">
        {subjects.map((subject) => (
          <span className="subject-item" key={subject.slug}>
            <button
              type="button"
              className={subject.slug === activeSubject ? 'subject-tab active' : 'subject-tab'}
              onClick={() => { setActiveSubject(subject.slug); setGlobalSearch(false); setQuery(''); setSelectedTag(''); setError(''); }}
            >
              {subject.name}
            </button>
          </span>
        ))}
        <button type="button" className="subject-add" onClick={() => {
          if (showSubjectForm) createNoteAfterSubjectRef.current = false;
          setShowSubjectForm((value) => !value);
        }} aria-expanded={showSubjectForm}>＋ Add subject</button>
      </nav>

      {showSubjectForm && (
        <form className="subject-create-form" onSubmit={createSubject}>
          <input ref={subjectInputRef} value={subjectName} onChange={(event) => setSubjectName(event.target.value)} placeholder="New subject name" maxLength={60} required aria-label="New subject name" />
          <button className="add-button" type="submit" disabled={subjectSaving}>{subjectSaving ? 'Adding…' : 'Add subject'}</button>
          <button className="text-button" type="button" onClick={() => {
            setShowSubjectForm(false);
            createNoteAfterSubjectRef.current = false;
          }}>Cancel</button>
        </form>
      )}

      <section className="intro">
        <div>
          <p className="eyebrow">YOUR PERSONAL KNOWLEDGE BASE</p>
          <h1>{globalSearch ? 'Your library' : (active?.name || 'Your')} notes<span className="period">.</span></h1>
          <p className="subtitle">A clear place for the commands, concepts, and things you learn.</p>
        </div>
        <div className="intro-actions">
          <button className="add-button" type="button" onClick={() => openNewNote()}><span>＋</span> Add a note</button>
          {vaultMode && hybridDrafts && <Link className="add-button" href="/vault/capture">Quick Capture →</Link>}
        </div>
      </section>

      <section className="stats" aria-label="Note statistics">
        <div className="stat"><span className="stat-number">{String(vaultMode ? (totalVaultNotes ?? notes.length) : notes.length).padStart(2, '0')}</span><span className="stat-label">{vaultMode ? 'GITHUB NOTES' : 'TOTAL NOTES'}</span></div>
        <div className="stat-divider" />
        <div className="stat"><span className="stat-number">{String(subjects.length).padStart(2, '0')}</span><span className="stat-label">SUBJECTS</span></div>
        <div className="stat-spacer" />
        <div className="search-wrap"><span aria-hidden="true">⌕</span><input type="search" placeholder={globalSearch ? 'Search all subjects…' : 'Search this subject…'} aria-label="Search notes" value={query} onChange={(event) => setQuery(event.target.value)} />{query && <button type="button" className="search-clear" onClick={() => setQuery('')} aria-label="Clear search">×</button>}</div>
        <button type="button" className={globalSearch ? 'global-search-toggle active' : 'global-search-toggle'} aria-pressed={globalSearch} onClick={() => { setGlobalSearch((value) => !value); setQuery(''); setSelectedTag(''); }}>⌕ {globalSearch ? 'All subjects' : 'Search all subjects'}</button>
      </section>

      <section className="notes-section">
        <div className="section-heading">
          <div><p className="eyebrow">THE LIBRARY</p><h2>{globalSearch ? 'Search results' : 'All notes'} <span className="count-pill">{visibleNotes.length}</span></h2></div>
          <label className="sort-control">Sort <select value={sortOrder} onChange={(event) => setSortOrder(event.target.value)} aria-label="Sort notes"><option value="latest">Latest updated</option><option value="oldest">Oldest first</option><option value="title-asc">Title A–Z</option><option value="title-desc">Title Z–A</option></select></label>
        </div>
        <div className="note-filters" aria-label="Note filters">
          <button type="button" className={favoritesOnly ? 'filter-chip active' : 'filter-chip'} aria-pressed={favoritesOnly} onClick={() => setFavoritesOnly((value) => !value)}>★ Favorites</button>
          {availableTags.length > 0 && <label className="tag-filter">Tag <select value={selectedTag} onChange={(event) => setSelectedTag(event.target.value)} aria-label="Filter notes by tag"><option value="">All tags</option>{availableTags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}</select></label>}
          {(query || globalSearch || favoritesOnly || selectedTag) && <button type="button" className="clear-filters" onClick={() => { setQuery(''); setGlobalSearch(false); setFavoritesOnly(false); setSelectedTag(''); }}>Clear all</button>}
        </div>

        {vaultMode && query.trim() && nextNotesCursor && <div className="oge-vault-notes-pagination" role="group" aria-label="Search all GitHub Notes">
          <p role="status">Searching {notes.length} of {totalVaultNotes ?? notes.length} loaded Notes. Older notes may be on other GitHub pages.</p>
          <button type="button" className="add-button" onClick={() => void scanRemainingVaultNotes()}
            disabled={searchScanBusy || loadingMoreNotes || loading || saving || noteDialog}>
            {searchScanBusy ? 'Searching…' : 'Search remaining GitHub Notes'}
          </button>
          {searchScanBusy && <button type="button" className="text-button"
            onClick={() => searchScanRef.current?.abort()}>Stop search</button>}
        </div>}
        {vaultMode && searchScanStatus && <p role="status">{searchScanStatus}</p>}
        {error && !noteDialog && <p className="page-error" role="alert">{error}</p>}
        {message && !noteDialog && <p className="form-success" role="status">{message}</p>}
        {loading ? <div className="empty-state" role="status"><span className="empty-icon">◌</span><h3>Loading notes…</h3><p>Getting your library ready.</p></div>
          : visibleNotes.length ? <div className="notes-grid">{visibleNotes.map((note, index) => (
            <article className="note-card" key={note.id}>
              <button type="button" className="card-open" onClick={() => setReaderNote(note)} aria-label={`Open note: ${note.heading}`}>
                <span className="card-top"><span className="note-index">NO. {String(index + 1).padStart(2, '0')}</span><span className="note-badges">{note.favorite && <span title="Favorite">★</span>}</span></span>
                <span className="note-title">{note.heading}</span>
                <span className="note-preview">{note.answer}</span>
                <span className="card-tags">{(note.tags || []).map((tag) => <span key={tag} className="tag-chip">{tag}</span>)}</span>
                <span className="card-bottom">◷ <span>{savedLabel(note.updatedAt || note.createdAt)}</span></span>
              </button>
              <div className="note-card-actions" aria-label={`Actions for ${note.heading}`}>
                <button type="button" className={note.favorite ? 'metadata-action selected' : 'metadata-action'} onClick={() => toggleFavorite(note)} aria-pressed={Boolean(note.favorite)} aria-label={note.favorite ? 'Remove favorite' : 'Add favorite'} title={note.favorite ? 'Remove favorite' : 'Add favorite'}>★</button>
                <button type="button" className="edit-note" onClick={() => editNote(note)} aria-label={`Edit note: ${note.heading}`} title="Edit note">✎</button>
                <button type="button" className="delete-note" onClick={() => deleteNote(note)} aria-label={`Delete note: ${note.heading}`} title="Delete note">×</button>
              </div>
            </article>
          ))}</div> : <div className="empty-state"><span className="empty-icon">⌕</span><h3>{query ? (vaultMode && nextNotesCursor ? 'No matches in loaded notes yet' : 'No notes found')
              : vaultMode && nextNotesCursor && !globalSearch && !favoritesOnly && !selectedTag
                ? 'No Notes from this subject loaded yet' : 'Start your collection'}</h3>
              <p>{query ? (vaultMode && nextNotesCursor
                ? 'Use Search remaining GitHub Notes above to check older pages.'
                : 'Try another search, or clear the filters.')
                : vaultMode && nextNotesCursor && !globalSearch && !favoritesOnly && !selectedTag
                  ? 'Your GitHub library has more pages. Notes for this subject may be farther down.'
                  : !activeSubject
                    ? 'Create a subject first; it helps organize your notes. Add a note will guide you through setup.'
                    : 'Add a note to this subject, then come back to study it.'}</p>
              {vaultMode && nextNotesCursor && !query.trim() && !globalSearch &&
                !favoritesOnly && !selectedTag && activeSubject && <button
                  className="add-button" type="button"
                  onClick={() => void scanRemainingVaultNotes({ subjectOnly: true })}
                  disabled={searchScanBusy || loadingMoreNotes || saving || noteDialog}>
                  {searchScanBusy ? 'Finding…' : 'Find older Notes in this subject'}
                </button>}
              <button className="add-button" type="button" onClick={() => openNewNote()}>
                <span>＋</span> {activeSubject ? 'Add a note' : 'Create a subject to add notes'}
              </button></div>}
        {vaultMode && <div className="oge-vault-notes-pagination">
          <p role="status">Showing {notes.length} of {totalVaultNotes ?? notes.length} GitHub notes. Search, filters and sorting apply to loaded notes. Use Search remaining GitHub Notes to include older pages.</p>
          {nextNotesCursor && <button type="button" className="add-button" onClick={() => void loadMoreVaultNotes()}
            disabled={loadingMoreNotes || searchScanBusy || saving || noteDialog}>
            {loadingMoreNotes ? 'Loading…' : 'Load more GitHub notes'}
          </button>}
        </div>}
      </section>

      <footer><span>Built for learning, one note at a time.</span><span>PRIVATE · SUBJECT BASED</span></footer>

      {noteDialog && <div className="modal-backdrop editor-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeNoteEditor(); }}>
        <section className="dialog editor-dialog" role="dialog" aria-modal="true" aria-labelledby="formTitle">
          <button className="close-button" type="button" onClick={closeNoteEditor} aria-label="Close form">×</button>
          <p className="eyebrow">{editingId ? 'EDIT NOTE' : 'GROW YOUR LIBRARY'}</p>
          <h2 id="formTitle">{editingId ? 'Edit note' : 'Add a note'}<span className="period">.</span></h2>
          <p className="form-subtitle">{editingId ? 'Update the heading, tags, or answer.' : 'Give it a clear heading and capture what you learned.'}</p>
          <form id="noteForm" onSubmit={saveNote}>
            <label htmlFor="heading">HEADING</label>
            <input ref={headingRef} id="heading" maxLength={160} placeholder="e.g. What does chmod do?" value={heading} onChange={(event) => { setHeading(event.target.value); setDraftStatus('Unsaved changes'); }} disabled={hybridDrafts && (!hybridReady || saving)} required />
            <label htmlFor="noteTags">TAGS <span className="field-hint">comma-separated · up to 10</span></label>
            <input id="noteTags" maxLength={260} placeholder="e.g. arrays, exam, important" value={tagsText} onChange={(event) => { setTagsText(event.target.value); setDraftStatus('Unsaved changes'); }} disabled={hybridDrafts && (!hybridReady || saving)} />
            {answerFullscreen ? createPortal(
              <div className="answer-workspace is-fullscreen">
                <div className="label-row"><label htmlFor="answer">ANSWER</label><span>Markdown · use headings, lists, quotes, links, and code blocks</span>{editingId && !vaultMode && <button type="button" className="answer-expand-button oge-gemini-cleanup-button" onClick={cleanupWithGemini} disabled={aiCleanupBusy || saving} title="Ask Gemini to improve clarity and Markdown; review before saving">{aiCleanupBusy ? '✦ Cleaning…' : '✦ Gemini clean up'}</button>}<button type="button" className="answer-expand-button" onClick={() => setAnswerFullscreen(false)} aria-label="Exit full-screen writing area" title="Exit full screen (Esc)">↙ Exit full screen</button></div>
                <div className="editor-toolbar" aria-label="Answer formatting"><button type="button" onClick={() => insertFormatting('bold')} title="Bold">B</button><button type="button" onClick={() => insertFormatting('code')} title="Inline code">&lt;/&gt;</button><button type="button" onClick={() => insertFormatting('list')} title="Bullet list">• List</button><button type="button" onClick={() => insertFormatting('codeblock')} title="Code block">{'{ }'}</button><span>Formatting shortcuts</span><span className="draft-status" role="status" aria-live="polite">{draftStatus}</span></div>
                <div className="editor-tabs"><button type="button" className={!preview ? 'active' : ''} onClick={() => setPreview(false)}>Write</button><button type="button" className={preview ? 'active' : ''} onClick={() => setPreview(true)}>Preview</button></div>
                {!preview ? <textarea ref={answerRef} form="noteForm" id="answer" rows={6} maxLength={20000} placeholder="Write your explanation here…" value={answer} onChange={(event) => { setAnswer(event.target.value); setDraftStatus('Unsaved changes'); }} disabled={hybridDrafts && (!hybridReady || saving)} required /> : <div className="answer-preview">{answer ? <div dangerouslySetInnerHTML={{ __html: markdownHtml(answer) }} /> : <p className="preview-placeholder">Nothing to preview yet.</p>}</div>}
              </div>,
              document.body
            ) : <div className="answer-workspace">
              <div className="label-row"><label htmlFor="answer">ANSWER</label><span>Markdown · use headings, lists, quotes, links, and code blocks</span>{editingId && !vaultMode && <button type="button" className="answer-expand-button oge-gemini-cleanup-button" onClick={cleanupWithGemini} disabled={aiCleanupBusy || saving} title="Ask Gemini to improve clarity and Markdown; review before saving">{aiCleanupBusy ? '✦ Cleaning…' : '✦ Gemini clean up'}</button>}<button type="button" className="answer-expand-button" onClick={() => setAnswerFullscreen(true)} aria-label="Expand writing area to full screen" title="Expand writing area">⛶ Expand</button></div>
              <div className="editor-toolbar" aria-label="Answer formatting"><button type="button" onClick={() => insertFormatting('bold')} title="Bold">B</button><button type="button" onClick={() => insertFormatting('code')} title="Inline code">&lt;/&gt;</button><button type="button" onClick={() => insertFormatting('list')} title="Bullet list">• List</button><button type="button" onClick={() => insertFormatting('codeblock')} title="Code block">{'{ }'}</button><span>Formatting shortcuts</span><span className="draft-status" role="status" aria-live="polite">{draftStatus}</span></div>
              <div className="editor-tabs"><button type="button" className={!preview ? 'active' : ''} onClick={() => setPreview(false)}>Write</button><button type="button" className={preview ? 'active' : ''} onClick={() => setPreview(true)}>Preview</button></div>
              {!preview ? <textarea ref={answerRef} id="answer" rows={8} maxLength={20000} placeholder="Write your explanation here…" value={answer} onChange={(event) => { setAnswer(event.target.value); setDraftStatus('Unsaved changes'); }} disabled={hybridDrafts && (!hybridReady || saving)} required /> : <div className="answer-preview">{answer ? <div dangerouslySetInnerHTML={{ __html: markdownHtml(answer) }} /> : <p className="preview-placeholder">Nothing to preview yet.</p>}</div>}
            </div>}
            <p className={'oge-editor-feedback oge-editor-feedback--' + editorFeedback.kind}
              role="status" aria-live="polite">{editorFeedback.label}</p>
            {vaultMode && hybridDrafts && draftStatus && <p className="oge-editor-draft-detail">
              {draftStatus === 'Draft saved' ? 'Temporary draft only — not yet committed.' : draftStatus}
            </p>}
            {hybridError && <p role="alert" className="form-error">{hybridError}</p>}
            {hybridDrafts && hybridReady && hybridError && !hybridError.startsWith('Draft conflict:') &&
              <button type="button" className="answer-expand-button" onClick={() => {
                setHybridError('');
                setHybridRetryToken((token) => token + 1);
              }}>Retry draft autosave</button>}
            {error && <p className="form-error" role="alert">{error}{vaultMode && <> <Link href="/vault">Check your Vault connection</Link>.</>}</p>}
            <div className="oge-editor-save-footer">
              <div className="oge-editor-save-meta">
                <span>{editorMetrics.words} {editorMetrics.words === 1 ? 'word' : 'words'} · {editorMetrics.characters.toLocaleString('en-IN')} / 20,000 characters</span>
                <span>{vaultMode ? 'Saved to private GitHub only when you press Save' : 'Press Save to keep your changes'}</span>
              </div>
              <button className="submit-button" type="submit"
                disabled={saving || !activeSubject || (hybridDrafts && !hybridReady)}>
                <span>{saving ? 'Saving…' : vaultMode ? 'Save to GitHub' : editingId ? 'Save changes' : 'Save note'}</span><span aria-hidden="true">→</span>
              </button>
              <p className="field-hint">Tip: press Ctrl+Enter (Windows) or ⌘+Enter (Mac) to Save.</p>
            </div>
          </form>
        </section>
      </div>}

      {readerNote && <div className="reader-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) { setReaderNote(null); setShareMenuOpen(false); } }}>
        <article className="reader-panel" role="dialog" aria-modal="true" aria-labelledby="readerTitle">
          <div className="reader-toolbar">
            <span className="reader-kicker">NOTE · {(subjects.find((item) => item.slug === readerNote.subjectSlug) || active)?.name || 'LIBRARY'}</span>
            <div className="reader-toolbar-actions">
              <button type="button" className="note-share-button"
                onClick={() => editNote(readerNote)} aria-label={'Edit note: ' + readerNote.heading}>
                ✎ Edit note
              </button>
              <div className="note-share-wrap">
                <button type="button" className="note-share-button" aria-expanded={shareMenuOpen} onClick={() => setShareMenuOpen((open) => !open)}>↗ Share</button>
                {shareMenuOpen && <div className="note-share-menu" role="menu">
                  <button type="button" role="menuitem" onClick={shareReaderNote}><strong>Share note</strong><small>Send text to available apps</small></button>
                  <button type="button" role="menuitem" onClick={printReaderNote}><strong>Print / Save PDF</strong><small>Keep the note formatting</small></button>
                </div>}
              </div>
              <button type="button" className="close-button reader-close" onClick={() => { setShareMenuOpen(false); setReaderNote(null); }} aria-label="Close note">×</button>
            </div>
          </div>
          <div className="reader-content">
            <p className="eyebrow">{(subjects.find((item) => item.slug === readerNote.subjectSlug) || active)?.name || 'YOUR LIBRARY'}</p>
            <h2 id="readerTitle">{readerNote.heading}</h2>
            <div className="reader-meta">Saved {savedLabel(readerNote.updatedAt || readerNote.createdAt)}</div>
            <div className="reader-answer" dangerouslySetInnerHTML={{ __html: markdownHtml(readerNote.answer) }} />
            {(readerNote.tags || []).length > 0 && <div className="reader-tags">{readerNote.tags.map((tag) => <span key={tag} className="tag-chip">{tag}</span>)}</div>}
          </div>
        </article>
      </div>}
    </main>
  );
}
