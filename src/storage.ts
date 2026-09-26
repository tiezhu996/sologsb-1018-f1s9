import type { LibraryItemMeta, PersistedPractice, PracticeLibraryMeta, PracticeProject } from './types'

const DB_NAME = 'sologsb-1018-prosody'
const STORE = 'practice'
const LIBRARY_KEY = 'library'
const PRACTICE_PREFIX = 'practice:'
const LEGACY_KEY = 'current'
const LEGACY_FALLBACK_KEY = 'sologsb-1018-fallback'
const FALLBACK_LIBRARY_KEY = 'sologsb-1018-library'

interface FallbackLibrary {
  meta: PracticeLibraryMeta
  projects: Record<string, PracticeProject>
}

export function newPracticeId(): string {
  return `practice-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

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

async function idbPut(key: string, value: unknown): Promise<void> {
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite')
      transaction.objectStore(STORE).put(value, key)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
  } finally {
    db.close()
  }
}

async function idbDelete(key: string): Promise<void> {
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite')
      transaction.objectStore(STORE).delete(key)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
  } finally {
    db.close()
  }
}

async function idbClear(): Promise<void> {
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite')
      transaction.objectStore(STORE).clear()
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
  } finally {
    db.close()
  }
}

function stripAudio(project: PracticeProject): PracticeProject {
  return { ...project, attempts: project.attempts.map((attempt) => ({ ...attempt, audioBlob: undefined })) }
}

function metaItemFor(id: string, project: PracticeProject, createdAt?: string): LibraryItemMeta {
  return {
    id,
    title: project.title || '未命名练习',
    createdAt: createdAt ?? project.updatedAt,
    updatedAt: project.updatedAt,
    attemptCount: project.attempts.length,
    targetAttempts: project.targetAttempts
  }
}

function readFallback(): FallbackLibrary | null {
  try {
    const raw = localStorage.getItem(FALLBACK_LIBRARY_KEY)
    return raw ? (JSON.parse(raw) as FallbackLibrary) : null
  } catch {
    return null
  }
}

function writeFallback(fallback: FallbackLibrary): void {
  localStorage.setItem(FALLBACK_LIBRARY_KEY, JSON.stringify(fallback))
}

function readLegacyFallback(): PracticeProject | null {
  try {
    const raw = localStorage.getItem(LEGACY_FALLBACK_KEY)
    return raw ? (JSON.parse(raw) as PracticeProject) : null
  } catch {
    return null
  }
}

export async function loadLibrary(): Promise<{ meta: PracticeLibraryMeta; project: PracticeProject | null } | null> {
  try {
    let meta = (await idbGet<PracticeLibraryMeta>(LIBRARY_KEY)) ?? null
    // 旧版本只存一份练习：IndexedDB 的 current 键和 localStorage 备份都要并入库里，一条不丢。
    const legacyProjects: PracticeProject[] = []
    const legacy = await idbGet<PersistedPractice>(LEGACY_KEY)
    if (legacy?.project) legacyProjects.push(legacy.project)
    const legacyFallback = readLegacyFallback()
    if (legacyFallback) legacyProjects.push(legacyFallback)
    for (const legacyProject of legacyProjects) {
      const id = newPracticeId()
      await idbPut(PRACTICE_PREFIX + id, { project: legacyProject, version: 1 } satisfies PersistedPractice)
      const item = metaItemFor(id, legacyProject)
      meta = meta ? { ...meta, items: [...meta.items, item] } : { version: 2, activeId: id, items: [item] }
    }
    if (legacyProjects.length) {
      await idbDelete(LEGACY_KEY)
      localStorage.removeItem(LEGACY_FALLBACK_KEY)
      if (meta) await idbPut(LIBRARY_KEY, meta)
    }
    if (!meta || !meta.items.length) return null
    let activeId = meta.items.some((item) => item.id === meta.activeId) ? meta.activeId : meta.items[0].id
    let project = (await idbGet<PersistedPractice>(PRACTICE_PREFIX + activeId))?.project ?? null
    if (!project) {
      for (const item of meta.items) {
        const candidate = (await idbGet<PersistedPractice>(PRACTICE_PREFIX + item.id))?.project
        if (candidate) {
          activeId = item.id
          project = candidate
          break
        }
      }
    }
    const nextMeta: PracticeLibraryMeta = { ...meta, activeId }
    if (activeId !== meta.activeId) await idbPut(LIBRARY_KEY, nextMeta)
    return { meta: nextMeta, project }
  } catch {
    try {
      let fallback = readFallback()
      const legacyProject = readLegacyFallback()
      if (legacyProject) {
        const id = newPracticeId()
        const item = metaItemFor(id, legacyProject)
        fallback = fallback
          ? { meta: { ...fallback.meta, items: [...fallback.meta.items, item] }, projects: { ...fallback.projects, [id]: legacyProject } }
          : { meta: { version: 2, activeId: id, items: [item] }, projects: { [id]: legacyProject } }
        localStorage.removeItem(LEGACY_FALLBACK_KEY)
        writeFallback(fallback)
      }
      if (!fallback || !fallback.meta.items.length) return null
      const activeId = fallback.meta.items.some((item) => item.id === fallback.meta.activeId) ? fallback.meta.activeId : fallback.meta.items[0].id
      return { meta: { ...fallback.meta, activeId }, project: fallback.projects[activeId] ?? null }
    } catch {
      return null
    }
  }
}

export async function loadPracticeById(id: string): Promise<PracticeProject | null> {
  try {
    const record = await idbGet<PersistedPractice>(PRACTICE_PREFIX + id)
    return record?.project ?? null
  } catch {
    return readFallback()?.projects[id] ?? null
  }
}

export async function savePractice(id: string, project: PracticeProject): Promise<{ target: 'indexeddb' | 'localstorage'; item: LibraryItemMeta }> {
  try {
    const meta: PracticeLibraryMeta = (await idbGet<PracticeLibraryMeta>(LIBRARY_KEY)) ?? { version: 2, activeId: id, items: [] }
    const existing = meta.items.find((item) => item.id === id)
    const item = metaItemFor(id, project, existing?.createdAt)
    const nextMeta: PracticeLibraryMeta = {
      ...meta,
      activeId: id,
      items: existing ? meta.items.map((entry) => (entry.id === id ? item : entry)) : [...meta.items, item]
    }
    await idbPut(PRACTICE_PREFIX + id, { project, version: 1 } satisfies PersistedPractice)
    await idbPut(LIBRARY_KEY, nextMeta)
    return { target: 'indexeddb', item }
  } catch {
    const fallback = readFallback() ?? { meta: { version: 2 as const, activeId: id, items: [] }, projects: {} }
    const existing = fallback.meta.items.find((item) => item.id === id)
    const item = metaItemFor(id, project, existing?.createdAt)
    writeFallback({
      meta: {
        ...fallback.meta,
        activeId: id,
        items: existing ? fallback.meta.items.map((entry) => (entry.id === id ? item : entry)) : [...fallback.meta.items, item]
      },
      projects: { ...fallback.projects, [id]: stripAudio(project) }
    })
    return { target: 'localstorage', item }
  }
}

export async function createPractice(project: PracticeProject): Promise<LibraryItemMeta> {
  const result = await savePractice(newPracticeId(), project)
  return result.item
}

export async function deletePractice(id: string): Promise<void> {
  try {
    await idbDelete(PRACTICE_PREFIX + id)
    const meta = await idbGet<PracticeLibraryMeta>(LIBRARY_KEY)
    if (meta) {
      const items = meta.items.filter((item) => item.id !== id)
      await idbPut(LIBRARY_KEY, { ...meta, items, activeId: meta.activeId === id ? items[0]?.id ?? '' : meta.activeId })
    }
  } catch {
    const fallback = readFallback()
    if (fallback) {
      const items = fallback.meta.items.filter((item) => item.id !== id)
      const projects = { ...fallback.projects }
      delete projects[id]
      writeFallback({ meta: { ...fallback.meta, items, activeId: fallback.meta.activeId === id ? items[0]?.id ?? '' : fallback.meta.activeId }, projects })
    }
  }
}

export async function setActivePractice(id: string): Promise<void> {
  try {
    const meta = await idbGet<PracticeLibraryMeta>(LIBRARY_KEY)
    if (meta) await idbPut(LIBRARY_KEY, { ...meta, activeId: id })
  } catch {
    const fallback = readFallback()
    if (fallback) writeFallback({ ...fallback, meta: { ...fallback.meta, activeId: id } })
  }
}

export async function clearAllPractices(): Promise<void> {
  try {
    await idbClear()
  } catch {
    // IndexedDB 不可用时只清理本地备份即可。
  }
  localStorage.removeItem(FALLBACK_LIBRARY_KEY)
  localStorage.removeItem(LEGACY_FALLBACK_KEY)
}
