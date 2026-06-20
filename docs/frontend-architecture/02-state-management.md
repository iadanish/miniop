# MiniOp Frontend Architecture: State Management

## Overview

MiniOp uses a layered state management strategy that avoids global stores wherever possible. The guiding principle: **server state lives on the server, URL state lives in the URL, and only truly client-local ephemeral state uses React context or `useState`**. This document defines each layer, when to use it, and how the approach scales from the free-tier single-user deployment to production multi-tenant environments.

## State Taxonomy

| Layer | Tool | Lifetime | Example |
|-------|------|----------|---------|
| Server state | Next.js Server Components + React `cache()` | Per-request | Project list, user profile, clip metadata |
| URL state | `useSearchParams`, route params | Navigation lifetime | Active clip ID, timeline zoom, tab selection |
| Server mutation state | Server Actions + `useFormState` | Form submission | Create project, update clip title, export |
| Client ephemeral state | `useState` / `useReducer` | Component lifetime | Drag position, modal open/close, tooltip |
| Client shared state | React Context (scoped) | Page/feature lifetime | Video player state, clip selection, timeline view |
| Persistent client state | `localStorage` via hook | Cross-session | Theme preference, sidebar collapsed state |

There is no Redux, Zustand, or Jotai in the default stack. If you reach for a global store, you have a server/client boundary problem to solve first.

## Layer 1: Server State (Server Components)

Next.js 14 App Router makes server state the default. Data is fetched inside Server Components with zero client JavaScript:

```tsx
// app/(dashboard)/project/[id]/page.tsx
import { getProject, getClips } from '@/lib/db/queries';
import { notFound } from 'next/navigation';
import { EditorWorkspace } from '@/components/editor/EditorWorkspace';

interface ProjectPageProps {
  params: { id: string };
}

export default async function ProjectPage({ params }: ProjectPageProps) {
  const project = await getProject(params.id);
  if (!project) notFound();

  const clips = await getClips(params.id);

  return <EditorWorkspace project={project} clips={clips} />;
}
```

Data fetching functions use React's `cache()` for request-level deduplication:

```tsx
// lib/db/queries.ts
import { cache } from 'react';
import { db } from './drizzle';
import { projects, clips } from './schema';
import { eq } from 'drizzle-orm';

export const getProject = cache(async (id: string) => {
  return db.query.projects.findFirst({
    where: eq(projects.id, id),
    with: { user: true },
  });
});

export const getClips = cache(async (projectId: string) => {
  return db.query.clips.findMany({
    where: eq(clips.projectId, projectId),
    orderBy: (clips, { asc }) => [asc(clips.startTime)],
  });
});
```

In the free tier, the database is a local SQLite file via `better-sqlite3`. In production, it's PostgreSQL via Drizzle ORM with Neon or Supabase. The query functions abstract this — the components never know the difference.

## Layer 2: URL State

Anything that should survive a page refresh or be shareable via URL goes into search params or route segments.

```tsx
// components/editor/EditorWorkspace.tsx
'use client';

import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { useCallback } from 'react';

export function useEditorUrlState() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const activeClipId = searchParams.get('clip');
  const timelineZoom = Number(searchParams.get('zoom') ?? '1');
  const activeTab = (searchParams.get('tab') ?? 'transcript') as 'transcript' | 'subtitles' | 'audio';

  const setActiveClip = useCallback(
    (clipId: string | null) => {
      const params = new URLSearchParams(searchParams);
      if (clipId) params.set('clip', clipId);
      else params.delete('clip');
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [searchParams, router, pathname]
  );

  const setZoom = useCallback(
    (zoom: number) => {
      const params = new URLSearchParams(searchParams);
      params.set('zoom', String(zoom));
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [searchParams, router, pathname]
  );

  return { activeClipId, timelineZoom, activeTab, setActiveClip, setZoom };
}
```

URL state is the single source of truth for the editor view. When a user shares a link like `/project/proj_123?clip=clip_456&zoom=2&tab=transcript`, the recipient sees the exact same view.

## Layer 3: Server Actions + `useFormState`

Mutations (create, update, delete) use Next.js Server Actions. The `useFormState` hook (React 18) provides optimistic UI and validation feedback without a client-side API layer.

```tsx
// app/(dashboard)/project/actions.ts
'use server';

import { revalidatePath } from 'next/cache';
import { db } from '@/lib/db/drizzle';
import { projects } from '@/lib/db/schema';
import { requireAuth } from '@/lib/auth';
import { z } from 'zod';

const CreateProjectSchema = z.object({
  title: z.string().min(1).max(200),
  sourceUrl: z.string().url().optional(),
});

export type CreateProjectState = {
  errors?: { title?: string[]; sourceUrl?: string[] };
  message?: string;
  projectId?: string;
};

export async function createProject(
  prevState: CreateProjectState,
  formData: FormData
): Promise<CreateProjectState> {
  const user = await requireAuth();
  const parsed = CreateProjectSchema.safeParse({
    title: formData.get('title'),
    sourceUrl: formData.get('sourceUrl'),
  });

  if (!parsed.success) {
    return { errors: parsed.error.flatten().fieldErrors };
  }

  const [project] = await db
    .insert(projects)
    .values({
      title: parsed.data.title,
      sourceUrl: parsed.data.sourceUrl,
      userId: user.id,
      status: 'pending',
    })
    .returning();

  revalidatePath('/projects');
  return { projectId: project.id };
}
```

```tsx
// components/project/CreateProjectDialog.tsx
'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { useRouter } from 'next/navigation';
import { createProject, type CreateProjectState } from '@/app/(dashboard)/project/actions';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} className="w-full">
      {pending ? 'Creating...' : 'Create Project'}
    </Button>
  );
}

interface CreateProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateProjectDialog({ open, onOpenChange }: CreateProjectDialogProps) {
  const router = useRouter();
  const [state, formAction] = useActionState(
    async (prev: CreateProjectState, formData: FormData) => {
      const result = await createProject(prev, formData);
      if (result.projectId) {
        onOpenChange(false);
        router.push(`/project/${result.projectId}`);
      }
      return result;
    },
    {}
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New Project</DialogTitle>
          <DialogDescription>Upload a video or paste a URL to get started.</DialogDescription>
        </DialogHeader>
        <form action={formAction} className="space-y-4">
          <div>
            <Label htmlFor="title">Project Title</Label>
            <Input id="title" name="title" placeholder="My Podcast Episode" />
            {state.errors?.title && (
              <p className="mt-1 text-sm text-destructive">{state.errors.title[0]}</p>
            )}
          </div>
          <div>
            <Label htmlFor="sourceUrl">Video URL (optional)</Label>
            <Input id="sourceUrl" name="sourceUrl" placeholder="https://youtube.com/watch?v=..." />
            {state.errors?.sourceUrl && (
              <p className="mt-1 text-sm text-destructive">{state.errors.sourceUrl[0]}</p>
            )}
          </div>
          <SubmitButton />
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

## Layer 4: Client Ephemeral State

Standard `useState` for UI-only state that doesn't need to be shared or persisted:

```tsx
// Drag position, tooltip visibility, animation state
const [isDragging, setIsDragging] = useState(false);
const [tooltipContent, setTooltipContent] = useState<string | null>(null);
```

This is the simplest layer. If a piece of state is only used by one component and doesn't need to survive navigation, use `useState`.

## Layer 5: Client Shared State (Scoped Context)

The video editor is the one place where multiple sibling components need access to the same mutable state. A scoped React Context keeps this contained to the editor feature, not the entire app.

```tsx
// lib/hooks/useVideoPlayer.ts
'use client';

import { createContext, useContext, useReducer, type ReactNode, type Dispatch } from 'react';

interface VideoState {
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  volume: number;
  playbackRate: number;
  buffered: TimeRanges | null;
}

type VideoAction =
  | { type: 'SET_TIME'; time: number }
  | { type: 'SET_DURATION'; duration: number }
  | { type: 'PLAY' }
  | { type: 'PAUSE' }
  | { type: 'SET_VOLUME'; volume: number }
  | { type: 'SET_PLAYBACK_RATE'; rate: number }
  | { type: 'SET_BUFFERED'; buffered: TimeRanges };

const initialState: VideoState = {
  currentTime: 0,
  duration: 0,
  isPlaying: false,
  volume: 1,
  playbackRate: 1,
  buffered: null,
};

function videoReducer(state: VideoState, action: VideoAction): VideoState {
  switch (action.type) {
    case 'SET_TIME':
      return { ...state, currentTime: action.time };
    case 'SET_DURATION':
      return { ...state, duration: action.duration };
    case 'PLAY':
      return { ...state, isPlaying: true };
    case 'PAUSE':
      return { ...state, isPlaying: false };
    case 'SET_VOLUME':
      return { ...state, volume: action.volume };
    case 'SET_PLAYBACK_RATE':
      return { ...state, playbackRate: action.rate };
    case 'SET_BUFFERED':
      return { ...state, buffered: action.buffered };
    default:
      return state;
  }
}

const VideoStateContext = createContext<VideoState | null>(null);
const VideoDispatchContext = createContext<Dispatch<VideoAction> | null>(null);

export function VideoPlayerProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(videoReducer, initialState);
  return (
    <VideoStateContext.Provider value={state}>
      <VideoDispatchContext.Provider value={dispatch}>
        {children}
      </VideoDispatchContext.Provider>
    </VideoStateContext.Provider>
  );
}

export function useVideoState() {
  const ctx = useContext(VideoStateContext);
  if (!ctx) throw new Error('useVideoState must be used within VideoPlayerProvider');
  return ctx;
}

export function useVideoDispatch() {
  const ctx = useContext(VideoDispatchContext);
  if (!ctx) throw new Error('useVideoDispatch must be used within VideoPlayerProvider');
  return ctx;
}
```

The provider is scoped to the editor page only — not the root layout:

```tsx
// components/editor/EditorWorkspace.tsx
'use client';

import { VideoPlayerProvider } from '@/lib/hooks/useVideoPlayer';
import { VideoPlayer } from './VideoPlayer';
import { Timeline } from './Timeline';
import { TranscriptPanel } from './TranscriptPanel';
import type { Project, Clip } from '@/lib/types/project';

interface EditorWorkspaceProps {
  project: Project;
  clips: Clip[];
}

export function EditorWorkspace({ project, clips }: EditorWorkspaceProps) {
  return (
    <VideoPlayerProvider>
      <div className="grid h-[calc(100vh-4rem)] grid-cols-[1fr_350px] grid-rows-[1fr_200px]">
        <VideoPlayer src={project.videoUrl} className="col-span-1 row-span-1" />
        <TranscriptPanel clips={clips} className="col-start-2 row-span-2" />
        <Timeline clips={clips} duration={project.duration} className="col-start-1 row-start-2" />
      </div>
    </VideoPlayerProvider>
  );
}
```

## Layer 6: Persistent Client State

Theme and sidebar preferences persist across sessions via `localStorage`:

```tsx
// lib/hooks/useLocalStorage.ts
'use client';

import { useState, useEffect, useCallback } from 'react';

export function useLocalStorage<T>(key: string, initialValue: T): [T, (value: T | ((prev: T) => T)) => void] {
  const [storedValue, setStoredValue] = useState<T>(initialValue);

  useEffect(() => {
    try {
      const item = window.localStorage.getItem(key);
      if (item) setStoredValue(JSON.parse(item));
    } catch {
      // SSR or localStorage unavailable — use initialValue
    }
  }, [key]);

  const setValue = useCallback(
    (value: T | ((prev: T) => T)) => {
      setStoredValue((prev) => {
        const nextValue = value instanceof Function ? value(prev) : value;
        window.localStorage.setItem(key, JSON.stringify(nextValue));
        return nextValue;
      });
    },
    [key]
  );

  return [storedValue, setValue];
}
```

```tsx
// Used for theme
const [theme, setTheme] = useLocalStorage<'light' | 'dark' | 'system'>('miniop-theme', 'system');

// Used for sidebar
const [sidebarCollapsed, setSidebarCollapsed] = useLocalStorage<boolean>('miniop-sidebar-collapsed', false);
```

## Free Tier vs. Production Differences

### Free Tier

- No `localStorage` for billing state (no billing exists).
- Server Actions hit a local SQLite database directly — no API key rotation, no connection pooling.
- No optimistic updates for clip processing (free tier processes sequentially, so the UI just shows a spinner).

### Production

- **Optimistic updates** for clip editing: when a user drags a clip boundary, the UI updates immediately while the Server Action persists the change in the background. If the mutation fails, the UI rolls back.
- **Rate limit awareness**: the `useUpload` hook tracks remaining daily uploads and disables the upload button at zero.
- **Collaborative presence** (future): a lightweight WebSocket channel broadcasts cursor positions and active clip selections to other editors viewing the same project. This would use a small Zustand store scoped to the WebSocket connection — the only justified use of a client store in the architecture.

## Anti-Patterns to Avoid

1. **Don't fetch in `useEffect` + `useState` for server-available data.** Use Server Components.
2. **Don't store form data in global state.** Use `useFormState` and Server Actions.
3. **Don't lift video player state to the app root.** Scope the provider to the editor.
4. **Don't use `localStorage` for anything sensitive.** Tokens, user data, and project data live in httpOnly cookies and the database.

## Data Flow Diagram

```
User Action
    │
    ├─ Read data? → Server Component (RSC) → DB query → Rendered HTML
    │
    ├─ Submit form? → Server Action → useActionState → Revalidate → Re-render
    │
    ├─ Edit in editor? → useReducer (context) → Immediate UI update → Server Action → DB
    │
    └─ Toggle theme? → useLocalStorage → localStorage → CSS class toggle
```

## Next Steps

- See [01-component-structure.md](./01-component-structure.md) for how these state patterns map to the component tree.
- See [03-routing-navigation.md](./03-routing-navigation.md) for how URL state is defined and protected.
