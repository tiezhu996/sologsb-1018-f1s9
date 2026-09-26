import type { LibraryMeta, PersistedPractice, PracticeProject, PracticeSummary } from './types'

const DB_NAME = 'sologsb-1018-prosody'
const STORE = 'practice'
const META_KEY = 'library'
const PROJECT_PREFIX = 'project:'
const SUMMARY_PREFIX = 'summary:'
const LEGACY_KEY = 'current'
const LEGACY_FALLBACK_KEY = 'sologsb-1018-fallback'
const LIBRARY_FALLBACK_KEY = 'sologsb-1018-library'

export interface LibrarySnapshot {
  meta: LibraryMeta
  summaries: PracticeSummary[]
  migrated: number
}

interface FallbackDoc {
  meta: LibraryMeta
  summaries: Record<string, PracticeSummary>
  projects: Record<string, PracticeProject>
}

const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
const emptyMeta = (): LibraryMeta => ({ activeId: null, order: [] })

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb()
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readonly')
      const request = transaction.objectStore(STORE).get(key)
      request.onsuccess = () => resolve(request.result as T | undefined)
      request.onerror = () => reject(request.error)
    })
  } finally {
    db.close()
  }
}

async function idbWrite(operations: (store: IDBObjectStore) => void): Promise<void> {
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite')
      operations(transaction.objectStore(STORE))
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
  } finally {
    db.close()
  }
}

function stripBlobs(project: PracticeProject): PracticeProject {
  return { ...project, attempts: project.attempts.map((attempt) => ({ ...attempt, audioBlob: undefined })) }
}

function readFallback(): FallbackDoc {
  try {
    const raw = localStorage.getItem(LIBRARY_FALLBACK_KEY)
    if (raw) {
      const doc = JSON.parse(raw) as FallbackDoc
      if (doc?.meta && doc.summaries && doc.projects) return doc
    }
  } catch {
    // Corrupted fallback data: start from an empty library below.
  }
  return { meta: emptyMeta(), summaries: {}, projects: {} }
}

function writeFallback(doc: FallbackDoc): void {
  localStorage.setItem(LIBRARY_FALLBACK_KEY, JSON.stringify(doc))
}

export function summarizeProject(id: string, project: PracticeProject): PracticeSummary {
  const target = Math.max(project.targetAttempts, 1)
  const latest = project.attempts.at(-1)
  const lastAccuracy = latest?.scores.length
    ? Math.round(latest.scores.reduce((sum, score) => sum + score.accuracy, 0) / latest.scores.length)
    : 0
  return {
    id,
    title: project.title || '未命名练习',
    teacher: project.teacher,
    updatedAt: project.updatedAt,
    attempts: project.attempts.length,
    targetAttempts: project.targetAttempts,
    progress: Math.min(100, Math.round((Math.min(project.attempts.length, target) / target) * 100)),
    lastAccuracy
  }
}

async function importLegacyProject(project: PracticeProject): Promise<void> {
  await saveProject(uid('practice'), project)
}

async function migrateLegacy(): Promise<number> {
  let migrated = 0
  try {
    const legacy = await idbGet<PersistedPractice>(LEGACY_KEY)
    if (legacy?.project) {
      await importLegacyProject(legacy.project)
      await idbWrite((store) => store.delete(LEGACY_KEY))
      migrated += 1
    }
  } catch {
    // IndexedDB unavailable here; the localStorage legacy copy is handled below.
  }
  try {
    const raw = localStorage.getItem(LEGACY_FALLBACK_KEY)
    if (raw) {
      const project = JSON.parse(raw) as PracticeProject
      if (project && Array.isArray(project.groups) && Array.isArray(project.attempts)) {
        await importLegacyProject(project)
        migrated += 1
      }
    }
    localStorage.removeItem(LEGACY_FALLBACK_KEY)
  } catch {
    localStorage.removeItem(LEGACY_FALLBACK_KEY)
  }
  return migrated
}

export async function loadLibrary(): Promise<LibrarySnapshot> {
  const migrated = await migrateLegacy()
  try {
    const meta = (await idbGet<LibraryMeta>(META_KEY)) ?? emptyMeta()
    const summaries: PracticeSummary[] = []
    for (const id of meta.order) {
      const summary = await idbGet<PracticeSummary>(SUMMARY_PREFIX + id)
      if (summary) summaries.push(summary)
    }
    return { meta, summaries, migrated }
  } catch {
    const doc = readFallback()
    const summaries = doc.meta.order.map((id) => doc.summaries[id]).filter((item): item is PracticeSummary => Boolean(item))
    return { meta: doc.meta, summaries, migrated }
  }
}

export async function loadProject(id: string): Promise<PracticeProject | null> {
  try {
    const value = await idbGet<PersistedPractice>(PROJECT_PREFIX + id)
    return value?.project ?? null
  } catch {
    return readFallback().projects[id] ?? null
  }
}

export async function saveProject(id: string, project: PracticeProject): Promise<'indexeddb' | 'localstorage'> {
  const summary = summarizeProject(id, project)
  try {
    const meta = (await idbGet<LibraryMeta>(META_KEY)) ?? emptyMeta()
    if (!meta.order.includes(id)) meta.order.push(id)
    if (!meta.activeId) meta.activeId = id
    const value: PersistedPractice = { project, version: 1 }
    await idbWrite((store) => {
      store.put(value, PROJECT_PREFIX + id)
      store.put(summary, SUMMARY_PREFIX + id)
      store.put(meta, META_KEY)
    })
    return 'indexeddb'
  } catch {
    const doc = readFallback()
    if (!doc.meta.order.includes(id)) doc.meta.order.push(id)
    if (!doc.meta.activeId) doc.meta.activeId = id
    doc.summaries[id] = summary
    doc.projects[id] = stripBlobs(project)
    writeFallback(doc)
    return 'localstorage'
  }
}

export async function deleteProject(id: string): Promise<LibraryMeta> {
  try {
    const meta = (await idbGet<LibraryMeta>(META_KEY)) ?? emptyMeta()
    meta.order = meta.order.filter((item) => item !== id)
    if (meta.activeId === id) meta.activeId = meta.order[0] ?? null
    await idbWrite((store) => {
      store.delete(PROJECT_PREFIX + id)
      store.delete(SUMMARY_PREFIX + id)
      store.put(meta, META_KEY)
    })
    return meta
  } catch {
    const doc = readFallback()
    doc.meta.order = doc.meta.order.filter((item) => item !== id)
    if (doc.meta.activeId === id) doc.meta.activeId = doc.meta.order[0] ?? null
    delete doc.summaries[id]
    delete doc.projects[id]
    writeFallback(doc)
    return doc.meta
  }
}

export async function setActiveProject(id: string): Promise<void> {
  try {
    const meta = (await idbGet<LibraryMeta>(META_KEY)) ?? emptyMeta()
    meta.activeId = id
    await idbWrite((store) => store.put(meta, META_KEY))
  } catch {
    const doc = readFallback()
    doc.meta.activeId = id
    writeFallback(doc)
  }
}

export async function clearLibrary(): Promise<void> {
  try {
    await idbWrite((store) => store.clear())
  } catch {
    // Ignore cleanup errors and clear the fallback below.
  }
  localStorage.removeItem(LIBRARY_FALLBACK_KEY)
  localStorage.removeItem(LEGACY_FALLBACK_KEY)
}
