import { createContext, useContext, type ReactNode } from 'react'
import { useStore } from 'zustand'
import type { EditorState, EditorStore } from './editorStore'

const EditorStoreContext = createContext<EditorStore | null>(null)

export function EditorStoreProvider({
  store,
  children,
}: {
  store: EditorStore
  children: ReactNode
}) {
  return <EditorStoreContext.Provider value={store}>{children}</EditorStoreContext.Provider>
}

export function useEditorStore<T>(selector: (state: EditorState) => T): T {
  const store = useContext(EditorStoreContext)
  if (!store) throw new Error('useEditorStore must be used inside EditorStoreProvider')
  return useStore(store, selector)
}

export function useEditorStoreApi(): EditorStore {
  const store = useContext(EditorStoreContext)
  if (!store) throw new Error('useEditorStoreApi must be used inside EditorStoreProvider')
  return store
}